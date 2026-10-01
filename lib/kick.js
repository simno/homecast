const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// Resolves Kick channels, past broadcasts and clips to their HLS playlists
// through the JSON API the kick.com app itself reads. A channel page names its
// live playlist in its markup too, but a past broadcast's or clip's page is an
// empty app shell, and an offline channel deserves better than "no video".

const API = 'https://kick.com/api';
const TIMEOUT_MS = 8000;

// Path segments that are Kick features, not channel slugs.
const RESERVED_PATHS = new Set([
    'api', 'browse', 'categories', 'category', 'following', 'search', 'settings',
    'subscriptions', 'dashboard', 'video', 'clips', 'terms-of-service',
    'privacy-policy', 'community-guidelines', 'dmca-policy', 'about', 'brand'
]);

const SLUG_RE = /^[A-Za-z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIP_RE = /^clip_[A-Za-z0-9]+$/;

function isKickUrl(rawUrl) {
    try {
        const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
        return host === 'kick.com' || host === 'player.kick.com';
    } catch {
        return false;
    }
}

// Returns { kind: 'live', channel } | { kind: 'vod', uuid } | { kind: 'clip', clipId } | null
//   kick.com/<channel>                    player.kick.com/<channel>
//   kick.com/<channel>/videos/<uuid>      kick.com/video/<uuid>
//   kick.com/<channel>/clips/<clip_id>    kick.com/<channel>?clip=<clip_id>
function parseKickUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (!isKickUrl(rawUrl)) return null;

    const clip = parsed.searchParams.get('clip');
    if (clip && CLIP_RE.test(clip)) return { kind: 'clip', clipId: clip };

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'video' && UUID_RE.test(segments[1] || '')) return { kind: 'vod', uuid: segments[1] };
    if (segments[1] === 'videos' && UUID_RE.test(segments[2] || '')) return { kind: 'vod', uuid: segments[2] };
    if (segments[1] === 'clips' && CLIP_RE.test(segments[2] || '')) return { kind: 'clip', clipId: segments[2] };
    if (segments.length === 1 && SLUG_RE.test(segments[0]) && !RESERVED_PATHS.has(segments[0].toLowerCase())) {
        return { kind: 'live', channel: segments[0].toLowerCase() };
    }
    return null;
}

async function getJson(path, signal) {
    const { status, data } = await axios.get(`${API}${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        httpsAgent,
        signal,
        timeout: TIMEOUT_MS,
        validateStatus: () => true
    });
    return { status, data: status === 200 && data && typeof data === 'object' ? data : null };
}

const thumbnailOf = (t) => (typeof t === 'string' ? t : t?.src || t?.url || null);

// Resolves a Kick URL to its HLS playlist. Returns one of:
//   { status: 'ok', url, type, referer, live, title, thumbnail }
//   { status: 'offline', message }   — channel not live / video or clip gone
//   { status: 'error', message }     — couldn't reach or parse Kick
async function resolveKick(rawUrl, { signal } = {}) {
    const target = parseKickUrl(rawUrl);
    if (!target) return { status: 'error', message: 'Unrecognised Kick URL' };

    const path = target.kind === 'live' ? `/v2/channels/${target.channel}`
        : target.kind === 'vod' ? `/v1/video/${target.uuid}`
            : `/v2/clips/${target.clipId}`;
    let reply;
    try {
        reply = await getJson(path, signal);
    } catch (err) {
        if (!signal?.aborted) console.log(`[Kick] ${path} failed: ${err.message}`);
        return { status: 'error', message: 'Could not reach Kick' };
    }
    if (reply.status === 404) {
        const what = { live: 'Kick channel', vod: 'Kick video', clip: 'Kick clip' }[target.kind];
        return { status: 'offline', message: `This ${what} doesn't exist or has been removed` };
    }
    if (!reply.data) {
        console.log(`[Kick] ${path} answered HTTP ${reply.status}`);
        return { status: 'error', message: `Kick returned an unexpected response (${reply.status})` };
    }

    const base = { status: 'ok', type: 'hls', referer: 'https://kick.com/' };
    const { data } = reply;
    if (target.kind === 'live') {
        // playback_url is issued whether or not the channel is live; the
        // livestream record is what says it is on air.
        if (!data.livestream?.is_live || !data.playback_url) {
            return { status: 'offline', message: 'This Kick channel is offline' };
        }
        return {
            ...base,
            url: data.playback_url,
            live: true,
            title: data.livestream.session_title || data.user?.username || null,
            thumbnail: thumbnailOf(data.livestream.thumbnail)
        };
    }
    if (target.kind === 'vod') {
        if (!data.source) return { status: 'offline', message: 'This Kick video is unavailable' };
        return {
            ...base,
            url: data.source,
            live: false,
            title: data.livestream?.session_title || null,
            thumbnail: thumbnailOf(data.livestream?.thumbnail)
        };
    }
    const clip = data.clip;
    const url = clip?.video_url || clip?.clip_url;
    if (!url) return { status: 'offline', message: 'This Kick clip is unavailable' };
    return { ...base, url, live: false, title: clip.title || null, thumbnail: clip.thumbnail_url || null };
}

module.exports = { isKickUrl, parseKickUrl, resolveKick };
