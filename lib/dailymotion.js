const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// Resolves Dailymotion videos and live streams to their HLS playlist through
// the API the current player (geo.dailymotion.com) reads. The older
// /player/metadata endpoint still answers, but the manifests it names are
// refused (HTTP 403, X-Error-Code E005) to everyone, browsers included.

const API = 'https://geo.dailymotion.com/videos/';
const TIMEOUT_MS = 8000;
const ID_RE = /^x[a-z0-9]+$/i;

const HOSTS = new Set(['dailymotion.com', 'm.dailymotion.com', 'geo.dailymotion.com', 'dai.ly']);

function isDailymotionUrl(rawUrl) {
    return videoIdFromUrl(rawUrl) !== null;
}

// dailymotion.com/video/<id>, dailymotion.com/embed/video/<id>, dai.ly/<id>,
// geo.dailymotion.com/player/<player>.html?video=<id>
function videoIdFromUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!HOSTS.has(host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const candidate = host === 'dai.ly' ? segments[0]
        : host === 'geo.dailymotion.com' ? parsed.searchParams.get('video')
            : segments[0] === 'video' ? segments[1]
                : segments[0] === 'embed' && segments[1] === 'video' ? segments[2]
                    : null;
    // Video URLs may carry a slug after the ID: /video/x8j6bwk_popeye
    const id = candidate?.split('_')[0];
    return id && ID_RE.test(id) ? id : null;
}

async function getJson(url, signal) {
    const { status, data } = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        httpsAgent,
        signal,
        timeout: TIMEOUT_MS,
        validateStatus: () => true
    });
    return { status, data: data && typeof data === 'object' ? data : null };
}

// The largest poster the record lists.
function largestPoster(posters) {
    const sizes = Object.keys(posters || {}).map(Number).filter(Number.isFinite);
    return sizes.length > 0 ? posters[Math.max(...sizes)] : null;
}

// Reasons Dailymotion gives for not playing a video, as users should read them.
const REFUSALS = {
    content_not_found: 'This Dailymotion video doesn\'t exist or has been removed',
    embed_rules: 'This Dailymotion video can only be played on dailymotion.com',
    geoblocked: 'This Dailymotion video isn\'t available in your country',
    private: 'This Dailymotion video is private',
    password_protected: 'This Dailymotion video is password protected'
};

// Resolves a Dailymotion URL to its HLS playlist. Returns one of:
//   { status: 'ok', url, type, referer, live, title, thumbnail }
//   { status: 'offline', message }   — removed, private, or not playable here
//   { status: 'error', message }     — couldn't reach or parse Dailymotion
async function resolveDailymotion(rawUrl, { signal } = {}) {
    const id = videoIdFromUrl(rawUrl);
    if (!id) return { status: 'error', message: 'Unrecognised Dailymotion URL' };

    let video, details;
    try {
        // The title lives in the details record; losing it costs nothing else.
        [video, details] = await Promise.all([
            getJson(API + id, signal),
            getJson(`${API}${id}/details`, signal).catch(() => null)
        ]);
    } catch (err) {
        if (!signal?.aborted) console.log(`[Dailymotion] Lookup failed for ${id}: ${err.message}`);
        return { status: 'error', message: 'Could not reach Dailymotion' };
    }

    const refusal = video.data?.error?.reason;
    if (refusal) {
        return { status: 'offline', message: REFUSALS[refusal] || `Dailymotion won't play this video (${refusal})` };
    }
    const stream = video.data?.stream;
    if (!stream?.url) {
        console.log(`[Dailymotion] No stream for ${id} (HTTP ${video.status})`);
        return { status: 'error', message: `Dailymotion returned an unexpected response (${video.status})` };
    }
    return {
        status: 'ok',
        url: stream.url,
        type: 'hls',
        referer: 'https://www.dailymotion.com/',
        live: stream.stream_type === 'live',
        title: details?.data?.info?.title || null,
        thumbnail: largestPoster(video.data.media?.posters_url)
    };
}

module.exports = { isDailymotionUrl, videoIdFromUrl, resolveDailymotion };
