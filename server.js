const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const mdns = require('mdns-js');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const dns = require('dns');
const rateLimit = require('express-rate-limit');

// Mock Chromecast for development (conditionally loaded)
const IS_DEV = process.env.NODE_ENV === 'development';
let MockChromecast, MockCastClient, MockPlayer, mockDevice;

if (IS_DEV) {
    try {
        const mockModule = require('./mock-chromecast');
        MockChromecast = mockModule.MockChromecast;
        MockCastClient = mockModule.MockCastClient;
        MockPlayer = mockModule.MockPlayer;
    } catch {
        console.warn('[Dev] Mock chromecast module not found, mock device disabled');
    }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));

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

// Performance: DNS caching
dns.setDefaultResultOrder('ipv4first');

// Security: Enable strict SSRF protection (can be disabled for trusted LANs)
const ENABLE_SSRF_PROTECTION = process.env.DISABLE_SSRF_PROTECTION !== 'true';

// Security: SSRF Protection - Block private IP ranges
function isPrivateIP(ip) {
    // IPv4 private ranges
    const privateRanges = [
        /^127\./,                    // Loopback
        /^10\./,                     // Private Class A
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
        /^192\.168\./,               // Private Class C
        /^169\.254\./,               // Link-local (AWS metadata)
        /^::1$/,                     // IPv6 loopback
        /^fe80:/,                    // IPv6 link-local
        /^fc00:/,                    // IPv6 private
        /^fd00:/                     // IPv6 private
    ];

    return privateRanges.some(range => range.test(ip));
}

// Security: Validate URL for SSRF protection
async function validateProxyUrl(urlString) {
    if (!ENABLE_SSRF_PROTECTION) {
        console.log('[Security] SSRF protection disabled via environment variable');
        return { valid: true };
    }

    try {
        const url = new URL(urlString);

        // Block non-HTTP protocols
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, reason: `Protocol ${url.protocol} not allowed` };
        }

        // Resolve hostname to IP
        const addresses = await dns.promises.resolve(url.hostname).catch(() => [url.hostname]);

        // Check if any resolved IP is private
        for (const addr of addresses) {
            if (isPrivateIP(addr)) {
                return {
                    valid: false,
                    reason: `Access to private IP ranges is blocked (${addr})`
                };
            }
        }

        // Block localhost variations
        const localhostPatterns = ['localhost', '0.0.0.0', '127.0.0.1', '::1'];
        if (localhostPatterns.some(pattern => url.hostname.toLowerCase().includes(pattern))) {
            return { valid: false, reason: 'Access to localhost is blocked' };
        }

        return { valid: true };
    } catch (err) {
        return { valid: false, reason: `Invalid URL: ${err.message}` };
    }
}

// Rate limiting for proxy endpoint
const proxyLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per minute
    message: 'Too many proxy requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per minute
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

// Playlist cache to ensure consistent URLs for Chromecast
// Key: original URL, Value: { content: string, timestamp: number, isLive: boolean }
const playlistCache = new Map();
const CACHE_TTL_VOD = 60000; // 60 seconds for VOD
const CACHE_TTL_LIVE = 4000; // 4 seconds for live streams (needs frequent updates)

// Stream statistics tracking
// Key: deviceIp -> { totalBytes, startTime, lastActivity, resolution, bitrate }
const streamStats = new Map();

// Playback tracking for delay calculation
// Key: deviceIp -> { playbackStartTime, playbackStartPosition, lastDelay }
const playbackTracking = new Map();

// Buffer health tracking
// Key: deviceIp -> { bufferingEvents, totalBufferingTime, lastBufferStart, lastState, sessionStartTime }
const bufferHealthTracking = new Map();

// Stream stall detection and recovery
// Key: deviceIp -> { lastProxyRequest, bufferingStartTime, stallDetected, recoveryAttempts, streamUrl, referer }
const streamRecovery = new Map();
const MAX_RECOVERY_ATTEMPTS = 3;
const STALL_TIMEOUT = 15000; // 15 seconds of buffering = stalled

// --- Discovery ---
const devices = {};
const deviceLastSeen = new Map(); // Track when devices were last seen for staleness detection

// Initialize mock device in development mode
if (IS_DEV && MockChromecast) {
    console.log('[Discovery] Development mode - initializing mock Chromecast device');
    mockDevice = new MockChromecast('Mock Chromecast (Dev)', 8009);
    mockDevice.start();

    // Add mock device to device list
    const mockIp = '127.0.0.1';
    devices[mockIp] = {
        name: 'Mock Chromecast (Dev)',
        ip: mockIp,
        host: 'localhost',
        id: 'mock-chromecast-dev',
        isMock: true
    };
    deviceLastSeen.set(mockIp, Date.now());
    console.log('[Discovery] Mock device added to device list');
}

console.log('[Discovery] Initializing mDNS browser for Chromecast devices...');
const browser = mdns.createBrowser(mdns.tcp('googlecast'));

// Active cast sessions (IP -> { client, player })
const activeSessions = new Map();

// Connection health monitoring
// Key: deviceIp -> { lastHeartbeat, missedHeartbeats, connectionState, reconnectAttempts }
const connectionHealth = new Map();
const HEARTBEAT_INTERVAL = 5000; // Check every 5 seconds
const MAX_MISSED_HEARTBEATS = 3; // Mark as unhealthy after 3 missed (15 seconds)
const RECONNECT_DELAY = 10000; // Wait 10 seconds before reconnect attempt
const MAX_RECONNECT_ATTEMPTS = 3; // Try reconnecting 3 times

// Map device IPs to their streaming client IPs (for stats tracking)
// Key: chromecastIp -> clientIp (the IP making proxy requests)
const deviceToClientMap = new Map();

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

    // Check if it's a googlecast service
    // data.type is often an array of objects like [{name: 'googlecast', protocol: 'tcp', ...}]
    const isCast = data.type?.some(t => t.name === 'googlecast') ||
                   (Array.isArray(data.type) && data.type.includes('googlecast'));

    if (isCast && data.addresses && data.addresses[0]) {
        const ip = data.addresses[0];
        const name = data.txt?.find(x => x.startsWith('fn='))?.split('=')[1] || data.fullname || ip;
        const deviceId = data.txt?.find(x => x.startsWith('id='))?.split('=')[1];

        // Deduplicate by device ID if available
        if (deviceId) {
            // Check if we already have this device ID with a different IP
            const existingDevice = Object.values(devices).find(d => d.id === deviceId);

            if (existingDevice && existingDevice.ip !== ip) {
                // Device exists with different IP - prefer non-private class B/C networks
                const existingIsPreferred = !existingDevice.ip.startsWith('192.168.') && !existingDevice.ip.startsWith('172.');
                const newIsPreferred = !ip.startsWith('192.168.') && !ip.startsWith('172.');

                if (newIsPreferred && !existingIsPreferred) {
                    // New IP is better, remove old one
                    console.log(`[Discovery] Replacing ${name} ${existingDevice.ip} -> ${ip}`);
                    delete devices[existingDevice.ip];
                    deviceLastSeen.delete(existingDevice.ip);
                } else {
                    // Keep existing IP, ignore this one
                    console.log(`[Discovery] Ignoring duplicate ${name} (${ip}) - already have ${existingDevice.ip}`);
                    return;
                }
            }
        }

        console.log(`[Discovery] ✓ Found Chromecast device: ${name} (${ip})`);
        devices[ip] = { name, ip, host: data.host, id: deviceId };
        deviceLastSeen.set(ip, Date.now()); // Track last seen time
        broadcast({ type: 'devices', devices: Object.values(devices) });
    } else {
        // Not a googlecast service, but update lastSeen if this is a known device
        // (e.g., LG TVs send airplay/display updates but not googlecast updates)
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

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// Refresh discovery every 30s (don't clear devices - let them naturally update)
setInterval(() => {
    console.log(`[Discovery] Periodic scan - current devices: ${Object.keys(devices).length}`);
    try {
        browser.discover();
    } catch (e) {
        console.error('[Discovery] Periodic scan failed:', e);
    }
}, 30000); // 30s to keep discovering new devices

// Clean up stale devices every 2 minutes (devices that haven't been seen recently)
setInterval(() => {
    const now = Date.now();
    const staleThreshold = STALE_DEVICE_TIMEOUT_MS;
    let removed = 0;

    for (const ip of Object.keys(devices)) {
        // Skip mock device in dev mode
        if (IS_DEV && devices[ip]?.isMock) {
            continue;
        }

        const lastSeen = deviceLastSeen.get(ip);
        if (!lastSeen) {
            // Device in list but no lastSeen timestamp - shouldn't happen, but skip removal
            console.log(`[Discovery] Warning: Device ${ip} has no lastSeen timestamp`);
            deviceLastSeen.set(ip, now); // Set it now
            continue;
        }

        // Don't remove devices with active streaming sessions
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
}, 120000); // Check every 2 minutes

// Clean up expired playlist cache entries every 2 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of playlistCache.entries()) {
        const ttl = value.isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;
        if (now - value.timestamp > ttl) {
            playlistCache.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[Cache] Cleaned ${cleaned} expired playlist entries`);
    }
}, 120000); // 2 minutes

// --- WebSocket ---
function broadcast(msg) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    });
}

// --- API: List Devices ---
app.get('/api/devices', (req, res) => {
    const deviceList = Object.values(devices);
    console.log(`[API] Device list requested - returning ${deviceList.length} device(s)`);
    res.json(deviceList);
});

// --- API: Stream Stats ---
app.get('/api/stats', (req, res) => {
    const allStats = Array.from(streamStats.entries()).map(([clientIp, stats]) => {
        const duration = (Date.now() - stats.startTime) / 1000; // seconds
        const transferRate = duration > 0 ? Math.round((stats.totalBytes / duration) / 1024) : 0; // KB/s
        return {
            clientIp,
            totalMB: (stats.totalBytes / (1024 * 1024)).toFixed(2),
            transferRate,
            duration: Math.round(duration),
            resolution: stats.resolution,
            bitrate: stats.bitrate,
            segmentCount: stats.segmentCount,
            cacheHits: stats.cacheHits,
            lastActivity: new Date(stats.lastActivity).toISOString()
        };
    });
    res.json(allStats);
});

// --- API: Discovery Status (for debugging) ---
app.get('/api/discovery/status', (req, res) => {
    const os = require('os');
    const interfaces = os.networkInterfaces();

    res.json({
        devicesFound: Object.keys(devices).length,
        devices: devices,
        networkInterfaces: Object.keys(interfaces).reduce((acc, name) => {
            acc[name] = interfaces[name].filter(i => i.family === 'IPv4');
            return acc;
        }, {}),
        serverIP: getLocalIp(),
        port: PORT,
        mdnsNote: 'mDNS requires network_mode: host in Docker and UDP port 5353 open'
    });
});

// --- Helper: Recursive Iframe Search ---
async function searchIframesRecursively(pageUrl, htmlData, referer, depth) {
    const MAX_DEPTH = 3; // Limit recursion depth to prevent infinite loops
    const MAX_IFRAMES_PER_LEVEL = 5; // Limit iframes checked per page

    if (depth >= MAX_DEPTH) {
        console.log(`[Extract] Max recursion depth ${MAX_DEPTH} reached`);
        return null;
    }

    const $ = cheerio.load(htmlData);

    // First, try to find video in current page's HTML
    const videoUrl = extractVideoFromHtml(htmlData);
    if (videoUrl) {
        console.log(`[Extract] Found video at depth ${depth}: ${videoUrl}`);
        return { videoUrl, referer: pageUrl };
    }

    // Get all iframes
    const iframes = $('iframe').map((i, el) => $(el).attr('src')).get().slice(0, MAX_IFRAMES_PER_LEVEL);

    // Also check for dynamically loaded iframes in script tags
    const scriptIframes = await extractIframesFromScripts(htmlData, pageUrl);
    const allIframes = [...new Set([...iframes, ...scriptIframes])]; // Remove duplicates

    for (let iframeSrc of allIframes) {
        if (!iframeSrc) continue;

        try {
            // Handle relative URLs
            if (!iframeSrc.startsWith('http')) {
                iframeSrc = new URL(iframeSrc, new URL(pageUrl).origin).href;
            }

            console.log(`[Extract] Checking iframe at depth ${depth}: ${iframeSrc}`);

            const { data: iframeData } = await axios.get(iframeSrc, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': pageUrl // Use current page as referer
                },
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                timeout: 5000
            });

            // Recursively search this iframe, passing iframe URL as new referer
            const result = await searchIframesRecursively(iframeSrc, iframeData, iframeSrc, depth + 1);
            if (result) {
                return result;
            }
        } catch (iframeErr) {
            console.log(`[Extract] Failed to check iframe at depth ${depth} (${iframeSrc}): ${iframeErr.message}`);
        }
    }

    return null;
}

// --- Helper: Extract Video URL from HTML ---
function extractVideoFromHtml(html) {
    // 1. Common Player variables (source: "http...", file: "http...") - check first for accuracy
    let match = html.match(/(?:source|file)\s*:\s*['"](https?:\/\/[^"']+)['"]/);
    if (match) {
        return match[1];
    }

    // 2. Standard m3u8/mp4 URLs
    match = html.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/) ||
                html.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/);

    if (match) {
        return match[0];
    }

    // 3. Obfuscated window.atob('...')
    const atobMatch = html.match(/window\.atob\s*\(\s*['"]([a-zA-Z0-9+/=]+)['"]\s*\)/);
    if (atobMatch) {
        try {
            const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
            if (decoded.startsWith('http')) {
                console.log(`[Extract] Decoded atob URL: ${decoded}`);
                return decoded;
            }
        } catch {
            console.log('[Extract] Failed to decode atob string');
        }
    }

    return null;
}

// --- Helper: Extract iframes from JavaScript ---
async function extractIframesFromScripts(html, pageUrl) {
    const iframes = [];

    // Match document.write with iframe src
    const docWriteMatches = html.matchAll(/document\.write\([^)]*src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    for (const match of docWriteMatches) {
        iframes.push(match[1]);
    }

    // Match iframe src in string literals (common in obfuscated JS)
    const srcMatches = html.matchAll(/<iframe[^>]+src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    for (const match of srcMatches) {
        iframes.push(match[1]);
    }

    // Extract and fetch external script tags that might contain iframe URLs
    const scriptSrcMatches = html.matchAll(/<script[^>]+src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    const scriptUrls = [];
    for (const match of scriptSrcMatches) {
        scriptUrls.push(match[1]);
    }

    // Fetch external scripts and search for iframes (limit to 3 scripts for performance)
    for (const scriptUrl of scriptUrls.slice(0, 3)) {
        try {
            console.log(`[Extract] Fetching external script: ${scriptUrl}`);
            const { data: scriptData } = await axios.get(scriptUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': pageUrl
                },
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                timeout: 3000
            });

            // Search for iframe URLs in the script content
            const scriptIframeMatches = scriptData.matchAll(/src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
            for (const match of scriptIframeMatches) {
                iframes.push(match[1]);
            }
        } catch (err) {
            console.log(`[Extract] Failed to fetch script ${scriptUrl}: ${err.message}`);
        }
    }

    return iframes;
}

// --- Helper: Detect Frame Rate ---
async function detectFrameRate(videoUrl, type) {
    try {
        // For HLS, we'll extract from playlist during playback
        // For MP4, try to parse from container headers
        if (type === 'mp4') {
            try {
                // Request first 64KB of MP4 to parse atoms
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    timeout: 3000,
                    responseType: 'arraybuffer',
                    headers: {
                        'Range': 'bytes=0-65535' // First 64KB
                    },
                    validateStatus: (status) => status === 200 || status === 206
                });

                const buffer = Buffer.from(response.data);

                // Look for mvhd (movie header) atom which contains timescale
                const timescale = findMvhdTimescale(buffer);
                if (timescale) {
                    // Common timescales and their typical frame rates:
                    // Note: Timescale is time units per second, not always FPS
                    // These are educated guesses based on common encodings
                    if (timescale === 600) return 24;        // 24 FPS (23.976 * 25 = 599.4)
                    if (timescale === 24000) return 24;      // 24 FPS
                    if (timescale === 23976) return 24;      // 23.976 FPS
                    if (timescale === 25000) return 25;      // 25 FPS (PAL)
                    if (timescale === 1000) return 30;       // Usually 30 FPS
                    if (timescale === 30000) return 30;      // 30 FPS
                    if (timescale === 29970) return 30;      // 29.97 FPS (NTSC)
                    if (timescale === 48000) return 48;      // 48 FPS
                    if (timescale === 50000) return 50;      // 50 FPS (PAL HD)
                    if (timescale === 60000) return 60;      // 60 FPS
                    if (timescale === 59940) return 60;      // 59.94 FPS

                    // For uncommon timescales, timescale/1000 might work
                    const estimatedFps = Math.round(timescale / 1000);
                    if (estimatedFps >= 15 && estimatedFps <= 120) return estimatedFps;
                }
            } catch {
                // Silently fail - frame rate detection is optional
            }
        }

        return null;
    } catch {
        return null;
    }
}

// Helper to find timescale in mvhd atom
function findMvhdTimescale(buffer) {
    try {
        // Look for 'mvhd' atom signature
        const mvhdIndex = buffer.indexOf('mvhd');
        if (mvhdIndex === -1) return null;

        // mvhd structure:
        // - 1 byte: version
        // - 3 bytes: flags
        // - Version 0: 4 bytes creation + 4 bytes modification + 4 bytes timescale
        // - Version 1: 8 bytes creation + 8 bytes modification + 4 bytes timescale

        const versionOffset = mvhdIndex + 4; // After 'mvhd' string
        if (versionOffset >= buffer.length) return null;

        const version = buffer[versionOffset];
        let timescaleOffset;

        if (version === 1) {
            // Version 1: 1+3+8+8 = 20 bytes before timescale
            timescaleOffset = mvhdIndex + 4 + 20;
        } else {
            // Version 0: 1+3+4+4 = 12 bytes before timescale
            timescaleOffset = mvhdIndex + 4 + 12;
        }

        if (timescaleOffset + 4 > buffer.length) return null;

        // Read 32-bit big-endian integer
        const timescale = buffer.readUInt32BE(timescaleOffset);

        // Sanity check: timescale should be reasonable (1-600000)
        if (timescale < 1 || timescale > 600000) return null;

        return timescale;
    } catch {
        return null;
    }
}

// --- Helper: Detect Resolution ---
async function detectResolution(videoUrl, type) {
    try {
        // Method 1: Check URL patterns (fastest)
        const urlPatterns = [
            { regex: /(\d{3,4})p/i, format: (m) => `${m[1]}p` },                    // 720p, 1080p
            { regex: /(\d{3,4})x(\d{3,4})/i, format: (m) => `${m[2]}p` },          // 1280x720
            { regex: /_hd\b|\/hd\b/i, format: () => 'HD' },                        // _hd, /hd
            { regex: /_sd\b|\/sd\b/i, format: () => 'SD' },                        // _sd, /sd
            { regex: /_fhd\b|\/fhd\b/i, format: () => '1080p' },                   // _fhd, /fhd
            { regex: /4k|uhd|2160/i, format: () => '4K' },                         // 4k, uhd, 2160
            { regex: /quality[=_](\d+)/i, format: (m) => `${m[1]}p` }              // quality=720
        ];

        for (const pattern of urlPatterns) {
            const match = videoUrl.match(pattern.regex);
            if (match) {
                return pattern.format(match);
            }
        }

        // Method 2: For HLS, fetch playlist to check for resolution info
        if (type === 'hls' && videoUrl.includes('.m3u8')) {
            try {
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    timeout: 3000,
                    maxContentLength: 50000, // Only read first 50KB
                    validateStatus: (status) => status === 200
                });

                const playlist = response.data;

                // Check for master playlist with resolution info
                const resMatch = playlist.match(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)/);
                if (resMatch) {
                    const height = parseInt(resMatch[2]);
                    return `${height}p`;
                }

                // Check for bandwidth (estimate quality from bitrate)
                const bandwidthMatch = playlist.match(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)/);
                if (bandwidthMatch) {
                    const bandwidth = parseInt(bandwidthMatch[1]);
                    if (bandwidth > 5000000) return '1080p+';
                    if (bandwidth > 2500000) return '720p';
                    if (bandwidth > 1000000) return '480p';
                    return 'SD';
                }
            } catch {
                // Silently fail - resolution detection is optional
            }
        }

        // Method 3: For MP4, check common naming or use HEAD request for file size
        if (type === 'mp4') {
            try {
                const response = await axios({
                    method: 'head',
                    url: videoUrl,
                    timeout: 2000,
                    validateStatus: (status) => status === 200
                });

                const contentLength = parseInt(response.headers['content-length'] || '0');
                if (contentLength > 0) {
                    // Very rough estimation based on file size
                    const sizeMB = contentLength / (1024 * 1024);
                    if (sizeMB > 2000) return '1080p+';
                    if (sizeMB > 800) return '720p';
                    if (sizeMB > 300) return '480p';
                    return 'SD';
                }
            } catch {
                // Silently fail
            }
        }

        return null; // Unknown resolution
    } catch {
        return null;
    }
}

// --- API: Extract Video URL ---
app.post('/api/extract', apiLimiter, async (req, res) => {
    const { url } = req.body;
    let videoReferer = url; // Default to main URL

    try {
        // If it's already a video file, return it
        if (url.match(/\.(mp4|m3u8|webm|mkv)$/i)) return res.json({ videos: [{ url, referer: url }] });

        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 10000
        });
        const $ = cheerio.load(data);

        const foundVideos = new Set(); // Use Set to avoid duplicates

        // Try common video selectors
        $('video source').each((i, el) => {
            const src = $(el).attr('src');
            if (src) foundVideos.add(src);
        });

        const videoSrc = $('video').attr('src');
        if (videoSrc) foundVideos.add(videoSrc);

        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo) foundVideos.add(ogVideo);

        const ogVideoUrl = $('meta[property="og:video:url"]').attr('content');
        if (ogVideoUrl) foundVideos.add(ogVideoUrl);

        // Fallback: Regex search in raw HTML (for streams inside JS/JSON)
        // Look for all m3u8 URLs (common for livestreams)
        const m3u8Matches = data.matchAll(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/g);
        for (const match of m3u8Matches) {
            foundVideos.add(match[0]);
        }

        // Look for mp4 URLs
        const mp4Matches = data.matchAll(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/g);
        for (const match of mp4Matches) {
            foundVideos.add(match[0]);
        }

        // Look for MJPEG streams (common for webcams)
        const mjpegMatches = data.matchAll(/https?:\/\/[^"'\s]+(?:mjpg|mjpeg|jpg\/video)[^"'\s]*/g);
        for (const match of mjpegMatches) {
            foundVideos.add(match[0]);
        }

        // Deep Search: Inspect Iframes recursively if no videos found yet
        if (foundVideos.size === 0) {
            const result = await searchIframesRecursively(url, data, url, 0);
            if (result) {
                foundVideos.add(result.videoUrl);
                videoReferer = result.referer;
            }
        }

        if (foundVideos.size === 0) return res.status(404).json({ error: 'No video found' });

        // Convert Set to array and resolve relative URLs
        const videos = [];
        for (const videoUrl of foundVideos) {
            let resolvedUrl = videoUrl;

            // Handle relative URLs
            if (videoUrl && !videoUrl.startsWith('http')) {
                try {
                    const u = new URL(url);
                    resolvedUrl = new URL(videoUrl, u.origin).href;
                } catch {
                    continue; // Skip invalid URLs
                }
            }

            // Check if it's MJPEG and mark it
            const isMjpeg = resolvedUrl.match(/mjpe?g|jpg.*video/i);
            const type = isMjpeg ? 'mjpeg' : (resolvedUrl.includes('.m3u8') ? 'hls' : 'mp4');

            // Detect resolution
            const resolution = await detectResolution(resolvedUrl, type);

            videos.push({
                url: resolvedUrl,
                referer: videoReferer,
                type: type,
                resolution: resolution,
                unsupported: isMjpeg
            });
        }

        // Sort: HLS first, then MP4, MJPEG last
        videos.sort((a, b) => {
            const priority = { hls: 0, mp4: 1, mjpeg: 2 };
            return priority[a.type] - priority[b.type];
        });

        console.log(`[Extract] Found ${videos.length} video stream(s) at ${url}`);
        videos.forEach((v, i) => {
            const resInfo = v.resolution ? ` (${v.resolution})` : '';
            console.log(`[Extract]   ${i + 1}. ${v.type.toUpperCase()}${resInfo}: ${v.url.substring(0, 80)}...`);
        });

        res.json({ videos });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Helper: Try Next Segment ---
// For live streams, if current segment is missing, check if next segment exists
async function tryNextSegment(currentUrl) {
    try {
        // Extract segment number from URL (common patterns: segment_123.ts, chunk123.m4s, etc.)
        const match = currentUrl.match(/(\d+)\.(?:ts|m4s|mp4)(\?.*)?$/);
        if (!match) return null;

        const segmentNumber = parseInt(match[1]);
        const nextSegmentNumber = segmentNumber + 1;
        const nextUrl = currentUrl.replace(`${segmentNumber}.`, `${nextSegmentNumber}.`);

        // Quick HEAD request to check if next segment exists
        const response = await axios({
            method: 'head',
            url: nextUrl,
            timeout: 1000,
            validateStatus: (status) => status < 500
        });

        if (response.status === 200) {
            console.log(`[Proxy] Next segment exists (${nextSegmentNumber}), skipping missing segment ${segmentNumber}`);
            return nextUrl;
        }
    } catch {
        // Next segment doesn't exist or error checking
    }
    return null;
}

// --- Helper: Resolve M3U8 URLs ---
function resolveM3u8Url(line, baseUrl) {
    const trimmed = line.trim();

    // Skip comments/tags or empty lines
    if (!trimmed || trimmed.startsWith('#')) {
        return { isUrl: false, url: null };
    }

    try {
        // Check if already absolute URL
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            // Validate it's a proper URL
            new URL(trimmed);
            return { isUrl: true, url: trimmed };
        }

        // Handle protocol-relative URLs (//example.com/path)
        if (trimmed.startsWith('//')) {
            const absoluteUrl = baseUrl.protocol + trimmed;
            new URL(absoluteUrl); // Validate
            return { isUrl: true, url: absoluteUrl };
        }

        // Resolve relative URL to absolute
        const absoluteUrl = new URL(trimmed, baseUrl).href;
        return { isUrl: true, url: absoluteUrl };
    } catch {
        // If URL parsing fails, return original line
        console.log(`[Proxy] Failed to parse URL: ${trimmed.substring(0, 100)}`);
        return { isUrl: false, url: null };
    }
}

// --- Connection Health Monitoring ---
function initializeConnectionHealth(deviceIp) {
    connectionHealth.set(deviceIp, {
        lastHeartbeat: Date.now(),
        missedHeartbeats: 0,
        connectionState: 'healthy', // healthy, degraded, unhealthy, reconnecting
        reconnectAttempts: 0,
        lastActivity: Date.now()
    });
    console.log(`[Health] Initialized monitoring for ${deviceIp}`);

    // Broadcast initial healthy state
    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'healthy',
        message: 'Connected'
    });
}

function updateHeartbeat(deviceIp) {
    const health = connectionHealth.get(deviceIp);
    if (health) {
        health.lastHeartbeat = Date.now();
        health.lastActivity = Date.now();
        health.missedHeartbeats = 0;
        if (health.connectionState !== 'healthy') {
            health.connectionState = 'healthy';
            health.reconnectAttempts = 0;
            console.log(`[Health] Connection restored for ${deviceIp}`);
            broadcast({
                type: 'connectionHealth',
                deviceIp,
                state: 'healthy',
                message: 'Connection restored'
            });
        }
    }
}

function checkConnectionHealth() {
    const now = Date.now();

    for (const [deviceIp, health] of connectionHealth.entries()) {
        const timeSinceLastHeartbeat = now - health.lastHeartbeat;
        const session = activeSessions.get(deviceIp);

        if (!session) {
            // No active session, clean up health monitoring
            connectionHealth.delete(deviceIp);
            continue;
        }

        // Check if we've missed heartbeats
        if (timeSinceLastHeartbeat > HEARTBEAT_INTERVAL) {
            health.missedHeartbeats = Math.floor(timeSinceLastHeartbeat / HEARTBEAT_INTERVAL);

            if (health.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
                // Connection is unhealthy
                if (health.connectionState !== 'unhealthy' && health.connectionState !== 'reconnecting') {
                    health.connectionState = 'unhealthy';
                    console.warn(`[Health] Connection unhealthy for ${deviceIp} (${health.missedHeartbeats} missed heartbeats)`);
                    broadcast({
                        type: 'connectionHealth',
                        deviceIp,
                        state: 'unhealthy',
                        message: `No response for ${Math.round(timeSinceLastHeartbeat / 1000)}s`,
                        missedHeartbeats: health.missedHeartbeats
                    });

                    // Attempt reconnection if not already trying
                    if (health.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        setTimeout(() => attemptReconnect(deviceIp), RECONNECT_DELAY);
                    }
                }
            } else if (health.missedHeartbeats >= 2) {
                // Connection is degraded
                if (health.connectionState === 'healthy') {
                    health.connectionState = 'degraded';
                    console.log(`[Health] Connection degraded for ${deviceIp}`);
                    broadcast({
                        type: 'connectionHealth',
                        deviceIp,
                        state: 'degraded',
                        message: 'Connection may be unstable'
                    });
                }
            }
        }
    }
}

async function attemptReconnect(deviceIp) {
    const health = connectionHealth.get(deviceIp);
    if (!health || health.connectionState === 'healthy') return;

    health.reconnectAttempts++;
    health.connectionState = 'reconnecting';

    console.log(`[Health] Attempting reconnection for ${deviceIp} (attempt ${health.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'reconnecting',
        message: `Reconnecting... (${health.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
        attempt: health.reconnectAttempts
    });

    // Try to ping the Chromecast client
    try {
        const session = activeSessions.get(deviceIp);
        if (session && session.player) {
            // Request player status to test connection
            session.player.getStatus((err, status) => {
                if (!err && status) {
                    // Connection restored
                    console.log(`[Health] Reconnection successful for ${deviceIp}`);
                    updateHeartbeat(deviceIp);
                } else {
                    // Still failed
                    console.warn(`[Health] Reconnection failed for ${deviceIp}: ${err?.message || 'No status'}`);
                    if (health.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        console.error(`[Health] Max reconnection attempts reached for ${deviceIp}, giving up`);
                        broadcast({
                            type: 'connectionHealth',
                            deviceIp,
                            state: 'failed',
                            message: 'Connection lost. Please restart casting.'
                        });
                    }
                }
            });
        }
    } catch (error) {
        console.error(`[Health] Reconnection error for ${deviceIp}:`, error.message);
    }
}

// Start health monitoring interval
setInterval(checkConnectionHealth, HEARTBEAT_INTERVAL);
console.log('[Health] Connection monitoring started');

// --- Stream Stall Detection and Recovery ---
function trackStreamActivity(deviceIp) {
    const recovery = streamRecovery.get(deviceIp);
    if (recovery) {
        recovery.lastProxyRequest = Date.now();
        recovery.stallDetected = false;
    }
}

function initializeStreamRecovery(deviceIp, streamUrl, referer) {
    streamRecovery.set(deviceIp, {
        lastProxyRequest: Date.now(),
        bufferingStartTime: null,
        stallDetected: false,
        recoveryAttempts: 0,
        streamUrl,
        referer
    });
    console.log(`[Recovery] Initialized stall detection for ${deviceIp}`);
}

async function checkStreamStalls() {
    const now = Date.now();

    for (const [deviceIp, recovery] of streamRecovery.entries()) {
        const bufferHealth = bufferHealthTracking.get(deviceIp);

        // Check if stream is buffering
        if (bufferHealth && bufferHealth.lastState === 'BUFFERING' && bufferHealth.lastBufferStart) {
            const bufferingDuration = now - bufferHealth.lastBufferStart;

            // If buffering for more than STALL_TIMEOUT and no recent proxy requests
            const timeSinceLastRequest = now - recovery.lastProxyRequest;
            if (bufferingDuration > STALL_TIMEOUT && timeSinceLastRequest > STALL_TIMEOUT) {
                if (!recovery.stallDetected && recovery.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                    recovery.stallDetected = true;
                    recovery.recoveryAttempts++;
                    console.log(`[Recovery] Stream stalled for ${deviceIp} (${Math.round(bufferingDuration / 1000)}s), attempting recovery (${recovery.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);

                    await attemptStreamRecovery(deviceIp, recovery);
                }
            }
        } else if (bufferHealth && bufferHealth.lastState === 'IDLE') {
            // Check if stream went IDLE unexpectedly (not due to user stopping)
            const session = activeSessions.get(deviceIp);
            const timeSinceLastRequest = now - recovery.lastProxyRequest;

            // If we have an active session, went IDLE, and no recent activity = unexpected failure
            if (session && timeSinceLastRequest > 10000 && !recovery.stallDetected && recovery.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                recovery.stallDetected = true;
                recovery.recoveryAttempts++;
                console.log(`[Recovery] Stream went IDLE unexpectedly for ${deviceIp}, attempting recovery (${recovery.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);

                await attemptStreamRecovery(deviceIp, recovery);
            }
        } else {
            // Stream is playing normally, reset recovery attempts
            if (recovery.stallDetected && bufferHealth && bufferHealth.lastState === 'PLAYING') {
                console.log(`[Recovery] Stream recovered for ${deviceIp}, resetting recovery counter`);
                recovery.recoveryAttempts = 0;
                recovery.stallDetected = false;
            }
        }
    }
}

async function attemptStreamRecovery(deviceIp, recovery) {
    try {
        const session = activeSessions.get(deviceIp);
        if (!session) {
            console.log(`[Recovery] No active session for ${deviceIp}, cannot recover`);
            return;
        }

        const { player } = session;

        // Broadcast recovery attempt to frontend
        broadcast({
            type: 'streamRecovery',
            deviceIp,
            status: 'attempting',
            attempt: recovery.recoveryAttempts,
            maxAttempts: MAX_RECOVERY_ATTEMPTS
        });

        // Stop current playback
        console.log(`[Recovery] Stopping stalled stream on ${deviceIp}`);
        await new Promise((resolve) => {
            player.stop((err) => {
                if (err) console.error('[Recovery] Stop error:', err.message);
                resolve();
            });
        });

        // Wait a moment for cleanup
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Restart stream
        console.log(`[Recovery] Restarting stream on ${deviceIp}`);
        const localIp = getLocalIp();
        const media = {
            contentId: `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(recovery.streamUrl)}&referer=${encodeURIComponent(recovery.referer || '')}`,
            contentType: 'application/x-mpegURL',
            streamType: 'LIVE'
        };

        player.load(media, { autoplay: true }, (err, _status) => {
            if (err) {
                console.error(`[Recovery] Recovery failed for ${deviceIp}:`, err.message);
                broadcast({
                    type: 'streamRecovery',
                    deviceIp,
                    status: 'failed',
                    attempt: recovery.recoveryAttempts,
                    maxAttempts: MAX_RECOVERY_ATTEMPTS
                });

                // If max attempts reached, give up
                if (recovery.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                    console.log(`[Recovery] Max recovery attempts reached for ${deviceIp}, giving up`);
                    broadcast({
                        type: 'streamRecovery',
                        deviceIp,
                        status: 'giveup',
                        message: 'Stream recovery failed after multiple attempts. Please restart manually.'
                    });
                }
            } else {
                console.log(`[Recovery] Stream restarted successfully for ${deviceIp}`);
                recovery.lastProxyRequest = Date.now();
                recovery.stallDetected = false;
                broadcast({
                    type: 'streamRecovery',
                    deviceIp,
                    status: 'success',
                    attempt: recovery.recoveryAttempts
                });
            }
        });
    } catch (error) {
        console.error(`[Recovery] Recovery error for ${deviceIp}:`, error.message);
    }
}

// Start stall detection monitoring (check every 10 seconds)
setInterval(checkStreamStalls, 10000);
console.log('[Recovery] Stream stall detection started');

// --- Buffer Health Tracking ---
function trackBufferHealth(deviceIp, playerState) {
    let tracking = bufferHealthTracking.get(deviceIp);

    // Initialize tracking on first status update
    if (!tracking) {
        tracking = {
            bufferingEvents: 0,
            totalBufferingTime: 0,
            lastBufferStart: null,
            lastState: null,
            sessionStartTime: Date.now()
        };
        bufferHealthTracking.set(deviceIp, tracking);
    }

    const now = Date.now();

    // Detect state transitions
    if (playerState === 'BUFFERING' && tracking.lastState !== 'BUFFERING') {
        // Started buffering
        tracking.bufferingEvents++;
        tracking.lastBufferStart = now;
        console.log(`[BufferHealth] ${deviceIp} - Buffering started (event #${tracking.bufferingEvents})`);
    } else if (tracking.lastState === 'BUFFERING' && playerState !== 'BUFFERING') {
        // Stopped buffering
        if (tracking.lastBufferStart) {
            const bufferingDuration = (now - tracking.lastBufferStart) / 1000; // seconds
            tracking.totalBufferingTime += bufferingDuration;
            console.log(`[BufferHealth] ${deviceIp} - Buffering ended (duration: ${bufferingDuration.toFixed(1)}s, total: ${tracking.totalBufferingTime.toFixed(1)}s)`);
            tracking.lastBufferStart = null;
        }
    }

    tracking.lastState = playerState;
}

function getBufferHealthStats(deviceIp) {
    const tracking = bufferHealthTracking.get(deviceIp);
    if (!tracking) {
        return {
            healthScore: 100,
            bufferingEvents: 0,
            totalBufferingTime: 0
        };
    }

    // Calculate current buffering time if currently buffering
    let currentBufferingTime = tracking.totalBufferingTime;
    if (tracking.lastBufferStart) {
        currentBufferingTime += (Date.now() - tracking.lastBufferStart) / 1000;
    }

    // Calculate health score: (playingTime / totalTime) * 100
    const totalSessionTime = (Date.now() - tracking.sessionStartTime) / 1000; // seconds
    const playingTime = totalSessionTime - currentBufferingTime;
    const healthScore = totalSessionTime > 0 ? Math.round((playingTime / totalSessionTime) * 100) : 100;

    return {
        healthScore: Math.max(0, Math.min(100, healthScore)), // Clamp to 0-100
        bufferingEvents: tracking.bufferingEvents,
        totalBufferingTime: Math.round(currentBufferingTime)
    };
}

// --- API: Proxy Stream ---
app.get('/proxy', proxyLimiter, async (req, res) => {
    const { url, referer } = req.query;
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[Proxy] Request from ${clientIp} for: ${url?.substring(0, 80)}...`);

    if (!url) return res.status(400).json({ error: 'URL parameter required' });

    // Find which device this client belongs to
    let deviceIp = null;

    // Normalize localhost representations
    let normalizedClientIp = clientIp;
    if (clientIp === '127.0.0.1' || clientIp === '::ffff:127.0.0.1') {
        normalizedClientIp = '::1';
    }

    for (const [devIp, mappedClientIp] of deviceToClientMap.entries()) {
        if (mappedClientIp === clientIp || mappedClientIp === normalizedClientIp) {
            deviceIp = devIp;
            break;
        }
    }

    // If no mapping found, use client IP as fallback (shouldn't happen normally)
    if (!deviceIp) {
        deviceIp = clientIp;
        console.log(`[Proxy] No device mapping found for ${clientIp}, using as device IP`);
    }

    // Update connection heartbeat (device is making requests = healthy)
    updateHeartbeat(deviceIp);

    // Track stream activity for stall detection
    trackStreamActivity(deviceIp);

    // Initialize or get stream stats for this device
    if (!streamStats.has(deviceIp)) {
        streamStats.set(deviceIp, {
            totalBytes: 0,
            startTime: Date.now(),
            lastActivity: Date.now(),
            resolution: 'Unknown',
            bitrate: 0,
            segmentCount: 0,
            cacheHits: 0,
            frameRate: null
        });
    }

    const stats = streamStats.get(deviceIp);
    stats.lastActivity = Date.now();

    if (!url) return res.status(400).json({ error: 'URL parameter required' });

    // Security: Validate URL for SSRF protection
    const validation = await validateProxyUrl(url);
    if (!validation.valid) {
        console.warn(`[Security] Blocked proxy request from ${clientIp}: ${validation.reason}`);
        return res.status(403).json({
            error: 'URL blocked by security policy',
            reason: validation.reason,
            note: 'Set DISABLE_SSRF_PROTECTION=true to disable (not recommended for public deployments)'
        });
    }

    // CORS for Chromecast
    res.header('Access-Control-Allow-Origin', '*');

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        if (referer) headers['Referer'] = referer;

        const contentType = url.includes('.m3u8') || url.includes('playlist')
            ? 'application/vnd.apple.mpegurl'
            : '';

        // HLS Playlist - Check cache first
        if (url.includes('.m3u8') || url.includes('playlist')) {
            const cacheKey = url;
            const cached = playlistCache.get(cacheKey);

            // Determine appropriate TTL based on stream type
            const cacheTTL = cached?.isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;

            // Return cached if still valid
            if (cached && (Date.now() - cached.timestamp < cacheTTL)) {
                const age = Math.round((Date.now() - cached.timestamp) / 1000);
                console.log(`[Proxy] Serving cached playlist (${cached.isLive ? 'LIVE' : 'VOD'}, age: ${age}s): ${url.substring(0, 80)}...`);
                stats.cacheHits++;
                res.set('Content-Type', contentType);
                return res.send(cached.content);
            }

            if (cached) {
                const age = Math.round((Date.now() - cached.timestamp) / 1000);
                console.log(`[Proxy] Cache expired (age: ${age}s, TTL: ${cacheTTL / 1000}s), refetching: ${url.substring(0, 80)}...`);
            } else {
                console.log(`[Proxy] No cache entry, fetching: ${url.substring(0, 80)}...`);
            }

            // Fetch with timeout
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: headers,
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                timeout: 30000,
                validateStatus: (status) => status < 500
            });

            // Check for error status codes
            if (response.status >= 400) {
                console.error(`[Proxy] Upstream returned ${response.status} for ${url}`);
                return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
            }

            const chunks = [];
            response.data.on('data', chunk => chunks.push(chunk));
            response.data.on('error', (err) => {
                console.error('[Proxy] Stream error:', err);
                if (!res.headersSent) res.status(500).end();
            });
            response.data.on('end', () => {
                try {
                    const originalM3u8 = Buffer.concat(chunks).toString('utf8');
                    const baseUrl = new URL(url);

                    // Detect if this is a live stream (no EXT-X-ENDLIST tag)
                    const isLive = !originalM3u8.includes('#EXT-X-ENDLIST');

                    // Extract resolution from playlist if available (master playlists)
                    const resolutionMatch = originalM3u8.match(/RESOLUTION=(\d+x\d+)/);
                    if (resolutionMatch) {
                        stats.resolution = resolutionMatch[1];
                    } else if (!stats.resolution || stats.resolution === 'Unknown') {
                        // For media playlists, estimate from context or mark as stream
                        stats.resolution = 'Live Stream';
                    }

                    // Extract bandwidth/bitrate if available
                    const bandwidthMatch = originalM3u8.match(/BANDWIDTH=(\d+)/);
                    if (bandwidthMatch) {
                        stats.bitrate = Math.round(parseInt(bandwidthMatch[1]) / 1000); // Convert to Kbps
                    } else if (!stats.bitrate || stats.bitrate === 0) {
                        // Try to extract target duration to estimate bitrate
                        const targetDurationMatch = originalM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
                        if (targetDurationMatch && stats.segmentCount > 0) {
                            // Rough estimate: if we know segment duration, estimate from data rate
                            const duration = (Date.now() - stats.startTime) / 1000;
                            if (duration > 10) {
                                stats.bitrate = Math.round((stats.totalBytes * 8) / duration / 1000); // Kbps
                            }
                        }
                    }

                    // Extract frame rate if available (common in master playlists)
                    const frameRateMatch = originalM3u8.match(/FRAME-RATE=([\d.]+)/);
                    if (frameRateMatch && !stats.frameRate) {
                        stats.frameRate = parseFloat(frameRateMatch[1]);
                        console.log(`[Proxy] Detected frame rate from playlist: ${stats.frameRate} FPS`);
                        // Broadcast the updated stats with frame rate
                        broadcast({
                            type: 'streamStats',
                            deviceIp: deviceIp,
                            stats: { ...stats }
                        });
                    } else if (!stats.frameRate) {
                        // Fallback: Try to infer from target duration
                        // Most live sports streams are 30 or 60 FPS
                        // Unfortunately, HLS doesn't always include frame rate info
                        // We can only make educated guesses based on segment duration
                        const targetDuration = originalM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
                        if (targetDuration && stats.segmentCount > 5) {
                            // Common patterns: 2-6 second segments usually = 30fps
                            const segDuration = parseInt(targetDuration[1]);
                            if (segDuration <= 2) {
                                stats.frameRate = 60; // Short segments often mean high FPS
                            } else if (segDuration >= 3 && segDuration <= 10) {
                                stats.frameRate = 30; // Standard segment length
                            }
                            if (stats.frameRate) {
                                console.log(`[Proxy] Estimated frame rate: ${stats.frameRate} FPS (based on segment duration: ${segDuration}s)`);
                                broadcast({
                                    type: 'streamStats',
                                    deviceIp: deviceIp,
                                    stats: { ...stats }
                                });
                            }
                        }
                    }

                    const rewrittenM3u8 = originalM3u8.split('\n').map(line => {
                        const result = resolveM3u8Url(line, baseUrl);

                        if (!result.isUrl) {
                            return line; // Keep original line (comments, etc.)
                        }

                        // Rewrite to point to proxy
                        const proxyUrl = `http://${req.headers.host}/proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(referer || '')}`;
                        return proxyUrl;
                    }).join('\n');

                    // Cache the rewritten playlist with stream type info
                    playlistCache.set(cacheKey, {
                        content: rewrittenM3u8,
                        timestamp: Date.now(),
                        isLive: isLive
                    });

                    console.log(`[Proxy] Cached as ${isLive ? 'LIVE' : 'VOD'} stream (TTL: ${isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD}ms)`);

                    res.set('Content-Type', contentType);
                    res.send(rewrittenM3u8);
                } catch (err) {
                    console.error('[Proxy] M3U8 rewrite error:', err);
                    if (!res.headersSent) res.status(500).json({ error: 'Failed to rewrite playlist' });
                }
            });
            return;
        }

        // Standard Binary Stream (Segments, MP4, etc.) - No caching
        // Retry logic for video segments (404s are common in live streams)
        const isVideoSegment = url.includes('.ts') || url.includes('.m4s') || url.includes('.mp4');
        let response;
        let _lastError;
        let currentUrl = url;
        const maxRetries = isVideoSegment ? 10 : 0; // ~4 seconds total with exponential backoff
        const retryStartTime = Date.now();
        let segmentSkipped = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                response = await axios({
                    method: 'get',
                    url: currentUrl,
                    responseType: 'stream',
                    headers: headers,
                    httpAgent: httpAgent,
                    httpsAgent: httpsAgent,
                    timeout: 30000,
                    validateStatus: (status) => status < 500
                });

                if (response.status >= 400) {
                    _lastError = response.status;
                    const elapsedTime = Date.now() - retryStartTime;

                    // For live streams: check if next segment exists (skip ahead to stay live)
                    if (isVideoSegment && response.status === 404 && attempt === 0) {
                        const nextSegmentUrl = await tryNextSegment(currentUrl);
                        if (nextSegmentUrl) {
                            console.log('[Proxy] Skipping to next segment for live stream latency');
                            currentUrl = nextSegmentUrl;
                            segmentSkipped = true;
                            continue; // Try next segment immediately
                        }
                    }

                    // After 4 seconds of retries, skip the segment by returning empty response
                    if (elapsedTime >= 4000 && isVideoSegment) {
                        console.warn(`[Proxy] Skipping segment after ${Math.round(elapsedTime / 1000)}s of 404s: ${currentUrl.substring(currentUrl.lastIndexOf('/') + 1, 80)}...`);
                        res.status(200);
                        res.set('Content-Type', 'video/mp2t'); // MPEG-TS format
                        res.set('Content-Length', '0');
                        return res.end();
                    }

                    if (attempt < maxRetries) {
                        const delay = Math.min(200 * Math.pow(1.5, attempt), 800); // 200ms, 300ms, 450ms, 675ms, 800ms...
                        console.log(`[Proxy] Upstream returned ${response.status}, retry ${attempt + 1}/${maxRetries} after ${delay}ms (${Math.round(elapsedTime / 1000)}s elapsed): ${currentUrl.substring(currentUrl.lastIndexOf('/') + 1, 80)}...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    } else {
                        // Non-video segments (playlists) should fail
                        console.error(`[Proxy] Upstream returned ${response.status} after ${maxRetries} retries for ${currentUrl}`);
                        return res.status(response.status).end();
                    }
                }

                // Success - break out of retry loop
                if (segmentSkipped) {
                    console.log('[Proxy] Successfully retrieved next segment after skip');
                }
                break;
            } catch (err) {
                _lastError = err;
                const elapsedTime = Date.now() - retryStartTime;

                // After 4 seconds of retries, skip the segment
                if (elapsedTime >= 4000 && isVideoSegment) {
                    console.warn(`[Proxy] Skipping segment after ${Math.round(elapsedTime / 1000)}s of errors: ${err.message}`);
                    res.status(200);
                    res.set('Content-Type', 'video/mp2t');
                    res.set('Content-Length', '0');
                    return res.end();
                }

                if (attempt < maxRetries) {
                    const delay = Math.min(200 * Math.pow(1.5, attempt), 800);
                    console.log(`[Proxy] Request failed, retry ${attempt + 1}/${maxRetries} after ${delay}ms (${Math.round(elapsedTime / 1000)}s elapsed): ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw err;
            }
        }

        // Performance: Optimize socket for video streaming
        res.socket.setNoDelay(true);  // Disable Nagle's algorithm for lower latency
        res.socket.setKeepAlive(true, 1000);  // Keep connection alive

        res.set(response.headers);
        res.removeHeader('content-length');

        // Track bytes transferred
        stats.segmentCount++;
        let segmentBytes = 0;
        response.data.on('data', (chunk) => {
            stats.totalBytes += chunk.length;
            segmentBytes += chunk.length;
        });

        response.data.on('error', (err) => {
            console.error('[Proxy] Stream pipe error:', err);
            console.error('[Proxy] URL was:', currentUrl.substring(0, 100));
            if (!res.headersSent) res.status(500).end();
        });

        response.data.on('end', () => {
            const segmentName = currentUrl.substring(currentUrl.lastIndexOf('/') + 1, currentUrl.lastIndexOf('?') > 0 ? currentUrl.lastIndexOf('?') : undefined);
            console.log(`[Proxy] Segment completed: ${segmentName} (${segmentBytes} bytes)${segmentSkipped ? ' [SKIPPED AHEAD]' : ''}`);

            // Broadcast stats after segment completes
            const duration = (Date.now() - stats.startTime) / 1000; // seconds
            const transferRate = duration > 0 ? Math.round((stats.totalBytes / duration) / 1024) : 0; // KB/s

            // Get the latest delay from playback tracking for this device
            let currentDelay = 0;
            const tracking = playbackTracking.get(deviceIp);
            if (tracking && tracking.lastDelay !== undefined) {
                currentDelay = tracking.lastDelay;
            }

            broadcast({
                type: 'streamStats',
                deviceIp: deviceIp, // Include device IP so frontend knows which device these stats are for
                stats: {
                    totalBytes: stats.totalBytes,
                    totalMB: (stats.totalBytes / (1024 * 1024)).toFixed(2),
                    transferRate: transferRate,
                    duration: Math.round(duration),
                    resolution: stats.resolution,
                    bitrate: stats.bitrate,
                    segmentCount: stats.segmentCount,
                    cacheHits: stats.cacheHits,
                    delay: currentDelay,
                    frameRate: stats.frameRate
                }
            });
        });

        // Performance: Stream with larger chunks for better throughput
        response.data.pipe(res, { highWaterMark: 256 * 1024 }); // 256KB chunks

    } catch (e) {
        console.error('[Proxy] Error:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy failed: ' + e.message });
        }
    }
});


// --- API: Cast ---
const os = require('os');

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

app.post('/api/cast', (req, res) => {
    const { ip, url, proxy, referer } = req.body;
    console.log(`[Cast] Request received for IP: ${ip}, URL: ${url}, Proxy: ${proxy}, Referer: ${referer}`);

    // Clear any existing session and stats for this device (starting fresh)
    if (activeSessions.has(ip)) {
        console.log(`[Cast] Stopping existing session on ${ip} before starting new stream`);
        const existingSession = activeSessions.get(ip);
        try {
            existingSession.player.stop(() => {
                existingSession.client.close();
            });
        } catch (err) {
            console.warn('[Cast] Error stopping existing session:', err.message);
        }
        activeSessions.delete(ip);
    }

    // Clear tracking and stats for this specific device
    playbackTracking.delete(ip);
    streamStats.delete(ip);
    deviceToClientMap.delete(ip);
    console.log('[Cast] Statistics reset for new stream on', ip);

    // Resolve local IP (needed for proxy URL and mock device mapping)
    const localIp = getLocalIp();

    // Check if this is a mock device
    const isMockDevice = IS_DEV && devices[ip]?.isMock;

    // Map device IP to its client IP (the Chromecast's IP when making proxy requests)
    // For real Chromecasts, the device IP and client IP are the same
    // For mock devices, the client IP is the server's local IP (since it makes requests to http://localIP:port)
    const clientIpForMapping = isMockDevice ? localIp : ip;
    deviceToClientMap.set(ip, clientIpForMapping);
    console.log(`[Cast] Mapped device ${ip} to client ${clientIpForMapping}${isMockDevice ? ' (mock device)' : ''}`);

    let client, launchReceiver;
    if (isMockDevice) {
        console.log('[Cast] Using mock Chromecast device');
        client = new MockCastClient(mockDevice);
        launchReceiver = (ReceiverType, callback) => {
            // Return mock player
            const player = new MockPlayer(client, mockDevice);
            callback(null, player);
        };
    } else {
        client = new Client();
        launchReceiver = (ReceiverType, callback) => {
            client.launch(ReceiverType, callback);
        };
    }

    // Append Referer to the proxy URL
    const finalUrl = proxy
        ? `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`
        : url;

    console.log(`[Cast] Final Media URL: ${finalUrl}`);

    // Determine content type and video type
    let contentType = 'video/mp4';
    let videoType = 'mp4';
    const lowerUrl = finalUrl.toLowerCase();
    if (lowerUrl.includes('.m3u8') || lowerUrl.includes('playlist')) {
        contentType = 'application/x-mpegURL';
        videoType = 'hls';
    }
    if (lowerUrl.includes('.webm')) {
        contentType = 'video/webm';
        videoType = 'webm';
    }
    console.log(`[Cast] Content-Type: ${contentType}`);

    // Detect frame rate for MP4 streams upfront (HLS will be detected during playback)
    if (videoType === 'mp4') {
        detectFrameRate(url, 'mp4').then(fps => {
            if (fps && streamStats.has(ip)) {
                streamStats.get(ip).frameRate = fps;
                console.log(`[Cast] Detected MP4 frame rate: ${fps} FPS`);
                broadcast({
                    type: 'streamStats',
                    deviceIp: ip,
                    stats: { ...streamStats.get(ip) }
                });
            }
        }).catch(err => {
            console.log(`[Cast] Could not detect MP4 frame rate: ${err.message}`);
        });
    }

    client.connect(ip, () => {
        console.log(`[Cast] Connected to device ${ip}`);
        launchReceiver(DefaultMediaReceiver, (err, player) => {
            if (err) {
                console.error('[Cast] Launch failed:', err);
                if (!res.headersSent) res.status(500).json({ error: 'Launch failed: ' + err.message });
                client.close();
                return;
            }
            console.log('[Cast] DefaultMediaReceiver launched');
            console.log('[Cast] Attempting to load media...');

            const media = {
                contentId: finalUrl,
                contentType: contentType,
                streamType: 'LIVE' // Changed from BUFFERED to LIVE for HLS streams
            };

            console.log('[Cast] Media object:', JSON.stringify(media, null, 2));

            // Set timeout for load operation
            const loadTimeout = setTimeout(() => {
                console.error('[Cast] Load timeout - Chromecast may not be able to reach the proxy URL');
                console.error('[Cast] Verify:');
                console.error('[Cast]   1. Chromecast can reach', localIp);
                console.error('[Cast]   2. No firewall blocking port', PORT);
                console.error('[Cast]   3. Both devices on same network');
                if (!res.headersSent) {
                    res.status(408).json({
                        error: 'Load timeout - Chromecast cannot reach proxy',
                        proxyUrl: finalUrl,
                        troubleshooting: {
                            chromecastIp: ip,
                            proxyIp: localIp,
                            proxyPort: PORT,
                            message: 'Ensure Chromecast can reach the proxy IP. Check firewall and network settings.'
                        }
                    });
                }
                client.close();
            }, 10000); // 10 second timeout

            player.load(media, { autoplay: true }, (err, status) => {
                clearTimeout(loadTimeout);

                if (err) {
                    console.error('[Cast] Load failed:', err);
                    if (!res.headersSent) res.status(500).json({ error: 'Load failed: ' + err.message });
                    client.close();
                    return;
                }

                console.log('[Cast] Media loaded successfully');
                console.log('[Cast] Player status:', status);
                if (!res.headersSent) res.json({ status: 'casting', media: status });
                broadcast({ type: 'status', status: 'Playing on ' + ip });

                // Store active session for stop functionality
                activeSessions.set(ip, { client, player });

                // Initialize connection health monitoring
                initializeConnectionHealth(ip);

                // Initialize stream recovery tracking
                initializeStreamRecovery(ip, url, referer || '');

                // Monitor status
                player.on('status', (status) => {
                    console.log('[Cast] Player Status Update:', status.playerState);

                    // Update heartbeat on every status update
                    updateHeartbeat(ip);

                    // DEBUG: Log full status object once to see what's available
                    if (!playbackTracking.has(ip)) {
                        console.log('[Cast] Full status object:', JSON.stringify(status, null, 2));
                    }

                    // Track buffer health
                    trackBufferHealth(ip, status.playerState);

                    // Calculate delay only if liveSeekableRange is available
                    let delay = 0;
                    if (status.currentTime !== undefined && status.liveSeekableRange && status.liveSeekableRange.end !== undefined) {
                        // Use the live edge from Chromecast
                        const liveEdge = status.liveSeekableRange.end;
                        delay = Math.max(0, liveEdge - status.currentTime);
                        console.log(`[Delay] Live stream - edge: ${liveEdge.toFixed(1)}s, current: ${status.currentTime.toFixed(1)}s, delay: ${delay.toFixed(1)}s`);

                        // Store delay for streamStats broadcast
                        const tracking = playbackTracking.get(ip) || {};
                        tracking.lastDelay = delay;
                        playbackTracking.set(ip, tracking);
                    }

                    // Get buffer health stats
                    const bufferHealth = getBufferHealthStats(ip);

                    broadcast({
                        type: 'playerStatus',
                        deviceIp: ip, // Include device IP so frontend can filter
                        status,
                        delay,
                        bufferHealth
                    });
                });

                // Clean up session when media ends
                player.on('close', () => {
                    console.log('[Cast] Player closed for', ip);
                    activeSessions.delete(ip);
                    playbackTracking.delete(ip);
                    bufferHealthTracking.delete(ip);
                    streamRecovery.delete(ip);
                    deviceToClientMap.delete(ip);
                    connectionHealth.delete(ip);

                    // Clear stream statistics for this device
                    streamStats.delete(ip);

                    broadcast({ type: 'status', status: 'Playback ended' });
                });

                // Keep connection alive - don't close immediately
                // Client will auto-close when media ends or on error
            });
        });
    });

    client.on('error', (err) => {
        console.error('[Cast] Client error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Client error: ' + err.message });
        activeSessions.delete(ip);
        playbackTracking.delete(ip);
        deviceToClientMap.delete(ip);
        streamStats.delete(ip);
        client.close();
    });
});

// --- API: Get Session State ---
app.get('/api/session/:ip', (req, res) => {
    const { ip } = req.params;

    const session = activeSessions.get(ip);
    if (!session) {
        return res.json({ active: false });
    }

    const stats = streamStats.get(ip);
    const tracking = playbackTracking.get(ip);

    res.json({
        active: true,
        stats: stats || null,
        tracking: tracking || null,
        hasPlayer: !!session.player
    });
});

// --- API: Stop Casting ---
app.post('/api/stop', (req, res) => {
    const { ip } = req.body;
    console.log(`[Stop] Request received for IP: ${ip}`);

    if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
    }

    const session = activeSessions.get(ip);
    if (!session) {
        return res.status(404).json({ error: 'No active session found for this device' });
    }

    try {
        const { client, player } = session;

        // Stop playback
        player.stop((err) => {
            if (err) {
                console.error('[Stop] Failed to stop player:', err);
            } else {
                console.log('[Stop] Player stopped successfully');
            }

            // Close connection
            client.close();
            activeSessions.delete(ip);
            playbackTracking.delete(ip);
            bufferHealthTracking.delete(ip);
            streamRecovery.delete(ip);
            deviceToClientMap.delete(ip);
            connectionHealth.delete(ip);

            // Clear stream statistics for this device
            streamStats.delete(ip);

            broadcast({ type: 'status', status: 'Playback stopped' });
            res.json({ status: 'stopped' });
        });
    } catch (err) {
        console.error('[Stop] Error stopping playback:', err);
        activeSessions.delete(ip);
        streamRecovery.delete(ip);
        deviceToClientMap.delete(ip);
        streamStats.delete(ip);
        res.status(500).json({ error: 'Failed to stop playback: ' + err.message });
    }
});

const PORT = process.env.PORT || 3000;
const STALE_DEVICE_TIMEOUT_MS = parseInt(process.env.STALE_DEVICE_TIMEOUT_HOURS || '3') * 60 * 60 * 1000;

// Only start server if not being required as a module
if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`HomeCast running on port ${PORT}`);
        console.log(`[Server] Stale device timeout: ${STALE_DEVICE_TIMEOUT_MS / 1000 / 60 / 60} hours`);
        console.log(`[Server] Access the web interface at http://localhost:${PORT}`);
        console.log(`[Server] Local IP: ${getLocalIp()}`);
        console.log('[Server] Waiting for Chromecast devices...');
    });
}

// Export for testing
module.exports = { resolveM3u8Url };
