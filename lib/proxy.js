const axios = require('axios');
const { safeRequestOptions } = require('./security');
const { nicheCodec } = require('./media-scan');

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
// This only guards the automatic 'highest' pick, and not when the proxy
// converts the pick to HEVC. An explicit height from the user is still
// honoured — AirPlay shares this path, and an Apple TV 4K plays 4K H.264 fine.
// For a Chromecast the page offers such variants only converted.
const H264_MAX_HEIGHT = 1080;

// VP9 and AV1 decode only on newer receivers (Chromecast Ultra and with
// Google TV); YouTube's masters list them beside H.264 up to 1080p, and the
// converter expects H.264 in. Picks keep to the codecs every receiver has
// wherever the master offers a choice.
const isNicheCodec = (variant) => nicheCodec(variant.codecs) !== null;

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
// `convertible`: the proxy will convert whatever is picked (lib/transcode.js),
// so 'highest' may pick a variant the receiver couldn't decode as it is.
function pickVariant(variants, quality, { convertible = false } = {}) {
    const target = parseInt(quality, 10);
    if (Number.isFinite(target) && target > 0) {
        // Nearest height; break ties by the common codec, then higher bandwidth.
        return variants.reduce((best, v) => {
            const dBest = Math.abs(best.height - target);
            const dV = Math.abs(v.height - target);
            if (dV !== dBest) return dV < dBest ? v : best;
            if (isNicheCodec(v) !== isNicheCodec(best)) return isNicheCodec(best) ? v : best;
            return v.bandwidth > best.bandwidth ? v : best;
        });
    }
    // 'highest' (default): max bandwidth, tie-break on height — but only
    // among variants the receiver can actually decode.
    const playable = convertible ? variants : variants.filter(isReceiverDecodable);
    const decodable = playable.length > 0 ? playable : variants;
    const common = decodable.filter(v => !isNicheCodec(v));
    const pool = common.length > 0 ? common : decodable;
    return pool.reduce((best, v) => {
        if (v.bandwidth > best.bandwidth) return v;
        if (v.bandwidth === best.bandwidth && v.height > best.height) return v;
        return best;
    });
}

// --- Helper: Filter a master playlist down to a single quality variant ---
// `quality` is one of:
//   'auto'                  -> the receiver picks via ABR: the playlist unchanged,
//                              less any VP9/AV1 variants beside H.264/HEVC ones and
//                              any with other audio than the best variant's
//   'highest' / '' / undef  -> keep only the highest-BANDWIDTH variant
//   a height string ('1080')-> keep the variant with that RESOLUTION height,
//                              or the nearest available height if absent
// A media playlist (no #EXT-X-STREAM-INF) is returned unchanged, so this is
// safe to call on every playlist the proxy serves.
function filterMasterPlaylist(m3u8, quality, { convertible = false } = {}) {
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

    // 'auto' leaves the choice to the receiver, among variants it can switch
    // between. Cast receivers don't change codec or audio rendition mid-way:
    // offered YouTube's mix of H.264 (TS) and VP9 (fMP4), they settle on its
    // 240p VP9; offered only its H.264, on the 240p whose low-bitrate audio
    // no other variant shares. Either way they never adapt up. So: the codecs
    // every receiver has, when the master mixes in VP9/AV1, and the audio of
    // the best of those.
    let kept;
    if (quality === 'auto') {
        const common = variants.filter(v => !isNicheCodec(v));
        const pool = common.length > 0 ? common : variants;
        const top = pool.reduce((best, v) => (v.bandwidth > best.bandwidth ? v : best));
        const sameAudio = pool.filter(v => v.attrs.AUDIO === top.attrs.AUDIO);
        if (sameAudio.length === variants.length) return m3u8;
        kept = new Set(sameAudio);
    } else {
        kept = new Set([pickVariant(variants, quality, { convertible })]);
    }

    // Groups the kept variants reference — used to drop now-orphaned
    // #EXT-X-MEDIA renditions (audio/video/subtitle) for other variants.
    const keepGroups = new Set();
    for (const v of kept) {
        for (const key of ['VIDEO', 'AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS']) {
            const g = v.attrs[key];
            if (g && g !== 'NONE') keepGroups.add(g);
        }
    }

    const dropIndices = new Set();
    for (const v of variants) {
        if (kept.has(v)) continue;
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

// --- Helper: Audio languages ---
// A master's audio renditions can be the same audio in several languages.
// Receivers play whichever is the default, or the first when none is: and
// YouTube's auto-dubbed videos list every dub beside the original in one
// group, none of them the default, the original last, so an English video
// comes out in Arabic. selectAudio keeps one language per group, as the
// default: the one asked for, else the original.
// YouTube names the original "<language> - original" and its dubs
// "<language> - dubbed-auto", and says the same in YT-EXT-XTAGS (base64).
function youTubeAudioTag(line) {
    const name = line.match(/NAME="([^"]*)"/i)?.[1] || '';
    const tags = line.match(/YT-EXT-XTAGS="([^"]*)"/i)?.[1];
    const decoded = tags ? Buffer.from(tags, 'base64').toString('latin1') : '';
    if (/\boriginal\b/i.test(name) || decoded.includes('original')) return 'original';
    if (/\bdubbed\b/i.test(name) || decoded.includes('dubbed')) return 'dubbed';
    return null;
}

// A BCP 47 language tag as playlists and MPDs carry them ('en', 'en-US', 'pt-BR').
const isLanguageTag = (v) => typeof v === 'string' && /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(v);

const audioAttr = (line, name) => line.match(new RegExp(`${name}="([^"]*)"`, 'i'))?.[1];
const baseLanguage = (tag) => (tag || '').toLowerCase().split(/[-_]/)[0];

// A master's audio renditions, one per language and name, in playlist order:
// [{ language, label, default, original, dubbed }]. The label loses
// YouTube's " - original" / " - dubbed-auto", which the flags carry.
function parseHlsAudio(m3u8) {
    if (typeof m3u8 !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const line of m3u8.split('\n')) {
        if (!/^#EXT-X-MEDIA:/i.test(line.trim()) || !/TYPE=AUDIO/i.test(line)) continue;
        const language = audioAttr(line, 'LANGUAGE') || null;
        const name = audioAttr(line, 'NAME') || language;
        if (!name) continue;
        const key = `${language}|${name}`;
        if (seen.has(key)) continue; // one entry per rendition, not per group
        seen.add(key);
        const tag = youTubeAudioTag(line);
        out.push({
            language,
            label: name.replace(/\s+-\s+(original|dubbed-auto|dubbed)$/i, '') || language,
            default: /DEFAULT=YES/i.test(line),
            original: tag === 'original',
            dubbed: tag === 'dubbed'
        });
    }
    return out;
}

// Keep one audio language in each group of a master, as its default:
// `language` (a tag; exact, then the same base language) when given and the
// group has it. Otherwise a group with no default keeps its original, when
// one is marked. Groups with neither are left as they are.
function selectAudio(m3u8, language = null) {
    if (!/#EXT-X-STREAM-INF/i.test(m3u8)) return m3u8;
    const lines = m3u8.split('\n');
    const groups = new Map(); // GROUP-ID -> line indices of its audio renditions
    lines.forEach((line, i) => {
        if (!/^#EXT-X-MEDIA:/i.test(line.trim()) || !/TYPE=AUDIO/i.test(line)) return;
        const group = audioAttr(line, 'GROUP-ID');
        if (group === undefined) return;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(i);
    });

    const wanted = (language || '').toLowerCase();
    const drop = new Set();
    for (const indices of groups.values()) {
        if (indices.length < 2) continue;
        const lang = (i) => (audioAttr(lines[i], 'LANGUAGE') || '').toLowerCase();
        const isOriginal = (i) => youTubeAudioTag(lines[i]) === 'original';
        let matches = wanted ? indices.filter(i => lang(i) === wanted) : [];
        if (wanted && matches.length === 0) matches = indices.filter(i => baseLanguage(lang(i)) === baseLanguage(wanted));
        let keep = matches.find(isOriginal) ?? matches[0];
        if (keep === undefined) {
            if (indices.some(i => /DEFAULT=YES/i.test(lines[i]))) continue;
            keep = indices.find(isOriginal);
            if (keep === undefined) continue;
        }
        for (const i of indices) if (i !== keep) drop.add(i);
        lines[keep] = /DEFAULT=(YES|NO)/i.test(lines[keep])
            ? lines[keep].replace(/DEFAULT=(YES|NO)/i, 'DEFAULT=YES')
            : lines[keep].replace(/(\r?)$/, ',DEFAULT=YES$1');
    }
    if (drop.size === 0) return m3u8;
    return lines.filter((_, i) => !drop.has(i)).join('\n');
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

// --- Helper: Trim a long live playlist to its recent end ---
// YouTube's live playlists list an hour of one-second segments, 3600 signed
// URLs (6 MB once proxied), and receivers reload a live playlist about once
// per segment: they fall behind parsing it and stall, or refuse the load. A
// live playlist longer than LIVE_TRIM_ABOVE segments keeps its last
// LIVE_KEEP_SEGMENTS; Twitch's and X's are far shorter and pass unchanged.
// Media sequence and discontinuity sequence move up by what was dropped, and
// the key and init segment in force at the cut are carried over.
const LIVE_TRIM_ABOVE = 600;
const LIVE_KEEP_SEGMENTS = 300;

function trimLivePlaylist(m3u8) {
    if (/#EXT-X-ENDLIST|#EXT-X-STREAM-INF|#EXT-X-PLAYLIST-TYPE\s*:\s*VOD/i.test(m3u8)) return m3u8;
    const lines = m3u8.split('\n');
    const uriIndices = [];
    lines.forEach((line, i) => {
        const t = line.trim();
        if (t && !t.startsWith('#')) uriIndices.push(i);
    });
    if (uriIndices.length <= LIVE_TRIM_ABOVE) return m3u8;

    const dropped = uriIndices.length - LIVE_KEEP_SEGMENTS;
    const cutAfter = uriIndices[dropped - 1]; // last line of the last dropped segment
    // The first tag that belongs to a segment, not the header (whose
    // #EXT-X-DISCONTINUITY-SEQUENCE must not pass for a #EXT-X-DISCONTINUITY).
    const firstSegmentTag = lines.findIndex(l => /^#EXT(INF:|-X-(DISCONTINUITY\s*$|PROGRAM-DATE-TIME:|KEY:|MAP:|BYTERANGE:))/i.test(l.trim()));
    const header = lines.slice(0, firstSegmentTag);
    const droppedLines = lines.slice(firstSegmentTag, cutAfter + 1);
    const kept = lines.slice(cutAfter + 1);

    const discontinuities = droppedLines.filter(l => /^#EXT-X-DISCONTINUITY\s*$/i.test(l.trim())).length;
    const lastOf = (re) => [...droppedLines].reverse().find(l => re.test(l.trim()));
    const carried = [lastOf(/^#EXT-X-KEY:/i), lastOf(/^#EXT-X-MAP:/i)].filter(Boolean);

    const bump = (line, tag, by) => line.replace(new RegExp(`^(#EXT-X-${tag}:\\s*)(\\d+)`, 'i'), (_, p, n) => p + (Number(n) + by));
    const out = header.map(l => bump(bump(l, 'MEDIA-SEQUENCE', dropped), 'DISCONTINUITY-SEQUENCE', discontinuities));
    if (discontinuities > 0 && !out.some(l => /^#EXT-X-DISCONTINUITY-SEQUENCE/i.test(l))) {
        const at = out.findIndex(l => /^#EXT-X-MEDIA-SEQUENCE/i.test(l));
        out.splice(at + 1, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuities}`);
    }
    if (!out.some(l => /^#EXT-X-MEDIA-SEQUENCE/i.test(l))) {
        out.splice(out.findIndex(l => /^#EXTM3U/i.test(l)) + 1, 0, `#EXT-X-MEDIA-SEQUENCE:${dropped}`);
    }
    return [...out, ...carried, ...kept].join('\n');
}

// --- Helper: Rewrite every reference in a playlist ---
// Covers bare URI lines and the URI="..." attribute of tags (#EXT-X-MAP init
// segments, #EXT-X-KEY keys, #EXT-X-MEDIA renditions). A tag URI left relative
// would resolve against the /proxy URL on the receiver and 404, which breaks
// fMP4 and encrypted streams outright. `toProxyUrl(absoluteUrl, isPlaylist,
// isTagUri, tag)` returns the replacement; `tag` is the tag line a URI came from.
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
                    return `URI="${toProxyUrl(new URL(uri, baseUrl).href, isPlaylist, true, trimmed)}"`;
                } catch {
                    return whole;
                }
            });
        }

        const result = resolveM3u8Url(line, baseUrl);
        if (!result.isUrl) return line;
        return toProxyUrl(result.url, isMaster, false);
    }).join('\n');
}

// --- Helper: Build a /proxy URL ---
// The single place the proxy's query contract is spelled out. `type` ('hls'
// or 'dash') marks a manifest whose URL doesn't say so (no .m3u8/.mpd), so the
// proxy rewrites it instead of piping it through as opaque bytes; 'segment'
// marks media whose URL looks like a manifest's, so it is piped through.
// `transcode: 'hevc'` converts an H.264 variant for Chromecast (lib/transcode.js);
// `part: 'init'` asks for a converted variant's shared init section.
// `device: 'webos'` serves an LG TV: every variant is kept (it decodes 4K
// H.264 itself) and segments get their frame-rate header checked (lib/h264-timing.js).
// `audio` marks an audio rendition and its segments, whose packed audio the
// proxy rewraps as MPEG-TS for Cast receivers (lib/packed-audio.js).
function buildProxyUrl(host, { url, referer, quality, type, transcode, part, device, audio, lang }) {
    let proxyUrl = `http://${host}/proxy?url=${encodeURIComponent(url)}` +
        `&referer=${encodeURIComponent(referer || '')}` +
        `&quality=${encodeURIComponent(quality || 'highest')}`;
    if (['hls', 'dash', 'subtitle', 'segment'].includes(type)) proxyUrl += `&type=${type}`;
    if (transcode === 'hevc') proxyUrl += '&transcode=hevc';
    if (part === 'init') proxyUrl += '&part=init';
    if (device === 'webos') proxyUrl += '&device=webos';
    if (audio) proxyUrl += '&audio=1';
    // The audio language picked for a master playlist or MPD (selectAudio).
    if (lang) proxyUrl += `&lang=${encodeURIComponent(lang)}`;
    return proxyUrl;
}

module.exports = {
    buildProxyUrl,
    rewritePlaylist,
    tryNextSegment,
    resolveM3u8Url,
    filterMasterPlaylist,
    parseHlsAudio,
    selectAudio,
    isLanguageTag,
    trimLivePlaylist,
    pickVariant,
    isReceiverDecodable,
    shouldSendReferer,
    noteRefererRejected,
    clearRefererMemo
};
