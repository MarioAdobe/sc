# Archiwizator WWW

Aplikacja webowa do zebrania **zrzutu desktop, zrzutu mobile, tekstu oraz grafik** z podanego adresu i pobrania wszystkiego jako ZIP. Użytkownik nie instaluje niczego na swoim komputerze: program działa na serwerze i otwiera się przez zwykłą przeglądarkę.

## Publikacja bez instalowania programów na komputerze

Do pierwszej publikacji potrzebujesz konta **GitHub** i konta **Render**. Nie trzeba używać terminala ani instalować Node/Python/Dockera lokalnie.

1. Wejdź na https://github.com/new i utwórz **prywatne repozytorium** (np. `archiwizator-www`).
2. W repozytorium użyj `Add file` → `Upload files`, aby dodać pliki projektu. Rozpakuj otrzymany ZIP i umieść **zawartość folderu** w katalogu głównym repozytorium (plik `Dockerfile` musi być widoczny od razu). GitHub nie przyjmuje całego folderu jako ZIP do automatycznego rozpakowania.
3. Otwórz https://dashboard.render.com i wybierz `New` → `Web Service`.
4. Połącz repozytorium GitHub i wskaż swoje repozytorium.
5. W polu **Language / Runtime** wybierz **Docker**. Dockerfile Path: `./Dockerfile`. Health Check Path: `/health`.
6. W ustawieniach usługi dodaj zmienną środowiskową **ACCESS_KEY** z własnym długim, losowym hasłem (np. w `Environment`). `render.yaml` zawiera również opcję automatycznego generowania klucza, ale przy konfiguracji ręcznej dodaj go samodzielnie.
7. Wybierz plan zapewniający wystarczającą pamięć do uruchomienia Chromium. Koszt i dostępność planów sprawdź w Render; darmowy plan może być niewystarczający. Kliknij `Create Web Service` / `Deploy`.
8. Po zakończeniu wdrożenia otwórz adres przydzielony przez Render, np. `https://twoja-nazwa.onrender.com`. Wklej adres strony i swój klucz, kliknij **Przygotuj archiwum ZIP**.

**Ważne:** bez wdrożenia na serwer aplikacja nie ma działającego publicznego adresu URL. Ten ZIP zawiera kompletny projekt do opublikowania, a nie już działającą usługę.

## Zawartość ZIP tworzonego przez aplikację

```
archiwum_domena_YYYY-MM-DD/
├── desktop.png
├── mobile.png
├── tekst.txt
├── zrodlo.url
├── metadata.json
└── grafiki/
    ├── obraz_001.jpg
    ├── obraz_002.webp
    └── indeks.json
```

## Ograniczenia

- Archiwizuje publicznie dostępne strony; nie omija paywalli, logowania, blokad antybotowych ani zabezpieczeń DRM.
- Nie gwarantuje pobrania każdej grafiki: zapisuje pliki obrazów przechwycone podczas otwierania i przewijania strony. Limity: maks. 90 obrazów, maks. 8 MB na plik i 45 MB łącznie.
- Tekst jest heurystycznie pobierany z `<article>`, `<main>` albo z treści strony, bez znaczników HTML; nie jest to gwarantowana rekonstrukcja artykułu.
- Strony bardzo długie, niestandardowe, dynamiczne albo nieodpowiadające mogą zakończyć się błędem lub mieć niekompletne zrzuty.
- Publiczne wystawianie automatycznej przeglądarki na dowolne strony wiąże się z ryzykiem bezpieczeństwa. Aplikacja ogranicza lokalne/prywatne adresy oraz porty, ale zabezpieczenie SSRF nie jest absolutne (np. DNS rebinding). Do zastosowań produkcyjnych uruchom ją w odizolowanej sieci bez dostępu do infrastruktury wewnętrznej, za uwierzytelnieniem, z limitami czasu/zasobów i monitoringiem. Nie używaj do pobierania wrażliwych dokumentów bez oceny polityk bezpieczeństwa.
- Klucz jest wpisywany za każdym razem i nie jest przechowywany przez aplikację.

## Lokalna obsługa (opcjonalnie, tylko dla administratorów)

W środowisku ze zainstalowanym Dockerem: `docker build -t archiwizator .` i `docker run -p 10000:10000 -e ACCESS_KEY=twoj_klucz archiwizator`.

## Technologie

Express / Node.js, Playwright / Chromium, archiver, kontener Docker. Program nie wymaga bazy danych; archiwa są generowane w pamięci i przesyłane do przeglądarki.
