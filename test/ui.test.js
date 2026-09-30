// The dashboard in a real browser (Playwright's Chromium), against the fully
// wired app and the mock Chromecast: picking a device, analysing a URL,
// casting, the dashboard, stopping, pages handed over with ?url=, and the
// help dialog. Skipped when Playwright's Chromium isn't installed
// (npx playwright install chromium).
process.env.NODE_ENV = 'development';        // lets cast.js use the mock client
process.env.DISABLE_SSRF_PROTECTION = 'true'; // fixtures live on 127.0.0.1

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');
const { chromium } = require('playwright');

const MOCK_IP = '127.0.0.1';
const MP4 = Buffer.alloc(256 * 1024, 1);

let server;
let devices;
let activeSessions;
let stopCasting;
let base;
let cdn;
let browser;
let page;
let pageErrors;
let deviceListener;

// A site with a video page and the video itself.
const upstream = http.createServer((req, res) => {
    if (req.url === '/watch') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<html><head><title>Test Show</title></head><body><video src="${cdn}/v.mp4"></video></body></html>`);
    }
    if (req.url === '/watch-2') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<html><head><title>Second Show</title></head><body><video src="${cdn}/v.mp4?n=2"></video></body></html>`);
    }
    if (req.url.startsWith('/v.mp4')) {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
        return res.end(MP4);
    }
    res.writeHead(404);
    res.end();
});

const listen = (s) => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));

before(async () => {
    try {
        browser = await chromium.launch();
    } catch (err) {
        console.log(`[UI] Skipping: ${err.message.split('\n')[0]}`);
        return;
    }
    await listen(upstream);
    cdn = `http://127.0.0.1:${upstream.address().port}`;
    // Stands in for the device's cast port in the reachability check.
    deviceListener = net.createServer(sock => sock.destroy());
    await listen(deviceListener);

    // The mock receiver fetches proxied media from http://<LAN IP>:<PORT>.
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, resolve));
    process.env.PORT = String(probe.address().port);
    await new Promise(resolve => probe.close(resolve));

    ({ server } = require('../server'));
    ({ devices, activeSessions } = require('../lib/state'));
    ({ stopCasting } = require('../lib/cast'));
    await new Promise(resolve => server.listen(Number(process.env.PORT), '0.0.0.0', resolve));
    base = `http://127.0.0.1:${process.env.PORT}`;
    devices.set(MOCK_IP, {
        name: 'Mock Chromecast (UI)', ip: MOCK_IP, host: 'localhost', id: 'mock-ui',
        type: 'chromecast', isMock: true, port: deviceListener.address().port
    });
});

// Each test's first step: without a browser there's nothing to test.
const needBrowser = (t) => {
    if (!browser) t.skip('Playwright Chromium not installed');
    return !browser;
};

async function openPage(path = '/') {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    page.on('console', msg => {
        if (msg.type() === 'error') pageErrors.push(msg.text());
    });
    await page.goto(`${base}${path}`);
    return page;
}

afterEach(async () => {
    if (!browser) return;
    // Directly: the page's CSRF protection stays on in these tests.
    for (const ip of [...activeSessions.keys()]) await stopCasting(ip);
    await page?.context().close();
    page = null;
});

after(async () => {
    if (!browser) return;
    await browser.close();
    server.closeAllConnections();
    server.close();
    upstream.close();
    deviceListener.close();
});

async function pickMockDevice() {
    await page.click('#device-picker-btn');
    await page.click('#device-list [role="option"]:has-text("Mock Chromecast (UI)")');
    assert.match(await page.textContent('#device-picker-btn'), /Mock Chromecast \(UI\)/);
}

async function analyze(url) {
    await page.fill('#video-url', url);
    await page.press('#video-url', 'Enter');
    await page.waitForSelector('.stream-option');
}

test('the page loads without errors and lists the device', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    assert.strictEqual(await page.getAttribute('#app', 'data-mode'), 'setup');
    await page.click('#device-picker-btn');
    await page.waitForSelector('#device-list [role="option"]:has-text("Mock Chromecast (UI)")');
    assert.deepStrictEqual(pageErrors, []);
});

test('analysing a page finds its video, and casting it opens the dashboard', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    await pickMockDevice();
    await analyze(`${cdn}/watch`);
    assert.match(await page.textContent('.stream-option-url'), /v\.mp4/);
    assert.strictEqual(await page.isEnabled('#cast-btn'), true);

    await page.click('#cast-btn');
    await page.waitForSelector('#app[data-mode="dashboard"]');
    await page.waitForSelector('.stream-pill:has-text("Mock Chromecast (UI)")');
    assert.ok(activeSessions.has(MOCK_IP));

    // Stop asks for a second click.
    await page.click('#stop-btn');
    assert.match(await page.textContent('#stop-btn'), /Confirm/);
    await page.click('#stop-btn');
    await page.waitForSelector('#app[data-mode="setup"]');
    assert.ok(!activeSessions.has(MOCK_IP));
    assert.deepStrictEqual(pageErrors, []);
});

test('a page opened with ?url= analyses that URL and cleans the address', async (t) => {
    if (needBrowser(t)) return;
    await openPage(`/?url=${encodeURIComponent(`${cdn}/watch`)}`);
    await page.waitForSelector('.stream-option');
    assert.strictEqual(await page.inputValue('#video-url'), `${cdn}/watch`);
    assert.strictEqual(new URL(page.url()).search, '');
    assert.deepStrictEqual(pageErrors, []);
});

test('a share that puts the link in its text is analysed too', async (t) => {
    if (needBrowser(t)) return;
    await openPage(`/?title=Test&text=${encodeURIComponent(`Watch this ${cdn}/watch now`)}`);
    await page.waitForSelector('.stream-option');
    assert.strictEqual(await page.inputValue('#video-url'), `${cdn}/watch`);
});

test('a page handed over while a stream plays opens the compose overlay', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    await pickMockDevice();
    await analyze(`${cdn}/watch`);
    await page.click('#cast-btn');
    await page.waitForSelector('#app[data-mode="dashboard"]');

    await page.goto(`${base}/?url=${encodeURIComponent(`${cdn}/watch`)}`);
    await page.waitForSelector('#app[data-mode="dashboard"]');
    await page.waitForSelector('#compose-overlay:not(.hidden)');
    await page.waitForSelector('.stream-option');
    assert.strictEqual(await page.inputValue('#video-url'), `${cdn}/watch`);
});

test('the help dialog offers a bookmarklet for this server', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    await page.click('#help-btn');
    await page.waitForSelector('#help-modal:not(.hidden)');
    const href = await page.getAttribute('#bookmarklet', 'href');
    assert.ok(href.startsWith('javascript:'));
    assert.ok(href.includes(JSON.stringify(`${base}/?url=`)), href);
    assert.strictEqual(await page.textContent('#share-link-format'), `${base}/?url=…`);

    // It can be copied instead of dragged; the browser's clipboard holds it.
    assert.match(await page.textContent('#bookmarks-bar-keys'), /Ctrl\+Shift\+B|\u2318\u21e7B/);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#bookmarklet-copy');
    await page.waitForSelector('#bookmarklet-copied:not(.hidden)');
    assert.match(await page.textContent('#bookmarklet-copied'), /^Copied/);
    assert.strictEqual(await page.evaluate('navigator.clipboard.readText()'), decodeURIComponent(href));

    // Clicking it here does nothing; Escape closes the dialog.
    await page.click('#bookmarklet');
    assert.strictEqual(new URL(page.url()).pathname, '/');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#help-modal.hidden', { state: 'attached' });
    assert.deepStrictEqual(pageErrors, []);
});

test('the bookmarklet opens HomeCast with the page it was clicked on', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    const href = await page.getAttribute('#bookmarklet', 'href');
    const site = await page.context().newPage();
    await site.goto(`${cdn}/watch`);
    const [opened] = await Promise.all([
        page.context().waitForEvent('page'),
        site.evaluate(decodeURIComponent(href.slice('javascript:'.length)))
    ]);
    await opened.waitForSelector('.stream-option');
    assert.strictEqual(await opened.inputValue('#video-url'), `${cdn}/watch`);
});

test('a queued video is listed, can be removed, and plays on Play next now', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    await pickMockDevice();
    await analyze(`${cdn}/watch`);
    await page.click('#cast-btn');
    await page.waitForSelector('#app[data-mode="dashboard"]');
    assert.match(await page.textContent('#queue-note'), /Nothing queued/);

    const addSecondShow = async () => {
        await page.click('#queue-add-btn');
        await page.waitForSelector('#compose-overlay:not(.hidden)');
        // It's for the playing device, so there's no picker, and the button queues.
        assert.strictEqual(await page.textContent('#compose-title'), 'Queue a video');
        assert.strictEqual(await page.textContent('#compose-subtitle'), 'Plays on Mock Chromecast (UI) after the current video.');
        assert.strictEqual(await page.isVisible('#device-picker-btn'), false);
        assert.strictEqual((await page.textContent('#cast-btn-label')).trim(), 'Add to queue');
        await analyze(`${cdn}/watch-2`);
        await page.click('#cast-btn');
        await page.waitForSelector('#compose-overlay.hidden', { state: 'attached' });
        await page.waitForSelector('#queue-list li');
    };

    // The × closes the form without queueing anything, and a new stream's form
    // is the ordinary one again.
    await page.click('#queue-add-btn');
    await page.click('#compose-close-btn');
    await page.waitForSelector('#compose-overlay.hidden', { state: 'attached' });
    await page.click('#add-stream-btn');
    assert.strictEqual(await page.textContent('#compose-title'), 'Stream a video to your TV');
    assert.strictEqual(await page.isVisible('#device-picker-btn'), true);
    assert.strictEqual((await page.textContent('#cast-btn-label')).trim(), 'Start Casting');
    await page.click('#compose-close-btn');
    await page.waitForSelector('#compose-overlay.hidden', { state: 'attached' });

    await addSecondShow();
    assert.match(await page.textContent('#queue-list li'), /Second Show/);
    assert.strictEqual(await page.isVisible('#queue-next-btn'), true);

    await page.click('#queue-list .recent-remove');
    await page.waitForSelector('#queue-list li', { state: 'detached' });
    assert.match(await page.textContent('#queue-note'), /Nothing queued/);

    await addSecondShow();
    await page.click('#queue-next-btn');
    await page.waitForSelector('#queue-list li', { state: 'detached' });
    // Cast through the proxy, so the video is the proxy URL's `url`.
    const playing = () => {
        const contentId = activeSessions.get(MOCK_IP)?.player.mockDevice?.media?.contentId;
        return contentId && new URL(contentId).searchParams.get('url');
    };
    for (let i = 0; i < 100 && playing() !== `${cdn}/v.mp4?n=2`; i++) await page.waitForTimeout(50);
    assert.strictEqual(playing(), `${cdn}/v.mp4?n=2`);
    await page.waitForSelector('#app[data-mode="dashboard"]');
    assert.deepStrictEqual(pageErrors, []);
});

test('the bookmarklet can be copied on a plain http:// LAN address too', async (t) => {
    if (needBrowser(t)) return;
    const lanIp = require('../lib/utils').getLocalIp();
    if (lanIp === '127.0.0.1') return t.skip('no LAN address');
    // Not a secure context, so there's no clipboard API: the fallback copies.
    await openPage();
    await page.goto(`http://${lanIp}:${process.env.PORT}/`);
    assert.strictEqual(await page.evaluate('window.isSecureContext'), false);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.click('#help-btn');
    await page.click('#bookmarklet-copy');
    await page.waitForSelector('#bookmarklet-copied:not(.hidden)');
    assert.match(await page.textContent('#bookmarklet-copied'), /^Copied/);

    // Read back from a secure page in the same browser.
    const reader = await page.context().newPage();
    await reader.goto(base);
    const copied = await reader.evaluate('navigator.clipboard.readText()');
    assert.ok(copied.startsWith(`javascript:(()=>{window.open("http://${lanIp}:${process.env.PORT}/?url="`), copied);
});

test('the volume slider sets the device volume, and says when the device ignores it', async (t) => {
    if (needBrowser(t)) return;
    await openPage();
    await pickMockDevice();
    await analyze(`${cdn}/watch`);
    await page.click('#cast-btn');
    await page.waitForSelector('#app[data-mode="dashboard"]');
    // Usable straight away: the cast's answer carried the volume.
    assert.strictEqual(await page.isEnabled('#volume-slider'), true);
    const client = () => activeSessions.get(MOCK_IP).client;

    const setSlider = (value) => page.fill('#volume-slider', String(value));
    await setSlider(30);
    for (let i = 0; i < 40 && client().volume.level !== 0.3; i++) await page.waitForTimeout(50);
    assert.strictEqual(client().volume.level, 0.3);

    // A device whose TV owns the volume: the slider goes back, and the page says why.
    client().ignoresLevel = true;
    await setSlider(80);
    await page.waitForSelector('#dashboard-notice:not(.hidden)', { timeout: 5000 });
    assert.match(await page.textContent('#dashboard-notice-text'), /TV remote/);
    assert.strictEqual(await page.inputValue('#volume-slider'), '30');

    // One that says outright its volume is fixed: no slider, a note instead.
    client().volume = { ...client().volume, controlType: 'fixed' };
    client().emit('status', { volume: client().volume });
    await page.waitForSelector('#volume-slider:disabled');
    assert.strictEqual(await page.textContent('#volume-note'), 'Set the volume with the TV remote');
    assert.strictEqual(await page.isVisible('#volume-note'), true);
    assert.strictEqual(await page.isEnabled('#mute-btn'), true);
    assert.deepStrictEqual(pageErrors, []);
});
