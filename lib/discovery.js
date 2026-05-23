const dgram = require('dgram');
const http = require('http');
const mdns = require('mdns-js');
const { devices, deviceLastSeen, activeSessions, activeAirPlaySessions } = require('./state');
const { STALE_DEVICE_TIMEOUT_MS } = require('./utils');
const { broadcast } = require('./websocket');

const IS_DEV = process.env.NODE_ENV === 'development';

// SSDP multicast address and Chromecast search target
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const DIAL_ST = 'urn:dial-multiscreen-org:service:dial:1';

const M_SEARCH = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    `ST: ${DIAL_ST}\r\n` +
    '\r\n'
);

function registerDevice(ip, name, deviceId, source) {
    if (devices[ip] && devices[ip].type === 'airplay') return; // Don't overwrite AirPlay

    if (deviceId) {
        const existing = Object.values(devices).find(d => d.id === deviceId && d.ip !== ip);
        if (existing) {
            const newPreferred = !ip.startsWith('192.168.') && !ip.startsWith('172.');
            const oldPreferred = !existing.ip.startsWith('192.168.') && !existing.ip.startsWith('172.');
            if (!newPreferred || oldPreferred) {
                console.log(`[Discovery] Skipping ${name} (${ip}) — already have ${existing.ip}`);
                return;
            }
            console.log(`[Discovery] Replacing ${name}: ${existing.ip} -> ${ip}`);
            delete devices[existing.ip];
            deviceLastSeen.delete(existing.ip);
        }
    }

    if (devices[ip]) {
        deviceLastSeen.set(ip, Date.now());
        return;
    }

    console.log(`[Discovery] Found device (${source}): ${name} (${ip})`);
    devices[ip] = { name, ip, host: ip, id: deviceId, type: 'chromecast' };
    deviceLastSeen.set(ip, Date.now());
    broadcast({ type: 'devices', devices: Object.values(devices) });
}

// --- SSDP Discovery (for TVs and devices that don't broadcast mDNS) ---

function fetchDeviceName(ip) {
    return new Promise((resolve) => {
        const req = http.get(`http://${ip}:8008/ssdp/device-desc.xml`, { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const match = body.match(/<friendlyName>([^<]+)<\/friendlyName>/);
                resolve(match ? match[1] : null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function initSSDPDiscovery() {
    console.log('[Discovery] Initializing SSDP scanner for DIAL/Chromecast devices...');

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', (err) => {
        console.error('[Discovery] SSDP socket error:', err.message);
        socket.close();
    });

    socket.on('message', async (msg) => {
        const text = msg.toString();
        if (!text.includes(DIAL_ST)) return;

        // Extract LOCATION header to get IP
        const locMatch = text.match(/^LOCATION:\s*http:\/\/([^:]+):(\d+)/im);
        if (!locMatch) return;

        const ip = locMatch[1];
        // Skip non-local addresses and self
        if (ip.startsWith('127.') || ip === '0.0.0.0') return;

        // Extract UUID from USN header
        const usnMatch = text.match(/^USN:\s*uuid:([^\s:]+)/im);
        const deviceId = usnMatch ? usnMatch[1] : null;

        // Try to get friendly name from the device description
        const name = await fetchDeviceName(ip);
        registerDevice(ip, name || `Chromecast (${ip})`, deviceId, 'SSDP');
    });

    socket.bind(() => {
        const port = socket.address().port;
        console.log(`[Discovery] SSDP scanner listening on port ${port}`);
        socket.addMembership(SSDP_ADDR);
        sendSSDPSearch(socket);
    });

    return socket;
}

function sendSSDPSearch(socket) {
    socket.send(M_SEARCH, 0, M_SEARCH.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) console.error('[Discovery] SSDP send error:', err.message);
    });
}

// --- mDNS Discovery (for standalone Chromecast dongles) ---

function initMDNSDiscovery() {
    console.log('[Discovery] Initializing mDNS browser for Chromecast devices...');
    const browser = mdns.createBrowser(mdns.tcp('googlecast'));

    browser.on('error', (err) => {
        console.error('[Discovery] mDNS error:', err.message || err);
        console.error('[Discovery] This usually means:');
        console.error('[Discovery]   - Network doesn\'t support multicast (check Docker network mode)');
        console.error('[Discovery]   - Firewall blocking UDP port 5353');
        console.error('[Discovery]   - No network interfaces available');
    });

    browser.on('ready', () => {
        console.log('[Discovery] mDNS browser ready');
        try { browser.discover(); } catch { /* ignore */ }
    });

    browser.on('update', (data) => {
        const isCast = data.type?.some(t => t.name === 'googlecast') ||
                       (Array.isArray(data.type) && data.type.includes('googlecast'));

        if (isCast && data.addresses?.[0]) {
            const ip = data.addresses[0];
            const name = data.txt?.find(x => x.startsWith('fn='))?.split('=')[1] || data.fullname || ip;
            const deviceId = data.txt?.find(x => x.startsWith('id='))?.split('=')[1];
            registerDevice(ip, name, deviceId, 'mDNS');
        } else if (data.addresses?.[0]) {
            const ip = data.addresses[0];
            if (devices[ip]) deviceLastSeen.set(ip, Date.now());
        }
    });

    return browser;
}

// --- Main init ---

function initDiscovery() {
    // Mock device for development
    let mockDevice = null;
    if (IS_DEV) {
        try {
            const MockChromecast = require('../mock-chromecast').MockChromecast;
            mockDevice = new MockChromecast('Mock Chromecast (Dev)', 8009);
            mockDevice.start();
            const mockIp = '127.0.0.1';
            devices[mockIp] = {
                name: 'Mock Chromecast (Dev)', ip: mockIp, host: 'localhost',
                id: 'mock-chromecast-dev', type: 'chromecast', isMock: true
            };
            deviceLastSeen.set(mockIp, Date.now());
            console.log('[Discovery] Mock device added');
        } catch { /* ignore */ }
    }

    const mDNSBrowser = initMDNSDiscovery();
    const ssdpSocket = initSSDPDiscovery();

    // Periodic rediscovery
    setInterval(() => {
        try { mDNSBrowser.discover(); } catch { /* ignore */ }
        try { sendSSDPSearch(ssdpSocket); } catch { /* ignore */ }
    }, 30000);

    // Clean up stale devices every 2 minutes
    setInterval(() => {
        const now = Date.now();
        let removed = 0;

        for (const ip of Object.keys(devices)) {
            if (IS_DEV && devices[ip]?.isMock) continue;

            const lastSeen = deviceLastSeen.get(ip);
            if (!lastSeen) { deviceLastSeen.set(ip, now); continue; }

            if (activeSessions.has(ip) || activeAirPlaySessions.has(ip)) continue;

            if (now - lastSeen > STALE_DEVICE_TIMEOUT_MS) {
                console.log(`[Discovery] Removing stale: ${devices[ip].name} (${ip})`);
                delete devices[ip];
                deviceLastSeen.delete(ip);
                removed++;
            }
        }

        if (removed > 0) {
            broadcast({ type: 'devices', devices: Object.values(devices) });
        }
    }, 120000);

    return { browser: mDNSBrowser, ssdpSocket, mockDevice };
}

module.exports = { initDiscovery };
