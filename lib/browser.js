/* global document */
const { chromium } = require('playwright');
const { extractVideoFromHtml } = require('./extraction');
const { USER_AGENT } = require('./utils');

let browser = null;
let extractionQueue = Promise.resolve();

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    browser = await chromium.launch({ headless: true });
    return browser;
}

async function closeBrowser() {
    if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
        browser = null;
    }
}

// Clean up browser on process exit
process.once('SIGTERM', closeBrowser);
process.once('SIGINT', closeBrowser);
process.once('beforeExit', closeBrowser);

const VIDEO_PATTERN = /\.(m3u8|mp4|webm|mkv)(\?|$)/i;

function isVideoUrl(u) {
    return VIDEO_PATTERN.test(u) || /\/hls\//i.test(u) || /\/stream/i.test(u);
}

function dedupPlaylists(urls) {
    const arr = [...urls];
    const m3u8Groups = new Map();

    for (const u of arr) {
        if (!u.includes('.m3u8')) continue;
        const m = u.match(/\/hls\/([^/]+)/);
        if (!m) continue;
        const streamId = m[1];
        if (!m3u8Groups.has(streamId)) m3u8Groups.set(streamId, []);
        m3u8Groups.get(streamId).push(u);
    }

    const toRemove = new Set();
    for (const [, groupUrls] of m3u8Groups) {
        const masters = groupUrls.filter((u) => u.includes('master'));
        if (masters.length > 0) {
            // Keep the master, remove variants from same stream
            for (const u of groupUrls) {
                if (!u.includes('master')) toRemove.add(u);
            }
        }
    }

    return arr.filter((u) => !toRemove.has(u));
}

async function clickWatchButtons(page) {
    const selectors = [
        'a:has-text("WATCH")',
        'a:has-text("REWATCH")',
        'button:has-text("WATCH")',
        'button:has-text("REWATCH")',
        '[role="button"]:has-text("WATCH")',
        '[role="button"]:has-text("REWATCH")',
        '[class*="watch"]',
        '[class*="play"]'
    ];

    for (const selector of selectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
                console.log(`[Browser] Clicking "${await btn.textContent({ timeout: 500 }).catch(() => '')}" via ${selector}`);
                await btn.click({ timeout: 3000 });
                return true;
            }
        } catch {
            // selector didn't match or click failed, try next
        }
    }
    return false;
}

async function extractWithBrowser(url) {
    // Serialize browser extractions to avoid resource exhaustion
    const task = extractionQueue.then(() => doExtract(url)).catch(() => null);
    extractionQueue = task.catch(() => {});
    return task;
}

async function doExtract(url) {
    const browser = await getBrowser();
    const context = await browser.newContext({
        userAgent: USER_AGENT
    });

    const page = await context.newPage();
    const videoUrls = new Set();

    page.on('response', (response) => {
        const resUrl = response.url();
        if (/\.(m3u8|mp4)(\?|$)/i.test(resUrl)) {
            videoUrls.add(resUrl);
        }
    });

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

        const html = await page.content();
        const htmlVideo = extractVideoFromHtml(html);
        if (htmlVideo) videoUrls.add(htmlVideo);

        // Try clicking a WATCH/play button to reveal hidden video players
        const clicked = await clickWatchButtons(page);
        if (clicked) {
            // Wait for the video overlay/player to load and start fetching video
            await page.waitForTimeout(5000);
            // Let any network requests settle
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        }

        // Scan DOM for video elements (now includes any revealed overlays)
        const domVideos = await page.evaluate(() => {
            const found = [];
            document.querySelectorAll('video source, video[src]').forEach((el) => {
                const src = el.src || el.getAttribute('src');
                if (src && !src.startsWith('blob:')) found.push(src);
            });
            document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach((el) => {
                const c = el.getAttribute('content');
                if (c) found.push(c);
            });
            return found;
        });

        domVideos.forEach((v) => {
            if (isVideoUrl(v)) videoUrls.add(v);
        });
    } catch (err) {
        console.log(`[Browser] Page load failed: ${err.message}`);
    } finally {
        await context.close();
    }

    if (videoUrls.size === 0) return null;

    const deduped = dedupPlaylists(videoUrls);

    const results = [];
    for (const videoUrl of deduped) {
        if (!videoUrl.startsWith('http')) continue;
        results.push({ url: videoUrl, referer: url });
    }

    return results.length > 0 ? results : null;
}

module.exports = { extractWithBrowser };
