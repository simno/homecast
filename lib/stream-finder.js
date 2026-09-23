const axios = require('axios');
const { httpAgent, httpsAgent, USER_AGENT } = require('./utils');
const { validateProxyUrl, safeRequestOptions } = require('./security');
const { isTwitchUrl, resolveTwitchStream } = require('./twitch');
const scan = require('./media-scan');
const { describeMpd } = require('./dash');
const { parseHlsSubtitles } = require('./subtitles');

// Finds the castable streams behind a URL. Escalates from cheap to expensive
// and stops at the first rung that turns something up:
//
//   1. the URL is itself a stream (by extension, or by sniffing the response)
//   2. the page's markup, inline scripts and JSON
//   3. embedded players (iframes), breadth-first, a few levels deep
//   4. the page's external scripts
//   5. a headless browser, watching the network while the page runs
//
// Every candidate is then probed in parallel: dead links are dropped, HLS
// masters report their qualities, MP4s their resolution. The survivors come
// back best first.

const PAGE_MAX_BYTES = 3 * 1024 * 1024;
const PLAYLIST_MAX_BYTES = 512 * 1024;
const MPD_MAX_BYTES = 2 * 1024 * 1024; // SegmentTimelines on long recordings run large
const SCRIPT_MAX_BYTES = 1536 * 1024;
const PROBE_BYTES = 64 * 1024;

const PAGE_TIMEOUT_MS = 10000;
const EMBED_TIMEOUT_MS = 6000;
const PROBE_TIMEOUT_MS = 5000;

const MAX_EMBED_DEPTH = 3;
const MAX_EMBEDS_PER_LEVEL = 6;
const MAX_SCRIPTS = 4;
const MAX_PROBES = 10;
const MAX_RESULTS = 12;
const CONCURRENCY = 4;

// Statuses that usually mean "not for bots" rather than "not here" — worth a
// real browser's attempt.
const BOT_BLOCK_STATUSES = new Set([401, 403, 406, 429, 503]);

const BROWSER_HEADERS = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
};

class FinderError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// --- Fetching ---

// Read at most `maxBytes` of a response stream, then hang up.
function readCapped(stream, maxBytes) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve(Buffer.concat(chunks, Math.min(total, maxBytes)));
        };
        stream.on('data', (chunk) => {
            chunks.push(chunk);
            total += chunk.length;
            if (total >= maxBytes) {
                finish();
                stream.destroy();
            }
        });
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', finish);
    });
}

// GET a URL through the SSRF guard. Never throws for HTTP or network failures:
// returns { ok, status, contentType, finalUrl, body, error }. Media bodies are
// cut short — only their first bytes are needed to identify them.
async function fetchResource(url, { referer, signal, maxBytes = PAGE_MAX_BYTES, timeout = PAGE_TIMEOUT_MS, range } = {}) {
    const validation = await validateProxyUrl(url);
    if (!validation.valid) {
        return { ok: false, status: 0, blocked: true, error: validation.reason, finalUrl: url, body: Buffer.alloc(0) };
    }

    const headers = { ...BROWSER_HEADERS };
    if (referer) headers.Referer = referer;
    if (range) headers.Range = range;

    try {
        const response = await axios({
            method: 'get',
            url,
            headers,
            responseType: 'stream',
            timeout,
            signal,
            maxRedirects: 5,
            httpAgent,
            httpsAgent,
            ...safeRequestOptions,
            validateStatus: () => true
        });
        const contentType = String(response.headers['content-type'] || '');
        const isVideo = /^video\/|octet-stream|multipart\/x-mixed-replace/i.test(contentType);
        const body = await readCapped(response.data, isVideo ? Math.min(maxBytes, PROBE_BYTES) : maxBytes);
        return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            contentType,
            headers: response.headers,
            finalUrl: response.request?.res?.responseUrl || url,
            body
        };
    } catch (err) {
        if (signal?.aborted) throw new FinderError(499, 'Cancelled');
        return { ok: false, status: 0, error: err.message, finalUrl: url, body: Buffer.alloc(0) };
    }
}

// Run `fn` over `items` with at most `limit` in flight, preserving order.
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// --- Discovery rungs ---

function withContext(candidates, referer, depth) {
    return candidates.map(c => ({ ...c, referer, depth }));
}

// Follow iframes breadth-first; stop at the first level that yields media.
// The referer for a hit is the frame it was found in — that is what its own
// player would have sent.
async function followEmbeds(startEmbeds, pageUrl, visited, ctx) {
    let frontier = startEmbeds.map(url => ({ url, referer: pageUrl }));
    const found = [];

    for (let depth = 1; depth <= MAX_EMBED_DEPTH && frontier.length > 0; depth++) {
        const level = frontier.filter(e => !visited.has(e.url)).slice(0, MAX_EMBEDS_PER_LEVEL);
        if (level.length === 0) break;
        level.forEach(e => visited.add(e.url));
        ctx.progress(`Checking ${level.length} embedded player${level.length > 1 ? 's' : ''}…`);

        const scanned = await mapLimit(level, CONCURRENCY, async (embed) => {
            const res = await fetchResource(embed.url, { referer: embed.referer, signal: ctx.signal, timeout: EMBED_TIMEOUT_MS });
            if (!res.ok) return null;
            const frameUrl = res.finalUrl;
            const type = scan.sniffType(res.contentType, res.body);
            if (type) return { candidates: [{ url: frameUrl, type, source: 'video-tag', referer: embed.referer, depth }], embeds: [] };
            const doc = scan.scanDocument(res.body.toString('utf8'), frameUrl);
            return {
                candidates: withContext(doc.candidates, frameUrl, depth),
                embeds: doc.embeds.map(url => ({ url, referer: frameUrl }))
            };
        });

        found.push(...scanned.filter(Boolean).flatMap(s => s.candidates));
        if (hasPlayable(found)) break;
        frontier = scanned.filter(Boolean).flatMap(s => s.embeds);
    }
    return found;
}

// Library bundles never hold a page's video URL; skip them to save the fetch.
const LIBRARY_SCRIPT_RE = /jquery|bootstrap|googletagmanager|google-analytics|gtag|analytics|recaptcha|polyfill|cookie|consent|gpt\.js|adsbygoogle|facebook|twitter|fontawesome|modernizr|lodash|sentry|hotjar|segment|intercom|zendesk/i;
const PLAYER_SCRIPT_RE = /player|video|embed|stream|source|config|media|watch|live/i;

async function scanScripts(scriptUrls, pageUrl, ctx) {
    const picked = scriptUrls
        .filter(u => !LIBRARY_SCRIPT_RE.test(u))
        .sort((a, b) => PLAYER_SCRIPT_RE.test(b) - PLAYER_SCRIPT_RE.test(a))
        .slice(0, MAX_SCRIPTS);
    if (picked.length === 0) return { candidates: [], embeds: [] };

    ctx.progress('Searching page scripts…');
    const scanned = await mapLimit(picked, CONCURRENCY, async (scriptUrl) => {
        const res = await fetchResource(scriptUrl, { referer: pageUrl, signal: ctx.signal, maxBytes: SCRIPT_MAX_BYTES, timeout: EMBED_TIMEOUT_MS });
        if (!res.ok) return { candidates: [], embeds: [] };
        const text = res.body.toString('utf8');
        return {
            // URLs in a script resolve against the page that runs it.
            candidates: scan.scanText(text, pageUrl).map(c => ({ ...c, source: 'script' })),
            embeds: scan.scanScriptEmbeds(text, pageUrl).filter(u => !scan.isIgnoredEmbed(u))
        };
    });
    return {
        candidates: withContext(scanned.flatMap(s => s.candidates), pageUrl, 0),
        embeds: [...new Set(scanned.flatMap(s => s.embeds))]
    };
}

let browserExtractor = null;
function getBrowserExtractor() {
    if (browserExtractor !== null) return browserExtractor;
    try {
        browserExtractor = require('./browser').extractWithBrowser;
    } catch {
        console.log('[Extract] Playwright not available, browser fallback disabled');
        browserExtractor = undefined;
    }
    return browserExtractor;
}

async function scanWithBrowser(pageUrl, ctx) {
    const extract = ctx.browser === false ? undefined : (ctx.browser || getBrowserExtractor());
    if (!extract) return [];
    ctx.progress('Rendering the page in a headless browser…');
    const found = await extract(pageUrl, { signal: ctx.signal });
    if (ctx.signal?.aborted) throw new FinderError(499, 'Cancelled');
    return (found || []).map(v => ({
        url: v.url,
        type: v.type || scan.typeFromUrl(v.url),
        source: v.source || 'network',
        referer: v.referer || pageUrl,
        depth: 0
    }));
}

// --- Enrichment ---

// Fetch just enough of a candidate to confirm it is alive and what it is.
// Mutates and returns the candidate; `dead: true` marks one to drop.
async function probeCandidate(c, ctx) {
    if (c.type === 'mjpeg') return c; // unsupported; nothing to learn

    const isManifest = c.type === 'hls' || c.type === 'dash';
    const res = await fetchResource(c.url, {
        referer: c.referer,
        signal: ctx.signal,
        timeout: PROBE_TIMEOUT_MS,
        maxBytes: c.type === 'dash' ? MPD_MAX_BYTES : (isManifest ? PLAYLIST_MAX_BYTES : PROBE_BYTES),
        range: isManifest ? undefined : `bytes=0-${PROBE_BYTES - 1}`
    });

    // 401/403 may only mean the CDN wants cookies we don't have; the proxy's
    // own referer handling may still get through, so only drop the clear misses.
    if (res.status === 404 || res.status === 410 || res.blocked) {
        c.dead = true;
        return c;
    }
    if (!res.ok) return c; // unverified: timeouts, auth, rate limits

    const sniffed = scan.sniffType(res.contentType, res.body);
    if (!sniffed) {
        // An HTML error page where a video was promised.
        if (scan.isHtmlResponse(res.contentType, res.body) || !c.type) c.dead = true;
        return c;
    }
    c.type = sniffed;

    if (sniffed === 'hls') {
        const text = res.body.toString('utf8');
        const base = res.finalUrl || c.url;
        c.qualities = scan.parseHlsVariants(text, base).map(({ value, label, height, bandwidth }) => ({ value, label, height, bandwidth }));
        if (/#EXT-X-STREAM-INF/i.test(text)) c.variantUrls = scan.playlistChildUrls(text, base);
        c.manifestSubtitles = parseHlsSubtitles(text);
        if (c.qualities.length > 0) {
            c.height = c.qualities[0].height;
            c.resolution = c.qualities[0].label;
        } else {
            const dims = text.match(/RESOLUTION=(\d+)x(\d+)/i);
            if (dims) c.resolution = scan.resolutionLabel(+dims[1], +dims[2]);
        }
        return c;
    }

    if (sniffed === 'dash') {
        const mpd = describeMpd(res.body.toString('utf8'));
        if (!mpd) {
            c.dead = true;
            return c;
        }
        c.qualities = mpd.qualities;
        c.manifestSubtitles = mpd.subtitles;
        c.live = mpd.live;
        if (mpd.qualities.length > 0) {
            c.height = mpd.qualities[0].height;
            c.resolution = mpd.qualities[0].label;
        }
        if (mpd.drm) c.unsupportedReason = 'This DASH stream is DRM-protected';
        return c;
    }

    if (sniffed === 'mp4') {
        const dims = scan.parseMp4Dimensions(res.body);
        if (dims) {
            c.height = Math.min(dims.width, dims.height);
            c.resolution = scan.resolutionLabel(dims.width, dims.height);
        }
    }
    const total = String(res.headers?.['content-range'] || '').match(/\/(\d+)$/);
    const size = total ? parseInt(total[1], 10) : (res.status === 200 ? parseInt(res.headers?.['content-length'] || '0', 10) : 0);
    if (size > 0) c.size = size;
    return c;
}

// Best-effort resolution from the URL, for candidates the probe couldn't read.
const COMMON_HEIGHTS = new Set([144, 240, 360, 480, 540, 576, 720, 1080, 1440, 2160]);
function resolutionFromUrl(url) {
    const p = url.match(/(?:^|[^a-z0-9])(\d{3,4})p(?![a-z])/i);
    if (p && COMMON_HEIGHTS.has(+p[1])) return p[1] === '2160' ? '4K' : `${p[1]}p`;
    const wh = url.match(/(?:^|[^0-9])(\d{3,4})x(\d{3,4})(?![0-9])/);
    if (wh) return scan.resolutionLabel(+wh[1], +wh[2]);
    return null;
}

// Keep the first (best-sourced) sighting of each URL.
function dedupe(candidates) {
    return [...new Map(candidates.map(c => [c.url, c]).reverse()).values()];
}

function finalize(candidates) {
    return scan.rankCandidates(scan.pruneCandidates(dedupe(candidates))).slice(0, MAX_RESULTS);
}

// Probe the most promising candidates in parallel and keep the live ones.
async function enrich(candidates, ctx) {
    const ranked = scan.rankCandidates(dedupe(candidates)).slice(0, MAX_PROBES);
    if (ranked.length === 0) return [];
    ctx.progress(`Checking ${ranked.length} stream${ranked.length > 1 ? 's' : ''}…`);
    const probed = await mapLimit(ranked, CONCURRENCY + 2, c => probeCandidate(c, ctx));
    const alive = probed.filter(c => !c.dead && c.type);
    for (const c of alive) {
        if (!c.resolution) c.resolution = resolutionFromUrl(c.url);
    }
    return finalize(alive);
}

function hasPlayable(candidates) {
    return candidates.some(scan.isCastable);
}

function toVideo(c) {
    const reason = c.unsupportedReason || scan.UNSUPPORTED_REASONS[c.type];
    const video = {
        url: c.url,
        referer: c.referer,
        type: c.type,
        resolution: c.resolution || null,
        qualities: c.qualities || [],
        source: c.source,
        unsupported: Boolean(reason)
    };
    if (reason) video.reason = reason;
    if (c.size) video.size = c.size;
    // Page <track> files are cast as sideloaded tracks (they carry a URL);
    // manifest renditions are picked on the receiver by language and name.
    const subtitles = [
        ...(c.subtitles || []).map(({ url, language, label }) => ({ source: 'page', url, language, label })),
        ...(c.manifestSubtitles || []).map(({ language, label }) => ({ source: 'manifest', language, label }))
    ];
    if (subtitles.length > 0) video.subtitles = subtitles;
    if (c.live !== undefined) video.live = c.live;
    return video;
}

// --- Entry point ---

// Returns { videos, title }. Throws FinderError with an HTTP-ish status when
// nothing castable can be found. Options:
//   signal      AbortSignal — stops all fetching (and the browser) when aborted
//   onProgress  called with short human-readable status lines
//   browser     override the headless-browser extractor (false disables it)
async function findStreams(pageUrl, { signal, onProgress, browser } = {}) {
    const ctx = {
        signal,
        browser,
        progress: (msg) => {
            if (onProgress && !signal?.aborted) onProgress(msg);
        }
    };

    if (isTwitchUrl(pageUrl)) {
        ctx.progress('Asking Twitch for the stream…');
        const twitch = await resolveTwitchStream(pageUrl);
        if (twitch.status !== 'ok') {
            throw new FinderError(twitch.status === 'offline' ? 404 : 502, twitch.message);
        }
        const videos = await enrich([{ url: twitch.url, type: 'hls', source: 'direct', referer: twitch.referer, depth: 0 }], ctx);
        return { videos: videos.map(toVideo), title: null };
    }

    // Rung 1: a URL that names a stream is checked directly. If it turns out
    // to be a page after all (/watch/movie.mp4), carry on as for any page.
    const urlType = scan.typeFromUrl(pageUrl);
    if (urlType) {
        const videos = await enrich([{ url: pageUrl, type: urlType, source: 'direct', referer: pageUrl, depth: 0 }], ctx);
        if (videos.length > 0) return { videos: videos.map(toVideo), title: null };
    }

    ctx.progress('Fetching page…');
    const page = await fetchResource(pageUrl, { signal });

    // Rung 1 again, for URLs that don't look like streams but are.
    const sniffed = page.ok ? scan.sniffType(page.contentType, page.body) : null;
    if (sniffed) {
        const videos = await enrich([{ url: pageUrl, type: sniffed, source: 'direct', referer: pageUrl, depth: 0 }], ctx);
        return { videos: videos.map(toVideo), title: null };
    }

    let title = null;
    let found = [];
    const botBlocked = !page.ok && (page.status === 0 || BOT_BLOCK_STATUSES.has(page.status));

    if (!page.ok && !botBlocked) {
        throw new FinderError(page.status === 404 ? 404 : 502,
            page.status ? `The page returned HTTP ${page.status}` : `Could not load the page: ${page.error}`);
    }

    if (page.ok) {
        const html = page.body.toString('utf8');
        const base = page.finalUrl;
        const doc = scan.scanDocument(html, base);
        title = doc.title;
        found = withContext(doc.candidates, base, 0);

        const visited = new Set([pageUrl, base]);
        if (!hasPlayable(found) && doc.embeds.length > 0) {
            found.push(...await followEmbeds(doc.embeds, base, visited, ctx));
        }
        if (!hasPlayable(found) && doc.scripts.length > 0) {
            const scripts = await scanScripts(doc.scripts, base, ctx);
            found.push(...scripts.candidates);
            if (!hasPlayable(found) && scripts.embeds.length > 0) {
                found.push(...await followEmbeds(scripts.embeds, base, visited, ctx));
            }
        }
    }

    let videos = found.length > 0 ? await enrich(found, ctx) : [];

    // Rung 5: nothing castable survived — let the page run. Also the answer to
    // a bot wall, which a real browser often gets past.
    const worthRendering = botBlocked || /<script/i.test(page.body.toString('utf8'));
    if (!hasPlayable(videos) && worthRendering) {
        const rendered = await scanWithBrowser(pageUrl, ctx);
        if (rendered.length > 0) videos = finalize([...await enrich(rendered, ctx), ...videos]);
    }

    if (videos.length === 0) {
        // The lite image ships without Playwright: say so, since rendering is
        // exactly what these pages may have needed.
        const browserMissing = worthRendering && ctx.browser === undefined && !getBrowserExtractor();
        const hint = browserMissing ? '. This HomeCast image has no headless browser; the full image may find it' : '';
        if (botBlocked) {
            throw new FinderError(502, `The site refused the request (HTTP ${page.status || 'error'}) and no video could be found${browserMissing ? '' : ' by rendering it'}${hint}`);
        }
        throw new FinderError(404, `No video found on this page${hint}`);
    }

    return { videos: videos.map(toVideo), title };
}

module.exports = { findStreams, FinderError, fetchResource, probeCandidate, resolutionFromUrl };
