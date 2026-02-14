const mdns = require('mdns-js');
const { devices, deviceLastSeen, activeSessions } = require('./state');
const { STALE_DEVICE_TIMEOUT_MS } = require('./utils');
const { broadcast } = require('./websocket');

const IS_DEV = process.env.NODE_ENV === 'development';

function initDiscovery() {
    // Initialize mock device in development mode
    let mockDevice = null;
    if (IS_DEV) {
        try {
            const mockModule = require('../mock-chromecast');
            const MockChromecast = mockModule.MockChromecast;
            mockDevice = new MockChromecast('Mock Chromecast (Dev)', 8009);
            mockDevice.start();

            const mockIp = '127.0.0.1';
            devices[mockIp] = {
                name: 'Mock Chromecast (Dev)',
                ip: mockIp,
                host: 'localhost',
                id: 'mock-chromecast-dev',
                isMock: true
            };
            deviceLastSeen.set(mockIp, Date.now());
            console.log('[Discovery] Development mode - mock device added');
        } catch {
            console.warn('[Dev] Mock chromecast module not found, mock device disabled');
        }
    }

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
        console.log('[Discovery] mDNS browser ready, starting device scan...');
        try {
            browser.discover();
            console.log('[Discovery] Discovery started successfully');
        } catch (e) {
            console.error('[Discovery] Failed to start discovery:', e);
        }
    });

    browser.on('update', (data) => {
        console.log('[Discovery] mDNS update received:', {
            type: data.type,
            addresses: data.addresses,
            host: data.host,
            fullname: data.fullname,
            txt: data.txt
        });

        const isCast = data.type?.some(t => t.name === 'googlecast') ||
                       (Array.isArray(data.type) && data.type.includes('googlecast'));

        if (isCast && data.addresses && data.addresses[0]) {
            const ip = data.addresses[0];
            const name = data.txt?.find(x => x.startsWith('fn='))?.split('=')[1] || data.fullname || ip;
            const deviceId = data.txt?.find(x => x.startsWith('id='))?.split('=')[1];

            if (deviceId) {
                const existingDevice = Object.values(devices).find(d => d.id === deviceId);
                if (existingDevice && existingDevice.ip !== ip) {
                    const existingIsPreferred = !existingDevice.ip.startsWith('192.168.') && !existingDevice.ip.startsWith('172.');
                    const newIsPreferred = !ip.startsWith('192.168.') && !ip.startsWith('172.');

                    if (newIsPreferred && !existingIsPreferred) {
                        console.log(`[Discovery] Replacing ${name} ${existingDevice.ip} -> ${ip}`);
                        delete devices[existingDevice.ip];
                        deviceLastSeen.delete(existingDevice.ip);
                    } else {
                        console.log(`[Discovery] Ignoring duplicate ${name} (${ip}) - already have ${existingDevice.ip}`);
                        return;
                    }
                }
            }

            console.log(`[Discovery] Found Chromecast device: ${name} (${ip})`);
            devices[ip] = { name, ip, host: data.host, id: deviceId };
            deviceLastSeen.set(ip, Date.now());
            broadcast({ type: 'devices', devices: Object.values(devices) });
        } else {
            if (data.addresses && data.addresses[0]) {
                const ip = data.addresses[0];
                if (devices[ip]) {
                    deviceLastSeen.set(ip, Date.now());
                    console.log(`[Discovery] Updated lastSeen for known device at ${ip}`);
                } else {
                    console.log('[Discovery] Ignoring non-Chromecast service:', data.type);
                }
            } else {
                console.log('[Discovery] Ignoring non-Chromecast service:', data.type);
            }
        }
    });

    // Refresh discovery every 30s
    setInterval(() => {
        console.log(`[Discovery] Periodic scan - current devices: ${Object.keys(devices).length}`);
        try {
            browser.discover();
        } catch (e) {
            console.error('[Discovery] Periodic scan failed:', e);
        }
    }, 30000);

    // Clean up stale devices every 2 minutes
    setInterval(() => {
        const now = Date.now();
        const staleThreshold = STALE_DEVICE_TIMEOUT_MS;
        let removed = 0;

        for (const ip of Object.keys(devices)) {
            if (IS_DEV && devices[ip]?.isMock) continue;

            const lastSeen = deviceLastSeen.get(ip);
            if (!lastSeen) {
                console.log(`[Discovery] Warning: Device ${ip} has no lastSeen timestamp`);
                deviceLastSeen.set(ip, now);
                continue;
            }

            if (activeSessions.has(ip)) {
                console.log(`[Discovery] Keeping device ${devices[ip].name} (${ip}) despite being stale - has active session`);
                continue;
            }

            if (now - lastSeen > staleThreshold) {
                console.log(`[Discovery] Removing stale device: ${devices[ip].name} (${ip}) - not seen for ${Math.round((now - lastSeen) / 1000)}s`);
                delete devices[ip];
                deviceLastSeen.delete(ip);
                removed++;
            }
        }

        if (removed > 0) {
            broadcast({ type: 'devices', devices: Object.values(devices) });
        }
    }, 120000);

    return { browser, mockDevice };
}

module.exports = { initDiscovery };
