const { devices } = require('./state');
const { castToDevice } = require('./cast');
const { castToAirPlayDevice } = require('./airplay');
const { castToWebOsDevice } = require('./webos');
const { isAvailable: isTranscodeAvailable } = require('./transcode');

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

const isDashUrl = (url, type) => type === 'dash' || (!type && /\.mpd(?:$|[?;])/i.test(url));

// A cast request as sent to /api/cast, checked and normalised:
// { cast: { ip, url, proxy, referer, deviceType, quality, type, subtitle, transcode } }
// or { error } for a 400. `deviceType` is resolved against discovery here,
// so a queued cast still goes the same way when it starts.
function parseCastRequest(body = {}) {
    const { ip, url, deviceType } = body;
    if (!validateIp(ip)) return { error: 'Invalid or missing IP address' };
    if (!validateUrl(url)) return { error: 'Invalid or missing URL. Only http and https protocols are allowed.' };
    const subtitle = normalizeSubtitle(body.subtitle);
    if (subtitle === undefined) return { error: 'Invalid subtitle choice' };
    // The extractor's verdict on the format, for URLs that don't carry an extension.
    const type = STREAM_TYPES.has(body.type) ? body.type : undefined;
    const receiver = deviceType === 'airplay' || devices.get(ip)?.type === 'airplay' ? 'airplay'
        : deviceType === 'webos' || devices.get(ip)?.type === 'webos' ? 'webos' : 'chromecast';
    if (receiver === 'airplay' && isDashUrl(url, type)) {
        return { error: 'Apple TV cannot play DASH streams. Cast this one to a Chromecast, or pick an HLS or MP4 stream.' };
    }
    return {
        cast: {
            ip, url, type, subtitle, deviceType: receiver,
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
function startCast(cast, res) {
    return Promise.resolve()
        .then(() => dispatchCast(cast, res))
        .catch((err) => {
            console.error(`[Cast] Starting a cast on ${cast.ip} failed:`, err);
            if (!res.headersSent) res.status(500).json({ error: `Could not start the cast: ${err.message}` });
        });
}

function dispatchCast(cast, res) {
    const { ip, url, proxy, referer, quality, type, subtitle, deviceType } = cast;
    if (deviceType === 'airplay') {
        // AirPlay 1 can't sideload text tracks; HLS subtitles are picked on the Apple TV itself.
        return castToAirPlayDevice(ip, url, proxy, referer, quality, res, type);
    }
    // LG TVs play in their own browser (DASH through dash.js on the player page).
    if (deviceType === 'webos') {
        return castToWebOsDevice(ip, url, referer, quality, res, isDashUrl(url, type) ? 'dash' : type, subtitle);
    }
    // Convert a variant the Chromecast can't decode to HEVC as it's proxied
    // (lib/transcode.js); needs the proxy and a working hardware encoder.
    const transcode = cast.transcode && proxy && isTranscodeAvailable();
    return castToDevice(ip, url, proxy, referer, quality, res, type, subtitle, transcode);
}

module.exports = { validateIp, parseCastRequest, startCast };
