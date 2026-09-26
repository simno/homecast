// Casting end to end against the mock Chromecast (lib/mock-chromecast.js):
// the /api/cast -> castv2 LOAD path, stream types, subtitles, replacing and
// stopping sessions, and the unreachable-device error. The mock pulls media
// like a real receiver, so the proxied case exercises the whole chain.
process.env.NODE_ENV = 'development';        // lets cast.js use the mock client
process.env.DISABLE_SSRF_PROTECTION = 'true'; // fixtures live on 127.0.0.1
process.env.DISABLE_CSRF = 'true';            // server.test.js covers CSRF

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');

const MOCK_IP = '127.0.0.1';
const MP4 = Buffer.alloc(64 * 1024, 1);

let base;
let cdn;
let server;
let devices;
let activeSessions;
let streamStats;
let deviceListener;

const upstream = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/v.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
        return res.end(MP4);
    }
    if (path === '/vod.m3u8' || path === '/live.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        const end = path === '/vod.m3u8' ? '#EXT-X-ENDLIST\n' : '';
        return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n${end}`);
    }
    if (path === '/seg1.ts') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return res.end(Buffer.alloc(1024));
    }
    res.writeHead(404);
    res.end();
});

const listen = (s, host) => new Promise((resolve) => s.listen(0, host, resolve));

before(async () => {
    await listen(upstream, '127.0.0.1');
    cdn = `http://127.0.0.1:${upstream.address().port}`;

    // What the reachability check connects to, standing in for the device's cast port.
    deviceListener = net.createServer((sock) => sock.destroy());
    await listen(deviceListener, '127.0.0.1');

    // The receiver fetches proxied media from http://<LAN IP>:<PORT>, so the
    // server must be on all interfaces and PORT known before the app loads.
    const probe = http.createServer();
    await listen(probe);
    process.env.PORT = String(probe.address().port);
    await new Promise((resolve) => probe.close(resolve));

    ({ server } = require('../server'));
    ({ devices, activeSessions, streamStats } = require('../lib/state'));
    await new Promise((resolve) => server.listen(Number(process.env.PORT), '0.0.0.0', resolve));
    base = `http://127.0.0.1:${process.env.PORT}`;
});

function registerMock(overrides = {}) {
    devices.set(MOCK_IP, {
        name: 'Mock Chromecast (Test)', ip: MOCK_IP, host: 'localhost', id: 'mock-test',
        type: 'chromecast', isMock: true, port: deviceListener.address().port, ...overrides
    });
}

afterEach(async () => {
    if (activeSessions.has(MOCK_IP)) await post('/api/stop', { ip: MOCK_IP });
    devices.delete(MOCK_IP);
});

after(() => {
    for (const s of [server, upstream]) {
        s.closeAllConnections();
        s.close();
    }
    deviceListener.close();
});

async function post(path, body) {
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
}

const cast = (body) => post('/api/cast', { ip: MOCK_IP, proxy: false, ...body });
const receiver = () => activeSessions.get(MOCK_IP)?.player.mockDevice;

async function waitFor(predicate, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

test('an MP4 is loaded on the receiver as a recorded stream', async () => {
    registerMock();
    const res = await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'casting');
    assert.deepStrictEqual(
        { contentId: receiver().media.contentId, contentType: receiver().media.contentType, streamType: receiver().media.streamType },
        { contentId: `${cdn}/v.mp4`, contentType: 'video/mp4', streamType: 'BUFFERED' });
});

test('the manifest decides live vs recorded for HLS', async () => {
    registerMock();
    await cast({ url: `${cdn}/live.m3u8`, type: 'hls' });
    assert.strictEqual(receiver().media.streamType, 'LIVE');
    assert.strictEqual(receiver().media.contentType, 'application/x-mpegURL');

    await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
    assert.strictEqual(receiver().media.streamType, 'BUFFERED');
});

test('a proxied cast is fetched through HomeCast and counted for the device', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, type: 'mp4', proxy: true });
    const contentId = new URL(receiver().media.contentId);
    assert.strictEqual(contentId.pathname, '/proxy');
    assert.strictEqual(contentId.searchParams.get('url'), `${cdn}/v.mp4`);
    assert.ok(await waitFor(() => streamStats.get(MOCK_IP)?.totalBytes >= MP4.length),
        'the receiver\'s fetch should be tracked as this device\'s traffic');
});

test('a sideloaded subtitle file is loaded with the media and switched on', async () => {
    registerMock();
    const res = await cast({ url: `${cdn}/v.mp4`, subtitle: { url: `${cdn}/subs/en.srt`, language: 'en', label: 'English' } });
    assert.deepStrictEqual(res.body.subtitles, { tracks: [{ trackId: 1, name: 'English', language: 'en' }], activeTrackId: 1 });

    const [track] = receiver().media.tracks;
    const trackUrl = new URL(track.trackContentId);
    assert.strictEqual(trackUrl.pathname, '/proxy', 'subtitles go through the proxy even with proxy off');
    assert.strictEqual(trackUrl.searchParams.get('type'), 'subtitle');
    assert.strictEqual(trackUrl.searchParams.get('url'), `${cdn}/subs/en.srt`);
    assert.deepStrictEqual(receiver().activeTrackIds, [1]);
});

test('subtitles can be switched off and on while playing', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, subtitle: { url: `${cdn}/subs/en.srt`, label: 'English' } });

    const off = await post('/api/subtitles', { ip: MOCK_IP, trackId: null });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.activeTrackId, null);
    assert.deepStrictEqual(receiver().activeTrackIds, []);

    const on = await post('/api/subtitles', { ip: MOCK_IP, trackId: 1 });
    assert.strictEqual(on.body.activeTrackId, 1);
    assert.deepStrictEqual(receiver().activeTrackIds, [1]);

    const unknown = await post('/api/subtitles', { ip: MOCK_IP, trackId: 7 });
    assert.strictEqual(unknown.status, 400);
});

test('without subtitles no text track is sent', async () => {
    registerMock();
    const res = await cast({ url: `${cdn}/v.mp4` });
    assert.deepStrictEqual(receiver().media.tracks, []);
    assert.deepStrictEqual(res.body.subtitles, { tracks: [], activeTrackId: null });
});

test('casting again replaces the session and stops the old playback', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4` });
    const first = receiver();
    await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
    assert.notStrictEqual(receiver(), first);
    assert.strictEqual(first.playerState, 'IDLE');
    assert.strictEqual(receiver().media.contentId, `${cdn}/vod.m3u8`);
});

test('stopping ends the session on the receiver and the server', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4` });
    const mock = receiver();

    const res = await post('/api/stop', { ip: MOCK_IP });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(mock.playerState, 'IDLE');
    assert.strictEqual(activeSessions.has(MOCK_IP), false);

    const status = await (await fetch(`${base}/api/session/${MOCK_IP}`)).json();
    assert.strictEqual(status.active, false);
});

test('stopping a device with no session is a 404', async () => {
    const res = await post('/api/stop', { ip: '192.168.1.77' });
    assert.strictEqual(res.status, 404);
});

test('an unreachable device without a known MAC fails fast with an explanation', async () => {
    const closed = net.createServer();
    await listen(closed, '127.0.0.1');
    const port = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));

    registerMock({ port });
    const res = await cast({ url: `${cdn}/v.mp4` });
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, new RegExp(`Cannot reach device at ${MOCK_IP}:${port}.*Wake-on-LAN`));
    assert.strictEqual(activeSessions.has(MOCK_IP), false);
});

test('seeks land inside the live window, short of the edge', () => {
    const { clampSeek } = require('../lib/cast');
    const status = { liveSeekableRange: { start: 100, end: 1100, isMovingWindow: true } };
    assert.strictEqual(clampSeek(status, 500), 500);
    assert.strictEqual(clampSeek(status, 20), 100);
    assert.strictEqual(clampSeek(status, 5000), 1085);
});

test('seeks in a recording stop short of its end', () => {
    const { clampSeek } = require('../lib/cast');
    assert.strictEqual(clampSeek({ media: { duration: 600 } }, 900), 599);
    assert.strictEqual(clampSeek({ media: { duration: 600 } }, -5), 0);
    assert.strictEqual(clampSeek({}, 42), 42);
});
