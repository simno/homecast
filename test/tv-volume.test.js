// A Chromecast that leaves its volume to the TV (lib/cast.js linkTvVolume):
// its slider turns the LG TV it's plugged into up and down instead, found as
// the paired LG TV showing an HDMI input. The mock Chromecast plays on
// 127.0.0.1, the fake LG TV (fake-lg-tv.js) answers as "localhost".
process.env.NODE_ENV = 'development';        // lets cast.js use the mock client
process.env.DISABLE_SSRF_PROTECTION = 'true';
process.env.DISABLE_CSRF = 'true';

const { test, before, after, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createFakeLgTv } = require('./fake-lg-tv');

const CAST_IP = '127.0.0.1';
const TV_IP = 'localhost';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-tv-volume-'));
process.env.WEBOS_KEY_STORE = path.join(tmpDir, 'webos-keys.json');

let base;
let cdn;
let server;
let state;
let webos;
let deviceListener;
let page;
let tv;

const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1024 });
    res.end(Buffer.alloc(1024));
});

const freePort = async () => {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
};

function pairTv(paired) {
    fs.writeFileSync(process.env.WEBOS_KEY_STORE, JSON.stringify({ version: 1, keys: paired ? { [TV_IP]: { key: 'key-1', mac: null, name: 'LG OLED' } } : {} }));
    return webos.initKeyStore();
}

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

    page = { ws: new WebSocket(`ws://127.0.0.1:${process.env.PORT}`), messages: [] };
    page.ws.on('message', (data) => page.messages.push(JSON.parse(data)));
    await new Promise(resolve => page.ws.once('open', resolve));
});

async function lgTv(options = {}) {
    tv = createFakeLgTv({ knownKey: 'key-1', foregroundApp: 'com.webos.app.hdmi2', volume: 12, ...options });
    webos.SSAP_PORTS.plain = await tv.listen();
    state.devices.set(TV_IP, { name: 'LG OLED', ip: TV_IP, type: 'webos' });
}

afterEach(async () => {
    await post('/api/stop', { ip: CAST_IP });
    state.devices.delete(CAST_IP);
    state.devices.delete(TV_IP);
    if (tv) await tv.close();
    tv = null;
    page.messages.length = 0;
});

after(() => {
    page.ws.close();
    for (const s of [server, upstream]) {
        s.closeAllConnections?.();
        s.close();
    }
    deviceListener.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function post(urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('Timed out waiting');
}

// A Chromecast whose volume control is `controlType` ('master': it passes
// volume to the TV over HDMI), playing a video.
async function castTo({ controlType = 'master', ignoresLevel = false } = {}) {
    state.devices.set(CAST_IP, {
        name: 'Chromecast', ip: CAST_IP, host: 'localhost', id: 'cc-1',
        type: 'chromecast', isMock: true, port: deviceListener.address().port
    });
    const res = await post('/api/cast', { ip: CAST_IP, url: `${cdn}/v.mp4`, type: 'mp4', proxy: false });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const client = state.activeSessions.get(CAST_IP).client;
    client.ignoresLevel = ignoresLevel;
    client.volume = { ...client.volume, controlType };
    client.emit('status', { volume: client.volume });
    return client;
}

const session = () => state.activeSessions.get(CAST_IP);
const control = (action, value) => post('/api/playback', { ip: CAST_IP, action, value });

test('a Chromecast that leaves volume to the TV gets its LG TV\'s volume on the slider', async () => {
    await pairTv(true);
    await lgTv();
    const client = await castTo();

    const shown = await waitFor(() => page.messages.find(m => m.type === 'volume' && m.volume.via));
    assert.deepStrictEqual(shown.volume, { level: 0.12, muted: false, fixed: false, via: 'LG OLED' });

    // The slider sets the TV, not the Chromecast.
    const res = await control('volume', 0.3);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.volume, { level: 0.3, muted: false, fixed: false, via: 'LG OLED' });
    assert.strictEqual(tv.state.volume, 30);
    assert.strictEqual(client.volume.level, 0.5);

    await control('mute', true);
    assert.strictEqual(tv.state.muted, true);

    // The TV's own remote moves the slider too.
    tv.changeVolume(45);
    await waitFor(() => page.messages.some(m => m.type === 'volume' && m.volume.level === 0.45 && m.volume.via));
    assert.strictEqual(session().volume.level, 0.45);
});

test('one that just ignores the level has it applied on the TV, with no warning', async () => {
    await pairTv(true);
    await lgTv();
    await castTo({ controlType: 'attenuation', ignoresLevel: true });

    await control('volume', 0.2);
    await waitFor(() => tv.state.volume === 20, 6000);
    assert.ok(!page.messages.some(m => m.type === 'castNotice'), 'no "use the TV remote" warning');
    assert.strictEqual(session().volume.via, 'LG OLED');
});

test('a TV that isn\'t showing an HDMI input isn\'t taken for the Chromecast\'s', async () => {
    await pairTv(true);
    await lgTv({ foregroundApp: 'com.webos.app.livetv' });
    await castTo({ controlType: 'attenuation', ignoresLevel: true });

    await control('volume', 0.2);
    const notice = await waitFor(() => page.messages.find(m => m.type === 'castNotice'), 6000);
    assert.match(notice.message, /TV remote/);
    assert.strictEqual(tv.state.volume, 12);
    assert.strictEqual(session().volume.via, undefined);
});

test('a TV HomeCast was never allowed on isn\'t asked (no prompt on it)', async () => {
    await pairTv(false);
    await lgTv({ knownKey: null });
    await castTo({ controlType: 'fixed' });
    await new Promise(r => setTimeout(r, 4000));
    assert.strictEqual(tv.state.prompts, 0);
    assert.strictEqual(session().volume.fixed, true);
});

test('stopping the cast lets go of the TV', async () => {
    await pairTv(true);
    await lgTv();
    await castTo();
    await waitFor(() => session()?.volumeTv);
    await post('/api/stop', { ip: CAST_IP });
    tv.changeVolume(70);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!page.messages.some(m => m.type === 'volume' && m.volume.level === 0.7), 'no more volume from the TV');
});
