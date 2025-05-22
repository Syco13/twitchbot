# Twitch to TikTok Auto-Poster

Dieses Node.js-Tool postet automatisch Twitch-Clips von angegebenen Streamern (aus den letzten 30 Tagen) direkt über die Twitch-Weboberfläche auf TikTok – **ohne Video-Download, nur per Browser-Automation**.

## Features

- Holt Clips von beliebig vielen Streamern (nur Username nötig)
- Postet Clips direkt über die Twitch-Weboberfläche auf TikTok (kein Download)
- Erkennt und beachtet TikTok-Upload-Limits automatisch (12h-Pause)
- Vermeidet doppelte Uploads (führt Buch über bereits gepostete Clips)
- Robuste Cookie-basierte Anmeldung für Twitch & TikTok
- Ausführliches Logging (Konsole & Datei)
- Läuft im Hintergrund, prüft alle 5 Minuten auf neue Clips

## Voraussetzungen

- Node.js 14.x oder höher
- Twitch- und TikTok-Account
- Exportierte Twitch- und TikTok-Cookies (als JSON)
- `.env`-Datei mit Streamer-Usernames und Log-Pfad

## Einrichtung

1. Repository klonen  
2. Abhängigkeiten installieren:
   ```bash
   npm install
   ```
3. `.env` anlegen und ausfüllen (siehe unten)
4. Twitch-Cookies und TikTok-Cookies als JSON exportieren (z.B. mit EditThisCookie)
   - Twitch: `twitch_cookies.json`
   - TikTok: (wird aktuell nicht direkt genutzt, aber vorbereiten)
5. Tool starten:
   ```bash
   npm start
   ```
   oder per Batch-Datei:
   ```bash
   start-autopost.bat
   ```

## .env-Beispiel

```
TWITCH_STREAMER_USERNAMES=streamer1,streamer2
LOG_FILE_PATH=autopost.log
```

## Funktionsweise

- Das Tool öffnet einen sichtbaren Browser (headless: false), loggt sich per Cookie bei Twitch ein und ruft die Clips-Seite jedes angegebenen Streamers für die letzten 30 Tage auf.
- Es prüft, welche Clips noch nicht auf TikTok gepostet wurden (geführt in `uploaded_clips.json`).
- Neue Clips werden von **neu nach alt** gepostet.
- Nach jedem Upload prüft das Tool, ob das TikTok-Upload-Limit erreicht wurde (exakter Text:  
  „Du hast die maximale Anzahl an Uploads erreicht, die TikTok erlaubt. Bitte versuche es später erneut.“).
- Bei Limit: 12 Stunden Pause, dann erneuter Versuch.
- Alle Aktionen werden geloggt.

## Logging

- Konsole und Datei (Standard: `autopost.log`)
- Uploads, Fehler, Pausen und alle wichtigen Schritte werden dokumentiert

## Hinweise

- Das Tool benötigt keine Twitch-API-Keys mehr, sondern arbeitet rein über die Weboberfläche.
- Die Datei `uploaded_clips.json` wird regelmäßig aktualisiert und vor jedem Durchlauf neu eingelesen.
- Die Sperr-Erkennung für TikTok ist maximal robust (exakter Textabgleich).
- Das Tool kann jederzeit gestoppt und wieder gestartet werden, ohne doppelte Uploads zu verursachen.

## Troubleshooting

- **Browser öffnet sich nicht:**  
  - Prüfe, ob das Upload-Limit aktiv ist (siehe Log und ggf. `tiktok_upload_limit.json` löschen).
- **Clips werden doppelt gepostet:**  
  - Prüfe, ob `uploaded_clips.json` korrekt geschrieben wird und nicht gelöscht/überschrieben wird.
- **TikTok-Login/Cookies:**  
  - Cookies müssen gültig und aktuell sein. Bei Problemen neu exportieren.
