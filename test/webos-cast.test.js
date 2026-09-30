// Casting to an LG TV (lib/webos.js) through the fully wired app, against the
// fake TV in fake-lg-tv.js: the first-cast prompt and the stored key, opening
// the player page and handing it the stream, transport and volume control,
// full screen clicks, stopping, and SSDP discovery.
process.env.DISABLE_CSRF = 'true';            // server.test.js covers CSRF
process.env.DISABLE_SSRF_PROTECTION = 'true'; // the TV's description lives on 127.0.0.1
process.env.HOST_IP = '127.0.0.1';            // where the TV's browser finds HomeCast

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const dgram = require('dgram');
const EventEmitter = require('events');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createFakeLgTv } = require('./fake-lg-tv');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-webos-'));
process.env.WEBOS_KEY_STORE = path.join(tmpDir, 'webos-keys.json');

const IP = '127.0.0.1';
const STREAM = 'https://cdn.example.com/show/master.m3u8';

let server;
let devices;
let activeWebOsSessions;
let webos;
let base;
let tv;
let dashboard;

const freePort = async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
};

before(async () => {
    // The player page URL the TV opens is built from PORT, read on load.
    process.env.PORT = String(await freePort());
    ({ server } = require('../server'));
    ({ devices, activeWebOsSessions } = require('../lib/state'));
    webos = require('../lib/webos');
    await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
    base = `http://127.0.0.1:${process.env.PORT}`;
    // Only the plain SSAP port answers: the TLS attempt is refused first.
    webos.SSAP_PORTS.tls = await freePort();

    // A dashboard page, collecting what HomeCast broadcasts.
    dashboard = { ws: new WebSocket(`ws://127.0.0.1:${process.env.PORT}`), messages: [] };
    dashboard.ws.on('message', (data) => dashboard.messages.push(JSON.parse(data)));
    await new Promise(resolve => dashboard.ws.once('open', resolve));
});

async function lgTv(options) {
    tv = createFakeLgTv(options);
    webos.SSAP_PORTS.plain = await tv.listen();
    devices.set(IP, { name: 'LG OLED', ip: IP, host: IP, id: 'lg-1', type: 'webos' });
    return tv;
}

afterEach(async () => {
    if (activeWebOsSessions.has(IP)) await post('/api/stop', { ip: IP });
    devices.delete(IP);
    if (tv) await tv.close();
    tv = null;
    dashboard.messages.length = 0;
});

after(() => {
    dashboard.ws.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
}
const cast = (body = {}) => post('/api/cast', { ip: IP, url: STREAM, proxy: true, deviceType: 'webos', ...body });
const control = (action, value) => post('/api/playback', { ip: IP, action, value });

async function waitFor(predicate, ms = 3000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('Timed out waiting');
}

const storedKeys = () => JSON.parse(fs.readFileSync(process.env.WEBOS_KEY_STORE, 'utf8')).keys;

// ===== Casting =====

test('the first cast shows the prompt, keeps the key, and hands the player page the stream', async () => {
    await lgTv();
    const res = await cast({ subtitle: { url: 'https://cdn.example.com/show/en.vtt', language: 'en' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body, { status: 'casting', deviceType: 'webos', volume: { level: 0.12, muted: false } });

    assert.strictEqual(tv.state.prompts, 1);
    assert.ok(dashboard.messages.some(m => m.type === 'status' && /Accept HomeCast on LG OLED/.test(m.status)));
    assert.strictEqual(storedKeys()[IP].key, 'key-1');

    // The browser was sent to the player page, which got the stream through the proxy.
    const [launch] = tv.state.launched;
    assert.strictEqual(launch.id, 'com.webos.app.browser');
    assert.match(launch.params.target, new RegExp(`^${base}/webos-player\\.html\\?session=`));
    const media = tv.lastPlayer().messages.find(m => m.type === 'webosMedia');
    const src = new URL(media.src);
    assert.strictEqual(src.pathname, '/proxy');
    assert.strictEqual(src.searchParams.get('url'), STREAM);
    assert.strictEqual(src.searchParams.get('device'), 'webos');
    assert.strictEqual(new URL(media.sub).searchParams.get('url'), 'https://cdn.example.com/show/en.vtt');
    assert.strictEqual(media.subLang, 'en');
    assert.strictEqual(media.dash, false);
});

test('a TV that knows HomeCast is cast to without a prompt', async () => {
    await lgTv({ knownKey: 'key-1' });
    const res = await cast();
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(tv.state.prompts, 0);
});

test('DASH is played on the page with dash.js', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast({ url: 'https://cdn.example.com/show/manifest.mpd' });
    const media = tv.lastPlayer().messages.find(m => m.type === 'webosMedia');
    assert.strictEqual(media.dash, true);
});

test('a new cast stops the page of the one it replaces', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    const first = tv.lastPlayer();
    await cast({ url: 'https://cdn.example.com/other.m3u8' });
    await waitFor(() => first.commands().includes('stop'));
    assert.strictEqual(tv.state.players.length, 2);
});

test('a TV whose viewer declines the prompt is reported', async () => {
    await lgTv({ prompt: 'decline' });
    const res = await cast();
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, /declined/);
    assert.ok(!activeWebOsSessions.has(IP));
});

test('a paired TV that is off, with no MAC address to wake it by, is reported', async () => {
    // Paired by the tests above; nothing answers on its port now.
    devices.set(IP, { name: 'LG OLED', ip: IP, type: 'webos' });
    webos.SSAP_PORTS.plain = await freePort();
    const res = await cast();
    assert.strictEqual(res.status, 502);
    assert.match(res.body.error, /does not know its MAC address/);
});

test('connecting again does not rewrite a key that has not changed', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    const before = fs.statSync(process.env.WEBOS_KEY_STORE).mtimeMs;
    await control('volume', 0.2);
    await control('mute', false);
    assert.strictEqual(fs.statSync(process.env.WEBOS_KEY_STORE).mtimeMs, before);
});

// ===== Control =====

test('transport controls go to the player page', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    const player = tv.lastPlayer();
    for (const [action, value] of [['pause'], ['play'], ['seek', 30], ['seekTo', 120], ['live']]) {
        assert.strictEqual((await control(action, value)).status, 200);
    }
    await waitFor(() => player.commands().length === 5);
    assert.deepStrictEqual(player.commands(), ['pause', 'play', 'seek', 'seekTo', 'live']);
    assert.strictEqual(player.messages.find(m => m.action === 'seek').value, 30);
});

test('volume and mute are set on the TV itself', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    const res = await control('volume', 0.3);
    assert.deepStrictEqual(res.body, { volume: { level: 0.3, muted: false } });
    assert.strictEqual(tv.state.volume, 30);
    await control('mute', true);
    assert.strictEqual(tv.state.muted, true);
});

test('a volume change on the TV reaches the dashboard', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    // The watch connection subscribes just after the cast starts.
    await waitFor(() => activeWebOsSessions.get(IP)?.volumeTv);
    tv.changeVolume(45);
    const msg = await waitFor(() => dashboard.messages.find(m => m.type === 'volume' && m.volume.level === 0.45));
    assert.strictEqual(msg.deviceIp, IP);
});

test('the player page reports playback to the dashboard, with its delay behind live', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    tv.lastPlayer().report({ playerState: 'PLAYING', currentTime: 90, live: true, seekableStart: 0, seekableEnd: 100, fullscreen: true });
    const msg = await waitFor(() => dashboard.messages.find(m => m.type === 'playerStatus' && m.status.playerState === 'PLAYING'));
    assert.strictEqual(msg.delay, 10);
    assert.strictEqual(msg.status.media.streamType, 'LIVE');
    assert.deepStrictEqual(msg.status.liveSeekableRange, { start: 0, end: 100, isMovingWindow: true });
});

test('a page that is not full screen is clicked with the pointer', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    tv.lastPlayer().report({ playerState: 'PLAYING', currentTime: 1, fullscreen: false });
    await waitFor(() => tv.state.pointer.includes('type:button'));
    assert.deepStrictEqual(tv.state.pointer, ['type:move', 'type:move', 'type:click', 'type:button']);
});

test('a playback error on the TV is shown on the dashboard', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    tv.lastPlayer().report({ playerState: 'IDLE', error: 'a network error' });
    await waitFor(() => !activeWebOsSessions.has(IP));
});

// ===== Stopping =====

test('stopping stops the page and returns the TV to what it was showing', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    const player = tv.lastPlayer();
    const res = await post('/api/stop', { ip: IP });
    assert.deepStrictEqual(res.body, { status: 'stopped' });
    await waitFor(() => player.commands().includes('stop'));
    assert.deepStrictEqual(tv.state.launched.at(-1), { id: 'com.webos.app.livetv' });
    assert.ok(!activeWebOsSessions.has(IP));
});

test('stopping closes the browser when the TV was showing nothing to go back to', async () => {
    await lgTv({ knownKey: 'key-1', foregroundApp: null });
    await cast();
    await post('/api/stop', { ip: IP });
    assert.deepStrictEqual(tv.state.closed, [{ id: 'com.webos.app.browser', sessionId: 'browser-1' }]);
});

test('a video played to its end ends the session like Stop', async () => {
    await lgTv({ knownKey: 'key-1' });
    await cast();
    tv.lastPlayer().report({ playerState: 'IDLE', currentTime: 600 });
    await waitFor(() => !activeWebOsSessions.has(IP));
    await waitFor(() => tv.state.launched.some(l => l.id === 'com.webos.app.livetv'));
});

// ===== Discovery =====

test('SSDP discovery names the TV from its device description', async (t) => {
    const description = http.createServer((req, res) => {
        res.end('<root><device><friendlyName>Bedroom OLED</friendlyName></device></root>');
    });
    await new Promise(resolve => description.listen(0, '127.0.0.1', resolve));
    t.after(() => description.close());

    const socket = Object.assign(new EventEmitter(), {
        bind: (cb) => cb(),
        send: t.mock.fn(),
        close: () => {}
    });
    t.mock.method(dgram, 'createSocket', () => socket);
    webos.initWebOsDiscovery();
    assert.match(String(socket.send.mock.calls[0].arguments[0]), /ST: urn:lge-com:service:webos-second-screen:1/);

    socket.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nST: urn:lge-com:service:webos-second-screen:1\r\n' +
        `LOCATION: http://127.0.0.1:${description.address().port}/desc.xml\r\nUSN: uuid:abc-123::urn:lge\r\n\r\n`),
    { address: '192.168.1.60' });
    const device = await waitFor(() => devices.get('192.168.1.60'));
    assert.deepStrictEqual(device, { name: 'Bedroom OLED', ip: '192.168.1.60', host: '192.168.1.60', id: 'abc-123', type: 'webos' });

    // A Cast TV on the same address stays a Cast device, flagged as webOS too.
    devices.set('192.168.1.61', { name: 'Den TV', ip: '192.168.1.61', type: 'chromecast' });
    socket.emit('message', Buffer.from('ST: urn:lge-com:service:webos-second-screen:1\r\n\r\n'), { address: '192.168.1.61' });
    await waitFor(() => devices.get('192.168.1.61').webos);
    assert.strictEqual(devices.get('192.168.1.61').type, 'chromecast');

    // Other SSDP answers are ignored.
    socket.emit('message', Buffer.from('ST: upnp:rootdevice\r\n\r\n'), { address: '192.168.1.62' });
    assert.ok(!devices.has('192.168.1.62'));
    devices.delete('192.168.1.60');
    devices.delete('192.168.1.61');
});
