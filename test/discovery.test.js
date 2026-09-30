// Chromecast discovery (lib/discovery.js): mDNS and SSDP answers becoming
// devices, one entry per device, what other discovery found first, rescans,
// and removing devices that have gone quiet. The sockets and timers are fakes.
const { test, before, after, afterEach, mock } = require('node:test');
const assert = require('assert');
const dgram = require('dgram');
const EventEmitter = require('events');
const http = require('http');
const mdns = require('../lib/mdns');
const { devices, deviceLastSeen, activeSessions } = require('../lib/state');
const { initDiscovery, onRescan, rescanDevices } = require('../lib/discovery');
const { STALE_DEVICE_TIMEOUT_MS } = require('../lib/utils');

let browser;
let ssdp;
// Device description answers by IP (fetched from http://<ip>:8008).
const descriptions = new Map();

before(() => {
    browser = Object.assign(new EventEmitter(), { discover: mock.fn() });
    mock.method(mdns, 'createBrowser', () => browser);

    ssdp = Object.assign(new EventEmitter(), {
        bind: (cb) => cb(),
        address: () => ({ port: 50000 }),
        addMembership: mock.fn(),
        send: mock.fn(),
        close: () => {}
    });
    mock.method(dgram, 'createSocket', () => ssdp);

    mock.method(http, 'get', (url, options, callback) => {
        const req = Object.assign(new EventEmitter(), { destroy: () => {} });
        const ip = new URL(url).hostname;
        setImmediate(() => {
            if (!descriptions.has(ip)) return req.emit('error', new Error('ECONNREFUSED'));
            const res = new EventEmitter();
            callback(res);
            res.emit('data', `<root><device><friendlyName>${descriptions.get(ip)}</friendlyName></device></root>`);
            res.emit('end');
        });
        return req;
    });

    mock.timers.enable({ apis: ['setInterval'] });
    initDiscovery();
});

afterEach(() => {
    devices.clear();
    deviceLastSeen.clear();
    activeSessions.clear();
    descriptions.clear();
});

after(() => mock.reset());

const castAnnouncement = (overrides = {}) => ({
    type: [{ name: 'googlecast', protocol: 'tcp' }],
    instance: 'Chromecast-abc',
    addresses: ['192.168.1.20'],
    txt: ['id=abc123', 'fn=Living Room', 'md=Chromecast'],
    ...overrides
});

const ssdpAnswer = (ip, usn = 'uuid:tv-1') => Buffer.from(
    'HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n' +
    `LOCATION: http://${ip}:8008/ssdp/device-desc.xml\r\nUSN: ${usn}::urn:dial\r\n\r\n`);

async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(r => setImmediate(r));
    }
    throw new Error('Timed out waiting');
}

test('the mDNS browser asks for Cast devices once ready', () => {
    browser.emit('ready');
    assert.ok(browser.discover.mock.callCount() >= 1);
});

test('an mDNS answer adds a Chromecast under its friendly name', () => {
    browser.emit('update', castAnnouncement());
    assert.deepStrictEqual(devices.get('192.168.1.20'),
        { name: 'Living Room', ip: '192.168.1.20', host: '192.168.1.20', id: 'abc123', type: 'chromecast' });
    assert.ok(deviceLastSeen.has('192.168.1.20'));
});

test('an mDNS answer with no name in TXT uses the instance name', () => {
    browser.emit('update', castAnnouncement({ txt: [] }));
    assert.strictEqual(devices.get('192.168.1.20').name, 'Chromecast-abc');
});

test('SSDP searches for DIAL devices and names them from their description', async () => {
    assert.match(String(ssdp.send.mock.calls[0].arguments[0]), /ST: urn:dial-multiscreen-org:service:dial:1/);
    assert.strictEqual(ssdp.addMembership.mock.calls[0].arguments[0], '239.255.255.250');

    descriptions.set('192.168.1.30', 'Bedroom TV');
    ssdp.emit('message', ssdpAnswer('192.168.1.30'));
    await waitFor(() => devices.has('192.168.1.30'));
    assert.deepStrictEqual(devices.get('192.168.1.30'),
        { name: 'Bedroom TV', ip: '192.168.1.30', host: '192.168.1.30', id: 'tv-1', type: 'chromecast' });
});

test('an SSDP device without a readable description gets a generic name', async () => {
    ssdp.emit('message', ssdpAnswer('192.168.1.31', 'uuid:tv-2'));
    await waitFor(() => devices.has('192.168.1.31'));
    assert.strictEqual(devices.get('192.168.1.31').name, 'Chromecast (192.168.1.31)');
});

test('SSDP answers for other services, or from loopback, are ignored', async () => {
    ssdp.emit('message', Buffer.from('ST: upnp:rootdevice\r\nLOCATION: http://192.168.1.32:8008/\r\n\r\n'));
    ssdp.emit('message', ssdpAnswer('127.0.0.1'));
    await new Promise(r => setImmediate(r));
    assert.strictEqual(devices.size, 0);
});

test('the same device seen on two addresses keeps one entry', () => {
    browser.emit('update', castAnnouncement());
    browser.emit('update', castAnnouncement({ addresses: ['192.168.1.21'] }));
    assert.deepStrictEqual([...devices.keys()], ['192.168.1.20']);
});

test('an Apple TV on the same address is left alone', () => {
    devices.set('192.168.1.20', { name: 'Apple TV', ip: '192.168.1.20', type: 'airplay' });
    browser.emit('update', castAnnouncement());
    assert.strictEqual(devices.get('192.168.1.20').type, 'airplay');
});

test('an LG TV found over SSDP first becomes a Cast device that also plays in its browser', () => {
    devices.set('192.168.1.20', { name: 'LG TV', ip: '192.168.1.20', type: 'webos' });
    browser.emit('update', castAnnouncement({ txt: ['id=lg1', 'fn=LG OLED'] }));
    assert.deepStrictEqual(devices.get('192.168.1.20'),
        { name: 'LG OLED', ip: '192.168.1.20', host: '192.168.1.20', id: 'lg1', type: 'chromecast', webos: true });
});

test('other mDNS answers from a known device count as seeing it', () => {
    devices.set('192.168.1.20', { name: 'Living Room', ip: '192.168.1.20', type: 'chromecast' });
    deviceLastSeen.set('192.168.1.20', 0);
    browser.emit('update', { type: [{ name: 'spotify-connect', protocol: 'tcp' }], addresses: ['192.168.1.20'], txt: [] });
    assert.ok(deviceLastSeen.get('192.168.1.20') > 0);
});

test('a rescan runs every registered search again', () => {
    const searches = ssdp.send.mock.callCount();
    const discovers = browser.discover.mock.callCount();
    const extra = mock.fn();
    onRescan(extra);
    rescanDevices();
    assert.strictEqual(ssdp.send.mock.callCount(), searches + 1);
    assert.strictEqual(browser.discover.mock.callCount(), discovers + 1);
    assert.strictEqual(extra.mock.callCount(), 1);
});

test('the searches repeat every 30 seconds', () => {
    const searches = ssdp.send.mock.callCount();
    mock.timers.tick(30000);
    assert.strictEqual(ssdp.send.mock.callCount(), searches + 1);
});

test('devices not seen for a while are removed, unless something is playing on them', () => {
    const old = Date.now() - STALE_DEVICE_TIMEOUT_MS - 1000;
    for (const ip of ['192.168.1.40', '192.168.1.41', '192.168.1.42']) {
        devices.set(ip, { name: ip, ip, type: 'chromecast' });
    }
    deviceLastSeen.set('192.168.1.40', old);
    deviceLastSeen.set('192.168.1.41', old);
    deviceLastSeen.set('192.168.1.42', Date.now());
    activeSessions.set('192.168.1.41', {});

    // Ticks to the next two-minute sweep (other tests have moved the clock).
    mock.timers.tick(120000);
    assert.deepStrictEqual([...devices.keys()].sort(), ['192.168.1.41', '192.168.1.42']);
});
