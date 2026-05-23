const http = require('http');
const crypto = require('crypto');
const mdns = require('mdns-js');
const { devices, deviceLastSeen, activeAirPlaySessions, streamStats } = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT } = require('./utils');

const AIRPLAY_PORT = 7000;

// Consistent device ID for our server (generated once at startup)
const serverDeviceId = crypto.randomUUID();

// ===== DISCOVERY =====

function initAirPlayDiscovery() {
    console.log('[AirPlay] Initializing mDNS browser for AirPlay devices...');
    const browser = mdns.createBrowser(mdns.tcp('airplay'));

    browser.on('error', (err) => {
        console.error('[AirPlay] mDNS error:', err.message || err);
    });

    browser.on('ready', () => {
        console.log('[AirPlay] mDNS browser ready, scanning for Apple TV devices...');
        try {
            browser.discover();
        } catch (e) {
            console.error('[AirPlay] Discovery start failed:', e.message);
        }
    });

    browser.on('update', (data) => {
        const isAirPlay = data.type?.some(t => t.name === 'airplay');

        if (!isAirPlay || !data.addresses?.[0]) return;

        const ip = data.addresses[0];

        // Parse TXT records
        const txtMap = {};
        data.txt?.forEach(entry => {
            const eq = entry.indexOf('=');
            if (eq > 0) txtMap[entry.slice(0, eq)] = entry.slice(eq + 1);
        });

        const name = txtMap.fn || data.fullname || `Apple TV (${ip})`;
        const deviceId = txtMap.deviceid;

        // Parse features bitfield to check capabilities
        const featuresHex = txtMap.features;
        const features = featuresHex ? parseInt(featuresHex, 16) : 0;
        const hasVideo = (features & 0x1) !== 0; // Bit 0: Video support

        if (!hasVideo) {
            console.log(`[AirPlay] Skipping audio-only device: ${name} (${ip})`);
            return;
        }

        // Deduplicate by deviceId
        if (deviceId) {
            const existing = Object.values(devices).find(d => d.id === deviceId);
            if (existing && existing.ip !== ip) {
                const existingPreferred = !existing.ip.startsWith('192.168.') && !existing.ip.startsWith('172.');
                const newPreferred = !ip.startsWith('192.168.') && !ip.startsWith('172.');
                if (newPreferred && !existingPreferred) {
                    console.log(`[AirPlay] Replacing ${name}: ${existing.ip} -> ${ip}`);
                    delete devices[existing.ip];
                    deviceLastSeen.delete(existing.ip);
                } else {
                    console.log(`[AirPlay] Ignoring duplicate ${name} (${ip}), already have ${existing.ip}`);
                    return;
                }
            }
        }

        console.log(`[AirPlay] Found device: ${name} (${ip}) features=0x${features.toString(16)}`);
        devices[ip] = { name, ip, host: data.host, id: deviceId, type: 'airplay', features };
        deviceLastSeen.set(ip, Date.now());
        broadcast({ type: 'devices', devices: Object.values(devices) });
    });

    // Periodic rediscovery
    setInterval(() => {
        try { browser.discover(); } catch { /* ignore */ }
    }, 30000);

    return browser;
}

// ===== HTTP HELPERS =====

function airPlayRequest(ip, path, method = 'POST', extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: ip,
            port: AIRPLAY_PORT,
            path,
            method,
            headers: {
                'User-Agent': 'MediaControl/1.0',
                'X-Apple-Device-ID': serverDeviceId,
                ...extraHeaders
            },
            timeout: 15000
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({ statusCode: res.statusCode, headers: res.headers, body });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('AirPlay request timeout'));
        });
        req.end();
    });
}

// ===== CASTING =====

async function castToAirPlayDevice(ip, url, proxy, referer, res) {
    const localIp = getLocalIp();
    const finalUrl = proxy
        ? `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`
        : url;

    console.log(`[AirPlay] Casting to ${ip}: ${finalUrl}`);

    // Stop any existing session on this device first
    if (activeAirPlaySessions.has(ip)) {
        console.log(`[AirPlay] Stopping existing session on ${ip}`);
        try { await airPlayRequest(ip, '/stop', 'POST'); } catch { /* ignore */ }
        activeAirPlaySessions.delete(ip);
    }
    streamStats.delete(ip);

    try {
        const result = await airPlayRequest(ip, '/play', 'POST', {
            'Content-Location': finalUrl,
            'Start-Position': '0.0'
        });

        if (result.statusCode === 200) {
            console.log(`[AirPlay] Playback started on ${ip}`);
            activeAirPlaySessions.set(ip, {
                ip,
                url,
                proxy,
                referer,
                finalUrl,
                startTime: Date.now()
            });

            streamStats.set(ip, {
                totalMB: 0,
                segmentCount: 0,
                startTime: Date.now(),
                lastActivity: Date.now()
            });

            if (!res.headersSent) {
                res.json({ status: 'casting', deviceType: 'airplay' });
            }

            broadcast({ type: 'status', status: 'Playing on ' + ip + ' (AirPlay)' });
            broadcast({
                type: 'playerStatus',
                deviceIp: ip,
                status: { playerState: 'PLAYING' },
                delay: 0
            });
        } else if (result.statusCode === 403 || result.statusCode === 401) {
            console.error(`[AirPlay] Authentication required for ${ip} (status ${result.statusCode})`);
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'AirPlay device requires authentication. Make sure "Allow Access" is set to "Everyone" in Apple TV Settings > AirPlay.',
                    detail: `HTTP ${result.statusCode}`
                });
            }
        } else {
            console.error(`[AirPlay] Play request failed: HTTP ${result.statusCode}`);
            if (!res.headersSent) {
                res.status(500).json({
                    error: `AirPlay device returned HTTP ${result.statusCode}`,
                    detail: result.body.toString('utf8').substring(0, 300)
                });
            }
        }
    } catch (err) {
        console.error('[AirPlay] Connection error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Could not connect to AirPlay device: ' + err.message,
                troubleshooting: {
                    message: 'Ensure the Apple TV is on the same network and AirPlay is enabled in Settings.'
                }
            });
        }
    }
}

async function stopAirPlayCasting(ip) {
    const session = activeAirPlaySessions.get(ip);
    if (!session) return null;

    console.log(`[AirPlay] Stopping playback on ${ip}`);

    try {
        await airPlayRequest(ip, '/stop', 'POST');
        console.log(`[AirPlay] Playback stopped on ${ip}`);
    } catch (err) {
        console.error('[AirPlay] Stop error:', err.message);
        // Still clean up session even if stop fails
    }

    activeAirPlaySessions.delete(ip);
    streamStats.delete(ip);
    broadcast({ type: 'status', status: 'Playback stopped on ' + ip });
}

// ===== HEALTH CHECK =====

async function checkAirPlayHealth(ip) {
    try {
        const result = await airPlayRequest(ip, '/server-info', 'GET');
        if (result.statusCode === 200) {
            if (!activeAirPlaySessions.has(ip)) return;
            broadcast({
                type: 'connectionHealth',
                deviceIp: ip,
                state: 'healthy',
                message: 'Connected'
            });
        }
    } catch {
        if (!activeAirPlaySessions.has(ip)) return;
        broadcast({
            type: 'connectionHealth',
            deviceIp: ip,
            state: 'degraded',
            message: 'Device not responding'
        });
    }
}

function startAirPlayHealthMonitoring() {
    setInterval(() => {
        for (const ip of activeAirPlaySessions.keys()) {
            checkAirPlayHealth(ip);
        }
    }, 10000);
    console.log('[AirPlay] Health monitoring started');
}

module.exports = {
    initAirPlayDiscovery,
    castToAirPlayDevice,
    stopAirPlayCasting,
    checkAirPlayHealth,
    startAirPlayHealthMonitoring,
    AIRPLAY_PORT
};
