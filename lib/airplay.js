const http = require('http');
const crypto = require('crypto');
const mdns = require('mdns-js');
const { devices, deviceLastSeen, activeAirPlaySessions, streamStats } = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT } = require('./utils');

// Lazy-loaded to avoid circular dependency with airplay-pairing
let pairingMod = null;
function getPairingMod() {
    if (!pairingMod) pairingMod = require('./airplay-pairing');
    return pairingMod;
}
let pairingStore = null;
function getPairingStore() {
    if (!pairingStore) pairingStore = require('./airplay-pairing-store');
    return pairingStore;
}

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
            const existing = [...devices.values()].find(d => d.id === deviceId);
            if (existing && existing.ip !== ip) {
                const existingPreferred = !existing.ip.startsWith('192.168.') && !existing.ip.startsWith('172.');
                const newPreferred = !ip.startsWith('192.168.') && !ip.startsWith('172.');
                if (newPreferred && !existingPreferred) {
                    console.log(`[AirPlay] Replacing ${name}: ${existing.ip} -> ${ip}`);
                    devices.delete(existing.ip);
                    deviceLastSeen.delete(existing.ip);
                } else {
                    console.log(`[AirPlay] Ignoring duplicate ${name} (${ip}), already have ${existing.ip}`);
                    return;
                }
            }
        }

        console.log(`[AirPlay] Found device: ${name} (${ip}) features=0x${features.toString(16)}`);
        devices.set(ip, { name, ip, host: data.host, id: deviceId, type: 'airplay', features });
        deviceLastSeen.set(ip, Date.now());
        broadcast({ type: 'devices', devices: [...devices.values()] });
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

// ===== CASTING HELPERS =====

// Create session, stats, and broadcast playback started
function createAirPlaySessionEntry(ip, url, proxy, referer, finalUrl) {
    activeAirPlaySessions.set(ip, {
        ip, url, proxy, referer, finalUrl, startTime: Date.now()
    });
    streamStats.set(ip, {
        totalMB: 0, segmentCount: 0, startTime: Date.now(), lastActivity: Date.now()
    });
    broadcast({ type: 'status', status: 'Playing on ' + ip + ' (AirPlay)' });
    broadcast({
        type: 'playerStatus', deviceIp: ip,
        status: { playerState: 'PLAYING' }, delay: 0
    });
}

function sendNeedsPairingResponse(res, ip, error, detail) {
    if (!res.headersSent) {
        res.status(401).json({
            needsPairing: true, deviceIp: ip,
            deviceName: devices.get(ip)?.name || ip,
            error, detail
        });
    }
}

// Try to authenticate with an already-paired device and retry /play.
// Returns true if casting succeeded, false if more action is needed.
async function retryPlayAfterPairVerify(ip, finalUrl, url, proxy, referer, res) {
    console.log(`[AirPlay] Device ${ip} is paired, attempting pair-verify...`);
    try {
        await getPairingMod().ensurePairVerify(ip);
    } catch (verifyErr) {
        console.error(`[AirPlay] Pair-verify failed for ${ip}:`, verifyErr.message);
        sendNeedsPairingResponse(res, ip,
            'Pair-verify failed. Please re-enter the PIN on your Apple TV.',
            verifyErr.message);
        return false;
    }

    const retryResult = await airPlayRequest(ip, '/play', 'POST', {
        'Content-Location': finalUrl,
        'Start-Position': '0.0'
    });

    if (retryResult.statusCode === 200) {
        console.log(`[AirPlay] Playback started on ${ip} after pair-verify`);
        createAirPlaySessionEntry(ip, url, proxy, referer, finalUrl);
        if (!res.headersSent) res.json({ status: 'casting', deviceType: 'airplay' });
        return true;
    }

    if (retryResult.statusCode === 403 || retryResult.statusCode === 401) {
        getPairingMod().clearPairVerifySession(ip);
        console.error(`[AirPlay] Pair-verify did not resolve auth for ${ip}`);
        sendNeedsPairingResponse(res, ip,
            'Pairing may be invalid. Please re-enter the PIN displayed on your Apple TV.',
            'Pair-verify succeeded but /play was still rejected.');
        return false;
    }

    if (!res.headersSent) {
        res.status(500).json({
            error: `AirPlay device returned HTTP ${retryResult.statusCode} after pair-verify`,
            detail: retryResult.body.toString('utf8').substring(0, 300)
        });
    }
    return false;
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
            createAirPlaySessionEntry(ip, url, proxy, referer, finalUrl);
            if (!res.headersSent) res.json({ status: 'casting', deviceType: 'airplay' });
            return;
        }

        if (result.statusCode === 403 || result.statusCode === 401) {
            console.error(`[AirPlay] Authentication required for ${ip} (status ${result.statusCode})`);

            if (getPairingStore().isPaired(ip)) {
                const succeeded = await retryPlayAfterPairVerify(ip, finalUrl, url, proxy, referer, res);
                if (succeeded) return;
            } else {
                console.log(`[AirPlay] Device ${ip} requires pairing (not paired)`);
                sendNeedsPairingResponse(res, ip,
                    'AirPlay device requires a PIN to pair. Enter the code displayed on your Apple TV.',
                    `HTTP ${result.statusCode}`);
            }
            return;
        }

        console.error(`[AirPlay] Play request failed: HTTP ${result.statusCode}`);
        if (!res.headersSent) {
            res.status(500).json({
                error: `AirPlay device returned HTTP ${result.statusCode}`,
                detail: result.body.toString('utf8').substring(0, 300)
            });
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
                type: 'connectionHealth', deviceIp: ip,
                state: 'healthy', message: 'Connected'
            });
        }
    } catch {
        if (!activeAirPlaySessions.has(ip)) return;
        broadcast({
            type: 'connectionHealth', deviceIp: ip,
            state: 'degraded', message: 'Device not responding'
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

function getPairingStatus(ip) {
    const store = getPairingStore();
    return {
        paired: store.isPaired(ip),
        deviceName: devices.get(ip)?.name || ip,
        pairing: store.getPairing(ip)
    };
}

module.exports = {
    initAirPlayDiscovery,
    castToAirPlayDevice,
    stopAirPlayCasting,
    checkAirPlayHealth,
    startAirPlayHealthMonitoring,
    getPairingStatus,
    AIRPLAY_PORT
};
