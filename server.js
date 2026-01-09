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

// --- Discovery ---
const devices = {};
const deviceLastSeen = new Map(); // Track when devices were last seen for staleness detection
console.log('[Discovery] Initializing mDNS browser for Chromecast devices...');
const browser = mdns.createBrowser(mdns.tcp('googlecast'));

// Active cast sessions (IP -> { client, player })
const activeSessions = new Map();

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

// --- API: Extract Video URL ---
app.post('/api/extract', apiLimiter, async (req, res) => {
    const { url } = req.body;
    let videoReferer = url; // Default to main URL

    try {
        // If it's already a video file, return it
        if (url.match(/\.(mp4|m3u8|webm|mkv)$/i)) return res.json({ videoUrl: url, referer: url });

        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 10000
        });
        const $ = cheerio.load(data);

        // Try common video selectors
        let videoUrl = $('video source').attr('src') ||
                       $('video').attr('src') ||
                       $('meta[property="og:video"]').attr('content') ||
                       $('meta[property="og:video:url"]').attr('content');

        // Fallback: Regex search in raw HTML (for streams inside JS/JSON)
        if (!videoUrl) {
            // Look for m3u8 first (common for livestreams)
            const m3u8Match = data.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/);
            if (m3u8Match) videoUrl = m3u8Match[0];
        }

        if (!videoUrl) {
            // Look for mp4 next
            const mp4Match = data.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/);
            if (mp4Match) videoUrl = mp4Match[0];
        }

        // Look for MJPEG streams (common for webcams)
        if (!videoUrl) {
            const mjpegMatch = data.match(/https?:\/\/[^"'\s]+(?:mjpg|mjpeg|jpg\/video)[^"'\s]*/);
            if (mjpegMatch) {
                videoUrl = mjpegMatch[0];
                console.log('[Extract] Found MJPEG stream:', videoUrl);
            }
        }

        // Deep Search: Inspect Iframes if still no video found
        if (!videoUrl) {
            const iframes = $('iframe').map((i, el) => $(el).attr('src')).get();
            for (let iframeSrc of iframes) {
                if (!iframeSrc) continue;
                try {
                    // Handle relative URLs
                    if (!iframeSrc.startsWith('http')) {
                        iframeSrc = new URL(iframeSrc, new URL(url).origin).href;
                    }

                    console.log(`[Extract] Checking iframe: ${iframeSrc}`);
                    const { data: iframeData } = await axios.get(iframeSrc, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': url // Critical for many embeds
                        },
                        httpAgent: httpAgent,
                        httpsAgent: httpsAgent,
                        timeout: 5000
                    });

                    // Regex search in iframe HTML
                    // 1. Standard m3u8/mp4
                    let match = iframeData.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/) ||
                                iframeData.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/);

                    // 2. Common Player variables (source: "http...", file: "http...")
                    if (!match) {
                        match = iframeData.match(/(?:source|file)\s*:\s*['"](https?:\/\/[^"']+)['"]/);
                    }

                    // 3. Obfuscated window.atob('...')
                    if (!match) {
                        const atobMatch = iframeData.match(/window\.atob\s*\(\s*['"]([a-zA-Z0-9+/=]+)['"]\s*\)/);
                        if (atobMatch) {
                            try {
                                const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
                                console.log(`[Extract] Decoded atob URL: ${decoded}`);
                                if (decoded.startsWith('http')) {
                                    videoUrl = decoded;
                                    videoReferer = iframeSrc; // Update referer to the iframe
                                    break;
                                }
                            } catch {
                                console.log('[Extract] Failed to decode atob string');
                            }
                        }
                    }

                    // 4. Aggressive loose match for anything with .m3u8
                    if (!match && !videoUrl) {
                        match = iframeData.match(/https?:\/\/[^"']+\.m3u8/);
                    }

                    if (match) {
                        videoUrl = match[1] || match[0]; // match[1] for capture group, match[0] for full match
                        videoReferer = iframeSrc; // Update referer to the iframe
                        console.log(`[Extract] Found in iframe: ${videoUrl}`);
                        break;
                    } else {
                        console.log(`[Extract] No video found in iframe ${iframeSrc}. Preview: ${iframeData.substring(0, 300)}...`);
                    }
                } catch (iframeErr) {
                    console.log(`[Extract] Failed to check iframe ${iframeSrc}: ${iframeErr.message}`);
                }
            }
        }

        if (!videoUrl) return res.status(404).json({ error: 'No video found' });

        // Handle relative URLs
        if (videoUrl && !videoUrl.startsWith('http')) {
            const u = new URL(url);
            videoUrl = new URL(videoUrl, u.origin).href;
        }

        // Check if it's MJPEG and warn user
        if (videoUrl.match(/mjpe?g|jpg.*video/i)) {
            return res.status(400).json({
                error: 'MJPEG streams are not supported',
                details: 'Chromecast does not support MJPEG format. This stream requires transcoding to HLS or MP4.',
                videoUrl: videoUrl
            });
        }

        res.json({ videoUrl, referer: videoReferer });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

// --- API: Proxy Stream ---
app.get('/proxy', proxyLimiter, async (req, res) => {
    const { url, referer } = req.query;
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[Proxy] Request from ${clientIp} for: ${url?.substring(0, 80)}...`);

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
                console.log(`[Proxy] Serving cached playlist (${cached.isLive ? 'LIVE' : 'VOD'}): ${url}`);
                res.set('Content-Type', contentType);
                return res.send(cached.content);
            }

            console.log(`[Proxy] Fetching and caching playlist: ${url}`);

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

        if (response.status >= 400) {
            console.error(`[Proxy] Upstream returned ${response.status} for ${url}`);
            return res.status(response.status).end();
        }

        // Performance: Optimize socket for video streaming
        res.socket.setNoDelay(true);  // Disable Nagle's algorithm for lower latency
        res.socket.setKeepAlive(true, 1000);  // Keep connection alive

        res.set(response.headers);
        res.removeHeader('content-length');

        response.data.on('error', (err) => {
            console.error('[Proxy] Stream pipe error:', err);
            if (!res.headersSent) res.status(500).end();
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

    const client = new Client();

    // Resolve local IP for callback
    const localIp = getLocalIp();
    // Append Referer to the proxy URL
    const finalUrl = proxy
        ? `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`
        : url;

    console.log(`[Cast] Final Media URL: ${finalUrl}`);

    // Determine content type
    let contentType = 'video/mp4';
    const lowerUrl = finalUrl.toLowerCase();
    if (lowerUrl.includes('.m3u8') || lowerUrl.includes('playlist')) {
        contentType = 'application/x-mpegURL';
    }
    if (lowerUrl.includes('.webm')) contentType = 'video/webm';
    console.log(`[Cast] Content-Type: ${contentType}`);

    client.connect(ip, () => {
        console.log(`[Cast] Connected to device ${ip}`);
        client.launch(DefaultMediaReceiver, (err, player) => {
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

                // Monitor status
                player.on('status', (status) => {
                    console.log('[Cast] Player Status Update:', status.playerState);
                    broadcast({ type: 'playerStatus', status });
                });

                // Clean up session when media ends
                player.on('close', () => {
                    console.log('[Cast] Player closed for', ip);
                    activeSessions.delete(ip);
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
        client.close();
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

            broadcast({ type: 'status', status: 'Playback stopped' });
            res.json({ status: 'stopped' });
        });
    } catch (err) {
        console.error('[Stop] Error stopping playback:', err);
        activeSessions.delete(ip);
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
