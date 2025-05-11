require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const winston = require('winston');
const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

puppeteer.use(StealthPlugin());

// Configure logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: process.env.LOG_FILE_PATH || 'autopost.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Store processed clip IDs to avoid duplicates
const processedClips = new Set();
const UPLOADED_CLIPS_FILE = 'uploaded_clips.json';
const UPLOAD_LIMIT_FILE = 'tiktok_upload_limit.json';

// Funktion zum Normalisieren der Clip-URLs
function normalizeClipUrl(url) {
    // Entferne Query-Parameter und normalisiere den Pfad
    return url.split('?')[0].toLowerCase();
}

function loadUploadedClips() {
    try {
        const arr = JSON.parse(fs.readFileSync(UPLOADED_CLIPS_FILE, 'utf8'));
        // Normalisiere die URLs beim Laden
        return new Set(arr.map(entry => {
            const url = typeof entry === 'string' ? entry : entry.url;
            return normalizeClipUrl(url);
        }));
    } catch {
        return new Set();
    }
}

function saveUploadedClips(set) {
    const arr = Array.from(set).map(url => ({ 
        url: normalizeClipUrl(url), 
        timestamp: Date.now() 
    }));
    fs.writeFileSync(UPLOADED_CLIPS_FILE, JSON.stringify(arr, null, 2));
}

let uploadedClips = loadUploadedClips();

// Funktion: Entferne alle Uploads der letzten 2 Stunden aus uploaded_clips.json
function removeRecentUploadedClips(hours = 2) {
    try {
        if (!fs.existsSync(UPLOADED_CLIPS_FILE)) return;
        const now = Date.now();
        const oldClips = JSON.parse(fs.readFileSync(UPLOADED_CLIPS_FILE, 'utf8'));
        // Nur Einträge behalten, die älter als X Stunden sind
        const filtered = oldClips.filter(entry => {
            if (typeof entry === 'string') return true; // fallback für alte Struktur
            if (entry.timestamp && (now - entry.timestamp) < hours * 60 * 60 * 1000) {
                return false;
            }
            return true;
        });
        fs.writeFileSync(UPLOADED_CLIPS_FILE, JSON.stringify(filtered, null, 2));
        logger.info(`Entfernt alle Uploads der letzten ${hours} Stunden aus uploaded_clips.json`);
    } catch (e) {
        logger.warn('Fehler beim Entfernen alter Uploads: ' + e.message);
    }
}

// Am Anfang des Scripts aufrufen
// removeRecentUploadedClips(2);

function setUploadLimitTimestamp() {
    fs.writeFileSync(UPLOAD_LIMIT_FILE, JSON.stringify({ blockedAt: Date.now() }, null, 2));
}

function getUploadLimitTimestamp() {
    if (!fs.existsSync(UPLOAD_LIMIT_FILE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(UPLOAD_LIMIT_FILE, 'utf8'));
        return data.blockedAt || null;
    } catch {
        return null;
    }
}

function clearUploadLimitTimestamp() {
    if (fs.existsSync(UPLOAD_LIMIT_FILE)) fs.unlinkSync(UPLOAD_LIMIT_FILE);
}

async function handleUploadLimitPause() {
    const blockedAt = getUploadLimitTimestamp();
    if (!blockedAt) return false;
    const now = Date.now();
    const elapsed = now - blockedAt;
    if (elapsed < 12 * 60 * 60 * 1000) {
        const waitMs = 12 * 60 * 60 * 1000 - elapsed;
        logger.warn(`TikTok Upload-Limit erkannt! Warte noch ${Math.ceil(waitMs / (60 * 60 * 1000))} Stunden bis zum nächsten Versuch (12h-Regel).`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return 'try12h';
    } else if (elapsed < 24 * 60 * 60 * 1000) {
        const waitMs = 24 * 60 * 60 * 1000 - elapsed;
        logger.warn(`TikTok Upload-Limit: 12h vorbei, versuche erneut zu posten...`);
        return 'try24h';
    } else {
        logger.warn('TikTok Upload-Limit: 24h vorbei, versuche erneut zu posten...');
        clearUploadLimitTimestamp();
        return false;
    }
}

async function processStreamer(username) {
    if (!username || username.trim() === '') {
        logger.warn('Skipping empty streamer username');
        return;
    }
    
    logger.info(`Processing streamer with username: ${username}`);
    let browser;
    let newClipsCount = 0;
    try {
        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Set Twitch cookies
        logger.info('Setting Twitch cookies...');
        const twitchCookies = JSON.parse(fs.readFileSync('twitch_cookies.json', 'utf8'));
        // Füge Sprach-Cookie hinzu
        twitchCookies.push({
            name: 'language',
            value: 'de-DE',
            domain: '.twitch.tv',
            path: '/'
        });
        await page.setCookie(...twitchCookies);

        // Hilfsfunktion für die Verarbeitung einer Sortierung
        async function processClipsForSort(sortParam, sortLabel) {
            const clipsUrl = `https://www.twitch.tv/${username}/clips?range=30d&sort=${sortParam}`;
            logger.info(`Navigating to ${clipsUrl} [${sortLabel}]`);
            await page.goto(clipsUrl, { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
                await page.waitForSelector('a[data-a-target="preview-card-image-link"]', { timeout: 15000 });
            } catch (e) {
                logger.warn(`Keine Clips gefunden für ${sortLabel}`);
                return;
            }
            let clipLinks = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('a[data-a-target="preview-card-image-link"]'))
                    .map(a => a.href);
            });
            logger.info(`Found ${clipLinks.length} clips in the last 30 days [${sortLabel}]`);
            let foundNew = false;
            for (const link of clipLinks) {
                try {
                    const normalizedLink = normalizeClipUrl(link);
                    if (processedClips.has(normalizedLink) || uploadedClips.has(normalizedLink)) {
                        logger.info(`Skipping already processed clip: ${link}`);
                        continue;
                    }
                    foundNew = true;
                    newClipsCount++;
                    logger.info(`Processing clip: ${link}`);
                    
                    // Navigate to the clip detail page
                    await page.goto(link, { waitUntil: 'networkidle2' });
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // --- Schritt 0: Videoqualität auf 1080p stellen ---
                    try {
                        await page.waitForSelector('button[aria-label*="Einstellungen"],button[aria-label*="Settings"]', {timeout: 10000});
                        const settingsBtn = await page.$('button[aria-label*="Einstellungen"],button[aria-label*="Settings"]');
                        if (settingsBtn) {
                            await settingsBtn.click();
                            await page.waitForTimeout(1000);
                            // Klicke auf "Qualität"
                            const qualBtn = await page.$x("//div[contains(text(), 'Qualität') or contains(text(), 'Quality')]");
                            if (qualBtn.length > 0) {
                                await qualBtn[0].click();
                                await page.waitForTimeout(1000);
                                // Wähle 1080p (oder höchste verfügbare)
                                const p1080Btn = await page.$x("//div[contains(text(), '1080p')]");
                                if (p1080Btn.length > 0) {
                                    await p1080Btn[0].click();
                                    await page.waitForTimeout(1000);
                                    logger.info('1080p Qualität ausgewählt.');
                                } else {
                                    logger.warn('1080p nicht verfügbar, höchste verfügbare Qualität wird verwendet.');
                                }
                            } else {
                                logger.warn('Qualitätsmenü nicht gefunden.');
                            }
                        } else {
                            logger.warn('Einstellungen-Button (Zahnrad) nicht gefunden.');
                        }
                    } catch (e) {
                        logger.warn('Fehler beim Setzen der Videoqualität: ' + e.message);
                    }

                    // --- Schritt 1: Teilen-Button robust suchen und klicken ---
                    let shareBtn = null;
                    const shareSelectors = [
                        'button[data-a-target="share-button"]',
                        'button[aria-label="Teilen"]',
                        'button:has(svg[data-test-selector="share-icon"])',
                        'button:has-text("Teilen")',
                    ];
                    for (const selector of shareSelectors) {
                        try {
                            shareBtn = await page.$(selector);
                            if (shareBtn) break;
                        } catch {}
                    }
                    if (!shareBtn) {
                        const allButtons = await page.$$('button');
                        for (const btn of allButtons) {
                            const text = await (await btn.getProperty('innerText')).jsonValue();
                            if (text && text.trim().toLowerCase().includes('teilen')) {
                                shareBtn = btn;
                                break;
                            }
                        }
                    }
                    if (!shareBtn) {
                        logger.error('Teilen-Button nicht gefunden!');
                        continue;
                    }
                    await shareBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 5000));

                    // --- Schritt 2: TikTok Button robust suchen und klicken ---
                    let tiktokBtn = null;
                    const tiktokSelectors = [
                        'button[data-a-target="share-to-tiktok"]',
                        'button:has-text("TikTok")',
                    ];
                    for (const selector of tiktokSelectors) {
                        try {
                            tiktokBtn = await page.$(selector);
                            if (tiktokBtn) break;
                        } catch {}
                    }
                    if (!tiktokBtn) {
                        const allButtons = await page.$$('button');
                        for (const btn of allButtons) {
                            const text = await (await btn.getProperty('innerText')).jsonValue();
                            if (text && text.trim().toLowerCase().includes('tiktok')) {
                                tiktokBtn = btn;
                                break;
                            }
                        }
                    }
                    if (!tiktokBtn) {
                        logger.error('TikTok-Button nicht gefunden!');
                        continue;
                    }
                    await tiktokBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    // Extra warten, damit das TikTok-Upload-Menü und die Checkbox wirklich geladen sind
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // --- Schritt 3: Kommentare erlauben Checkbox maximal robust suchen und anhaken ---
                    await page.waitForTimeout(1000); // 1 Sekunde warten, damit alles geladen ist
                    let kommentareCheckbox = null;
                    let checked = false;
                    const tryActivateCheckbox = async () => {
                        const checkboxes = await page.$$('input[type="checkbox"]');
                        for (const checkbox of checkboxes) {
                            // Prüfe Eltern-Element
                            let labelText = '';
                            let parent = null;
                            try { parent = await checkbox.getProperty('parentNode'); } catch {}
                            if (parent) {
                                try { labelText += await (await parent.getProperty('innerText')).jsonValue() || ''; } catch {}
                            }
                            // Prüfe vorheriges Geschwister-Element
                            let prev = null;
                            try { prev = await page.evaluateHandle(el => el.previousElementSibling, checkbox); } catch {}
                            if (prev) {
                                try {
                                    const prevText = await (await prev.getProperty('innerText')).jsonValue();
                                    if (prevText) labelText += ' ' + prevText;
                                } catch {}
                            }
                            // Prüfe nächstes Geschwister-Element
                            let sibling = null;
                            try { sibling = await page.evaluateHandle(el => el.nextElementSibling, checkbox); } catch {}
                            if (sibling) {
                                try {
                                    const siblingText = await (await sibling.getProperty('innerText')).jsonValue();
                                    if (siblingText) labelText += ' ' + siblingText;
                                } catch {}
                            }
                            // Prüfe aria-label und title
                            try {
                                const aria = await (await checkbox.getProperty('ariaLabel')).jsonValue();
                                if (aria) labelText += ' ' + aria;
                            } catch {}
                            try {
                                const title = await (await checkbox.getProperty('title')).jsonValue();
                                if (title) labelText += ' ' + title;
                            } catch {}
                            if (labelText && labelText.toLowerCase().includes('kommentare erlauben')) {
                                kommentareCheckbox = checkbox;
                                break;
                            }
                        }
                        if (kommentareCheckbox) {
                            checked = await (await kommentareCheckbox.getProperty('checked')).jsonValue();
                            if (!checked) {
                                await kommentareCheckbox.click();
                                await new Promise(resolve => setTimeout(resolve, 500));
                                checked = await (await kommentareCheckbox.getProperty('checked')).jsonValue();
                                if (!checked) {
                                    await kommentareCheckbox.click();
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                }
                            }
                            checked = await (await kommentareCheckbox.getProperty('checked')).jsonValue();
                        }
                        return checked;
                    };

                    // Erster Versuch
                    let success = await tryActivateCheckbox();
                    if (!success) {
                        logger.warn('Konnte "Kommentare erlauben" Checkbox nicht aktivieren! Versuche alternative Methode...');
                        await page.waitForTimeout(2000);
                        // Alternative Methode: Suche nach Label/Span/Div mit passendem Text und Checkbox in der Nähe
                        const labelHandles = await page.$x("//*[contains(text(), 'Kommentare erlauben') or contains(text(), 'kommentare erlauben')]");
                        for (const label of labelHandles) {
                            // Suche nach Checkbox im selben Parent
                            const parent = await label.getProperty('parentNode');
                            if (parent) {
                                const checkboxes = await page.evaluateHandle(el => Array.from(el.querySelectorAll('input[type=\'checkbox\']')), parent);
                                const checkboxList = await checkboxes.getProperties();
                                for (const cb of checkboxList.values()) {
                                    try {
                                        await cb.click();
                                        await new Promise(resolve => setTimeout(resolve, 500));
                                        const checked = await (await cb.getProperty('checked')).jsonValue();
                                        if (checked) {
                                            logger.info('"Kommentare erlauben" Checkbox aktiviert (Alternativmethode).');
                                            success = true;
                                            break;
                                        }
                                    } catch {}
                                }
                            }
                            if (success) break;
                        }
                        // Fallback: Versuche per JS zu setzen
                        if (!success) {
                            await page.evaluate(() => {
                                const all = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                                for (const cb of all) {
                                    let labelText = '';
                                    if (cb.parentNode && cb.parentNode.innerText) labelText += cb.parentNode.innerText;
                                    if (cb.nextElementSibling && cb.nextElementSibling.innerText) labelText += ' ' + cb.nextElementSibling.innerText;
                                    if (cb.previousElementSibling && cb.previousElementSibling.innerText) labelText += ' ' + cb.previousElementSibling.innerText;
                                    if (labelText.toLowerCase().includes('kommentare erlauben')) {
                                        if (!cb.checked) cb.click();
                                    }
                                }
                            });
                            await page.waitForTimeout(500);
                            // Prüfe erneut
                            kommentareCheckbox = null;
                            checked = false;
                            const checkboxes = await page.$$('input[type="checkbox"]');
                            for (const checkbox of checkboxes) {
                                let labelText = '';
                                let parent = null;
                                try { parent = await checkbox.getProperty('parentNode'); } catch {}
                                if (parent) {
                                    try { labelText += await (await parent.getProperty('innerText')).jsonValue() || ''; } catch {}
                                }
                                let prev = null;
                                try { prev = await page.evaluateHandle(el => el.previousElementSibling, checkbox); } catch {}
                                if (prev) {
                                    try {
                                        const prevText = await (await prev.getProperty('innerText')).jsonValue();
                                        if (prevText) labelText += ' ' + prevText;
                                    } catch {}
                                }
                                let sibling = null;
                                try { sibling = await page.evaluateHandle(el => el.nextElementSibling, checkbox); } catch {}
                                if (sibling) {
                                    try {
                                        const siblingText = await (await sibling.getProperty('innerText')).jsonValue();
                                        if (siblingText) labelText += ' ' + siblingText;
                                    } catch {}
                                }
                                try {
                                    const aria = await (await checkbox.getProperty('ariaLabel')).jsonValue();
                                    if (aria) labelText += ' ' + aria;
                                } catch {}
                                try {
                                    const title = await (await checkbox.getProperty('title')).jsonValue();
                                    if (title) labelText += ' ' + title;
                                } catch {}
                                if (labelText && labelText.toLowerCase().includes('kommentare erlauben')) {
                                    checked = await (await checkbox.getProperty('checked')).jsonValue();
                                    if (checked) {
                                        logger.info('"Kommentare erlauben" Checkbox aktiviert (JS-Fallback).');
                                        success = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (success) {
                        logger.info('"Kommentare erlauben" Checkbox aktiviert.');
                    } else {
                        logger.warn('Konnte "Kommentare erlauben" Checkbox nicht aktivieren!');
                    }

                    // --- Schritt 4: Auf TikTok posten Button robust suchen und klicken ---
                    let postBtn = null;
                    const postSelectors = [
                        'button[data-a-target="post-to-tiktok"]',
                        'button:has-text("Auf TikTok posten")',
                    ];
                    for (const selector of postSelectors) {
                        try {
                            postBtn = await page.$(selector);
                            if (postBtn) break;
                        } catch {}
                    }
                    if (!postBtn) {
                        const allButtons = await page.$$('button');
                        for (const btn of allButtons) {
                            const text = await (await btn.getProperty('innerText')).jsonValue();
                            if (text && text.trim().toLowerCase().includes('auf tiktok posten')) {
                                postBtn = btn;
                                break;
                            }
                        }
                    }
                    if (!postBtn) {
                        logger.error('"Auf TikTok posten"-Button nicht gefunden!');
                        continue;
                    }
                    await postBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 15000)); // 15 Sekunden warten

                    // Prüfe auf Upload-Limit-Fehlermeldung
                    let limitError = false;
                    // Liste möglicher Fehlermeldungen (deutsch & englisch)
                    const limitTexts = [
                        'maximale Anzahl an Uploads',
                        'Upload-Limit',
                        'Du hast das tägliche Upload-Limit erreicht',
                        'zu viele Videos',
                        'maximum number of uploads',
                        'upload limit',
                        'too many videos',
                    ];
                    try {
                        // Warte auf ein Element, das einen der Texte enthält
                        await page.waitForFunction((texts) => {
                            const bodyText = document.body.innerText.toLowerCase();
                            return texts.some(t => bodyText.includes(t.toLowerCase()));
                        }, {timeout: 8000}, limitTexts);
                        limitError = true;
                    } catch {}

                    // EXAKTE PRÜFUNG auf den bekannten Sperrtext, bevor zum nächsten Clip gegangen wird
                    const exactLimitText = 'Du hast die maximale Anzahl an Uploads erreicht, die TikTok erlaubt. Bitte versuche es später erneut.';
                    let exactLimitFound = false;
                    try {
                        exactLimitFound = await page.evaluate((text) => {
                            return document.body.innerText.includes(text);
                        }, exactLimitText);
                    } catch {}
                    if (exactLimitFound) {
                        logger.warn('TikTok Upload-Limit (exakter Text) erkannt! Das Tool pausiert jetzt für 12 Stunden.');
                        setUploadLimitTimestamp();
                        break;
                    }

                    if (limitError) {
                        logger.warn(`TikTok Upload-Limit erkannt! Es wurden ${newClipsCount} Videos erfolgreich gepostet. Pausiere für 12 Stunden.`);
                        setUploadLimitTimestamp();
                        logger.warn('Das Tool pausiert jetzt für 12 Stunden wegen TikTok-Limit.');
                        break;
                    } else {
                        logger.info(`TikTok-Upload erfolgreich. Bisherige Uploads in dieser Session: ${newClipsCount}`);
                        processedClips.add(normalizedLink);
                        uploadedClips.add(normalizedLink);
                        saveUploadedClips(uploadedClips);

                        // Add delay between posts
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                } catch (error) {
                    logger.error(`Error processing clip ${link}: ${error.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
            if (!foundNew) {
                logger.info(`[Scan Modus] Keine neuen Clips für ${username} gefunden, warte auf nächste Runde... [${sortLabel}]`);
            } else {
                logger.info(`[Scan Modus] ${newClipsCount} neue Clips für ${username} verarbeitet. [${sortLabel}]`);
            }
        }

        // 1. Neueste zuerst
        await processClipsForSort('time', 'Neueste');
        // 2. Populärste
        await processClipsForSort('views', 'Populärste');
        // 3. Älteste
        await processClipsForSort('all', 'Älteste');

    } catch (error) {
        logger.error(`Error processing streamer ${username}: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Funktion: Ping an eine URL senden, um Replit wach zu halten
function sendPing() {
    const url = process.env.PING_URL;
    if (!url) return;
    try {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, res => {
            logger.info(`Ping gesendet an ${url} (Status: ${res.statusCode})`);
        }).on('error', err => {
            logger.warn(`Ping an ${url} fehlgeschlagen: ${err.message}`);
        });
    } catch (e) {
        logger.warn(`Ping-Fehler: ${e.message}`);
    }
}

// Verbesserter Scan-Loop mit Logging und Fehlerbehandlung
async function scanLoop() {
    const scanInterval = 5 * 60 * 1000; // 5 Minuten
    let lastPing = 0;
    const pingInterval = 10 * 60 * 1000; // alle 10 Minuten
    while (true) {
        // Ping senden, falls Intervall erreicht
        if (process.env.PING_URL) {
            const now = Date.now();
            if (now - lastPing > pingInterval) {
                sendPing();
                lastPing = now;
            }
        }
        // Prüfe, ob Upload-Limit aktiv ist
        const limitStatus = await handleUploadLimitPause();
        if (limitStatus === 'try12h' || limitStatus === 'try24h') {
            // Nach Pause: versuche zu posten, wenn immer noch Limit, pausiere erneut
            logger.info('Versuche nach Upload-Limit erneut zu posten...');
        }
        // <--- HIER: uploadedClips neu laden
        uploadedClips = loadUploadedClips();
        for (const username of process.env.TWITCH_STREAMER_USERNAMES.split(',')) {
            try {
                await processStreamer(username.trim());
            } catch (e) {
                logger.error(`Fehler bei Streamer ${username}: ${e.message}`);
            }
        }
        logger.info(`[Scan Modus] Alle Streamer abgearbeitet. Nächster Scan in 5 Minuten um ${new Date(Date.now() + scanInterval).toLocaleTimeString()}`);
        await new Promise(resolve => setTimeout(resolve, scanInterval));
    }
}

// Main loop
scanLoop().catch(error => {
    logger.error(`Fatal error in scan loop: ${error.message}`);
    process.exit(1);
});

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Webserver läuft auf Port ${PORT}`);
}); 