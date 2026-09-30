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
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

const MOCK_IP = '127.0.0.1';
const MP4 = Buffer.alloc(64 * 1024, 1);

let base;
let cdn;
let server;
let devices;
let activeSessions;
let streamStats;
let streamRecovery;
let bufferHealthTracking;
let getLocalIp;
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
    if (path === '/longlive.m3u8') {
        // Forty seconds of live window: long enough to start short of its edge.
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        const segments = Array.from({ length: 10 }, () => '#EXTINF:4,\nseg1.ts').join('\n');
        return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${segments}\n`);
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
    ({ devices, activeSessions, streamStats, streamRecovery, bufferHealthTracking } = require('../lib/state'));
    ({ getLocalIp } = require('../lib/utils'));
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

test('a broadcast the receiver reports as done plays out and ends without a restart', async () => {
    registerMock();
    await cast({ url: `${cdn}/live.m3u8`, type: 'hls' });
    const mock = receiver();
    clearTimeout(mock.startTimeout); // skip the mock's simulated start-up buffering
    mock.play();

    mock.endBroadcast();
    assert.strictEqual(activeSessions.get(MOCK_IP).broadcastEnded, true);

    // Jump to just before the end so it finishes on the mock's next tick.
    mock.seek(mock.liveEdgeTime - 0.2);
    assert.ok(await waitFor(() => !activeSessions.has(MOCK_IP), 3000), 'the session should end with playback');
    assert.strictEqual(mock.idleReason, 'FINISHED');
    assert.strictEqual(streamRecovery.has(MOCK_IP), false, 'recovery must not restart a finished stream');
});

test('a live playlist that closes through the proxy marks the broadcast ended', async () => {
    registerMock();
    await cast({ url: `${cdn}/live.m3u8`, type: 'hls' });
    assert.strictEqual(activeSessions.get(MOCK_IP).broadcastEnded, false);

    // The receiver's own request, from the address its session is mapped to.
    const proxied = `http://${getLocalIp()}:${process.env.PORT}/proxy?type=hls&url=${encodeURIComponent(`${cdn}/vod.m3u8`)}`;
    assert.strictEqual((await fetch(proxied)).status, 200);
    assert.strictEqual(activeSessions.get(MOCK_IP).broadcastEnded, true);
});

test('a closed playlist does not mark a recording as an ended broadcast', async () => {
    registerMock();
    await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
    const proxied = `http://${getLocalIp()}:${process.env.PORT}/proxy?type=hls&url=${encodeURIComponent(`${cdn}/vod.m3u8`)}`;
    await fetch(proxied);
    assert.strictEqual(activeSessions.get(MOCK_IP).broadcastEnded, false);
});

test('seeks land inside the live window, short of the edge', () => {
    const { clampSeek } = require('../lib/cast');
    const status = { liveSeekableRange: { start: 100, end: 1100, isMovingWindow: true } };
    assert.strictEqual(clampSeek(status, 500), 500);
    assert.strictEqual(clampSeek(status, 20), 100);
    assert.strictEqual(clampSeek(status, 5000), 1085);
    // Once the broadcast is done its end is fixed and reachable.
    const done = { liveSeekableRange: { start: 100, end: 1100, isMovingWindow: false, isLiveDone: true } };
    assert.strictEqual(clampSeek(done, 5000), 1099);
});

test('seeks in a recording stop short of its end', () => {
    const { clampSeek } = require('../lib/cast');
    assert.strictEqual(clampSeek({ media: { duration: 600 } }, 900), 599);
    assert.strictEqual(clampSeek({ media: { duration: 600 } }, -5), 0);
    assert.strictEqual(clampSeek({}, 42), 42);
});

// --- Starting live streams at the edge ---

// The mock starts playing on its own after a simulated buffer; start it now.
function startPlaying(mock) {
    clearTimeout(mock.startTimeout);
    mock.play();
}

test('a live stream is loaded starting short of its edge, and not seeked again', async () => {
    registerMock();
    await cast({ url: `${cdn}/longlive.m3u8`, type: 'hls' });
    const mock = receiver();
    assert.strictEqual(mock.requestedStart, 25, '40s window, started 15s short of the edge');

    startPlaying(mock);
    mock.emit('status', mock.getStatus()); // a status while playing settles it
    assert.strictEqual(mock.currentTime, 25);
    assert.deepStrictEqual(mock.seeks, [], 'already at the edge: no second buffering');
});

test('a receiver that ignores the start position is still moved to the edge', async () => {
    registerMock();
    await cast({ url: `${cdn}/longlive.m3u8`, type: 'hls' });
    const mock = receiver();
    mock.ignoresStartTime = true;

    startPlaying(mock);
    assert.strictEqual(mock.seeks.length, 1);
    assert.ok(Math.abs(mock.seeks[0] - (mock.liveEdgeTime - 15)) < 1, `seeked to ${mock.seeks[0]}`);
});

test('a "live" stream whose window turns out fixed goes back to its start', async () => {
    registerMock();
    await cast({ url: `${cdn}/longlive.m3u8`, type: 'hls' });
    const mock = receiver();
    mock.fixedWindow = true; // a replay served without #EXT-X-ENDLIST

    startPlaying(mock);
    assert.deepStrictEqual(mock.seeks, [0]);
});

test('a URL marked as a replay is never started at its edge', async () => {
    registerMock();
    await cast({ url: `${cdn}/longlive.m3u8?type=replay`, type: 'hls' });
    assert.strictEqual(receiver().requestedStart, null);
});

// --- Receiver errors ---

// Messages the page would get over its WebSocket, from now on.
async function pageMessages() {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    return { messages, close: () => ws.close() };
}

test('a receiver error ends the session, without recovery, and tells the page why', async () => {
    registerMock();
    const page = await pageMessages();
    try {
        await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
        receiver().fail({ type: 'ERROR', detailedErrorCode: 104 });

        assert.ok(await waitFor(() => page.messages.some(m => m.type === 'castError')), 'the page hears about it');
        const error = page.messages.find(m => m.type === 'castError');
        assert.strictEqual(error.deviceIp, MOCK_IP);
        assert.match(error.message, /could not decode.*\(Receiver error 104\.\)/);
        assert.strictEqual(activeSessions.has(MOCK_IP), false);
        assert.strictEqual(streamRecovery.has(MOCK_IP), false, 'recovery must not retry what the TV cannot play');
    } finally {
        page.close();
    }
});

let hasX265 = false;
try {
    hasX265 = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx265');
} catch { /* no ffmpeg */ }

test('a converted cast the TV rejects before playing is recast without conversion', { skip: !hasX265 && 'ffmpeg with libx265 not installed' }, async () => {
    process.env.TRANSCODE_ENCODER = 'x265';
    await require('../lib/transcode').detect();
    registerMock();
    const page = await pageMessages();
    try {
        const res = await cast({ url: `${cdn}/vod.m3u8`, type: 'hls', proxy: true, transcode: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const first = receiver();
        assert.ok(first.media.contentId.includes('transcode=hevc'));

        first.fail({ type: 'LOAD_FAILED' });
        assert.ok(await waitFor(() => page.messages.some(m => m.type === 'castFallback')), 'the page hears about it');
        assert.ok(await waitFor(() => receiver() && receiver() !== first), 'recast on a new receiver session');
        assert.ok(!receiver().media.contentId.includes('transcode=hevc'), 'without conversion');
        assert.ok(!page.messages.some(m => m.type === 'castError'), 'a fallback is not reported as a failure');
    } finally {
        page.close();
    }
});

// --- Pages opened mid-stream ---

test('a page opened mid-stream finds the session, and where playback is', async () => {
    registerMock();
    await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
    startPlaying(receiver());

    const list = await (await fetch(`${base}/api/sessions`)).json();
    assert.deepStrictEqual(list.sessions.map(s => [s.ip, s.type]), [[MOCK_IP, 'chromecast']]);

    const session = await (await fetch(`${base}/api/session/${MOCK_IP}`)).json();
    assert.strictEqual(session.playback.status.playerState, 'PLAYING');
    assert.ok(session.playback.status.media, 'the media (and its duration) is carried over');
    assert.ok(Number.isFinite(session.playback.status.currentTime));
    assert.ok(session.playback.statusAgeMs < 1000, 'asked the receiver just now');
});

test('a jump the TV makes on its own (its remote) is recognised as a seek', async () => {
    registerMock();
    await cast({ url: `${cdn}/vod.m3u8`, type: 'hls' });
    const mock = receiver();
    startPlaying(mock);
    assert.strictEqual(bufferHealthTracking.get(MOCK_IP).lastSeekAt, null);

    mock.seek(600); // not through HomeCast
    assert.ok(bufferHealthTracking.get(MOCK_IP).lastSeekAt > 0, 'the buffering that follows is expected');
});

// ===== Volume =====

const volumeOf = () => activeSessions.get(MOCK_IP)?.client;
const playbackAction = (action, value) => post('/api/playback', { ip: MOCK_IP, action, value });

test('the cast answer carries the device volume, so the slider works from the start', async () => {
    registerMock();
    const res = await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    assert.deepStrictEqual(res.body.volume, { level: 0.5, muted: false, fixed: false });
});

test('the slider sets the device volume', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    const res = await playbackAction('volume', 0.3);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(volumeOf().volume.level, 0.3);
});

test('a device that ignores the level is caught, and the page shown its real volume', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    const page = await pageMessages();
    try {
        volumeOf().ignoresLevel = true;
        assert.strictEqual((await playbackAction('volume', 0.2)).status, 200);
        assert.ok(await waitFor(() => page.messages.some(m => m.type === 'castNotice'), 4000), 'the page hears about it');
        const notice = page.messages.find(m => m.type === 'castNotice');
        assert.match(notice.message, /TV remote/);
        assert.deepStrictEqual(notice.volume, { level: 0.5, muted: false, fixed: false });
    } finally {
        page.close();
    }
});

test('no warning when the device took the level', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    const page = await pageMessages();
    try {
        await playbackAction('volume', 0.2);
        await new Promise(r => setTimeout(r, 1800));
        assert.ok(!page.messages.some(m => m.type === 'castNotice'));
    } finally {
        page.close();
    }
});

test('a device with fixed volume refuses levels but can still be muted', async () => {
    registerMock();
    await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    const client = volumeOf();
    client.volume = { ...client.volume, controlType: 'fixed' };
    client.emit('status', { volume: client.volume });
    assert.strictEqual(activeSessions.get(MOCK_IP).volume.fixed, true);

    const res = await playbackAction('volume', 0.9);
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, /TV remote/);
    assert.strictEqual(client.volume.level, 0.5);
    assert.strictEqual((await playbackAction('mute', true)).status, 200);
    assert.strictEqual(client.volume.muted, true);
});

// ===== Errors inside a cast =====

test('an error thrown while starting a cast is answered, not left to crash the server', async (t) => {
    registerMock();
    // getLocalIp() is the first thing a cast does; make it throw.
    const hostIp = process.env.HOST_IP;
    delete process.env.HOST_IP;
    t.after(() => { if (hostIp !== undefined) process.env.HOST_IP = hostIp; });
    t.mock.method(require('os'), 'networkInterfaces', () => { throw new Error('no interfaces'); });

    const res = await cast({ url: `${cdn}/v.mp4`, type: 'mp4' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /no interfaces/);
    // Still serving.
    t.mock.restoreAll();
    assert.strictEqual((await fetch(`${base}/api/devices`)).status, 200);
});
