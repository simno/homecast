const cheerio = require('cheerio');

// Pure, network-free helpers: find media URLs in page content, classify them,
// and judge which one is most likely "the video". stream-finder.js does the
// fetching; everything here is deterministic and unit-tested.

const PLAYABLE_TYPES = new Set(['hls', 'dash', 'mp4', 'webm', 'mkv']);

const UNSUPPORTED_REASONS = {
    mjpeg: 'MJPEG camera streams cannot be cast'
};

// Castable: a playable format that the probe found no reason to refuse
// (e.g. DRM). `unsupportedReason` is set by the probe.
function isCastable(c) {
    return PLAYABLE_TYPES.has(c.type) && !c.unsupportedReason;
}

const EXTENSION_TYPES = {
    m3u8: 'hls',
    mpd: 'dash',
    mp4: 'mp4',
    m4v: 'mp4',
    webm: 'webm',
    mkv: 'mkv',
    mjpg: 'mjpeg',
    mjpeg: 'mjpeg'
};

// Last media extension in a path, allowing path params after it
// (/video.m3u8;jsessionid=x, /clip.mp4/download).
const PATH_EXTENSION_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mjpe?g)(?=$|[/;])/gi;

// IP-camera MJPEG endpoints that carry no extension.
const MJPEG_PATH_RE = /\/(?:mjpg|mjpeg)\/video|\/video\.cgi|nphMotionJpeg|faststream|action=stream/i;

// Classify by the URL's path, never its query: `/player?src=clip.mp4` is a page.
function typeFromUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    let path = parsed.pathname;
    try {
        path = decodeURIComponent(path);
    } catch { /* keep raw */ }

    const matches = [...path.matchAll(PATH_EXTENSION_RE)];
    if (matches.length > 0) return EXTENSION_TYPES[matches[matches.length - 1][1].toLowerCase()];
    if (MJPEG_PATH_RE.test(parsed.pathname + parsed.search)) return 'mjpeg';

    // Some players carry the format in the query instead: /stream?format=m3u8
    for (const key of ['format', 'fmt', 'ext']) {
        const value = (parsed.searchParams.get(key) || '').toLowerCase();
        if (value === 'm3u8' || value === 'hls') return 'hls';
        if (value === 'mp4') return 'mp4';
    }
    return null;
}

function typeFromMime(mime) {
    if (!mime) return null;
    const m = String(mime).toLowerCase();
    if (m.includes('mpegurl')) return 'hls';
    if (m.includes('dash+xml')) return 'dash';
    if (m.includes('multipart/x-mixed-replace')) return 'mjpeg';
    if (m.includes('video/webm')) return 'webm';
    if (m.includes('matroska')) return 'mkv';
    if (/video\/(mp4|x-m4v|quicktime)/.test(m)) return 'mp4';
    return null;
}

// Identify a response from its Content-Type and first bytes. Servers routinely
// label playlists text/plain and videos application/octet-stream, so the bytes
// get the final word when the header is vague.
function sniffType(contentType, buf) {
    const byMime = typeFromMime(contentType);
    if (byMime) return byMime;
    if (!buf || buf.length === 0) return null;

    const head = buf.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (head.startsWith('#EXTM3U')) return 'hls';
    if (/^<\?xml[^>]*>\s*<MPD[\s>]|^<MPD[\s>]/.test(head)) return 'dash';
    if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
    if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
        return buf.subarray(0, 64).toString('latin1').includes('webm') ? 'webm' : 'mkv';
    }
    return null;
}

function isHtmlResponse(contentType, buf) {
    if (/text\/html|application\/xhtml/i.test(contentType || '')) return true;
    const head = buf ? buf.subarray(0, 256).toString('utf8').trimStart().toLowerCase() : '';
    return head.startsWith('<!doctype html') || head.startsWith('<html');
}

// Undo the escaping that hides URLs inside inline JSON and HTML attributes:
// "https:\/\/cdn\/a.m3u8", "\u0026token=", "&amp;token=".
function decodeEscapes(text) {
    return text
        .replace(/\\u002[fF]/g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/\\u003[dD]/g, '=')
        .replace(/\\u003[fF]/g, '?')
        .replace(/\\u0022/g, '"')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/&#x2[fF];|&#47;/g, '/')
        .replace(/&quot;|&#34;/g, '"')
        .replace(/&#x27;|&#39;/g, '\'');
}

// Absolute (or protocol-relative) URL, conservative about where it ends.
const ABSOLUTE_URL_RE = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[^\s"'<>`\\^{}|()]*/gi;

// A quoted relative path ending in a media extension: file: "/hls/live.m3u8"
const RELATIVE_MEDIA_RE = /["'`]((?:\.{0,2}\/)?[^"'`\s<>:?#]*\.(?:m3u8|mpd|mp4|m4v|webm|mkv)(?:\?[^"'`\s<>]*)?)["'`]/gi;

// Base64 that decodes to a URL ("aHR0c" is "http"): a favourite way to hide a
// stream from scrapers, either bare or through atob().
const BASE64_URL_RE = /aHR0c[A-Za-z0-9+/]{12,}={0,2}/g;

// Resolve a raw reference to an absolute http(s) URL without its fragment.
function normalizeUrl(raw, baseUrl) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = decodeEscapes(raw.trim()).replace(/[.,;:!]+$/, '');
    if (!cleaned || /^(blob|data|javascript|about|mailto):/i.test(cleaned)) return null;
    try {
        const u = new URL(cleaned, baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        u.hash = '';
        return u.href;
    } catch {
        return null;
    }
}

// URLs smuggled inside another URL's query: /player?file=https%3A%2F%2F...m3u8
function nestedUrls(url) {
    const found = [];
    try {
        for (const value of new URL(url).searchParams.values()) {
            if (/^(?:https?:)?\/\//i.test(value)) found.push(value);
        }
    } catch { /* not a URL */ }
    return found;
}

// Media URLs anywhere in a blob of text (HTML, inline JS, JSON, a script file).
// Returns [{ url, type }].
function scanText(text, baseUrl) {
    if (!text) return [];
    const decoded = decodeEscapes(text);
    const found = new Map();

    const consider = (raw, depth = 0) => {
        const url = normalizeUrl(raw, baseUrl);
        if (!url || found.has(url)) return;
        const type = typeFromUrl(url);
        if (type) found.set(url, { url, type });
        if (depth < 2) nestedUrls(url).forEach(n => consider(n, depth + 1));
    };

    for (const m of decoded.matchAll(ABSOLUTE_URL_RE)) consider(m[0]);
    for (const m of decoded.matchAll(RELATIVE_MEDIA_RE)) consider(m[1]);
    for (const m of text.matchAll(BASE64_URL_RE)) {
        const plain = Buffer.from(m[0], 'base64').toString('utf8');
        if (/^https?:\/\/[\x21-\x7e]+$/.test(plain)) consider(plain);
    }

    return [...found.values()];
}

// Iframe references inside script text: document.write('<iframe src="...">')
// and templated players that build their embed markup client-side.
function scanScriptEmbeds(text, baseUrl) {
    const decoded = decodeEscapes(text);
    const embeds = new Set();
    for (const m of decoded.matchAll(/<iframe[^>]*?\ssrc\s*=\s*\\?["']([^"'\\]+)/gi)) {
        const url = normalizeUrl(m[1], baseUrl);
        if (url) embeds.add(url);
    }
    return [...embeds];
}

// Embeds that never hold the page's video: social widgets, captchas, ad frames.
const IGNORED_EMBED_RE = /(?:facebook\.com\/plugins|platform\.twitter\.com|twitter\.com\/widgets|google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|googletagmanager|doubleclick|googlesyndication|amazon-adsystem|disqus|addthis|sharethis|instagram\.com\/embed|open\.spotify\.com|w\.soundcloud\.com|youtube\.com\/embed|youtube-nocookie\.com|about:blank)/i;

function isIgnoredEmbed(url) {
    return IGNORED_EMBED_RE.test(url);
}

// Everything the markup of one document says about its video. Returns
// { candidates: [{ url, type, source, mime?, subtitles? }], embeds: [url], scripts: [url], title, thumbnail }.
function scanDocument(html, pageUrl) {
    const $ = cheerio.load(html);
    const baseHref = $('base[href]').attr('href');
    const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;

    const candidates = new Map();
    const add = (raw, source, mime) => {
        const url = normalizeUrl(raw, base);
        if (!url || candidates.has(url)) return;
        const type = typeFromMime(mime) || typeFromUrl(url);
        candidates.set(url, { url, type, source });
    };

    const embeds = new Set();
    const addEmbed = (raw) => {
        const url = normalizeUrl(raw, base);
        if (url && url !== pageUrl && !isIgnoredEmbed(url)) embeds.add(url);
    };

    // <video>/<source>, including lazy-loading attributes players use.
    $('video').each((_, el) => {
        const v = $(el);
        for (const attr of ['src', 'data-src', 'data-video-src', 'data-hls', 'data-stream']) {
            if (v.attr(attr)) add(v.attr(attr), 'video-tag');
        }
        v.find('source').each((__, s) => {
            const src = $(s).attr('src') || $(s).attr('data-src');
            if (src) add(src, 'video-tag', $(s).attr('type'));
        });
    });
    $('source[src]').each((_, el) => {
        const mime = $(el).attr('type');
        if (typeFromMime(mime)) add($(el).attr('src'), 'video-tag', mime);
    });

    // <track> subtitles. A page rarely has more than one player, so they're
    // offered with every video found in this document. Missing kind means
    // subtitles; chapters, descriptions and metadata tracks aren't for display.
    const subtitles = [];
    $('track[src]').each((_, el) => {
        const t = $(el);
        const kind = (t.attr('kind') || 'subtitles').toLowerCase();
        if (kind !== 'subtitles' && kind !== 'captions') return;
        const url = normalizeUrl(t.attr('src'), base);
        if (!url || subtitles.some(s => s.url === url)) return;
        const language = t.attr('srclang') || null;
        const label = t.attr('label') || language || 'Subtitles';
        subtitles.push({ url, language, label: kind === 'captions' ? `${label} (CC)` : label });
    });

    // Open Graph / Twitter cards. og:video is frequently the site's embed
    // *page* (Twitch, YouTube) rather than a file, so an HTML-typed or
    // extensionless one is treated as an embed to follow, not a stream.
    const ogType = $('meta[property="og:video:type"]').attr('content');
    const metaVideos = [
        'meta[property="og:video"]', 'meta[property="og:video:url"]',
        'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]',
        'meta[property="twitter:player:stream"]'
    ];
    for (const selector of metaVideos) {
        const content = $(selector).attr('content');
        if (!content) continue;
        const url = normalizeUrl(content, base);
        if (!url) continue;
        if (typeFromMime(ogType) || typeFromUrl(url)) add(url, 'meta', ogType);
        else addEmbed(url);
    }
    const twitterPlayer = $('meta[name="twitter:player"]').attr('content') ||
        $('meta[property="twitter:player"]').attr('content');
    if (twitterPlayer) addEmbed(twitterPlayer);
    $('link[rel="video_src"], link[rel="preload"][as="video"]').each((_, el) => {
        add($(el).attr('href'), 'meta', $(el).attr('type'));
    });

    // Schema.org VideoObject: contentUrl is the file, embedUrl the player page.
    $('script[type="application/ld+json"]').each((_, el) => {
        let data;
        try {
            data = JSON.parse($(el).text());
        } catch {
            return;
        }
        walkJsonLd(data, (node) => {
            if (typeof node.contentUrl === 'string') add(node.contentUrl, 'json-ld', node.encodingFormat);
            if (typeof node.embedUrl === 'string') addEmbed(node.embedUrl);
        });
    });

    // Frames (including lazy-loaded ones) and legacy plugin embeds.
    $('iframe, frame').each((_, el) => {
        const f = $(el);
        const src = f.attr('src') || f.attr('data-src') || f.attr('data-lazy-src');
        if (src) addEmbed(src);
    });
    $('embed[src], object[data]').each((_, el) => {
        const ref = $(el).attr('src') || $(el).attr('data');
        const url = normalizeUrl(ref, base);
        if (url && typeFromUrl(url)) add(url, 'video-tag');
        else if (url) addEmbed(url);
    });

    // Whatever the markup didn't declare: URLs in inline scripts, JSON blobs,
    // data attributes, base64.
    for (const { url, type } of scanText(html, base)) {
        if (!candidates.has(url)) candidates.set(url, { url, type, source: 'page-text' });
    }

    const scripts = $('script[src]').map((_, el) => normalizeUrl($(el).attr('src'), base)).get().filter(Boolean);

    const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || '')
        .trim().replace(/\s+/g, ' ').slice(0, 200) || null;

    // A picture of the video for the cast form's preview: the share card's
    // image, else the player's poster frame.
    const thumbnailRaw = $('meta[property="og:image"]').attr('content') ||
        $('meta[property="og:image:url"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('video[poster]').first().attr('poster');
    const thumbnail = (thumbnailRaw && normalizeUrl(thumbnailRaw, base)) || null;

    return {
        candidates: [...candidates.values()].map(c => (subtitles.length > 0 ? { ...c, subtitles } : c)),
        embeds: [...embeds],
        scripts: [...new Set(scripts)],
        title,
        thumbnail
    };
}

function walkJsonLd(node, visit, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
        node.forEach(n => walkJsonLd(n, visit, depth + 1));
        return;
    }
    const types = [].concat(node['@type'] || []);
    if (types.some(t => /VideoObject|Clip|Movie|Episode|BroadcastEvent/i.test(t))) visit(node);
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') walkJsonLd(value, visit, depth + 1);
    }
}

// --- Ranking ---

const SOURCE_SCORES = {
    direct: 100,
    'video-tag': 40,
    'json-ld': 35,
    network: 30,
    meta: 30,
    'page-text': 15,
    script: 10
};

// HLS plays on every receiver; DASH on Chromecast only, so it ranks just below.
const TYPE_SCORES = { hls: 30, dash: 25, mp4: 20, webm: 15, mkv: 5, mjpeg: -20 };

const AD_RE = /doubleclick|googlesyndication|googleads|imasdk|adservice|moatads|springserve|spotxchange|adnxs|pubmatic|rubiconproject|teads\.tv|innovid|serving-sys|\/ads?\/|[?&/_-](?:vast|vpaid|preroll|midroll)[/._=-]/i;
const LOW_VALUE_RE = /preview|thumb|sprite|teaser|poster|placeholder|bumper|promo|sample|background|\bbg[-_]|hero[-_]?video|loop\./i;
// Pieces of a stream rather than a stream: fMP4 init/segments, HLS chunks.
const SEGMENT_RE = /\.(?:m4s|ts|aac)(?:$|\?)|(?:^|[/_-])(?:init|seg(?:ment)?|chunk|frag(?:ment)?)[-_]?\d*\.(?:mp4|m4v)(?:$|\?)|\/range\/\d+-\d+/i;
const MASTER_HINT_RE = /master|playlist|index|manifest/i;

function isSegmentUrl(url) {
    return SEGMENT_RE.test(url);
}

function scoreCandidate(c) {
    let score = (SOURCE_SCORES[c.source] ?? 10) + (TYPE_SCORES[c.type] ?? 0);
    if (AD_RE.test(c.url)) score -= 60;
    if (LOW_VALUE_RE.test(c.url)) score -= 20;
    if (isSegmentUrl(c.url)) score -= 40;
    if ((c.type === 'hls' || c.type === 'dash') && MASTER_HINT_RE.test(c.url)) score += 5;
    if (c.qualities && c.qualities.length > 1) score += 5; // a real multi-variant master
    if (c.height) score += Math.min(c.height, 2160) / 100;
    score -= (c.depth || 0) * 3; // found deeper in an embed chain
    return score;
}

// Best first: anything castable before anything that isn't, then by score.
function rankCandidates(candidates) {
    return candidates
        .map(c => ({ c, score: scoreCandidate(c), playable: isCastable(c) }))
        .sort((a, b) => (b.playable - a.playable) || (b.score - a.score))
        .map(({ c }) => c);
}

// Drop what shouldn't be offered alongside a better option: segments when a
// manifest exists, and variant playlists that a listed master already covers.
function pruneCandidates(candidates) {
    const hasPlaylist = candidates.some(c => c.type === 'hls' || c.type === 'dash');
    const variantUrls = new Set(candidates.flatMap(c => c.variantUrls || []));
    return candidates.filter(c => {
        if (variantUrls.has(c.url)) return false;
        if (hasPlaylist && c.type !== 'hls' && c.type !== 'dash' && isSegmentUrl(c.url)) return false;
        return true;
    });
}

// --- HLS / MP4 metadata ---

// Variants of a master playlist, highest first:
//   [{ value: '1080', label: '1080p60', height, bandwidth, url }]
// `value` is the height string the proxy's quality cap understands.
// Returns [] for media playlists.
function parseHlsVariants(playlist, playlistUrl) {
    if (typeof playlist !== 'string' || !/#EXT-X-STREAM-INF/i.test(playlist)) return [];
    const lines = playlist.split(/\r?\n/);
    const variants = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF:/i.test(lines[i].trim())) continue;
        const attrLine = lines[i];
        let uri = null;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t === '' || t.startsWith('#')) continue;
            uri = t;
            break;
        }

        const resMatch = attrLine.match(/RESOLUTION=(\d+)x(\d+)/i);
        const bwMatch = attrLine.match(/[:,]BANDWIDTH=(\d+)/i);
        const fpsMatch = attrLine.match(/FRAME-RATE=([\d.]+)/i);
        const height = resMatch ? parseInt(resMatch[2], 10) : 0;
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        let url = null;
        if (uri && playlistUrl) {
            try {
                url = new URL(uri, playlistUrl).href;
            } catch { /* leave null */ }
        }

        if (!height) continue; // audio-only renditions
        if (seen.has(height)) continue; // collapse same-height (e.g. dup fps) entries
        seen.add(height);

        const fps = fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : null;
        let label = `${height}p`;
        if (fps && fps > 30) label += String(fps);
        variants.push({ value: String(height), label, height, bandwidth, url });
    }

    variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
    return variants;
}

// Every URI a master references — variant and rendition playlists — so they
// can be pruned from the list the user picks from.
function playlistChildUrls(playlist, playlistUrl) {
    const urls = [];
    const add = (ref) => {
        try {
            urls.push(new URL(ref, playlistUrl).href);
        } catch { /* skip */ }
    };
    for (const line of playlist.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith('#')) {
            const m = t.match(/URI="([^"]+)"/i);
            if (m) add(m[1]);
        } else {
            add(t);
        }
    }
    return urls;
}

// Video dimensions from an MP4's tkhd boxes, when the moov atom sits in the
// bytes we have (true of any "faststart" web MP4). Returns { width, height } or null.
function parseMp4Dimensions(buf) {
    if (!buf || buf.length < 100) return null;
    let best = null;
    let from = 0;
    for (;;) {
        const idx = buf.indexOf('tkhd', from, 'latin1');
        if (idx === -1) break;
        from = idx + 4;
        const version = buf[idx + 4];
        const offset = idx + 8 + (version === 1 ? 84 : 72); // past type, version+flags
        if (offset + 8 > buf.length) continue;
        const width = buf.readUInt32BE(offset) >>> 16;
        const height = buf.readUInt32BE(offset + 4) >>> 16;
        if (width > 0 && height > 0 && width <= 16384 && height <= 16384) {
            if (!best || width * height > best.width * best.height) best = { width, height };
        }
    }
    return best;
}

// "1080p" for a 1920x1080 frame, judged on the short side so portrait video
// (1080x1920) reads the way people expect.
function resolutionLabel(width, height) {
    const short = Math.min(width, height);
    if (short >= 2000) return '4K';
    return `${short}p`;
}

module.exports = {
    PLAYABLE_TYPES,
    UNSUPPORTED_REASONS,
    isCastable,
    typeFromUrl,
    typeFromMime,
    sniffType,
    isHtmlResponse,
    decodeEscapes,
    normalizeUrl,
    scanText,
    scanScriptEmbeds,
    scanDocument,
    isIgnoredEmbed,
    isSegmentUrl,
    scoreCandidate,
    rankCandidates,
    pruneCandidates,
    parseHlsVariants,
    playlistChildUrls,
    parseMp4Dimensions,
    resolutionLabel
};
