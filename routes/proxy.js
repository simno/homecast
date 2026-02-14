const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const {
    playlistCache,
    streamStats,
    playbackTracking,
    deviceToClientMap,
} = require('../lib/state');
const {
    httpAgent,
    httpsAgent,
    CACHE_TTL_VOD,
    CACHE_TTL_LIVE,
} = require('../lib/utils');
const { validateProxyUrl } = require('../lib/security');
const { broadcast } = require('../lib/websocket');
const { updateHeartbeat } = require('../lib/health');
const { trackStreamActivity } = require('../lib/recovery');
const { resolveM3u8Url, tryNextSegment } = require('../lib/proxy');

const router = express.Router();

const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: 'Too many proxy requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

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
}, 120000);

// --- API: Proxy Stream ---
router.get('/proxy', proxyLimiter, async (req, res) => {
    const { url, referer } = req.query;
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[Proxy] Request from ${clientIp} for: ${url?.substring(0, 80)}...`);

    if (!url) return res.status(400).json({ error: 'URL parameter required' });

    // Find which device this client belongs to
    let deviceIp = null;

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

    if (!deviceIp) {
        deviceIp = clientIp;
        console.log(`[Proxy] No device mapping found for ${clientIp}, using as device IP`);
    }

    updateHeartbeat(deviceIp);
    trackStreamActivity(deviceIp);

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

            const cacheTTL = cached?.isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;

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

                    const isLive = !originalM3u8.includes('#EXT-X-ENDLIST');

                    const resolutionMatch = originalM3u8.match(/RESOLUTION=(\d+x\d+)/);
                    if (resolutionMatch) {
                        stats.resolution = resolutionMatch[1];
                    } else if (!stats.resolution || stats.resolution === 'Unknown') {
                        stats.resolution = 'Live Stream';
                    }

                    const bandwidthMatch = originalM3u8.match(/BANDWIDTH=(\d+)/);
                    if (bandwidthMatch) {
                        stats.bitrate = Math.round(parseInt(bandwidthMatch[1]) / 1000);
                    } else if (!stats.bitrate || stats.bitrate === 0) {
                        const targetDurationMatch = originalM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
                        if (targetDurationMatch && stats.segmentCount > 0) {
                            const duration = (Date.now() - stats.startTime) / 1000;
                            if (duration > 10) {
                                stats.bitrate = Math.round((stats.totalBytes * 8) / duration / 1000);
                            }
                        }
                    }

                    const frameRateMatch = originalM3u8.match(/FRAME-RATE=([\d.]+)/);
                    if (frameRateMatch && !stats.frameRate) {
                        stats.frameRate = parseFloat(frameRateMatch[1]);
                        console.log(`[Proxy] Detected frame rate from playlist: ${stats.frameRate} FPS`);
                        broadcast({
                            type: 'streamStats',
                            deviceIp: deviceIp,
                            stats: { ...stats }
                        });
                    } else if (!stats.frameRate) {
                        const targetDuration = originalM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
                        if (targetDuration && stats.segmentCount > 5) {
                            const segDuration = parseInt(targetDuration[1]);
                            if (segDuration <= 2) {
                                stats.frameRate = 60;
                            } else if (segDuration >= 3 && segDuration <= 10) {
                                stats.frameRate = 30;
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
                            return line;
                        }

                        const proxyUrl = `http://${req.headers.host}/proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent(referer || '')}`;
                        return proxyUrl;
                    }).join('\n');

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
        const isVideoSegment = url.includes('.ts') || url.includes('.m4s') || url.includes('.mp4');
        let response;
        let _lastError;
        let currentUrl = url;
        const maxRetries = isVideoSegment ? 10 : 0;
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

                    if (isVideoSegment && response.status === 404 && attempt === 0) {
                        const nextSegmentUrl = await tryNextSegment(currentUrl);
                        if (nextSegmentUrl) {
                            console.log('[Proxy] Skipping to next segment for live stream latency');
                            currentUrl = nextSegmentUrl;
                            segmentSkipped = true;
                            continue;
                        }
                    }

                    if (elapsedTime >= 4000 && isVideoSegment) {
                        console.warn(`[Proxy] Skipping segment after ${Math.round(elapsedTime / 1000)}s of 404s: ${currentUrl.substring(currentUrl.lastIndexOf('/') + 1, 80)}...`);
                        res.status(200);
                        res.set('Content-Type', 'video/mp2t');
                        res.set('Content-Length', '0');
                        return res.end();
                    }

                    if (attempt < maxRetries) {
                        const delay = Math.min(200 * Math.pow(1.5, attempt), 800);
                        console.log(`[Proxy] Upstream returned ${response.status}, retry ${attempt + 1}/${maxRetries} after ${delay}ms (${Math.round(elapsedTime / 1000)}s elapsed): ${currentUrl.substring(currentUrl.lastIndexOf('/') + 1, 80)}...`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    } else {
                        console.error(`[Proxy] Upstream returned ${response.status} after ${maxRetries} retries for ${currentUrl}`);
                        return res.status(response.status).end();
                    }
                }

                if (segmentSkipped) {
                    console.log('[Proxy] Successfully retrieved next segment after skip');
                }
                break;
            } catch (err) {
                _lastError = err;
                const elapsedTime = Date.now() - retryStartTime;

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
        res.socket.setNoDelay(true);
        res.socket.setKeepAlive(true, 1000);

        res.set(response.headers);
        res.removeHeader('content-length');

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

            const duration = (Date.now() - stats.startTime) / 1000;
            const transferRate = duration > 0 ? Math.round((stats.totalBytes / duration) / 1024) : 0;

            let currentDelay = 0;
            const tracking = playbackTracking.get(deviceIp);
            if (tracking && tracking.lastDelay !== undefined) {
                currentDelay = tracking.lastDelay;
            }

            broadcast({
                type: 'streamStats',
                deviceIp: deviceIp,
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
        response.data.pipe(res, { highWaterMark: 256 * 1024 });

    } catch (e) {
        console.error('[Proxy] Error:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy failed: ' + e.message });
        }
    }
});

module.exports = router;
