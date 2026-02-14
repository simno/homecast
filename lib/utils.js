const os = require('os');
const http = require('http');
const https = require('https');
const dns = require('dns');

// Performance: DNS caching
dns.setDefaultResultOrder('ipv4first');

// Performance: Connection pooling for better throughput
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 60000,
    keepAliveMsecs: 1000
});

const PORT = process.env.PORT || 3000;
const STALE_DEVICE_TIMEOUT_MS = parseInt(process.env.STALE_DEVICE_TIMEOUT_HOURS || '3') * 60 * 60 * 1000;

// Constants for stream recovery
const MAX_RECOVERY_ATTEMPTS = 3;
const STALL_TIMEOUT = 15000; // 15 seconds of buffering = stalled

// Constants for connection health
const HEARTBEAT_INTERVAL = 5000;
const MAX_MISSED_HEARTBEATS = 3;
const RECONNECT_DELAY = 10000;
const MAX_RECONNECT_ATTEMPTS = 3;

// Cache TTLs
const CACHE_TTL_VOD = 60000;
const CACHE_TTL_LIVE = 4000;

function getLocalIp() {
    // 1. Check environment variable first
    if (process.env.HOST_IP) {
        return process.env.HOST_IP;
    }

    // 2. Fallback to network interface detection
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

module.exports = {
    httpAgent,
    httpsAgent,
    PORT,
    STALE_DEVICE_TIMEOUT_MS,
    MAX_RECOVERY_ATTEMPTS,
    STALL_TIMEOUT,
    HEARTBEAT_INTERVAL,
    MAX_MISSED_HEARTBEATS,
    RECONNECT_DELAY,
    MAX_RECONNECT_ATTEMPTS,
    CACHE_TTL_VOD,
    CACHE_TTL_LIVE,
    getLocalIp,
};
