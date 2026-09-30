// The play-next queue (lib/queue.js, routes/queue.js) through the fully wired
// app: queueing behind a stream, moving on when a Chromecast plays a video to
// its end (and not when it's stopped), skipping, removing, what clears a
// queue, an Apple TV's Next button, and an LG TV keeping its browser up
// between videos.
process.env.NODE_ENV = 'development';        // lets cast.js use the mock client
process.env.DISABLE_SSRF_PROTECTION = 'true'; // fixtures live on 127.0.0.1
process.env.DISABLE_CSRF = 'true';            // server.test.js covers CSRF
process.env.HOST_IP = '127.0.0.1';

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createFakeAppleTv } = require('./fake-apple-tv');
const { createFakeLgTv } = require('./fake-lg-tv');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-queue-'));
process.env.WEBOS_KEY_STORE = path.join(tmpDir, 'webos-keys.json');
process.env.AIRPLAY_PAIRING_STORE = path.join(tmpDir, 'pairings.json');

const IP = '127.0.0.1';
const MP4 = Buffer.alloc(64 * 1024, 1);

let server;
let state;
let webos;
let base;
let cdn;
let deviceListener;
let dashboard;
let fake;

const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
    res.end(MP4);
});

const freePort = async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
};

before(async () => {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${upstream.address().port}`;
    deviceListener = net.createServer(sock => sock.destroy());
    await new Promise(resolve => deviceListener.listen(0, '127.0.0.1', resolve));

    process.env.PORT = String(await freePort());
    ({ server } = require('../server'));
    state = require('../lib/state');
    webos = require('../lib/webos');
    webos.SSAP_PORTS.tls = await freePort();
    await new Promise(resolve => server.listen(Number(process.env.PORT), '0.0.0.0', resolve));
    base = `http://127.0.0.1:${process.env.PORT}`;

    dashboard = { ws: new WebSocket(`ws://127.0.0.1:${process.env.PORT}`), messages: [] };
    dashboard.ws.on('message', (data) => dashboard.messages.push(JSON.parse(data)));
    await new Promise(resolve => dashboard.ws.once('open', resolve));
});

afterEach(async () => {
    await post('/api/stop', { ip: IP });
    state.devices.delete(IP);
    if (fake) await fake.close();
    fake = null;
    dashboard.messages.length = 0;
});

after(() => {
    dashboard.ws.close();
    for (const s of [server, upstream]) {
        s.closeAllConnections?.();
        s.close();
    }
    deviceListener.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function request(method, urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
}
const post = (urlPath, body) => request('POST', urlPath, body);
const video = (n) => `${cdn}/video-${n}.mp4`;

async function waitFor(predicate, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('Timed out waiting');
}

function mockChromecast() {
    state.devices.set(IP, {
        name: 'Mock Chromecast (Queue)', ip: IP, host: 'localhost', id: 'mock-queue',
        type: 'chromecast', isMock: true, port: deviceListener.address().port
    });
}
const receiver = () => state.activeSessions.get(IP)?.player.mockDevice;
const playing = () => receiver()?.media?.contentId;
const queued = async () => (await request('GET', `/api/queue/${IP}`)).body.items;

// ===== Chromecast =====

test('with nothing playing, play next starts the video at once', async () => {
    mockChromecast();
    const res = await post('/api/queue', { ip: IP, url: video(1), type: 'mp4', title: 'One' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'casting');
    assert.strictEqual(playing(), video(1));
    assert.deepStrictEqual(await queued(), []);
});

test('videos queue behind the one playing, and are announced to pages', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    const res = await post('/api/queue', { ip: IP, url: video(2), type: 'mp4', title: 'Two', page: 'https://example.com/two' });
    assert.strictEqual(res.body.queued, true);
    await post('/api/queue', { ip: IP, url: video(3), type: 'mp4' });

    const items = await queued();
    assert.deepStrictEqual(items.map(i => [i.title, i.url]), [['Two', 'https://example.com/two'], [null, video(3)]]);
    assert.strictEqual(playing(), video(1));
    const announced = dashboard.messages.filter(m => m.type === 'queue').at(-1);
    assert.deepStrictEqual(announced, { type: 'queue', deviceIp: IP, items });
});

test('a video played to its end is followed by the next one', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(3), type: 'mp4' });

    await waitFor(() => receiver()?.playerState === 'PLAYING');
    receiver().finish();
    await waitFor(() => playing() === video(2));
    assert.deepStrictEqual((await queued()).map(i => i.url), [video(3)]);
});

test('the last video ending leaves the device idle', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    await waitFor(() => receiver()?.playerState === 'PLAYING');
    receiver().finish();
    await waitFor(() => playing() === video(2));
    await waitFor(() => receiver()?.playerState === 'PLAYING');
    receiver().finish();
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(!state.activeSessions.has(IP));
});

test('next skips to the following video now', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4', title: 'Two' });
    const res = await post(`/api/queue/${IP}/next`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.item.title, 'Two');
    assert.deepStrictEqual(res.body.items, []);
    assert.strictEqual(playing(), video(2));
    assert.strictEqual((await post(`/api/queue/${IP}/next`, {})).status, 404);
});

test('an item can be taken out of the queue', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(3), type: 'mp4' });
    const [first] = await queued();
    const res = await post(`/api/queue/${IP}/remove`, { id: first.id });
    assert.deepStrictEqual(res.body.items.map(i => i.url), [video(3)]);
    assert.strictEqual((await post(`/api/queue/${IP}/remove`, { id: first.id })).status, 404);
});

test('stopping clears the queue, and nothing starts afterwards', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    await post('/api/stop', { ip: IP });
    assert.deepStrictEqual(await queued(), []);
    await new Promise(r => setTimeout(r, 2000));
    assert.ok(!state.activeSessions.has(IP));
});

test('casting something new replaces the queue', async () => {
    mockChromecast();
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    await post('/api/cast', { ip: IP, url: video(4), type: 'mp4' });
    assert.deepStrictEqual(await queued(), []);
});

test('queue requests are checked like casts', async () => {
    assert.strictEqual((await post('/api/queue', { ip: 'nope', url: video(1) })).status, 400);
    assert.strictEqual((await post('/api/queue', { ip: IP, url: 'file:///etc/passwd' })).status, 400);
    assert.strictEqual((await request('GET', '/api/queue/nope')).status, 400);
    assert.strictEqual((await post('/api/queue/nope/next', {})).status, 400);
});

// ===== Apple TV =====

test('on an Apple TV the queue moves on with Next', async () => {
    fake = createFakeAppleTv();
    const port = await fake.listen();
    state.devices.set(IP, { name: 'Apple TV', ip: IP, port, type: 'airplay' });
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });
    // DASH can't be queued for an Apple TV any more than it can be cast.
    assert.strictEqual((await post('/api/queue', { ip: IP, url: `${cdn}/x.mpd` })).status, 400);

    const res = await post(`/api/queue/${IP}/next`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(fake.state.playing, video(2));
});

// ===== LG TV =====

test('on an LG TV the browser stays up between videos, and goes back to the TV after the last', async () => {
    fake = createFakeLgTv();
    webos.SSAP_PORTS.plain = await fake.listen();
    state.devices.set(IP, { name: 'LG OLED', ip: IP, type: 'webos' });
    await post('/api/cast', { ip: IP, url: video(1), type: 'mp4' });
    await post('/api/queue', { ip: IP, url: video(2), type: 'mp4' });

    fake.lastPlayer().report({ playerState: 'IDLE', currentTime: 60 });
    await waitFor(() => fake.state.players.length === 2 && fake.state.players[1].messages.some(m => m.type === 'webosMedia'));
    const media = fake.state.players[1].messages.find(m => m.type === 'webosMedia');
    assert.strictEqual(new URL(media.src).searchParams.get('url'), video(2));
    // Straight from one video to the next, not back to live TV in between.
    assert.deepStrictEqual(fake.state.launched.map(l => l.id), ['com.webos.app.browser', 'com.webos.app.browser']);

    fake.lastPlayer().report({ playerState: 'IDLE', currentTime: 60 });
    await waitFor(() => fake.state.launched.some(l => l.id === 'com.webos.app.livetv'));
    assert.ok(!state.activeWebOsSessions.has(IP));
});
