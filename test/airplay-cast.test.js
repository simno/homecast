// Casting to an Apple TV (lib/airplay.js, lib/airplay-pairing.js,
// routes/airplay-pairing.js) through the fully wired app, against the fake
// Apple TV in fake-apple-tv.js: discovery, PIN pairing and pair-verify, the
// /play handshake, remote control, stopping, and an unreachable device.
process.env.DISABLE_CSRF = 'true';            // server.test.js covers CSRF

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createFakeAppleTv } = require('./fake-apple-tv');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-airplay-'));
process.env.AIRPLAY_PAIRING_STORE = path.join(tmpDir, 'pairings.json');

const { server } = require('../server');
const { devices, activeAirPlaySessions, streamStats } = require('../lib/state');
const mdns = require('../lib/mdns');
const airplay = require('../lib/airplay');
const pairingStore = require('../lib/airplay-pairing-store');
const { clearPairVerifySession } = require('../lib/airplay-pairing');

const IP = '127.0.0.1';
const PIN = '4321';
const STREAM = 'https://cdn.example.com/show/master.m3u8';

let base;
let tv;

before(async () => {
    await pairingStore.initPairingStore();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

// A fresh Apple TV on its own port for each test, registered as discovered.
async function appleTv(options) {
    tv = createFakeAppleTv(options);
    const port = await tv.listen();
    devices.set(IP, { name: 'Living Room', ip: IP, port, id: 'AA:BB:CC:DD:EE:FF', type: 'airplay', features: 0x5A7FFFF7 });
    return tv;
}

afterEach(async () => {
    activeAirPlaySessions.delete(IP);
    streamStats.delete(IP);
    devices.delete(IP);
    clearPairVerifySession(IP);
    await pairingStore.removePairing(IP);
    if (tv) await tv.close();
    tv = null;
});

after(() => {
    server.closeAllConnections();
    server.close();
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
const cast = (body = {}) => post('/api/cast', { ip: IP, url: STREAM, proxy: false, deviceType: 'airplay', ...body });
const control = (action, value) => post('/api/playback', { ip: IP, action, value });

// ===== Casting =====

test('an Apple TV that allows everyone plays the stream straight away', async () => {
    await appleTv();
    const res = await cast();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { status: 'casting', deviceType: 'airplay' });
    assert.strictEqual(tv.state.playing, STREAM);
    assert.ok(activeAirPlaySessions.has(IP));

    const session = await request('GET', `/api/session/${IP}`);
    assert.strictEqual(session.body.type, 'airplay');
    const sessions = await request('GET', '/api/sessions');
    assert.deepStrictEqual(sessions.body.sessions, [{ ip: IP, type: 'airplay', deviceName: 'Living Room' }]);
});

test('a proxied cast hands the Apple TV a HomeCast proxy URL', async () => {
    await appleTv();
    await cast({ proxy: true, referer: 'https://example.com/watch' });
    const played = new URL(tv.state.playing);
    assert.strictEqual(played.pathname, '/proxy');
    assert.strictEqual(played.searchParams.get('url'), STREAM);
    assert.strictEqual(played.searchParams.get('referer'), 'https://example.com/watch');
});

test('DASH is refused before the Apple TV is contacted', async () => {
    await appleTv();
    const res = await cast({ url: 'https://cdn.example.com/show/manifest.mpd' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /DASH/);
    assert.strictEqual(tv.state.requests.length, 0);
});

test('casting again replaces the session on the device', async () => {
    await appleTv();
    await cast();
    await cast({ url: 'https://cdn.example.com/other.mp4' });
    const paths = tv.state.requests.map(r => `${r.method} ${r.path}`);
    assert.deepStrictEqual(paths, ['POST /play', 'POST /stop', 'POST /play']);
    assert.strictEqual(tv.state.playing, 'https://cdn.example.com/other.mp4');
});

test('an Apple TV that is not reachable gives a connection error', async () => {
    // A port with nothing listening on it.
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    devices.set(IP, { name: 'Gone', ip: IP, port, type: 'airplay' });

    const res = await cast();
    assert.strictEqual(res.status, 500);
    assert.match(res.body.error, /Could not connect to AirPlay device/);
    assert.ok(res.body.troubleshooting);
    assert.ok(!activeAirPlaySessions.has(IP));
});

// ===== Pairing =====

test('an Apple TV that wants a PIN asks for pairing', async () => {
    await appleTv({ pin: PIN });
    const res = await cast();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.needsPairing, true);
    assert.strictEqual(res.body.deviceName, 'Living Room');
    assert.ok(!activeAirPlaySessions.has(IP));
});

test('a wrong PIN is reported as such and nothing is stored', async () => {
    await appleTv({ pin: PIN });
    const res = await post(`/api/airplay/pair/${IP}`, { pin: '9999' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'WRONG_PIN');
    assert.strictEqual(pairingStore.isPaired(IP), false);
});

test('pairing with the right PIN completes SRP and pair-verify, then casting works', async () => {
    await appleTv({ pin: PIN });
    const res = await post(`/api/airplay/pair/${IP}`, { pin: PIN });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { success: true, deviceName: 'Living Room', deviceIp: IP });

    // The accessory's key came out of the encrypted part of its proof, and
    // was good enough to check its pair-verify signature.
    const stored = pairingStore.getPairing(IP);
    assert.strictEqual(Buffer.from(stored.serverEd25519PubKey, 'base64').length, 32);
    assert.strictEqual(tv.state.verified, true);

    const status = await request('GET', `/api/airplay/pairing-status/${IP}`);
    assert.strictEqual(status.body.paired, true);
    const list = await request('GET', '/api/airplay/paired-devices');
    assert.deepStrictEqual(list.body.devices.map(d => ({ ip: d.ip, online: d.online, currentName: d.currentName })),
        [{ ip: IP, online: true, currentName: 'Living Room' }]);

    const played = await cast();
    assert.strictEqual(played.status, 200, JSON.stringify(played.body));
    assert.strictEqual(tv.state.playing, STREAM);
});

test('a paired Apple TV that has forgotten the session is verified again on cast', async () => {
    await appleTv({ pin: PIN });
    await post(`/api/airplay/pair/${IP}`, { pin: PIN });
    tv.forgetVerify();
    clearPairVerifySession(IP);
    tv.state.requests.length = 0;

    const res = await cast();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(tv.state.requests.map(r => r.path), ['/play', '/pair-verify', '/play']);
});

test('unpairing forgets the device', async () => {
    await appleTv({ pin: PIN });
    await post(`/api/airplay/pair/${IP}`, { pin: PIN });
    const res = await post(`/api/airplay/unpair/${IP}`, {});
    assert.deepStrictEqual(res.body, { success: true });
    assert.strictEqual(pairingStore.isPaired(IP), false);
    const status = await request('GET', `/api/airplay/pairing-status/${IP}`);
    assert.strictEqual(status.body.paired, false);
});

test('pairing requests are validated', async () => {
    assert.strictEqual((await post('/api/airplay/pair/not-an-ip', { pin: PIN })).status, 400);
    assert.strictEqual((await post(`/api/airplay/pair/${IP}`, { pin: '12' })).status, 400);
    assert.strictEqual((await post(`/api/airplay/pair/${IP}`, { pin: 'abcd' })).status, 400);
    assert.strictEqual((await request('GET', '/api/airplay/pairing-status/999.1.1.1')).status, 400);
    assert.strictEqual((await post('/api/airplay/unpair/x', {})).status, 400);
});

// ===== Remote control =====

test('pause and resume set the playback rate', async () => {
    await appleTv();
    await cast();
    assert.strictEqual((await control('pause')).status, 200);
    assert.strictEqual(tv.state.rate, 0);
    assert.strictEqual((await control('play')).status, 200);
    assert.strictEqual(tv.state.rate, 1);
});

test('seeking skips from the current position and stays inside the video', async () => {
    await appleTv({ position: 30, duration: 600 });
    await cast();
    await control('seek', 10);
    assert.strictEqual(tv.state.scrubbedTo, 40);
    await control('seek', -120);
    assert.strictEqual(tv.state.scrubbedTo, 0);
    await control('seekTo', 5000);
    assert.strictEqual(tv.state.scrubbedTo, 599);
});

test('go live scrubs to just short of the end of the live window', async () => {
    await appleTv({ liveWindow: { start: 1000, duration: 120 } });
    await cast();
    const res = await control('live');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(tv.state.scrubbedTo, 1000 + 120 - 15);
});

test('go live on a stream with no live window is an error', async () => {
    await appleTv();
    await cast();
    const res = await control('live');
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, /live window/);
    assert.strictEqual(tv.state.scrubbedTo, null);
});

test('the volume is left to the Apple TV remote', async () => {
    await appleTv();
    await cast();
    assert.strictEqual((await control('volume', 0.5)).status, 400);
    assert.strictEqual((await control('mute', true)).status, 400);
    assert.strictEqual((await post('/api/subtitles', { ip: IP, trackId: null })).status, 400);
});

test('stopping ends the session on the device', async () => {
    await appleTv();
    await cast();
    const res = await post('/api/stop', { ip: IP });
    assert.deepStrictEqual(res.body, { status: 'stopped' });
    assert.strictEqual(tv.state.playing, null);
    assert.ok(!activeAirPlaySessions.has(IP));
    assert.strictEqual((await control('pause')).status, 404);
});

// ===== Health =====

test('the health check asks the device for its server info', async () => {
    await appleTv();
    await cast();
    await airplay.checkAirPlayHealth(IP);
    assert.ok(tv.state.requests.some(r => r.path === '/server-info'));
});

// ===== Discovery =====

function fakeBrowser(t) {
    const EventEmitter = require('events');
    const browser = Object.assign(new EventEmitter(), { discover: t.mock.fn() });
    t.mock.method(mdns, 'createBrowser', () => browser);
    t.mock.timers.enable({ apis: ['setInterval'] });
    airplay.initAirPlayDiscovery();
    return browser;
}

const announcement = (overrides = {}) => ({
    type: [{ name: 'airplay', protocol: 'tcp' }],
    instance: 'Bedroom',
    host: 'Bedroom.local',
    port: 7000,
    addresses: ['192.168.1.40'],
    txt: ['deviceid=11:22:33:44:55:66', 'features=0x5A7FFFF7,0x1E', 'fn=Bedroom Apple TV'],
    ...overrides
});

test('discovery adds Apple TVs that play AirPlay 1 video, with their port', (t) => {
    const browser = fakeBrowser(t);
    browser.emit('ready');
    assert.strictEqual(browser.discover.mock.callCount(), 1);

    browser.emit('update', announcement({ port: 7100 }));
    const device = devices.get('192.168.1.40');
    assert.deepStrictEqual({ name: device.name, port: device.port, id: device.id, type: device.type },
        { name: 'Bedroom Apple TV', port: 7100, id: '11:22:33:44:55:66', type: 'airplay' });
    devices.delete('192.168.1.40');
});

test('discovery skips speakers and AirPlay 2-only TVs', (t) => {
    const browser = fakeBrowser(t);
    browser.emit('update', announcement({ txt: ['deviceid=AA', 'features=0x4A7FCA00', 'fn=Kitchen Speaker'] }));
    browser.emit('update', announcement({ type: [{ name: 'raop', protocol: 'tcp' }] }));
    browser.emit('update', announcement({ addresses: [] }));
    assert.ok(!devices.has('192.168.1.40'));
});

test('discovery keeps one entry per Apple TV seen on two addresses', (t) => {
    const browser = fakeBrowser(t);
    browser.emit('update', announcement());
    browser.emit('update', announcement({ addresses: ['192.168.1.41'] }));
    assert.ok(devices.has('192.168.1.40'));
    assert.ok(!devices.has('192.168.1.41'));
    devices.delete('192.168.1.40');
});

// ===== Parsing =====

test('liveEdge reads the end of the last seekable range', () => {
    const plist = (ranges) => `<plist><dict><key>seekableTimeRanges</key><array>${ranges}</array></dict></plist>`;
    const range = (start, duration) => `<dict><key>duration</key><real>${duration}</real><key>start</key><integer>${start}</integer></dict>`;
    assert.strictEqual(airplay.liveEdge(plist(range(0, 60) + range(100, 30.5))), 130.5);
    assert.strictEqual(airplay.liveEdge(plist('')), null);
    assert.strictEqual(airplay.liveEdge('<plist><dict></dict></plist>'), null);
});
