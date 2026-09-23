// /proxy through the fully wired app from server.js, against a local fixture
// CDN: playlist rewriting and quality capping, segment passthrough with Range,
// and the CORS headers the cast receiver depends on. The fixture lives on
// 127.0.0.1, so the SSRF guard is off for this run (server.test.js covers it on).
process.env.DISABLE_SSRF_PROTECTION = 'true';

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const { server } = require('../server');

const SEGMENT = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080
hi/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
lo/index.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg1.ts
#EXT-X-ENDLIST
`;

let base;
let cdn;
let lastCdnRequest;

const upstream = http.createServer((req, res) => {
    lastCdnRequest = req;
    const path = req.url.split('?')[0];
    if (path === '/show/master.m3u8') {
        // An upstream that pins CORS to its own site must not leak through.
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': 'https://site.example' });
        return res.end(MASTER);
    }
    if (path === '/show/hi/index.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(MEDIA);
    }
    if (path === '/show/subs/en.srt') {
        // Served the way many sites do: SRT, as text/plain, locked to their origin.
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': 'https://site.example' });
        return res.end('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n');
    }
    if (path === '/show/subs/not-subs.vtt') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>Login required</html>');
    }
    if (path === '/show/hi/seg1.ts') {
        const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (range) {
            const [start, end] = [Number(range[1]), Number(range[2])];
            res.writeHead(206, {
                'Content-Type': 'video/mp2t',
                'Content-Range': `bytes ${start}-${end}/${SEGMENT.length}`,
                'Access-Control-Allow-Origin': 'https://site.example',
                'Set-Cookie': 'cdn_session=secret'
            });
            return res.end(SEGMENT.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Set-Cookie': 'cdn_session=secret' });
        return res.end(SEGMENT);
    }
    res.writeHead(404);
    res.end();
});

before(async () => {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${upstream.address().port}`;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    for (const s of [server, upstream]) {
        s.closeAllConnections();
        s.close();
    }
});

const proxy = (url, params = {}, init) =>
    fetch(`${base}/proxy?${new URLSearchParams({ url, ...params })}`, init);

test('a master playlist is capped to the highest variant and rewritten through the proxy', async () => {
    const res = await proxy(`${cdn}/show/master.m3u8`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /mpegurl/);
    const body = await res.text();
    assert.strictEqual((body.match(/#EXT-X-STREAM-INF/g) || []).length, 1, body);
    assert.match(body, /RESOLUTION=1920x1080/);
    const variant = body.split('\n').find(l => l && !l.startsWith('#'));
    const rewritten = new URL(variant);
    assert.strictEqual(rewritten.host, new URL(base).host, 'variant should point back at HomeCast');
    assert.strictEqual(rewritten.pathname, '/proxy');
    assert.strictEqual(rewritten.searchParams.get('url'), `${cdn}/show/hi/index.m3u8`);
});

test('quality=auto keeps every variant', async () => {
    const body = await (await proxy(`${cdn}/show/master.m3u8`, { quality: 'auto' })).text();
    assert.strictEqual((body.match(/#EXT-X-STREAM-INF/g) || []).length, 2, body);
});

test('playlists are served with CORS open to the receiver, not the upstream site', async () => {
    const res = await proxy(`${cdn}/show/master.m3u8`, { quality: 'auto' });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.strictEqual(res.headers.get('content-security-policy'), null);
});

test('a media playlist rewrites its segments through the proxy', async () => {
    const body = await (await proxy(`${cdn}/show/hi/index.m3u8`)).text();
    const segment = new URL(body.split('\n').find(l => l && !l.startsWith('#')));
    assert.strictEqual(segment.searchParams.get('url'), `${cdn}/show/hi/seg1.ts`);
});

test('the Referer is forwarded upstream', async () => {
    await (await proxy(`${cdn}/show/hi/seg1.ts`, { referer: 'https://site.example/watch' })).arrayBuffer();
    assert.strictEqual(lastCdnRequest.headers.referer, 'https://site.example/watch');
});

test('a segment is passed through byte for byte, without upstream cookies or CORS', async () => {
    const res = await proxy(`${cdn}/show/hi/seg1.ts`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), SEGMENT);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(res.headers.get('set-cookie'), null);
});

test('a Range request is forwarded and answered with 206 and an exposed Content-Range', async () => {
    const res = await proxy(`${cdn}/show/hi/seg1.ts`, {}, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes 100-199/${SEGMENT.length}`);
    assert.match(res.headers.get('access-control-expose-headers'), /Content-Range/);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), SEGMENT.subarray(100, 200));
});

test('an upstream playlist error is reported with its status', async () => {
    const res = await proxy(`${cdn}/show/missing.m3u8`);
    assert.strictEqual(res.status, 404);
    assert.match((await res.json()).error, /Upstream error: 404/);
});

test('subtitles are served as WebVTT, converted from SRT, readable by the receiver', async () => {
    const res = await proxy(`${cdn}/show/subs/en.srt`, { type: 'subtitle' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/vtt/);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(await res.text(), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n');
});

test('a subtitle URL that returns something else is refused', async () => {
    const res = await proxy(`${cdn}/show/subs/not-subs.vtt`, { type: 'subtitle' });
    assert.strictEqual(res.status, 415);
});
