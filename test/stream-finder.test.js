// End-to-end tests for stream discovery against a local fixture site.
// The fixtures live on 127.0.0.1, so the SSRF guard has to be off for this run.
process.env.DISABLE_SSRF_PROTECTION = 'true';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const express = require('express');
const { findStreams, FinderError } = require('../lib/stream-finder');
const extractRouter = require('../routes/extract');

// --- Fixtures ---

// A faststart-shaped MP4 head: ftyp, then a v0 tkhd declaring 1280x720.
function fakeMp4(width, height) {
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    const tkhd = Buffer.alloc(92);
    tkhd.writeUInt32BE(92, 0);
    tkhd.write('tkhd', 4, 'latin1');
    tkhd.writeUInt32BE(width << 16, 8 + 76);
    tkhd.writeUInt32BE(height << 16, 8 + 80);
    return Buffer.concat([ftyp, tkhd, Buffer.alloc(2048)]);
}
const MP4 = fakeMp4(1280, 720);

const MASTER = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720',
    'v/720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'v/360/index.m3u8',
    ''
].join('\n');
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n';

const pages = {
    '/pages/sub/relative.html': '<video src="clip.mp4"></video>',
    '/pages/json.html': '<script>var cfg = {"sources":[{"file":"BASE\\/master.m3u8?token=x"}]};</script>',
    '/pages/iframe-outer.html': '<h1>Show</h1><iframe src="/embed/middle.html"></iframe>',
    '/embed/middle.html': '<iframe src="inner.html"></iframe>',
    '/embed/inner.html': '<script>player.setup({ file: "/master.m3u8?token=x" });</script>',
    '/pages/og-embed.html': '<meta property="og:video" content="BASE/embed/inner.html"><meta property="og:video:type" content="text/html">',
    '/pages/mixed.html': `<title>Mixed bag</title>
        <video src="/ads/preroll.mp4"></video>
        <script>
            var a = "BASE/master.m3u8?token=x";
            var b = "BASE/v/720/index.m3u8";
            var c = "BASE/media/dead.mp4";
        </script>`,
    '/pages/script.html': '<script src="/js/player-config.js"></script>',
    '/pages/nothing.html': '<div id="app"></div><script>boot()</script>',
    '/pages/soft404.html': '<video src="/media/html.mp4"></video><video src="/media/dead.mp4"></video>',
    '/pages/extensionless.html': '<video><source src="/api/stream/7" type="application/x-mpegURL"></video>',
    '/pages/sniff.html': '<video src="/api/progressive/9"></video>'
};

let base;
const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const html = (body) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html><body>${body.replaceAll('BASE', base)}</body></html>`);
    };
    const mp4 = () => {
        res.writeHead(206, {
            'Content-Type': 'video/mp4',
            'Content-Range': `bytes 0-${MP4.length - 1}/${MP4.length * 1000}`
        });
        res.end(MP4);
    };

    if (pages[path]) return html(pages[path]);
    if (path === '/master.m3u8') {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(MASTER);
    }
    if (/^\/v\/\d+\/index\.m3u8$/.test(path)) return res.end(MEDIA);
    if (path === '/api/stream/7') {
        res.setHeader('Content-Type', 'text/plain');
        return res.end(MASTER);
    }
    if (path === '/api/progressive/9') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(MP4);
    }
    if (path.endsWith('clip.mp4') || path === '/ads/preroll.mp4') return mp4();
    if (path === '/media/html.mp4') return html('<h1>Not found</h1>');
    if (path === '/js/player-config.js') {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end('window.PLAYER = { hls: "/master.m3u8?token=x" };');
    }
    if (path === '/pages/blocked.html') {
        res.statusCode = 403;
        return res.end('Access denied');
    }
    if (path === '/redirect') {
        res.writeHead(302, { Location: '/pages/sub/relative.html' });
        return res.end();
    }
    if (path === '/slow.html') return; // never answers
    res.statusCode = 404;
    res.end('not found');
});

const noBrowser = { browser: false };

async function expectFinderError(promise, status) {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof FinderError, `expected FinderError, got ${err}`);
        assert.strictEqual(err.status, status, err.message);
        return err;
    }
    assert.fail(`expected FinderError ${status}`);
}

// --- Direct URLs ---

test('a direct playlist URL with a query string is recognised and its qualities listed', async () => {
    const { videos } = await findStreams(`${base}/master.m3u8?token=x`, noBrowser);
    assert.strictEqual(videos.length, 1);
    assert.strictEqual(videos[0].type, 'hls');
    assert.strictEqual(videos[0].source, 'direct');
    assert.deepStrictEqual(videos[0].qualities.map(q => q.label), ['720p', '360p']);
    assert.strictEqual(videos[0].resolution, '720p');
});

test('an extensionless URL is identified by sniffing the response', async () => {
    const { videos } = await findStreams(`${base}/api/stream/7`, noBrowser);
    assert.strictEqual(videos[0].type, 'hls');
    assert.strictEqual(videos[0].url, `${base}/api/stream/7`);
});

// --- Page scanning ---

test('relative sources resolve against the page directory', async () => {
    const { videos } = await findStreams(`${base}/pages/sub/relative.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/pages/sub/clip.mp4`);
    assert.strictEqual(videos[0].resolution, '720p', 'read from the MP4 header');
    assert.strictEqual(videos[0].size, MP4.length * 1000, 'total size from Content-Range');
});

test('relative sources resolve against the final URL after a redirect', async () => {
    const { videos } = await findStreams(`${base}/redirect`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/pages/sub/clip.mp4`);
});

test('JSON-escaped URLs in inline scripts are found', async () => {
    const { videos } = await findStreams(`${base}/pages/json.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/master.m3u8?token=x`);
});

test('a typed extensionless <source> is found and passed through as HLS', async () => {
    const { videos } = await findStreams(`${base}/pages/extensionless.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/api/stream/7`);
    assert.strictEqual(videos[0].type, 'hls');
});

test('an untyped extensionless <video> is identified by probing', async () => {
    const { videos } = await findStreams(`${base}/pages/sniff.html`, noBrowser);
    assert.strictEqual(videos[0].type, 'mp4');
});

test('ranks the master first, prunes its variant, drops dead links', async () => {
    const { videos, title } = await findStreams(`${base}/pages/mixed.html`, noBrowser);
    assert.strictEqual(title, 'Mixed bag');
    assert.deepStrictEqual(videos.map(v => v.url), [
        `${base}/master.m3u8?token=x`,
        `${base}/ads/preroll.mp4`
    ]);
});

// --- Embeds and scripts ---

test('follows a chain of iframes; the referer is the frame that holds the player', async () => {
    const { videos } = await findStreams(`${base}/pages/iframe-outer.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/master.m3u8?token=x`);
    assert.strictEqual(videos[0].referer, `${base}/embed/inner.html`);
});

test('an HTML og:video is followed as an embed', async () => {
    const { videos } = await findStreams(`${base}/pages/og-embed.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/master.m3u8?token=x`);
    assert.ok(!videos.some(v => v.url.endsWith('inner.html')), 'the embed page itself is not a stream');
});

test('external player scripts are searched', async () => {
    const { videos } = await findStreams(`${base}/pages/script.html`, noBrowser);
    assert.strictEqual(videos[0].url, `${base}/master.m3u8?token=x`);
    assert.strictEqual(videos[0].source, 'script');
});

// --- Browser fallback ---

test('a script-only page falls back to the browser, whose results are probed', async () => {
    let calledWith = null;
    const browser = async (url) => {
        calledWith = url;
        return [
            { url: `${base}/master.m3u8?token=x`, referer: `${base}/embed/inner.html` },
            { url: `${base}/media/dead.mp4` }
        ];
    };
    const { videos } = await findStreams(`${base}/pages/nothing.html`, { browser });
    assert.strictEqual(calledWith, `${base}/pages/nothing.html`);
    assert.deepStrictEqual(videos.map(v => v.url), [`${base}/master.m3u8?token=x`]);
    assert.strictEqual(videos[0].referer, `${base}/embed/inner.html`);
    assert.strictEqual(videos[0].source, 'network');
});

test('a bot-blocked page (403) goes to the browser instead of failing', async () => {
    let called = false;
    const browser = async () => {
        called = true;
        return [{ url: `${base}/pages/sub/clip.mp4` }];
    };
    const { videos } = await findStreams(`${base}/pages/blocked.html`, { browser });
    assert.ok(called);
    assert.strictEqual(videos[0].type, 'mp4');
});

test('the browser is not started when the static pass found a stream', async () => {
    const browser = async () => assert.fail('browser should not run');
    await findStreams(`${base}/pages/json.html`, { browser });
});

// --- Failures ---

test('a missing page is a 404 with a clear message', async () => {
    const err = await expectFinderError(findStreams(`${base}/pages/missing.html`, noBrowser), 404);
    assert.match(err.message, /404/);
});

test('only dead or HTML "videos" means no video found', async () => {
    await expectFinderError(findStreams(`${base}/pages/soft404.html`, noBrowser), 404);
});

test('a bot-blocked page with no browser reports the refusal', async () => {
    const err = await expectFinderError(findStreams(`${base}/pages/blocked.html`, noBrowser), 502);
    assert.match(err.message, /403/);
});

test('aborting stops the search promptly', async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await expectFinderError(findStreams(`${base}/slow.html`, { ...noBrowser, signal: controller.signal }), 499);
    assert.ok(Date.now() - started < 2000, 'did not wait for the page timeout');
});

test('progress is reported as the search escalates', async () => {
    const steps = [];
    await findStreams(`${base}/pages/iframe-outer.html`, { ...noBrowser, onProgress: s => steps.push(s) });
    assert.ok(steps.some(s => /Fetching page/.test(s)), steps.join(' | '));
    assert.ok(steps.some(s => /embedded player/.test(s)), steps.join(' | '));
    assert.ok(steps.some(s => /Checking \d+ stream/.test(s)), steps.join(' | '));
});

// --- HTTP API ---

function postExtract(appPort, body, accept) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1',
            port: appPort,
            path: '/api/extract',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(accept ? { Accept: accept } : {}) }
        }, (res) => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], data }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

test('the API streams NDJSON progress, then the result', async () => {
    const app = express();
    app.use(express.json());
    app.use(extractRouter);
    const api = app.listen(0, '127.0.0.1');
    await new Promise(r => api.once('listening', r));
    try {
        const res = await postExtract(api.address().port, { url: `${base}/pages/json.html` }, 'application/x-ndjson');
        assert.match(res.type, /ndjson/);
        const lines = res.data.trim().split('\n').map(l => JSON.parse(l));
        assert.ok(lines.length >= 2 && lines[0].progress, res.data);
        assert.strictEqual(lines.at(-1).videos[0].url, `${base}/master.m3u8?token=x`);

        const plain = await postExtract(api.address().port, { url: `${base}/pages/missing.html` });
        assert.strictEqual(plain.status, 404);
        assert.match(JSON.parse(plain.data).error, /404/);

        const bad = await postExtract(api.address().port, { url: 'ftp://example.com/x' });
        assert.strictEqual(bad.status, 400);
    } finally {
        api.close();
    }
});

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => extractRouter.clearExtractCache());

after(() => {
    server.closeAllConnections();
    server.close();
});
