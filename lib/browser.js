/* global document */
const { chromium } = require('playwright');
const { USER_AGENT } = require('./utils');
const { validateProxyUrl } = require('./security');
const scan = require('./media-scan');

// Headless-browser fallback for pages that only reveal their stream once
// their JavaScript runs. Watches every network request the page (and its
// frames) makes, nudges the player to start, and reports what it saw.

const NAVIGATION_TIMEOUT_MS = 15000;
const WATCH_BUDGET_MS = 12000;   // how long to watch after the DOM is ready
const PLAY_NUDGE_AFTER_MS = 1500; // give autoplay a chance before clicking
const GRACE_AFTER_HIT_MS = 1500;  // collect sibling playlists after the first hit
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let browser = null;
let idleTimer = null;
let extractionQueue = Promise.resolve();

async function getBrowser() {
    clearTimeout(idleTimer);
    if (browser && browser.isConnected()) return browser;
    browser = await chromium.launch({ headless: true });
    return browser;
}

async function closeBrowser() {
    clearTimeout(idleTimer);
    if (browser) {
        const b = browser;
        browser = null;
        try { await b.close(); } catch { /* ignore */ }
    }
}

// Chromium holds a few hundred MB; don't keep it around between uses.
function scheduleIdleClose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeBrowser, IDLE_CLOSE_MS);
    idleTimer.unref();
}

// Clean up browser on process exit
process.once('beforeExit', closeBrowser);

// Players and their big play buttons, most specific first. Generic class
// substrings like [class*="play"] are deliberately absent: they match
// "playlist" and "display" and click the page somewhere else entirely.
const PLAY_SELECTORS = [
    '.vjs-big-play-button',
    '.jw-icon-display',
    '.jw-display-icon-container',
    '.plyr__control--overlaid',
    '.fp-play',
    '.mejs__overlay-button',
    '.ytp-large-play-button',
    '.bmpui-ui-hugeplaybacktogglebutton',
    '.shaka-play-button',
    'button[aria-label*="play" i]',
    '[role="button"][aria-label*="play" i]',
    'button:has-text("WATCH")',
    'a:has-text("WATCH")',
    'button:has-text("REWATCH")',
    'a:has-text("REWATCH")',
    '.play-button',
    '.play-btn',
    '#play'
];

async function nudgePlayback(page) {
    for (const frame of page.frames()) {
        // Muted play() is allowed without a user gesture.
        await frame.evaluate(() => {
            document.querySelectorAll('video').forEach((v) => {
                v.muted = true;
                const p = v.play();
                if (p && p.catch) p.catch(() => {});
            });
        }).catch(() => {});
    }

    for (const frame of page.frames()) {
        for (const selector of PLAY_SELECTORS) {
            const btn = frame.locator(selector).first();
            if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
                console.log(`[Browser] Clicking play control ${selector}`);
                await btn.click({ timeout: 2000 }).catch(() => {});
                return true;
            }
        }
    }
    return false;
}

// Media URLs visible in the rendered DOM of every frame.
async function scanFrames(page) {
    const found = [];
    for (const frame of page.frames().slice(0, 8)) {
        const frameUrl = frame.url();
        if (!/^https?:/.test(frameUrl)) continue;
        const srcs = await frame.evaluate(() => {
            const out = [];
            document.querySelectorAll('video').forEach((v) => {
                const s = v.currentSrc || v.src;
                if (s && !s.startsWith('blob:')) out.push(s);
            });
            return out;
        }).catch(() => []);
        srcs.forEach(url => found.push({ url, type: scan.typeFromUrl(url), source: 'video-tag', referer: frameUrl }));

        const html = await frame.content().catch(() => '');
        for (const c of scan.scanDocument(html, frameUrl).candidates) {
            found.push({ ...c, referer: frameUrl });
        }
    }
    return found;
}

// Returns [{ url, type, source, referer }] or null. Extractions run one at a
// time so a burst of requests can't spawn a browser each.
function extractWithBrowser(url, { signal } = {}) {
    const task = extractionQueue.then(() => (signal?.aborted ? null : doExtract(url, signal))).catch((err) => {
        console.log(`[Browser] Extraction failed: ${err.message}`);
        return null;
    });
    extractionQueue = task.then(() => {}, () => {});
    return task;
}

async function doExtract(url, signal) {
    const b = await getBrowser();
    const context = await b.newContext({ userAgent: USER_AGENT, viewport: { width: 1280, height: 720 } });
    const onAbort = () => context.close().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    const captured = new Map();
    // A URL the page asked for is not evidence of a stream unless the answer
    // came back. Players request dead mirrors and refused links too, and the
    // request event fires either way — so without this a playlist the CDN
    // answered 403 gets reported as a found stream, cast, and fails on the TV
    // with nothing to show for it.
    const failed = new Set();
    // A URL that answered once has proved it is a stream; a player that
    // refetches a single-use token and gets refused afterwards must not lose
    // it. Only URLs that never answered are dropped.
    const succeeded = new Set();

    const capture = (mediaUrl, type, referer) => {
        if (!type || captured.has(mediaUrl) || scan.isSegmentUrl(mediaUrl)) return;
        if (!/^https?:/.test(mediaUrl)) return;
        captured.set(mediaUrl, { url: mediaUrl, type, source: 'network', referer: referer || url });
    };

    const noteFailed = (mediaUrl) => {
        if (captured.has(mediaUrl) && !succeeded.has(mediaUrl)) failed.add(mediaUrl);
    };

    // The page runs inside our network: hold it to the same SSRF rules as
    // every other fetch, and skip the bytes that can't contain a stream URL.
    const hostVerdicts = new Map();
    await context.route('**/*', async (route) => {
        const request = route.request();
        const kind = request.resourceType();
        if (kind === 'image' || kind === 'font') return route.abort();
        let host;
        try {
            host = new URL(request.url()).host;
        } catch {
            return route.continue();
        }
        if (!/^https?:/.test(request.url())) return route.continue();
        if (!hostVerdicts.has(host)) {
            hostVerdicts.set(host, validateProxyUrl(request.url()).then(v => v.valid));
        }
        return (await hostVerdicts.get(host)) ? route.continue() : route.abort('blockedbyclient');
    });

    // A request is enough when the URL says what it is; the response's
    // Content-Type catches the ones that don't (/api/stream?id=42).
    context.on('request', (request) => {
        const reqUrl = request.url();
        capture(reqUrl, scan.typeFromUrl(reqUrl), request.headers()['referer']);
    });
    context.on('response', (response) => {
        const reqUrl = response.url();
        if (response.status() >= 400) return noteFailed(reqUrl);
        succeeded.add(reqUrl);
        if (captured.has(reqUrl)) return;
        const type = scan.typeFromMime(response.headers()['content-type']);
        if (type) capture(reqUrl, type, response.request().headers()['referer']);
    });
    // Aborted and never-answered requests are failures too.
    context.on('requestfailed', (request) => noteFailed(request.url()));

    // Only a URL that actually answered counts as a hit, so the watch keeps
    // running for a mirror that works instead of stopping on the dead one.
    const hasHit = () => [...captured.values()].some(c => scan.PLAYABLE_TYPES.has(c.type) && !failed.has(c.url));

    try {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
            .catch(err => console.log(`[Browser] Navigation incomplete: ${err.message}`));

        const started = Date.now();
        let nudged = false;
        let firstHitAt = null;
        while (!signal?.aborted && Date.now() - started < WATCH_BUDGET_MS) {
            if (hasHit()) {
                firstHitAt ??= Date.now();
                if (Date.now() - firstHitAt >= GRACE_AFTER_HIT_MS) break;
            } else if (!nudged && Date.now() - started >= PLAY_NUDGE_AFTER_MS) {
                nudged = true;
                await nudgePlayback(page);
            }
            await page.waitForTimeout(250).catch(() => {});
        }

        if (!signal?.aborted) {
            for (const c of await scanFrames(page)) {
                if (!captured.has(c.url) && c.type) captured.set(c.url, c);
            }
        }
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await context.close().catch(() => {});
        scheduleIdleClose();
    }

    const results = [...captured.values()].filter(c => !failed.has(c.url));
    console.log(`[Browser] Captured ${results.length} media URL(s) from ${url}`);
    return results.length > 0 ? results : null;
}

module.exports = { extractWithBrowser, closeBrowser };
