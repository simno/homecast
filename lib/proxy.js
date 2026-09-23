const axios = require('axios');
const { safeRequestOptions } = require('./security');

// --- Referer rejection memo ---
// Some CDNs (Periscope/X among them) answer 401 to any request carrying a
// Referer, so every playlist refresh and every segment costs two upstream
// round trips: one rejected, one bare retry. Remember the hosts that do this
// and skip straight to the bare request.
//
// Only recorded when dropping the Referer actually fixed the request — a 401
// can equally mean an expired token, and blaming the Referer for that would
// silently strip a header some other host requires.
//
// Entries expire so a transient failure cannot disable the Referer forever,
// and the map is bounded so a long session cannot grow it without limit.
const REFERER_REJECT_TTL_MS = 30 * 60 * 1000;
const MAX_REFERER_REJECT_HOSTS = 50;
const refererRejectingHosts = new Map();

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return null;
    }
}

function shouldSendReferer(url) {
    const host = hostOf(url);
    if (!host) return true;
    const rejectedAt = refererRejectingHosts.get(host);
    if (rejectedAt === undefined) return true;
    if (Date.now() - rejectedAt > REFERER_REJECT_TTL_MS) {
        refererRejectingHosts.delete(host);
        return true;
    }
    return false;
}

function noteRefererRejected(url) {
    const host = hostOf(url);
    if (!host) return;
    if (!refererRejectingHosts.has(host)) {
        console.log(`[Proxy] ${host} rejects Referer — omitting it for subsequent requests`);
    }
    refererRejectingHosts.set(host, Date.now());
    while (refererRejectingHosts.size > MAX_REFERER_REJECT_HOSTS) {
        // Map preserves insertion order, so the first key is the oldest entry.
        refererRejectingHosts.delete(refererRejectingHosts.keys().next().value);
    }
}

// Test seam: reset the memo between cases.
function clearRefererMemo() {
    refererRejectingHosts.clear();
}

// --- Helper: Try Next Segment ---
async function tryNextSegment(currentUrl) {
    try {
        const match = currentUrl.match(/(\d+)\.(?:ts|m4s|mp4)(\?.*)?$/);
        if (!match) return null;

        const segmentNumber = parseInt(match[1]);
        const nextSegmentNumber = segmentNumber + 1;
        // Replace only the trailing "<number>." immediately before the
        // extension, not the first occurrence of that digit string anywhere
        // in the URL (which could match a channel ID or CDN path token).
        const nextUrl = currentUrl.slice(0, match.index) +
            currentUrl.slice(match.index).replace(`${segmentNumber}.`, `${nextSegmentNumber}.`);

        const response = await axios({
            method: 'head',
            url: nextUrl,
            timeout: 1000,
            ...safeRequestOptions,
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

// --- Helper: Parse #EXT-X-STREAM-INF attributes ---
// Returns a plain object of the comma-separated KEY=VALUE pairs, with any
// surrounding double-quotes stripped from the value.
function parseStreamInfAttrs(line) {
    const attrs = {};
    const body = line.slice(line.indexOf(':') + 1);
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        let value = m[2];
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        attrs[m[1]] = value;
    }
    return attrs;
}

// --- Helper: Can a cast receiver decode this variant? ---
// Cast receivers decode 4K only in VP9/HEVC/AV1; H.264 tops out at 1080p on
// the Chromecast Ultra and on TV-integrated receivers alike. Periscope/X serve
// their top rendition as 3840x2160 H.264, and picking it makes the receiver
// accept the stream, play about two segments, then quit with idleReason ERROR.
//
// This only guards the automatic 'highest' pick. An explicit height from the
// user is still honoured — if someone selects 2160 they get 2160.
const H264_MAX_HEIGHT = 1080;

function isReceiverDecodable(variant) {
    const codecs = variant.codecs || '';
    if (!codecs) return true; // no claim made; assume the receiver copes
    const isH264 = /\b(avc1|avc3|h264)\b/i.test(codecs);
    if (!isH264) return true;
    // Height 0 means the variant declared no RESOLUTION — nothing to object to.
    return variant.height === 0 || variant.height <= H264_MAX_HEIGHT;
}

// --- Helper: Choose one variant for a quality setting ---
// Shared by HLS masters and DASH manifests. Variants are
// { height, bandwidth, codecs }; `quality` is 'highest' or a height string.
function pickVariant(variants, quality) {
    const target = parseInt(quality, 10);
    if (Number.isFinite(target) && target > 0) {
        // Nearest height; break ties by higher bandwidth.
        return variants.reduce((best, v) => {
            const dBest = Math.abs(best.height - target);
            const dV = Math.abs(v.height - target);
            if (dV < dBest) return v;
            if (dV === dBest && v.bandwidth > best.bandwidth) return v;
            return best;
        });
    }
    // 'highest' (default): max bandwidth, tie-break on height — but only
    // among variants the receiver can actually decode.
    const playable = variants.filter(isReceiverDecodable);
    const pool = playable.length > 0 ? playable : variants;
    return pool.reduce((best, v) => {
        if (v.bandwidth > best.bandwidth) return v;
        if (v.bandwidth === best.bandwidth && v.height > best.height) return v;
        return best;
    });
}

// --- Helper: Filter a master playlist down to a single quality variant ---
// `quality` is one of:
//   'auto'                  -> return the playlist unchanged (receiver picks via ABR)
//   'highest' / '' / undef  -> keep only the highest-BANDWIDTH variant
//   a height string ('1080')-> keep the variant with that RESOLUTION height,
//                              or the nearest available height if absent
// A media playlist (no #EXT-X-STREAM-INF) is returned unchanged, so this is
// safe to call on every playlist the proxy serves.
function filterMasterPlaylist(m3u8, quality) {
    if (quality === 'auto') return m3u8;
    if (!/#EXT-X-STREAM-INF/i.test(m3u8)) return m3u8;

    const lines = m3u8.split('\n');

    // Collect each variant as the STREAM-INF line paired with the next
    // non-comment URI line that follows it.
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
        let uriIndex = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t === '' || t.startsWith('#')) continue;
            uriIndex = j;
            break;
        }
        if (uriIndex === -1) continue;
        const attrs = parseStreamInfAttrs(lines[i]);
        const resolution = attrs.RESOLUTION || '';
        const height = resolution.includes('x') ? parseInt(resolution.split('x')[1], 10) : 0;
        variants.push({
            infIndex: i,
            uriIndex,
            attrs,
            codecs: attrs.CODECS || '',
            height: Number.isFinite(height) ? height : 0,
            bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) || 0
        });
    }

    if (variants.length === 0) return m3u8;

    const chosen = pickVariant(variants, quality);

    // Groups the chosen variant references — used to drop now-orphaned
    // #EXT-X-MEDIA renditions (audio/video/subtitle) for other variants.
    const keepGroups = new Set();
    for (const key of ['VIDEO', 'AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS']) {
        const g = chosen.attrs[key];
        if (g && g !== 'NONE') keepGroups.add(g);
    }

    const dropIndices = new Set();
    for (const v of variants) {
        if (v === chosen) continue;
        dropIndices.add(v.infIndex);
        dropIndices.add(v.uriIndex);
    }

    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (dropIndices.has(i)) continue;
        const trimmed = lines[i].trim();
        if (/^#EXT-X-MEDIA/i.test(trimmed)) {
            const groupMatch = trimmed.match(/GROUP-ID="([^"]*)"/i);
            if (groupMatch && !keepGroups.has(groupMatch[1])) continue;
        }
        out.push(lines[i]);
    }

    return out.join('\n');
}

// --- Helper: Resolve M3U8 URLs ---
function resolveM3u8Url(line, baseUrl) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
        return { isUrl: false, url: null };
    }

    try {
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            new URL(trimmed);
            return { isUrl: true, url: trimmed };
        }

        if (trimmed.startsWith('//')) {
            const absoluteUrl = baseUrl.protocol + trimmed;
            new URL(absoluteUrl);
            return { isUrl: true, url: absoluteUrl };
        }

        const absoluteUrl = new URL(trimmed, baseUrl).href;
        return { isUrl: true, url: absoluteUrl };
    } catch {
        console.log(`[Proxy] Failed to parse URL: ${trimmed.substring(0, 100)}`);
        return { isUrl: false, url: null };
    }
}

// Tags whose URI attribute names another playlist rather than a key/init segment.
const PLAYLIST_URI_TAGS = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/i;

// --- Helper: Rewrite every reference in a playlist ---
// Covers bare URI lines and the URI="..." attribute of tags (#EXT-X-MAP init
// segments, #EXT-X-KEY keys, #EXT-X-MEDIA renditions). A tag URI left relative
// would resolve against the /proxy URL on the receiver and 404, which breaks
// fMP4 and encrypted streams outright. `toProxyUrl(absoluteUrl, isPlaylist)`
// returns the replacement.
function rewritePlaylist(m3u8, baseUrl, toProxyUrl) {
    // In a master playlist every bare URI is a variant playlist.
    const isMaster = /#EXT-X-STREAM-INF/i.test(m3u8);

    return m3u8.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            if (!/URI="/i.test(trimmed)) return line;
            const isPlaylist = PLAYLIST_URI_TAGS.test(trimmed);
            return line.replace(/URI="([^"]+)"/i, (whole, uri) => {
                if (/^(data|skd):/i.test(uri)) return whole; // inline or DRM key id, not fetchable
                try {
                    return `URI="${toProxyUrl(new URL(uri, baseUrl).href, isPlaylist)}"`;
                } catch {
                    return whole;
                }
            });
        }

        const result = resolveM3u8Url(line, baseUrl);
        if (!result.isUrl) return line;
        return toProxyUrl(result.url, isMaster);
    }).join('\n');
}

// --- Helper: Build a /proxy URL ---
// The single place the proxy's query contract is spelled out. `type` ('hls'
// or 'dash') marks a manifest whose URL doesn't say so (no .m3u8/.mpd), so the
// proxy rewrites it instead of piping it through as opaque bytes.
function buildProxyUrl(host, { url, referer, quality, type }) {
    let proxyUrl = `http://${host}/proxy?url=${encodeURIComponent(url)}` +
        `&referer=${encodeURIComponent(referer || '')}` +
        `&quality=${encodeURIComponent(quality || 'highest')}`;
    if (type === 'hls' || type === 'dash' || type === 'subtitle') proxyUrl += `&type=${type}`;
    return proxyUrl;
}

module.exports = {
    buildProxyUrl,
    rewritePlaylist,
    tryNextSegment,
    resolveM3u8Url,
    filterMasterPlaylist,
    pickVariant,
    shouldSendReferer,
    noteRefererRejected,
    clearRefererMemo
};
