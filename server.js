import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import archiver from 'archiver';
import { chromium, devices } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const app = express();
app.disable('x-powered-by');
// Render forwards requests through a single trusted reverse proxy.
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(express.static('public', { extensions: ['html'] }));
app.use(express.json({ limit: '8kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/health', (_, res) => res.json({ ok: true }));

const SHOT_HEIGHT = 4800; // Tall image for a vertical pan in After Effects.
let busy = false; // Limits expensive Chromium usage to one archive at a time.

const NON_EDITORIAL_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googletagservices\.com|google-analytics\.com|analytics\.google\.com|adnxs\.com|criteo\.com|taboola\.com|outbrain\.com|scorecardresearch\.com|quantserve\.com)$/i;

function blockedIp(address) {
  try {
    let addr = ipaddr.parse(address);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
    return addr.range() !== 'unicast';
  } catch { return true; }
}
async function safeHttpUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Dozwolone są tylko adresy http/https.');
  if (url.username || url.password) throw new Error('Adres z loginem lub hasłem nie jest obsługiwany.');
  if (url.hostname.toLowerCase() === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new Error('Adres lokalny jest zablokowany.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Niestandardowe porty nie są obsługiwane.');
  if (net.isIP(url.hostname)) {
    if (blockedIp(url.hostname)) throw new Error('Adres prywatny lub lokalny jest zablokowany.');
  } else {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => blockedIp(a.address))) throw new Error('Adres sieci wewnętrznej jest zablokowany.');
  }
  return url.href;
}
function filename(raw, fallback) {
  return (raw || fallback).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || fallback;
}
function slugHost(url) {
  return filename(new URL(url).hostname.replace(/^www\./, ''), 'strona');
}
function imageExtension(contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico' })[ct];
}
// Consent managers differ across publishers and often live in iframes.
// Prefer an explicit refusal of optional tracking over accepting all cookies.
async function dismissConsent(page, mode, warnings) {
  const reject = /^(odrzu[cć](?: wszystkie)?|odm[oó]w(?: wszystkie)?|nie zgadzam si[eę]|nie akceptuj[eę]|odrzu[cć] opcjonalne|tylko niezb[eę]dne|tylko wymagane|bez zgody|kontynuuj bez zgody|reject all|decline all|deny all|necessary only|essential only|continue without accepting)$/i;
  const manage = /^(ustawienia zaawansowane|zarz[aą]dzaj zgodami|ustawienia prywatno[sś]ci|dostosuj wyb[oó]r|manage options|manage preferences|customize|settings)$/i;
  const candidates = async pattern => {
    for (const frame of page.frames()) {
      for (const locator of [
        frame.getByRole('button', { name: pattern }),
        frame.getByRole('link', { name: pattern }),
        frame.locator('input[type="submit"],input[type="button"]').filter({ hasText: pattern }),
        frame.locator('button,[role="button"],a').filter({ hasText: pattern })
      ]) {
        try {
          const choice = locator.first();
          if (await choice.isVisible({ timeout: 350 })) {
            await choice.click({ timeout: 1200 });
            return true;
          }
        } catch { /* Try remaining consent UI elements. */ }
      }
    }
    return false;
  };
  const gazetaOverlay = async () => {
    // Visual-only fallback: no consent is granted. Remove only a known Gazeta.pl
    // cookie notice plus its dimming backdrop, not generic dialogs/paywalls.
    let cleaned = false;
    for (const frame of page.frames()) {
      try {
        const changed = await frame.evaluate(() => {
          const visible = el => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 150 && r.height > 120;
          };
          const text = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
          const matches = [...document.querySelectorAll('div,section,dialog,aside')]
            .filter(el => visible(el) && text(el).includes('Droga Użytkowniczko, Drogi Użytkowniku') &&
              text(el).includes('USTAWIENIA ZAAWANSOWANE') &&
              text(el).includes('AKCEPTUJĘ'));
          if (!matches.length) return false;
          // Smallest enclosing modal with consent text and action controls.
          const modal = matches.sort((a,b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height -
            b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
          const box = modal.getBoundingClientRect();
          if (box.width < 200 || box.height < 200) return false;
          modal.style.setProperty('display', 'none', 'important');
          // Hide dimming layer only when it covers nearly the entire viewport.
          for (const el of document.querySelectorAll('div,section')) {
            if (el === modal || el.contains(modal) || modal.contains(el)) continue;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if ((style.position === 'fixed' || style.position === 'absolute') &&
                rect.width >= innerWidth * .95 && rect.height >= innerHeight * .95 &&
                ((style.backgroundColor.startsWith('rgba(') && Number(style.backgroundColor.split(',')[3]?.replace(')', '').trim()) > 0.1) ||
                 (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && parseFloat(style.opacity || '1') < 1))) {
              el.style.setProperty('display', 'none', 'important');
            }
          }
          document.documentElement.style.setProperty('overflow', 'auto', 'important');
          document.body.style.setProperty('overflow', 'auto', 'important');
          return true;
        });
        if (changed) cleaned = true;
      } catch { /* inaccessible frame */ }
    }
    return cleaned;
  };
  try {
    await page.waitForTimeout(1700);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await candidates(reject)) {
        await page.waitForTimeout(900);
        return 'rejected';
      }
      if (await candidates(manage)) {
        await page.waitForTimeout(1100);
        if (await candidates(reject)) {
          await page.waitForTimeout(900);
          return 'rejected';
        }
        // Only save choices if the CMP explicitly offers a privacy-preserving
        // selection. Never toggle unknown switches or accept-all as a fallback.
      }
      await page.waitForTimeout(500);
    }
    if (await gazetaOverlay()) {
      warnings.push(`${mode}: ukryto wizualnie okno zgód Gazeta.pl bez udzielenia zgody; serwis może ograniczać zawartość.`);
      return 'visual-only';
    }
    warnings.push(`${mode}: nie udało się automatycznie obsłużyć okna zgód.`);
    return 'unresolved';
  } catch (error) {
    warnings.push(`${mode}: obsługa zgód: ${error.message}`);
    return 'unresolved';
  }
}

async function closeGuardianPrivacy(page, mode, warnings) {
  if (!/(^|\.)theguardian\.com$/i.test(new URL(page.url()).hostname)) return;
  let handled = false;
  for (const frame of page.frames()) {
    try {
      const heading = frame.getByText('Your privacy', { exact: true }).first();
      if (!await heading.isVisible({ timeout: 350 })) continue;
      for (const selector of ['button[aria-label*="close" i]', 'button[title*="close" i]', '[role="button"][aria-label*="close" i]']) {
        try {
          const button = frame.locator(selector).first();
          if (await button.isVisible({ timeout: 200 })) {
            await button.click({ timeout: 1200 });
            handled = true;
            break;
          }
        } catch {}
      }
      if (handled) break;
      handled = await frame.evaluate(() => {
        const heading = [...document.querySelectorAll('h1,h2,h3,div,p')]
          .find(el => el.children.length === 0 && el.textContent?.trim() === 'Your privacy');
        if (!heading) return false;
        let box = heading;
        for (let i = 0; i < 8 && box.parentElement; i++) {
          box = box.parentElement;
          const rect = box.getBoundingClientRect();
          if ((box.innerText || '').includes('Do not sell or share my personal information') &&
              rect.width > innerWidth * .45 && rect.height < innerHeight * .9) {
            box.style.setProperty('display','none','important');
            document.documentElement.style.setProperty('overflow','auto','important');
            document.body.style.setProperty('overflow','auto','important');
            return true;
          }
        }
        return false;
      });
      if (handled) break;
    } catch {}
  }
  if (handled) {
    warnings.push(mode + ': zamknięto wizualnie baner prywatności The Guardian bez udzielania zgody.');
    await page.waitForTimeout(400);
  } else warnings.push(mode + ': nie udało się usunąć banera prywatności The Guardian.');
}

// Sourcepoint frequently renders the Guardian's privacy notice in a separate
// cross-origin iframe. Remove that iframe visually; never grant consent.
async function suppressGuardianConsentFrames(page, mode, warnings) {
  if (!/(^|\.)theguardian\.com$/i.test(new URL(page.url()).hostname)) return;
  const details = [];
  for (const frame of page.frames()) {
    try {
      if (frame !== page.mainFrame()) {
        const isNotice = await frame.evaluate(() =>
          /your privacy/i.test(document.body?.innerText || '') &&
          /personal information|do not sell or share/i.test(document.body?.innerText || '')
        ).catch(() => false);
        if (isNotice) {
          const iframe = await frame.frameElement();
          await iframe.evaluate(el => el.style.setProperty('display', 'none', 'important'));
          details.push('privacy-frame');
          continue;
        }
      }
      const result = await frame.evaluate(() => {
        const matches = [];
        const walk = root => {
          for (const el of root.querySelectorAll('iframe,div,section,aside,dialog')) {
            const id = [el.id, el.className, el.getAttribute('title'), el.getAttribute('src')].join(' ');
            if (el.tagName === 'IFRAME' && /sp_message|sourcepoint|privacy-mgmt/i.test(id)) {
              el.style.setProperty('display','none','important');
              matches.push('iframe');
              continue;
            }
            const st = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const txt = (el.innerText || '').slice(0,1500);
            if (box.width > innerWidth * .65 && box.height > 50 &&
                box.height < innerHeight * .85 &&
                /your privacy/i.test(txt) &&
                /do not sell or share|personal information|guardian news and media/i.test(txt) &&
                (st.position === 'fixed' || st.position === 'sticky' || el.getAttribute('role') === 'dialog')) {
              el.style.setProperty('display','none','important');
              matches.push('banner');
            }
          }
        };
        walk(document);
        return matches;
      });
      details.push(...result);
    } catch (e) { console.warn('Consent frame inspection:', mode, e.message); }
  }
  if (details.length) {
    warnings.push(mode + ': ukryto nakładki prywatności Guardian: ' + details.join(', '));
    console.log('Guardian consent hidden:', mode, details.join(','));
  } else console.log('Guardian consent frame detection: no matching overlay', mode,
    page.frames().map(f=>f.url().slice(0,120)));
}

async function preloadArticleImages(page, mode, warnings) {
  try {
    await page.evaluate(() => {
      for (const img of document.images) img.loading = 'eager';
    });
    const maxY = await page.evaluate(() => Math.min(5700, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)));
    const step = await page.evaluate(() => Math.max(450, Math.round(innerHeight * .72)));
    for (let y = 0; y < maxY; y += step) {
      await page.evaluate(pos => window.scrollTo(0, pos), y);
      await page.waitForTimeout(350);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    const stats = await page.evaluate(async () => {
      const imgs = [...document.images].filter(img => {
        const r = img.getBoundingClientRect();
        return r.top + scrollY < 5700 && r.width > 80 && r.height > 60;
      });
      await Promise.race([
        Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
          new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }))),
        new Promise(resolve => setTimeout(resolve, 4500))
      ]);
      return { total: imgs.length, missing: imgs.filter(img => !img.complete || img.naturalWidth === 0).length };
    });
    if (stats.missing) warnings.push(mode + ': nie załadowano ' + stats.missing + '/' + stats.total + ' obrazów.');
  } catch (error) {
    warnings.push(mode + ': ładowanie zdjęć: ' + error.message);
  }
}

// Prepare a stable article-focused screenshot without newsletter/promo overlays.
async function prepareArticleShot(page, mode, warnings) {
  try {
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
      // Reset any scroll-induced navigation expansion and return to the top.
      document.querySelectorAll('[aria-expanded="true"]').forEach(el => {
        if (el.matches('button,[role="button"]') && /menu|nawigac|navigation/i.test(
          [el.getAttribute('aria-label'), el.className, el.id].join(' '))) {
          el.setAttribute('aria-expanded', 'false');
        }
      });
      const isVisible = el => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && st.display !== 'none' && st.visibility !== 'hidden';
      };
      const isArticlePart = el => Boolean(el.closest('article,[itemprop="articleBody"],[itemtype*="Article"]'));
      // Remove only known sticky promo containers, not generic fixed navigation.
      for (const el of document.querySelectorAll('div,aside,section')) {
        if (!isVisible(el) || isArticlePart(el)) continue;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (!['fixed','sticky'].includes(style.position)) continue;
        const text = (el.innerText || '').replace(/\s+/g,' ').trim();
        const knownPromo = /zobacz na gazeta\.pl|zobacz także na gazeta\.pl|przejdź do gazeta\.pl/i.test(text);
        const smallBottomBar = style.position === 'fixed' && box.top > innerHeight * 0.55 &&
          box.width > innerWidth * 0.65 && box.height < innerHeight * 0.38;
        // Match the smallest overlay to avoid hiding enclosing content.
        if ((knownPromo && box.height < innerHeight * .45 && box.width > innerWidth * .55) ||
            (smallBottomBar && /gazeta\.pl|zamknij|promocja|reklama/i.test(text))) {
          el.style.setProperty('display','none','important');
        }
      }
      document.documentElement.style.setProperty('overflow','auto','important');
      document.body.style.setProperty('overflow','auto','important');
      window.scrollTo(0,0);
    });
    await page.waitForTimeout(350);
  } catch (e) {
    warnings.push(`${mode}: przygotowanie kadru: ${e.message}`);
  }
}

async function articleVisibility(page) {
  return page.evaluate(() => {
    const visible = el => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 100 && box.height > 12;
    };
    const headline = [...document.querySelectorAll('h1')].find(el =>
      visible(el) && !el.closest('nav,footer,[role="dialog"]'));
    const body = [...document.querySelectorAll('article,[itemprop="articleBody"],main')]
      .filter(visible).sort((a,b) => (b.querySelectorAll('p').length - a.querySelectorAll('p').length))[0];
    const paragraphs = body ? [...body.querySelectorAll('p')].filter(el =>
      visible(el) && (el.innerText || '').trim().length > 45).length : 0;
    return { headline: Boolean(headline), paragraphs };
  });
}

// A desktop navigation flyout can obscure or replace the article when a page
// reacts to scrolling or consent. Recover the article rather than capture a menu.
async function ensureVisibleArticle(page, mode, warnings) {
  if (mode !== 'desktop') return;
  let state = await articleVisibility(page);
  if (state.headline && state.paragraphs >= 2) return;
  console.warn('Desktop article missing, attempting recovery:', state, page.url());
  await page.keyboard.press('Escape').catch(() => {});
  const close = page.locator('button[aria-label*="zamknij" i],button[aria-label*="close" i],button[title*="zamknij" i],button[title*="close" i]').first();
  if (await close.isVisible().catch(() => false)) await close.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(800);
  state = await articleVisibility(page);
  if (state.headline && state.paragraphs >= 2) return;
  // Reload resets flyout UI and any page state mutated by lazy scrolling.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await dismissConsent(page, mode, warnings);
  await page.waitForTimeout(900);
  state = await articleVisibility(page);
  if (!state.headline || state.paragraphs < 2) {
    // Some sites render only mobile/article content at medium-width layouts.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(1200);
    state = await articleVisibility(page);
    if (state.headline && state.paragraphs >= 2) {
      warnings.push('desktop: użyto szerokości 1024px, bo układ 1440px ukrywał artykuł.');
    }
  }
  if (!state.headline || state.paragraphs < 2) {
    throw new Error('Desktop: strona pokazuje menu lub pusty widok zamiast artykułu. Nie zapisano błędnego screenshotu.');
  }
}

async function getArticleClip(page, mode, warnings) {
  return await page.evaluate((mode) => {
    const vw = document.documentElement.clientWidth;
    const total = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const visible = el => {
      if (!el) return false;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 150 && r.height > 20;
    };
    // Article pages typically have a single visible H1. Ignore menu/footer items.
    const headings = [...document.querySelectorAll('main h1,article h1,h1')]
      .filter(el => visible(el) && !el.closest('nav,footer,header[role="banner"],[role="dialog"]'));
    const h1 = headings[0];
    const article = [...document.querySelectorAll('article,[itemprop="articleBody"],main')]
      .find(el => visible(el) && (h1 ? el.contains(h1) : true));
    const focus = h1 || article;
    // Mobile layouts may reposition the hero image above the headline. Starting
    // from the article H1 can therefore crop the photo and top of the story.
    // Capture from document top on mobile; keep desktop article framing intact.
    const y = mode === 'mobile' ? 0 : (focus ? Math.max(0, Math.floor(focus.getBoundingClientRect().top + scrollY - 160)) : 0);
    // Restrict capture to article content instead of site-wide footer/navigation.
    const possibleEnd = article && article !== document.querySelector('main')
      ? Math.ceil(article.getBoundingClientRect().bottom + scrollY + 80) : total;
    const bottom = Math.min(total, Math.max(y + 500, possibleEnd));
    return { x: 0, y, width: vw, height: Math.min(6500, Math.max(1, bottom-y)),
      focused: Boolean(focus), fullHeight: total };
  }, mode);
}

// Several small screenshots are stitched into one tall PNG. This avoids
// large Playwright screenshot timeouts and never substitutes a 1px placeholder.
async function captureTallImage(page, clip, mode) {
  const height = Math.min(SHOT_HEIGHT, clip.height);
  if (height < 300) throw new Error(`${mode}: zbyt krótki obszar artykułu do wykonania screenshotu.`);
  // CDP captures the full requested rectangle in one operation without
  // Playwright's screenshot stability/animation waiting or image stitching.
  const client = await page.context().newCDPSession(page);
  try {
    const capture = client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height, scale: 1 }
    });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${mode}: upłynął limit czasu dla długiego zrzutu (45 s).`)), 45000)
    );
    const result = await Promise.race([capture, timeout]);
    const image = Buffer.from(result.data, 'base64');
    if (image.length < 1000) throw new Error(`${mode}: zapisany obraz jest pusty.`);
    return image;
  } finally {
    await client.detach().catch(() => {});
  }
}

async function capture(browser, targetUrl, mode, warnings) {
  const mobile = mode === 'mobile';
  const context = await browser.newContext({
    ...(mobile ? { ...devices['iPhone 13'], deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
    locale: 'pl-PL',
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false
  });
  try {
    await context.route('**/*', async route => {
      const req = route.request();
      const u = req.url();
      if (!/^https?:/i.test(u)) return route.abort();
      try {
        const parsed = new URL(u);
        if (NON_EDITORIAL_HOSTS.test(parsed.hostname)) return route.abort();
        await safeHttpUrl(u);
        await route.continue();
      } catch { await route.abort(); }
    });
    const page = await context.newPage();
    page.on('crash', () => console.error('Chromium tab crashed:', mode));
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response) throw new Error('Strona nie zwróciła odpowiedzi.');
    if (response.status() >= 400) warnings.push(`${mode}: odpowiedź HTTP ${response.status()}.`);
    await dismissConsent(page, mode, warnings);
    await closeGuardianPrivacy(page, mode, warnings);
    await suppressGuardianConsentFrames(page, mode, warnings);
    await preloadArticleImages(page, mode, warnings);
    await prepareArticleShot(page, mode, warnings);
    await closeGuardianPrivacy(page, mode, warnings);
    await suppressGuardianConsentFrames(page, mode, warnings);
    await ensureVisibleArticle(page, mode, warnings);
    await prepareArticleShot(page, mode, warnings);
    const clip = await getArticleClip(page, mode, warnings);
    if (!clip.focused) warnings.push(`${mode}: nie znaleziono nagłówka artykułu; zapisano początek strony.`);
    if (clip.fullHeight > clip.y + Math.min(clip.height, SHOT_HEIGHT)) warnings.push(`${mode}: kadr ograniczono do ${SHOT_HEIGHT}px, aby zmieścił się na hostingu.`);
    // Screenshot is the primary artifact. Failure must be explicit.
    const screenshot = await captureTallImage(page, clip, mode);
    const data = await page.evaluate(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,button').forEach(n => n.remove());
      const blocks = [...clone.querySelectorAll('h1,h2,h3,h4,p,li,blockquote')];
      const raw = blocks.length >= 3 ? blocks.map(n => n.textContent.trim()).filter(Boolean).join('\n\n') : (root.innerText || clone.textContent || '');
      const text = raw.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').trim();
      return { title: document.title || '', text, url: location.href, description: document.querySelector('meta[name="description"]')?.content || '' };
    });
    return { screenshot, data };
  } finally { await context.close(); }
}

app.post('/api/archive', async (req, res) => {
  if (busy) return res.status(429).json({ error: 'Trwa już archiwizacja. Spróbuj ponownie za chwilę.' });
  if (process.env.ACCESS_KEY && req.headers['x-access-key'] !== process.env.ACCESS_KEY) return res.status(401).json({ error: 'Nieprawidłowy klucz dostępu.' });
  let url;
  try {
    if (typeof req.body?.url !== 'string' || req.body.url.length > 2048) throw new Error('Wpisz prawidłowy adres URL.');
    url = await safeHttpUrl(req.body.url);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  busy = true;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking'] });
    const warnings = [];
    const desktop = await capture(browser, url, 'desktop', warnings);
    const mobile = await capture(browser, url, 'mobile', warnings);
    const text = desktop.data.text || mobile.data.text || '';
    const archive = archiver('zip', { zlib: { level: 6 } });
    const base = `archiwum_${slugHost(url)}_${new Date().toISOString().slice(0, 10)}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    archive.on('error', e => { console.error('ZIP:', e); res.destroy(e); });
    archive.pipe(res);
    archive.append(desktop.screenshot, { name: `${base}/desktop.png` });
    archive.append(mobile.screenshot, { name: `${base}/mobile.png` });
    archive.append(text + '\n', { name: `${base}/tekst.txt` });
    await archive.finalize();
  } catch (err) {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Nie udało się zarchiwizować strony. ' + (err?.message || 'Błąd serwera.') });
    else res.destroy();
  } finally { if (browser) await browser.close().catch(() => {}); busy = false; }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', () => console.log(`Archiwizator działa na porcie ${PORT}`));
