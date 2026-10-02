const { devices } = require('./state');
const { castToDevice, clearSessionNotice } = require('./cast');
const { castToAirPlayDevice } = require('./airplay');
const { castToWebOsDevice } = require('./webos');
const { isAvailable: isTranscodeAvailable } = require('./transcode');
const { startSkipping, CATEGORY_NAMES } = require('./sponsorblock');
const { isLanguageTag } = require('./proxy');

// Starting a cast: checking what was asked for, then handing it to the
// receiver's module. Shared by POST /api/cast and the queue (lib/queue.js),
// which starts its next item exactly as the page would have.

// IPv4 address or hostname validation
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validateIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip === 'localhost') return true;
    if (IP_RE.test(ip)) {
        const parts = ip.split('.').map(Number);
        return parts.every(p => p >= 0 && p <= 255);
    }
    return false;
}

// Normalize the requested quality to one the proxy understands:
// 'highest' (default), 'auto', or a numeric height string like '1080'.
function normalizeQuality(quality) {
    if (quality === 'auto' || quality === 'highest') return quality;
    const height = parseInt(quality, 10);
    if (Number.isFinite(height) && height > 0 && height <= 4320) return String(height);
    return 'highest';
}

const STREAM_TYPES = new Set(['hls', 'dash', 'mp4', 'webm', 'mkv']);

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol);
    } catch {
        return false;
    }
}

const shortText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

// The subtitle choice sent with a cast: null (off), a file to sideload
// ({ url, language?, label? }) or a manifest rendition ({ language?, label? }).
// Returns undefined when the value is present but malformed.
function normalizeSubtitle(subtitle) {
    if (subtitle === undefined || subtitle === null) return null;
    if (typeof subtitle !== 'object' || Array.isArray(subtitle)) return undefined;
    const language = shortText(subtitle.language);
    const label = shortText(subtitle.label);
    if (subtitle.url !== undefined) {
        if (!validateUrl(subtitle.url) || subtitle.url.length > 4096) return undefined;
        return { url: subtitle.url, language, label };
    }
    if (!language && !label) return undefined;
    return { language, label };
}

// The SponsorBlock categories picked for a YouTube cast: undefined (the
// server's own setting), or a list of known ones ([] skips nothing).
function normalizeSponsorBlock(value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > Object.keys(CATEGORY_NAMES).length) return null;
    if (!value.every(c => typeof c === 'string' && CATEGORY_NAMES[c])) return null;
    return [...new Set(value)];
}

const isDashUrl = (url, type) => type === 'dash' || (!type && /\.mpd(?:$|[?;])/i.test(url));

// A cast request as sent to /api/cast, checked and normalised:
// { cast: { ip, url, proxy, referer, deviceType, quality, type, subtitle, audio, sponsorBlock, transcode } }
// or { error } for a 400. `deviceType` is resolved against discovery here,
// so a queued cast still goes the same way when it starts.
function parseCastRequest(body = {}) {
    const { ip, url, deviceType } = body;
    if (!validateIp(ip)) return { error: 'Invalid or missing IP address' };
    if (!validateUrl(url)) return { error: 'Invalid or missing URL. Only http and https protocols are allowed.' };
    const subtitle = normalizeSubtitle(body.subtitle);
    if (subtitle === undefined) return { error: 'Invalid subtitle choice' };
    // The audio language to play, as a language tag; null leaves it to the
    // proxy (a YouTube video's original).
    const audio = body.audio === undefined || body.audio === null ? null : body.audio;
    if (audio !== null && !isLanguageTag(audio)) return { error: 'Invalid audio language' };
    const sponsorBlock = normalizeSponsorBlock(body.sponsorBlock);
    if (sponsorBlock === null) return { error: 'Invalid SponsorBlock categories' };
    // The extractor's verdict on the format, for URLs that don't carry an extension.
    const type = STREAM_TYPES.has(body.type) ? body.type : undefined;
    const receiver = deviceType === 'airplay' || devices.get(ip)?.type === 'airplay' ? 'airplay'
        : deviceType === 'webos' || devices.get(ip)?.type === 'webos' ? 'webos' : 'chromecast';
    if (receiver === 'airplay' && isDashUrl(url, type)) {
        return { error: 'Apple TV cannot play DASH streams. Cast this one to a Chromecast, or pick an HLS or MP4 stream.' };
    }
    // The page the video was found on, for pages to show and match against
    // their recent list; the video URL itself when there's none.
    const page = typeof body.page === 'string' && validateUrl(body.page) && body.page.length <= 2048 ? body.page : url;
    return {
        cast: {
            ip, url, page, type, subtitle, audio, sponsorBlock, deviceType: receiver,
            proxy: !!body.proxy,
            referer: typeof body.referer === 'string' ? body.referer : '',
            quality: normalizeQuality(body.quality),
            transcode: body.transcode === true
        }
    };
}

// Start a parsed cast; the receiver's module answers on `res`. Whatever it
// throws is answered as a 500 here: nobody awaits a cast, and an unhandled
// rejection stops the server.
// The page each device's current cast came from (ip -> URL).
const castPages = new Map();
const castPage = (ip) => castPages.get(ip) || null;

function startCast(cast, res) {
    // A new stream: what was said about the last one no longer applies.
    clearSessionNotice(cast.ip);
    castPages.set(cast.ip, cast.page || cast.url);
    // A YouTube video's sponsors are skipped (lib/sponsorblock.js); any
    // other cast ends the last one's skipping.
    startSkipping(cast.ip, cast.page || cast.url, cast.sponsorBlock ? { wanted: cast.sponsorBlock } : undefined);
    return Promise.resolve()
        .then(() => dispatchCast(cast, res))
        .catch((err) => {
            console.error(`[Cast] Starting a cast on ${cast.ip} failed:`, err);
            if (!res.headersSent) res.status(500).json({ error: `Could not start the cast: ${err.message}` });
        });
}

function dispatchCast(cast, res) {
    const { ip, url, proxy, referer, quality, type, subtitle, audio, deviceType } = cast;
    if (deviceType === 'airplay') {
        // AirPlay 1 can't sideload text tracks; HLS subtitles are picked on the Apple TV itself.
        return castToAirPlayDevice(ip, url, proxy, referer, quality, res, type, audio);
    }
    // LG TVs play in their own browser (DASH through dash.js on the player page).
    if (deviceType === 'webos') {
        return castToWebOsDevice(ip, url, referer, quality, res, isDashUrl(url, type) ? 'dash' : type, subtitle, audio);
    }
    // Convert a variant the Chromecast can't decode to HEVC as it's proxied
    // (lib/transcode.js); needs the proxy and a working hardware encoder.
    const transcode = cast.transcode && proxy && isTranscodeAvailable();
    return castToDevice(ip, url, proxy, referer, quality, res, type, subtitle, transcode, audio);
}

module.exports = { validateIp, parseCastRequest, startCast, castPage };
