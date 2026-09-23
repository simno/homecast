// The proxy's playlist cache (routes/proxy.js): VOD playlists are reused,
// live ones only briefly, each quality separately, concurrent requests share
// one upstream fetch, and failures are never cached. The live TTL is cut to
// 1s so expiry can be seen without a long wait.
process.env.CACHE_TTL_LIVE_SECONDS = '1';
process.env.DISABLE_SSRF_PROTECTION = 'true'; // fixtures live on 127.0.0.1

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const express = require('express');

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nlo.m3u8\n';
const VOD = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXT-X-ENDLIST\n';
const LIVE = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n';

const hits = new Map(); // upstream path -> request count
let failNext = new Set(); // paths that answer 404 once
let cdn;
let base;
let api;

const upstream = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.set(path, (hits.get(path) || 0) + 1);
    if (failNext.delete(path)) {
        res.writeHead(404);
        return res.end();
    }
    const body = path.includes('master') ? MASTER : path.includes('live') ? LIVE : VOD;
    // A little latency, so concurrent requests really overlap.
    setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(body);
    }, path.includes('slow') ? 100 : 0);
});

before(async () => {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${upstream.address().port}`;
    const app = express();
    app.use(require('../routes/proxy'));
    api = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => api.once('listening', resolve));
    base = `http://127.0.0.1:${api.address().port}`;
});

after(() => {
    for (const s of [api, upstream]) {
        s.closeAllConnections();
        s.close();
    }
});

const get = (path, quality = 'highest') =>
    fetch(`${base}/proxy?${new URLSearchParams({ url: `${cdn}${path}`, quality, type: 'hls' })}`);

test('a VOD playlist is fetched once and then served from the cache', async () => {
    const first = await (await get('/vod-a.m3u8')).text();
    const second = await (await get('/vod-a.m3u8')).text();
    assert.strictEqual(hits.get('/vod-a.m3u8'), 1);
    assert.strictEqual(second, first);
});

test('a live playlist is reused within its TTL and refetched after it', async () => {
    await get('/live-a.m3u8');
    await get('/live-a.m3u8');
    assert.strictEqual(hits.get('/live-a.m3u8'), 1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await get('/live-a.m3u8');
    assert.strictEqual(hits.get('/live-a.m3u8'), 2);
});

test('each quality of a master is cached separately', async () => {
    const highest = await (await get('/master-a.m3u8', 'highest')).text();
    const auto = await (await get('/master-a.m3u8', 'auto')).text();
    assert.strictEqual(hits.get('/master-a.m3u8'), 2);
    assert.strictEqual((highest.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
    assert.strictEqual((auto.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
});

test('concurrent requests for the same playlist share one upstream fetch', async () => {
    const bodies = await Promise.all(Array.from({ length: 5 }, () => get('/slow-vod.m3u8').then(r => r.text())));
    assert.strictEqual(hits.get('/slow-vod.m3u8'), 1);
    assert.ok(bodies.every(b => b === bodies[0]));
});

test('an upstream error is passed on and not cached', async () => {
    failNext = new Set(['/vod-flaky.m3u8']);
    assert.strictEqual((await get('/vod-flaky.m3u8')).status, 404);
    assert.strictEqual((await get('/vod-flaky.m3u8')).status, 200);
    assert.strictEqual(hits.get('/vod-flaky.m3u8'), 2);
});
