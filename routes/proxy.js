const express = require('express');
const { PassThrough } = require('stream');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const {
    playlistCache,
    streamStats,
    playbackTracking,
    deviceToClientMap
} = require('../lib/state');
const {
    httpAgent,
    httpsAgent,
    CACHE_TTL_VOD,
    CACHE_TTL_LIVE,
    USER_AGENT
} = require('../lib/utils');
const { validateProxyUrl, safeRequestOptions } = require('../lib/security');
const { broadcast } = require('../lib/websocket');
const { updateHeartbeat } = require('../lib/health');
const { trackStreamActivity } = require('../lib/recovery');
const { markBroadcastEnded } = require('../lib/cast');
const {
    tryNextSegment,
    filterMasterPlaylist,
    rewritePlaylist,
    buildProxyUrl,
    shouldSendReferer,
    noteRefererRejected,
    isReceiverDecodable
} = require('../lib/proxy');
const transcoder = require('../lib/transcode');
const { fixSegmentTiming } = require('../lib/h264-timing');
const { getBufferHealthStats } = require('../lib/stats');
const { rewriteMpd, describeMpd, dashSegmentUrl, upstreamFromDashPath } = require('../lib/dash');
const { toWebVtt } = require('../lib/subtitles');

const router = express.Router();

const proxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: 'Too many proxy requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

// DASH segments arrive far faster than HLS ones: audio and video are fetched
// separately, often as 2s segments, and on-demand streams add byte ranges.
const dashSegmentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    message: 'Too many proxy requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

function withoutReferer(headers) {
    const stripped = { ...headers };
    delete stripped['Referer'];
    return stripped;
}

async function fetchUpstream(url, headers, axiosConfig) {
    // Security: pin DNS resolution at connect time so a rebinding attack can't
    // swap in a private IP after validateProxyUrl() already approved this URL,
    // and vet every redirect hop (IP-literal hops never reach the lookup).
    axiosConfig = { ...axiosConfig, ...safeRequestOptions };

    // Hosts already known to 401 on any Referer skip the doomed first attempt.
    if (headers['Referer'] && !shouldSendReferer(url)) {
        return await axios({ ...axiosConfig, url, headers: withoutReferer(headers) });
    }

    // Retry bare, and only blame the Referer if that is what actually fixed it.
    const retryWithoutReferer = async (status) => {
        console.log(`[Proxy] Upstream returned ${status} with referer, retrying without...`);
        const response = await axios({ ...axiosConfig, url, headers: withoutReferer(headers) });
        if (response.status < 400) noteRefererRejected(url);
        return response;
    };

    try {
        const response = await axios({ ...axiosConfig, url, headers });
        if ((response.status === 401 || response.status === 403) && headers['Referer']) {
            return await retryWithoutReferer(response.status);
        }
        return response;
    } catch (err) {
        if (err.response && (err.response.status === 401 || err.response.status === 403) && headers['Referer']) {
            return await retryWithoutReferer(err.response.status);
        }
        throw err;
    }
}

const MAX_CACHE_SIZE = 100;

// In-flight upstream playlist fetches, keyed the same as playlistCache.
// Prevents a "cache stampede": several requests for the same url|quality
// arriving within a few ms of each other (common when an HLS client and a
// dashboard preview hit the same manifest) would otherwise all miss the
// cache and each trigger their own upstream fetch. Concurrent callers await
// the same promise instead.
const inFlightPlaylistFetches = new Map();

// With `transcode` set, a master whose kept variant a Chromecast can't decode
// (4K H.264) declares HEVC and marks that variant's playlist for conversion; a
// media playlist marked that way points its segments at converted copies.
function planTranscode(m3u8, quality) {
    if (/#EXT-X-STREAM-INF/i.test(m3u8)) {
        // Only a single kept variant: 'auto' leaves the choice to the receiver.
        if (quality === 'auto') return null;
        const inf = m3u8.match(/#EXT-X-STREAM-INF:[^\n]*/i)[0];
        const codecs = inf.match(/CODECS="([^"]*)"/i)?.[1] || '';
        const height = parseInt(inf.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || '0', 10);
        return isReceiverDecodable({ codecs, height }) ? null : 'master';
    }
    if (!transcoder.canConvertMediaPlaylist(m3u8)) {
        console.warn('[Transcode] Segments are fMP4 or encrypted — cannot convert, passing through');
        return null;
    }
    return 'media';
}

function fetchAndRewritePlaylist(cacheKey, url, quality, headers, req, referer, transcode, { cache = true, device } = {}) {
    if (inFlightPlaylistFetches.has(cacheKey)) {
        return inFlightPlaylistFetches.get(cacheKey);
    }

    const promise = (async () => {
        const response = await fetchUpstream(url, headers, {
            method: 'get',
            responseType: 'stream',
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 30000,
            validateStatus: (status) => status < 500
        });

        if (response.status >= 400) {
            return { ok: false, status: response.status };
        }

        const chunks = await new Promise((resolve, reject) => {
            const collected = [];
            response.data.on('data', chunk => collected.push(chunk));
            response.data.on('error', reject);
            response.data.on('end', () => resolve(collected));
        });

        const originalM3u8 = Buffer.concat(chunks).toString('utf8');
        const baseUrl = new URL(url);
        // An LG TV decodes 4K H.264 itself: nothing needs filtering out for it.
        let filteredM3u8 = filterMasterPlaylist(originalM3u8, quality, { convertible: !!transcode || device === 'webos' });
        const isLive = !filteredM3u8.includes('#EXT-X-ENDLIST');
        const plan = transcode ? planTranscode(filteredM3u8, quality) : null;
        if (plan === 'master') filteredM3u8 = transcoder.declareHevc(filteredM3u8);

        // Carry quality onto child playlist requests so variant and segment
        // fetches stay consistent (and cache cleanly), and flag child playlists
        // so extensionless ones are still rewritten when they come back through.
        // Conversion follows the video variant and its segments, not separate
        // audio or subtitle renditions (tag URIs).
        const segmentUrls = [];
        let rewrittenM3u8 = rewritePlaylist(filteredM3u8, baseUrl, (childUrl, isPlaylist, isTagUri) => {
            if (plan === 'media' && !isPlaylist && !isTagUri) segmentUrls.push(childUrl);
            return buildProxyUrl(req.headers.host, {
                url: childUrl,
                referer,
                quality,
                type: isPlaylist ? 'hls' : undefined,
                transcode: plan && !isTagUri ? 'hevc' : undefined,
                device
            });
        });
        if (plan === 'media') {
            // One #EXTINF per segment, in the same order as the URIs.
            const durations = [...filteredM3u8.matchAll(/^#EXTINF:\s*([\d.]+)/gim)].map(m => parseFloat(m[1]));
            transcoder.noteVariant(url, segmentUrls.map((u, i) => ({ url: u, duration: durations[i] || 0 })),
                { live: isLive, fetchSegment: segmentFetcher(headers) });
            rewrittenM3u8 = transcoder.addInitMap(rewrittenM3u8,
                buildProxyUrl(req.headers.host, { url, referer, quality, transcode: 'hevc', part: 'init' }));
        }

        if (cache) playlistCache.set(cacheKey, {
            content: rewrittenM3u8,
            timestamp: Date.now(),
            isLive: isLive,
            ttl: playlistTtl(filteredM3u8, isLive)
        });

        return { ok: true, filteredM3u8, rewrittenM3u8, isLive };
    })();

    inFlightPlaylistFetches.set(cacheKey, promise);
    promise.finally(() => inFlightPlaylistFetches.delete(cacheKey));
    return promise;
}

// A live media playlist gains a segment every target duration, so caching it
// any longer than that hides the newest segments: a receiver playing near the
// live edge (Twitch uses 2s segments) then runs dry and stalls. Cap the live
// TTL at half the target duration so a refresh always sees fresh segments.
function playlistTtl(m3u8, isLive) {
    if (!isLive) return CACHE_TTL_VOD;
    const target = m3u8.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
    return target ? Math.min(CACHE_TTL_LIVE, parseFloat(target[1]) * 500) : CACHE_TTL_LIVE;
}

// Clean up expired and excess playlist cache entries every 2 minutes
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of playlistCache.entries()) {
        if (now - value.timestamp > value.ttl) {
            playlistCache.delete(key);
            cleaned++;
        }
    }

    // Evict oldest entries if still over the max size
    if (playlistCache.size > MAX_CACHE_SIZE) {
        const entries = [...playlistCache.entries()]
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        const toEvict = entries.slice(0, playlistCache.size - MAX_CACHE_SIZE);
        for (const [key] of toEvict) {
            playlistCache.delete(key);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[Cache] Cleaned ${cleaned} playlist entries`);
    }
}, 120000).unref(); // housekeeping only; don't hold the process open

// A media playlist (one listing segments, not variants) that ends in
// #EXT-X-ENDLIST: if the device was playing it live, the broadcast is over.
function noteClosedPlaylist(deviceIp, m3u8) {
    if (deviceIp && m3u8.includes('#EXT-X-ENDLIST') && m3u8.includes('#EXTINF')) {
        markBroadcastEnded(deviceIp);
    }
}

// Which cast device a proxy request belongs to, and that device's stats
// (created on first sight). Also feeds the health and stall monitors.
function trackClient(clientIp) {
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

    updateHeartbeat(deviceIp, 'media');
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

    return { deviceIp, stats };
}

// Log a finished segment and send the page the device's updated stats.
function noteSegmentDone({ deviceIp, stats, url, bytes, segmentSkipped }) {
    const segmentName = url.substring(url.lastIndexOf('/') + 1, url.lastIndexOf('?') > 0 ? url.lastIndexOf('?') : undefined);
    console.log(`[Proxy] Segment completed: ${segmentName} (${bytes} bytes)${segmentSkipped ? ' [SKIPPED AHEAD]' : ''}`);

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
        bufferHealth: getBufferHealthStats(deviceIp),
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
}

// Stream an upstream response to the receiver, forwarding its status (206
// for ranges) and headers, and counting the bytes toward the device's stats.
function pipeUpstream(res, response, { deviceIp, stats, url: currentUrl, segmentSkipped = false }) {
    // Performance: Optimize socket for video streaming
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true, 1000);

    // Forward the upstream's headers, except the ones that are ours to
    // decide. CORS is the important case: an upstream that pins access to
    // its own site (pscp.tv, which serves X/Periscope broadcasts, answers
    // `Access-Control-Allow-Origin: https://x.com`) would otherwise
    // overwrite the `*` set above. Playlists still carried `*` because
    // they're sent via res.send() further up, so the receiver would fetch
    // the manifest, then fail the CORS check on every segment — the cast
    // appears to start and then stalls without a single byte of video.
    const upstreamHeaders = { ...response.headers };
    for (const name of Object.keys(upstreamHeaders)) {
        if (name.toLowerCase().startsWith('access-control-')) {
            delete upstreamHeaders[name];
        }
    }
    delete upstreamHeaders['set-cookie'];

    res.status(response.status);
    res.set(upstreamHeaders);
    res.removeHeader('content-length');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');

    // .pipe() below does not destroy its source when the destination
    // closes unexpectedly, so an aborting client (e.g. a channel change
    // mid-segment) would otherwise leak the upstream socket.
    res.on('close', () => {
        if (!res.writableEnded) response.data.destroy();
    });

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

    response.data.on('end', () => noteSegmentDone({ deviceIp, stats, url: currentUrl, bytes: segmentBytes, segmentSkipped }));

    // Performance: Stream with larger chunks for better throughput
    response.data.pipe(res, { highWaterMark: 256 * 1024 });
}

// Segments for an LG TV get their frame-rate header checked
// (lib/h264-timing.js). Whether one is MPEG-TS is read from its first bytes,
// not its name: many CDNs serve segments without a .ts extension or content
// type. Anything else, or anything bigger than a segment (a continuous TS
// stream never ends), is passed on as it arrives.
const MAX_TIMED_SEGMENT_BYTES = 64 * 1024 * 1024;
const TS_SYNC_BYTE = 0x47;

// The stream's first chunk, with the stream left paused; null if it's empty.
function firstChunk(stream) {
    return new Promise((resolve, reject) => {
        const done = (fn) => (value) => {
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
            fn(value);
        };
        const onData = done((chunk) => { stream.pause(); resolve(chunk); });
        const onEnd = done(() => resolve(null));
        const onError = done(reject);
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
    });
}

// The rest of the stream after `first`, up to `limit` bytes. `complete` is
// false when the limit was reached (the stream is paused there).
function readUpTo(stream, first, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [first];
        // It may have ended while paused after its first chunk.
        if (stream.readableEnded) return resolve({ chunks, complete: true });
        let size = first.length;
        const done = (fn) => (value) => {
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
            fn(value);
        };
        const onData = (chunk) => {
            chunks.push(chunk);
            size += chunk.length;
            if (size > limit) done(() => { stream.pause(); resolve({ chunks, complete: false }); })();
        };
        const onEnd = done(() => resolve({ chunks, complete: true }));
        const onError = done(reject);
        stream.on('data', onData);
        stream.on('end', onEnd);
        stream.on('error', onError);
        stream.resume();
    });
}

// `stream` with `head` put back in front of whatever it has left.
function prepend(stream, head) {
    const combined = new PassThrough();
    combined.write(head);
    if (stream.readableEnded) combined.end();
    else stream.pipe(combined);
    stream.on('error', err => combined.destroy(err));
    combined.on('close', () => stream.destroy());
    return combined;
}

// Serve a segment to an LG TV: a whole TS segment with its frame-rate header
// corrected when needed; anything else piped through as usual.
async function serveTimedSegment(res, response, context) {
    const length = parseInt(response.headers['content-length'] || '0', 10);
    if (length > MAX_TIMED_SEGMENT_BYTES) return pipeUpstream(res, response, context);

    const first = await firstChunk(response.data);
    if (!first) return res.status(response.status).end();
    if (first[0] !== TS_SYNC_BYTE) {
        response.data = prepend(response.data, first);
        return pipeUpstream(res, response, context);
    }
    const { chunks, complete } = await readUpTo(response.data, first, MAX_TIMED_SEGMENT_BYTES);
    if (!complete) {
        response.data = prepend(response.data, Buffer.concat(chunks));
        return pipeUpstream(res, response, context);
    }
    const body = await fixSegmentTiming(Buffer.concat(chunks));

    const { deviceIp, stats, url, segmentSkipped } = context;
    stats.segmentCount++;
    stats.totalBytes += body.length;
    res.status(response.status);
    res.set('Content-Type', response.headers['content-type'] || 'video/mp2t');
    res.header('Access-Control-Allow-Origin', '*');
    res.send(body);
    noteSegmentDone({ deviceIp, stats, url, bytes: body.length, segmentSkipped });
}

// Fetch an MPD and hand the receiver a copy whose every URL points back at us.
async function serveDashManifest(req, res, { url, referer, quality, headers, stats, device }) {
    const response = await fetchUpstream(url, headers, {
        method: 'get',
        responseType: 'text',
        transformResponse: (body) => body,
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        timeout: 15000,
        maxContentLength: 8 * 1024 * 1024,
        validateStatus: (status) => status < 500
    });

    if (response.status >= 400) {
        console.error(`[Proxy] Upstream returned ${response.status} for MPD ${url}`);
        return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }

    // Relative references resolve against where the MPD actually came from.
    const mpdUrl = response.request?.res?.responseUrl || url;
    const host = req.headers.host;
    const rewritten = rewriteMpd(response.data, mpdUrl, {
        quality,
        // An LG TV decodes 4K H.264 itself: nothing needs filtering out for it.
        convertible: device === 'webos',
        toSegmentUrl: (segmentUrl) => dashSegmentUrl(host, segmentUrl, referer),
        toManifestUrl: (manifestUrl) => buildProxyUrl(host, { url: manifestUrl, referer, quality, type: 'dash', device })
    });
    if (!rewritten) {
        return res.status(502).json({ error: 'Upstream did not return a DASH manifest' });
    }

    const top = describeMpd(rewritten)?.qualities[0];
    if (top) {
        stats.resolution = top.label;
        stats.bitrate = Math.round(top.bandwidth / 1000);
    }

    res.set('Content-Type', 'application/dash+xml');
    res.set('Cache-Control', 'no-cache');
    return res.send(rewritten);
}

// --- API: DASH segments ---
// /proxy/dash/<token>/<upstream path>: see lib/dash.js for why DASH needs a
// path-shaped proxy. Ranges are forwarded — on-demand DASH (SegmentBase)
// reads its index and media as byte ranges of a single file.
const DASH_SEGMENT_PATH = /^\/proxy\/dash\//;

router.options(DASH_SEGMENT_PATH, (_req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Max-Age': '86400'
    });
    res.status(204).end();
});

router.get(DASH_SEGMENT_PATH, dashSegmentLimiter, async (req, res) => {
    const target = upstreamFromDashPath(req.originalUrl);
    if (!target) return res.status(400).json({ error: 'Malformed DASH proxy path' });

    const { deviceIp, stats } = trackClient(req.ip || req.socket.remoteAddress);

    const validation = await validateProxyUrl(target.url);
    if (!validation.valid) {
        console.warn(`[Security] Blocked DASH segment request: ${validation.reason}`);
        return res.status(403).json({ error: 'URL blocked by security policy', reason: validation.reason });
    }

    res.header('Access-Control-Allow-Origin', '*');

    const headers = { 'User-Agent': USER_AGENT };
    if (target.referer) headers['Referer'] = target.referer;
    if (req.headers.range) headers['Range'] = req.headers.range;

    try {
        const response = await fetchUpstream(target.url, headers, {
            method: 'get',
            responseType: 'stream',
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 30000,
            validateStatus: (status) => status < 500
        });

        if (response.status >= 400) {
            response.data.destroy();
            console.error(`[Proxy] Upstream returned ${response.status} for DASH segment ${target.url.substring(0, 100)}`);
            return res.status(response.status).end();
        }

        pipeUpstream(res, response, { deviceIp, stats, url: target.url });
    } catch (e) {
        console.error('[Proxy] DASH segment error:', e.message);
        if (!res.headersSent) res.status(502).json({ error: 'Proxy failed: ' + e.message });
    }
});

// Subtitle files for sideloaded text tracks, always served as WebVTT: that's
// the one sidecar format receivers take, and many sites serve SRT.
const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;

async function serveSubtitle(res, { url, headers }) {
    const response = await fetchUpstream(url, headers, {
        method: 'get',
        responseType: 'arraybuffer',
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        timeout: 15000,
        maxContentLength: SUBTITLE_MAX_BYTES,
        validateStatus: (status) => status < 500
    });

    if (response.status >= 400) {
        console.error(`[Proxy] Upstream returned ${response.status} for subtitles ${url}`);
        return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }

    const vtt = toWebVtt(Buffer.from(response.data));
    if (vtt === null) {
        console.warn(`[Proxy] Not a WebVTT or SRT file: ${url.substring(0, 80)}`);
        return res.status(415).json({ error: 'Not a WebVTT or SRT subtitle file' });
    }
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    return res.send(vtt);
}

// The video's thumbnail for the cast form's preview. Only images are passed
// on, so this can't be used to fetch anything else through the page's origin.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

async function serveImage(res, { url, headers }) {
    const response = await fetchUpstream(url, headers, {
        method: 'get',
        responseType: 'arraybuffer',
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        timeout: 10000,
        maxContentLength: IMAGE_MAX_BYTES,
        validateStatus: (status) => status < 500
    });

    if (response.status >= 400) {
        return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|gif|webp|avif)$/.test(contentType)) {
        return res.status(415).json({ error: 'Not an image' });
    }
    res.set({ 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600' });
    return res.send(Buffer.from(response.data));
}

// --- Converted (HEVC) segments, see lib/transcode.js ---

// The source bytes of a segment to convert, fetched like any proxied request
// (Referer handling, pinned DNS).
function segmentFetcher(headers) {
    return async (segmentUrl, signal) => {
        const response = await fetchUpstream(segmentUrl, headers, {
            method: 'get',
            responseType: 'arraybuffer',
            signal,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 15000,
            maxContentLength: 64 * 1024 * 1024
        });
        return Buffer.from(response.data);
    };
}

async function serveConvertedInit(res, { url, headers }) {
    try {
        const init = await transcoder.getInit(url, segmentFetcher(headers));
        res.set({ 'Content-Type': 'video/mp4', 'Cache-Control': 'max-age=3600' });
        return res.send(init);
    } catch (e) {
        console.error(`[Transcode] Init section failed: ${e.message}`);
        return res.status(502).json({ error: 'Conversion failed: ' + e.message });
    }
}

async function serveConvertedSegment(res, { url, headers, deviceIp, stats }) {
    // Validated above, like every proxied URL; segments listed in a converted
    // playlist are the only ones the receiver asks for.
    let media;
    try {
        media = await transcoder.getSegment(url, segmentFetcher(headers));
    } catch (e) {
        console.error(`[Transcode] Segment failed: ${e.message}`);
        return res.status(502).json({ error: 'Conversion failed: ' + e.message });
    }

    stats.segmentCount++;
    stats.totalBytes += media.length;
    // The dashboard's bitrate is what the receiver gets: the converted
    // stream's, not the source's the master playlist declared.
    const transcode = transcoder.statsFor(url);
    if (transcode?.outputKbps) stats.bitrate = transcode.outputKbps;
    const duration = (Date.now() - stats.startTime) / 1000;
    broadcast({
        type: 'streamStats',
        deviceIp,
        bufferHealth: getBufferHealthStats(deviceIp),
        stats: {
            ...stats,
            totalMB: (stats.totalBytes / (1024 * 1024)).toFixed(2),
            transferRate: duration > 0 ? Math.round((stats.totalBytes / duration) / 1024) : 0,
            duration: Math.round(duration),
            delay: playbackTracking.get(deviceIp)?.lastDelay || 0,
            transcode
        }
    });

    res.set('Content-Type', 'video/mp4');
    return res.send(media);
}

// --- API: Proxy Stream ---
router.get('/proxy', proxyLimiter, async (req, res) => {
    const { url, referer } = req.query;
    // Quality cap for HLS master playlists. Absent/empty defaults to 'highest'
    // so the highest available variant plays on every site unless the user
    // explicitly picks another quality (or 'auto' for adaptive bitrate).
    const quality = req.query.quality || 'highest';
    const clientIp = req.ip || req.connection.remoteAddress;

    console.log(`[Proxy] Request from ${clientIp} for: ${url?.substring(0, 80)}...`);

    if (!url) return res.status(400).json({ error: 'URL parameter required' });

    // Thumbnails are fetched by the browser, not a cast device: don't track
    // the page as a streaming client.
    const isImage = req.query.type === 'image';
    const { deviceIp, stats } = isImage ? {} : trackClient(clientIp);

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
            'User-Agent': USER_AGENT
        };
        if (referer) headers['Referer'] = referer;

        if (req.query.type === 'subtitle') {
            return await serveSubtitle(res, { url, headers });
        }
        if (isImage) {
            return await serveImage(res, { url, headers });
        }

        // `type` comes from the extractor (it sniffed the response) or from a
        // parent manifest, and covers manifests whose URL doesn't say so.
        const isDash = req.query.type === 'dash' || (req.query.type !== 'hls' && /\.mpd(?:$|[?;])/i.test(url));
        if (isDash) {
            const device = req.query.device === 'webos' ? 'webos' : undefined;
            return await serveDashManifest(req, res, { url, referer, quality, headers, stats, device });
        }

        const transcode = req.query.transcode === 'hevc' && transcoder.isAvailable() ? 'hevc' : undefined;
        const device = req.query.device === 'webos' ? 'webos' : undefined;
        if (transcode && req.query.part === 'init') {
            return await serveConvertedInit(res, { url, headers });
        }

        const isPlaylist = req.query.type === 'hls' || url.includes('.m3u8') || url.includes('playlist');
        const contentType = isPlaylist ? 'application/vnd.apple.mpegurl' : '';

        if (transcode && !isPlaylist) {
            return await serveConvertedSegment(res, { url, headers, deviceIp, stats });
        }

        // HLS Playlist - Check cache first
        if (isPlaylist) {
            // Quality is part of the key: the same upstream master URL yields
            // different rewritten playlists per requested quality.
            const cacheKey = `${url}|q=${quality}${transcode ? '|t=hevc' : ''}${device ? `|d=${device}` : ''}`;
            const cached = playlistCache.get(cacheKey);

            const cacheTTL = cached?.ttl;

            if (cached && (Date.now() - cached.timestamp < cacheTTL)) {
                const age = Math.round((Date.now() - cached.timestamp) / 1000);
                console.log(`[Proxy] Serving cached playlist (${cached.isLive ? 'LIVE' : 'VOD'}, age: ${age}s): ${url.substring(0, 80)}...`);
                stats.cacheHits++;
                noteClosedPlaylist(deviceIp, cached.content);
                res.set('Content-Type', contentType);
                return res.send(cached.content);
            }

            if (cached) {
                const age = Math.round((Date.now() - cached.timestamp) / 1000);
                console.log(`[Proxy] Cache expired (age: ${age}s, TTL: ${cacheTTL / 1000}s), refetching: ${url.substring(0, 80)}...`);
            } else {
                console.log(`[Proxy] No cache entry, fetching: ${url.substring(0, 80)}...`);
            }

            const result = await fetchAndRewritePlaylist(cacheKey, url, quality, headers, req, referer, transcode, { device });

            if (!result.ok) {
                console.error(`[Proxy] Upstream returned ${result.status} for ${url}`);
                return res.status(result.status).json({ error: `Upstream error: ${result.status}` });
            }

            const { filteredM3u8, rewrittenM3u8, isLive } = result;
            noteClosedPlaylist(deviceIp, filteredM3u8);

            // Cap a master playlist to the requested quality (no-op for media
            // playlists and for quality=auto). Stats below are parsed from the
            // filtered playlist so they reflect what actually plays. Applied
            // per-request (even when the fetch above was shared with a
            // concurrent caller) so every requesting device's stats stay accurate.
            const resolutionMatch = filteredM3u8.match(/RESOLUTION=(\d+x\d+)/);
            if (resolutionMatch) {
                stats.resolution = resolutionMatch[1];
            } else if (!stats.resolution || stats.resolution === 'Unknown') {
                stats.resolution = 'Live Stream';
            }

            const bandwidthMatch = filteredM3u8.match(/BANDWIDTH=(\d+)/);
            if (bandwidthMatch) {
                stats.bitrate = Math.round(parseInt(bandwidthMatch[1]) / 1000);
            } else if (!stats.bitrate || stats.bitrate === 0) {
                const targetDurationMatch = filteredM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
                if (targetDurationMatch && stats.segmentCount > 0) {
                    const duration = (Date.now() - stats.startTime) / 1000;
                    if (duration > 10) {
                        stats.bitrate = Math.round((stats.totalBytes * 8) / duration / 1000);
                    }
                }
            }

            const frameRateMatch = filteredM3u8.match(/FRAME-RATE=([\d.]+)/);
            if (frameRateMatch && !stats.frameRate) {
                stats.frameRate = parseFloat(frameRateMatch[1]);
                console.log(`[Proxy] Detected frame rate from playlist: ${stats.frameRate} FPS`);
                broadcast({
                    type: 'streamStats',
                    deviceIp: deviceIp,
                    bufferHealth: getBufferHealthStats(deviceIp),
                    stats: { ...stats }
                });
            } else if (!stats.frameRate) {
                const targetDuration = filteredM3u8.match(/#EXT-X-TARGETDURATION:(\d+)/);
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
                            bufferHealth: getBufferHealthStats(deviceIp),
                            stats: { ...stats }
                        });
                    }
                }
            }

            console.log(`[Proxy] Serving ${isLive ? 'LIVE' : 'VOD'} playlist (TTL: ${playlistTtl(filteredM3u8, isLive)}ms): ${url.substring(0, 80)}...`);

            res.set('Content-Type', contentType);
            return res.send(rewrittenM3u8);
        }

        // Standard Binary Stream (Segments, MP4, etc.) - No caching.
        // Forward the receiver's Range so MP4 seeking gets a 206 of the right bytes.
        if (req.headers.range) headers['Range'] = req.headers.range;
        const isVideoSegment = url.includes('.ts') || url.includes('.m4s') || url.includes('.mp4');
        let response;
        let _lastError;
        let currentUrl = url;
        const maxRetries = isVideoSegment ? 10 : 0;
        const retryStartTime = Date.now();
        let segmentSkipped = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // The 4s error budget below is only checked *after* an attempt
            // fails, but each attempt otherwise gets a 30s axios timeout — a
            // single slow-but-responsive upstream could blow well past the
            // documented recovery window before that check ever runs. Cap
            // each attempt's own timeout to whatever's left of the budget.
            if (isVideoSegment && attempt > 0) {
                const remaining = 4000 - (Date.now() - retryStartTime);
                if (remaining <= 0) {
                    console.warn(`[Proxy] Skipping segment, retry budget exhausted: ${currentUrl.substring(currentUrl.lastIndexOf('/') + 1, 80)}...`);
                    res.status(200);
                    res.set('Content-Type', 'video/mp2t');
                    res.set('Content-Length', '0');
                    return res.end();
                }
            }
            // Attempt 0 keeps the full 30s timeout so a legitimately slow (but
            // successful) upstream isn't punished; only retries are budgeted,
            // since those exist purely to recover from failures quickly.
            const attemptTimeout = (isVideoSegment && attempt > 0)
                ? Math.max(500, Math.min(30000, 4000 - (Date.now() - retryStartTime)))
                : 30000;

            try {
                response = await fetchUpstream(currentUrl, headers, {
                    method: 'get',
                    responseType: 'stream',
                    httpAgent: httpAgent,
                    httpsAgent: httpsAgent,
                    timeout: attemptTimeout,
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

        if (device === 'webos' && !req.headers.range) {
            return await serveTimedSegment(res, response, { deviceIp, stats, url: currentUrl, segmentSkipped });
        }
        pipeUpstream(res, response, { deviceIp, stats, url: currentUrl, segmentSkipped });

    } catch (e) {
        console.error('[Proxy] Error:', e.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy failed: ' + e.message });
        }
    }
});

// Start a converted cast's work before its receiver asks. The receiver spends
// seconds launching, then fetches the master and variant playlists, and only
// then does conversion begin (noteVariant). Fetching both playlists here, the
// same URLs the receiver will request, starts converting the first segments
// right away and leaves the variant playlist cached for it. The master isn't
// cached: the receiver's own fetch of it records the stream's stats.
async function warmConvertedPlaylists({ host, url, referer, quality }) {
    const headers = { 'User-Agent': USER_AGENT };
    if (referer) headers['Referer'] = referer;
    const req = { headers: { host } };

    if (!(await validateProxyUrl(url)).valid) return;
    const top = await fetchAndRewritePlaylist(`${url}|q=${quality}|t=hevc`, url, quality, headers, req, referer, 'hevc', { cache: false });
    // A media playlist given directly was noted (and started) just now.
    const variant = top.ok && top.rewrittenM3u8.split('\n').find(l => l.startsWith('http') && l.includes('transcode=hevc'));
    if (!variant) return;

    const variantUrl = new URL(variant).searchParams.get('url');
    if (!(await validateProxyUrl(variantUrl)).valid) return;
    await fetchAndRewritePlaylist(`${variantUrl}|q=${quality}|t=hevc`, variantUrl, quality, headers, req, referer, 'hevc');
}

module.exports = router;
module.exports.warmConvertedPlaylists = warmConvertedPlaylists;
