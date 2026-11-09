import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import archiver from 'archiver';
import { chromium, devices } from 'playwright';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Readable } from 'node:stream';

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"] } } }));
app.use(express.static('public', { extensions: ['html'] }));
app.use(express.json({ limit: '8kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/health', (_, res) => res.json({ ok: true }));

const MAX_IMAGES = 40;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGES = 16 * 1024 * 1024;
let busy = false; // Limits expensive Chromium usage to one archive at a time.

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
  const save = /^(zapisz (m[oó]j )?wyb[oó]r|zapisz preferencje|zapisz i zamknij|potwierd[zź] wyb[oó]r|zapisz ustawienia|save choices|save preferences|confirm choices)$/i;
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
          if (box.width < 200 || box.height < 200 || box.height > innerHeight * 1.2) return false;
          modal.style.setProperty('display', 'none', 'important');
          // Hide dimming layer only when it covers nearly the entire viewport.
          for (const el of document.querySelectorAll('div,section')) {
            if (el === modal || el.contains(modal) || modal.contains(el)) continue;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if ((style.position === 'fixed' || style.position === 'absolute') &&
                rect.width >= innerWidth * .95 && rect.height >= innerHeight * .95 &&
                style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                parseFloat(style.opacity || '1') < 1) {
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
      warnings.push(\`\${mode}: ukryto wizualnie okno zgód Gazeta.pl bez udzielenia zgody; serwis może ograniczać zawartość.\`);
      return 'visual-only';
    }
    warnings.push(\`\${mode}: nie udało się automatycznie obsłużyć okna zgód.\`);
    return 'unresolved';
  } catch (error) {
    warnings.push(\`\${mode}: obsługa zgód: \${error.message}\`);
    return 'unresolved';
  }
}

async function capture(browser, targetUrl, mode, images, state, warnings) {
  const mobile = mode === 'mobile';
  const context = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }),
    locale: 'pl-PL',
    serviceWorkers: 'block',
    acceptDownloads: false,
    ignoreHTTPSErrors: false
  });
  const pending = new Set();
  try {
    await context.route('**/*', async route => {
      const req = route.request();
      const u = req.url();
      if (!/^https?:/i.test(u)) return route.abort();
      try { await safeHttpUrl(u); await route.continue(); }
      catch { await route.abort(); }
    });
    const page = await context.newPage();
    page.on('response', response => {
      const p = (async () => {
        try {
          const ct = response.headers()['content-type'] || '';
          const ext = imageExtension(ct);
          if (!ext || state.count >= MAX_IMAGES || state.bytes >= MAX_TOTAL_IMAGES) return;
          const len = Number(response.headers()['content-length'] || 0);
          if (len > MAX_IMAGE_BYTES) return;
          const url = response.url();
          if (images.has(url)) return;
          const buffer = await response.body();
          if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return;
          if (state.count >= MAX_IMAGES || state.bytes + buffer.length > MAX_TOTAL_IMAGES) return;
          images.set(url, { buffer, ext, contentType: ct });
          state.count++;
          state.bytes += buffer.length;
        } catch { /* Some responses do not have readable bodies. */ }
      })();
      pending.add(p);
      p.finally(() => pending.delete(p));
    });
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!response) throw new Error('Strona nie zwróciła odpowiedzi.');
    if (response.status() >= 400) warnings.push(`${mode}: odpowiedź HTTP ${response.status()}.`);
    await dismissConsent(page, mode, warnings);
    // Trigger lazy-loaded images without infinite scrolling.
    await page.evaluate(async () => {
      const step = Math.max(window.innerHeight, 600);
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 11000); y += step) {
        window.scrollTo(0, y);
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(700);
    // Limit screenshot dimensions on small hosting instances to avoid OOM/502.
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    }));
    const limit = 6500;
    if (dimensions.height > limit) warnings.push(`${mode}: screenshot limited to ${limit}px due to server memory.`);
    const screenshot = await page.screenshot({
      clip: { x: 0, y: 0, width: dimensions.width, height: Math.min(dimensions.height, limit) },
      animations: 'disabled',
      timeout: 20_000
    });
    const data = await page.evaluate(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.body;
      const clone = root.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside,form,button').forEach(n => n.remove());
      const blocks = [...clone.querySelectorAll('h1,h2,h3,h4,p,li,blockquote')];
      const raw = blocks.length >= 3 ? blocks.map(n => n.textContent.trim()).filter(Boolean).join('\n\n') : (root.innerText || clone.textContent || '');
      const text = raw.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').trim();
      return { title: document.title || '', text, url: location.href, description: document.querySelector('meta[name="description"]')?.content || '' };
    });
    await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => setTimeout(resolve, 7000))]);
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
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const images = new Map();
    const state = { count: 0, bytes: 0 };
    const warnings = [];
    const desktop = await capture(browser, url, 'desktop', images, state, warnings);
    const mobile = await capture(browser, url, 'mobile', images, state, warnings);
    const text = desktop.data.text || mobile.data.text || '';
    const title = desktop.data.title || mobile.data.title || '';
    const meta = {
      originalUrl: url,
      finalDesktopUrl: desktop.data.url,
      finalMobileUrl: mobile.data.url,
      title,
      description: desktop.data.description,
      capturedAt: new Date().toISOString(),
      desktopViewport: '1440x900',
      mobileDevice: 'iPhone 13',
      imageCount: images.size,
      warnings,
      note: 'Grafiki to pliki przechwycone podczas ładowania strony, niekoniecznie wszystkie pliki z serwera.'
    };
    const archive = archiver('zip', { zlib: { level: 6 } });
    const base = `archiwum_${slugHost(url)}_${new Date().toISOString().slice(0, 10)}`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    archive.on('error', e => { console.error('ZIP:', e); res.destroy(e); });
    archive.pipe(res);
    archive.append(desktop.screenshot, { name: `${base}/desktop.png` });
    archive.append(mobile.screenshot, { name: `${base}/mobile.png` });
    archive.append(text + '\n', { name: `${base}/tekst.txt` });
    archive.append(url + '\n', { name: `${base}/zrodlo.url` });
    let index = 0;
    const imageIndex = [];
    for (const [source, image] of images) {
      const name = `grafiki/obraz_${String(++index).padStart(3, '0')}.${image.ext}`;
      archive.append(image.buffer, { name: `${base}/${name}` });
      imageIndex.push({ file: name, source });
    }
    archive.append(JSON.stringify(imageIndex, null, 2), { name: `${base}/grafiki/indeks.json` });
    archive.append(JSON.stringify(meta, null, 2), { name: `${base}/metadata.json` });
    await archive.finalize();
  } catch (err) {
    console.error('Archive error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Nie udało się zarchiwizować strony. ' + (err?.message || 'Błąd serwera.') });
    else res.destroy();
  } finally { if (browser) await browser.close().catch(() => {}); busy = false; }
});

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', () => console.log(`Archiwizator działa na porcie ${PORT}`));
