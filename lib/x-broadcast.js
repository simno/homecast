const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// Resolves X (Twitter / Periscope) live broadcasts — live or replay — to their
// HLS playlist, the same way the x.com web player does: an anonymous guest
// token, the broadcast's media key, then the stream status that names the
// playlist.

// Public bearer token of the x.com web client (the one yt-dlp and gallery-dl
// use for anonymous requests).
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const API = 'https://api.x.com/1.1';
const GUEST_TOKEN_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

// x.com/i/broadcasts/<id>, twitter.com/i/broadcasts/<id>,
// studio.x.com/embed/broadcast/<id>, periscope.tv/w/<id>, pscp.tv/w/<id>
const BROADCAST_PATTERNS = [
    { hosts: ['x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com'], path: /^\/i\/broadcasts\/([A-Za-z0-9]+)/ },
    { hosts: ['studio.x.com', 'studio.twitter.com'], path: /^\/embed\/broadcast\/([A-Za-z0-9]+)/ },
    { hosts: ['periscope.tv', 'pscp.tv'], path: /^\/w\/([A-Za-z0-9]+)/ }
];

function broadcastIdFromUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    for (const { hosts, path } of BROADCAST_PATTERNS) {
        if (!hosts.includes(host)) continue;
        const m = parsed.pathname.match(path);
        if (m) return m[1];
    }
    return null;
}

function isXBroadcastUrl(rawUrl) {
    return broadcastIdFromUrl(rawUrl) !== null;
}

let guestToken = null;

async function getGuestToken(fresh = false) {
    if (!fresh && guestToken && Date.now() - guestToken.at < GUEST_TOKEN_TTL_MS) return guestToken.value;
    const { data } = await axios.post(`${API}/guest/activate.json`, null, {
        headers: { Authorization: `Bearer ${BEARER}`, 'User-Agent': USER_AGENT },
        httpsAgent,
        timeout: TIMEOUT_MS
    });
    if (!data?.guest_token) throw new Error('No guest token returned');
    guestToken = { value: data.guest_token, at: Date.now() };
    return guestToken.value;
}

// GET an API path as a guest, renewing the token once if X has retired it.
async function apiGet(path) {
    for (const fresh of [false, true]) {
        const token = await getGuestToken(fresh);
        const resp = await axios.get(`${API}${path}`, {
            headers: { Authorization: `Bearer ${BEARER}`, 'x-guest-token': token, 'User-Agent': USER_AGENT },
            httpsAgent,
            timeout: TIMEOUT_MS,
            validateStatus: () => true
        });
        if ((resp.status === 401 || resp.status === 403) && !fresh) continue;
        return resp;
    }
}

// Resolves a broadcast ID (or any URL isXBroadcastUrl accepts) to its playlist.
// Returns one of:
//   { status: 'ok', url, referer, title, thumbnail, live }
//   { status: 'offline', message }   — unknown, private, or not yet started
//   { status: 'error', message }     — couldn't reach or parse X
async function resolveXBroadcast(idOrUrl) {
    const id = broadcastIdFromUrl(idOrUrl) || (/^[A-Za-z0-9]+$/.test(idOrUrl) ? idOrUrl : null);
    if (!id) return { status: 'error', message: 'Unrecognised X broadcast URL' };

    try {
        const show = await apiGet(`/broadcasts/show.json?ids=${id}&include_events=true`);
        const broadcast = show.status === 200 ? show.data?.broadcasts?.[id] : null;
        if (!broadcast?.media_key) {
            if (show.status !== 200) console.log(`[X] broadcasts/show returned ${show.status} for ${id}`);
            return { status: 'offline', message: 'This X broadcast is unavailable' };
        }

        const status = await apiGet(`/live_video_stream/status/${broadcast.media_key}`);
        const url = status.status === 200 ? status.data?.source?.location : null;
        if (!url) {
            return {
                status: 'offline',
                message: broadcast.state === 'NOT_STARTED'
                    ? 'This X broadcast has not started yet'
                    : 'This X broadcast has no playable stream'
            };
        }

        return {
            status: 'ok',
            url,
            referer: 'https://x.com/',
            title: broadcast.status || null,
            thumbnail: broadcast.image_url || null,
            live: broadcast.state === 'RUNNING'
        };
    } catch (err) {
        console.log(`[X] Broadcast lookup failed for ${id}: ${err.message}`);
        return { status: 'error', message: 'Could not reach X to look up the broadcast' };
    }
}

module.exports = { isXBroadcastUrl, broadcastIdFromUrl, resolveXBroadcast };
