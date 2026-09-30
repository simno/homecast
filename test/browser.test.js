// The headless-browser fallback (lib/browser.js): what it catches of the
// requests a page's JavaScript makes, against a local site with a page for
// each kind of player. Skipped when Playwright's Chromium isn't installed.
process.env.DISABLE_SSRF_PROTECTION = 'true'; // the site lives on 127.0.0.1; security.test.js covers the guard

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const { chromium } = require('playwright');
const { extractWithBrowser, closeBrowser } = require('../lib/browser');

const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n';
const page = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

let base;
let haveBrowser = false;
const requests = [];

const site = http.createServer((req, res) => {
    requests.push(req.url);
    const html = (body) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page(body));
    };
    const playlist = () => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(PLAYLIST);
    };
    switch (req.url) {
        // The player asks for its playlist a moment after the page loads.
        case '/js-player':
            return html('<script>setTimeout(() => fetch("/live/master.m3u8"), 300)</script>');
        case '/live/master.m3u8':
        case '/good.m3u8':
        case '/clicked.m3u8':
            return playlist();
        // A URL that says nothing: only the answer's Content-Type gives it away.
        case '/api-player':
            return html('<script>fetch("/api/stream?id=42")</script>');
        case '/api/stream?id=42':
            return playlist();
        // A dead mirror first, then one that works.
        case '/mirrors':
            return html('<script>fetch("/dead.m3u8").catch(() => {}); setTimeout(() => fetch("/good.m3u8"), 500)</script>');
        case '/dead.m3u8':
            res.writeHead(403);
            return res.end();
        // Nothing plays until the big play button is pressed.
        case '/click-to-play':
            return html('<div class="vjs-big-play-button" style="width:120px;height:80px;background:#000" ' +
                'onclick="fetch(\'/clicked.m3u8\')"></div>');
        // The player is in an iframe.
        case '/embed-page':
            return html('<iframe src="/js-player" width="640" height="360"></iframe><img src="/poster.jpg">');
        case '/poster.jpg':
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            return res.end(Buffer.alloc(10));
        case '/nothing':
            return html('<p>No video here.</p>');
        default:
            res.writeHead(404);
            return res.end();
    }
});

before(async () => {
    try {
        await (await chromium.launch()).close();
        haveBrowser = true;
    } catch {
        return;
    }
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
    await closeBrowser();
    site.close();
});

const needBrowser = (t) => {
    if (!haveBrowser) t.skip('Playwright Chromium not installed');
    return !haveBrowser;
};

test('a playlist the page\'s JavaScript fetches after load is caught', async (t) => {
    if (needBrowser(t)) return;
    const found = await extractWithBrowser(`${base}/js-player`);
    assert.deepStrictEqual(found.map(f => [f.url, f.type, f.source]), [[`${base}/live/master.m3u8`, 'hls', 'network']]);
    assert.strictEqual(found[0].referer, `${base}/js-player`);
});

test('a stream behind a URL with no extension is caught by its Content-Type', async (t) => {
    if (needBrowser(t)) return;
    const found = await extractWithBrowser(`${base}/api-player`);
    assert.deepStrictEqual(found.map(f => [f.url, f.type]), [[`${base}/api/stream?id=42`, 'hls']]);
});

test('a mirror the server refused is left out, and the watch goes on to one that works', async (t) => {
    if (needBrowser(t)) return;
    const found = await extractWithBrowser(`${base}/mirrors`);
    assert.deepStrictEqual(found.map(f => f.url), [`${base}/good.m3u8`]);
});

test('a player that waits for its play button is clicked', async (t) => {
    if (needBrowser(t)) return;
    const found = await extractWithBrowser(`${base}/click-to-play`);
    assert.deepStrictEqual(found.map(f => f.url), [`${base}/clicked.m3u8`]);
});

test('a player in an iframe is caught with the iframe as its referer, and images aren\'t fetched', async (t) => {
    if (needBrowser(t)) return;
    requests.length = 0;
    const found = await extractWithBrowser(`${base}/embed-page`);
    assert.deepStrictEqual(found.map(f => [f.url, f.referer]), [[`${base}/live/master.m3u8`, `${base}/js-player`]]);
    assert.ok(!requests.includes('/poster.jpg'), 'images are skipped');
});

test('a page with no stream gives null', async (t) => {
    if (needBrowser(t)) return;
    assert.strictEqual(await extractWithBrowser(`${base}/nothing`), null);
});

test('a cancelled search stops at once', async (t) => {
    if (needBrowser(t)) return;
    const controller = new AbortController();
    const started = Date.now();
    const search = extractWithBrowser(`${base}/nothing`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    assert.strictEqual(await search, null);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
});

test('searches run one at a time, and each gets its own answer', async (t) => {
    if (needBrowser(t)) return;
    const [a, b] = await Promise.all([extractWithBrowser(`${base}/js-player`), extractWithBrowser(`${base}/api-player`)]);
    assert.deepStrictEqual(a.map(f => f.url), [`${base}/live/master.m3u8`]);
    assert.deepStrictEqual(b.map(f => f.url), [`${base}/api/stream?id=42`]);
});
