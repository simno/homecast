const axios = require('axios');
const crypto = require('crypto');
const { httpsAgent, USER_AGENT } = require('./utils');

// Public Twitch web client ID (the one the twitch.tv web player ships with).
// Used to request anonymous playback access tokens for publicly viewable streams.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_ENDPOINT = 'https://gql.twitch.tv/gql';

// Persisted-query hash for the PlaybackAccessToken operation (stable, used by
// the web player, streamlink and yt-dlp).
const ACCESS_TOKEN_QUERY_HASH = '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712';

// Path segments that are Twitch features, not channel logins.
const RESERVED_PATHS = new Set([
    'videos', 'directory', 'settings', 'subscriptions', 'inventory',
    'wallet', 'friends', 'p', 'downloads', 'jobs', 'turbo', 'prime'
]);

function isTwitchUrl(rawUrl) {
    try {
        const host = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
        return host === 'twitch.tv' || host === 'm.twitch.tv' || host === 'player.twitch.tv';
    } catch {
        return false;
    }
}

// Returns { kind: 'live', channel } | { kind: 'vod', vodId } | null
function parseTwitchUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }

    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    // player.twitch.tv/?channel=X  or  ?video=123
    if (host === 'player.twitch.tv') {
        const channel = parsed.searchParams.get('channel');
        if (channel) return { kind: 'live', channel: channel.toLowerCase() };
        const video = parsed.searchParams.get('video');
        if (video) return { kind: 'vod', vodId: video.replace(/^v/, '') };
        return null;
    }

    // twitch.tv/videos/123  (VOD)
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'videos' && segments[1]) {
        return { kind: 'vod', vodId: segments[1].replace(/^v/, '') };
    }

    // twitch.tv/<channel>  (live)
    if (segments[0] && !RESERVED_PATHS.has(segments[0].toLowerCase())) {
        return { kind: 'live', channel: segments[0].toLowerCase() };
    }

    return null;
}

async function fetchAccessToken({ kind, channel, vodId }) {
    const isLive = kind === 'live';
    const body = {
        operationName: 'PlaybackAccessToken',
        extensions: {
            persistedQuery: { version: 1, sha256Hash: ACCESS_TOKEN_QUERY_HASH }
        },
        variables: {
            isLive,
            login: isLive ? channel : '',
            isVod: !isLive,
            vodID: isLive ? '' : vodId,
            playerType: 'embed'
        }
    };

    const { data } = await axios.post(GQL_ENDPOINT, body, {
        headers: {
            'Client-ID': CLIENT_ID,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT
        },
        httpsAgent,
        timeout: 8000
    });

    const token = isLive
        ? data?.data?.streamPlaybackAccessToken
        : data?.data?.videoPlaybackAccessToken;

    if (!token?.value || !token?.signature) {
        throw new Error('No playback access token returned (stream offline or restricted)');
    }
    return token;
}

function buildUsherUrl({ kind, channel, vodId }, token) {
    const isLive = kind === 'live';
    const base = isLive
        ? `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8`
        : `https://usher.ttvnw.net/vod/${vodId}.m3u8`;

    const params = new URLSearchParams({
        allow_source: 'true',
        allow_audio_only: 'true',
        fast_bread: 'true',
        // Force H.264 — Chromecast cannot decode Twitch's AV1/HEVC variants.
        supported_codecs: 'avc1',
        playlist_include_framerate: 'true',
        reassignments_supported: 'true',
        player_backend: 'mediaplayer',
        cdm: 'wv',
        sig: token.signature,
        token: token.value,
        p: String(Math.floor(Math.random() * 1e7)),
        play_session_id: crypto.randomBytes(16).toString('hex')
    });

    return `${base}?${params.toString()}`;
}

// Resolves a Twitch page/player URL to a directly-castable HLS master playlist.
// Returns one of:
//   { status: 'ok', url, referer }
//   { status: 'offline', message }   — channel not live / VOD unavailable
//   { status: 'error', message }     — couldn't reach or parse Twitch
async function resolveTwitchStream(rawUrl) {
    const target = parseTwitchUrl(rawUrl);
    if (!target) return { status: 'error', message: 'Unrecognised Twitch URL' };

    let token;
    try {
        token = await fetchAccessToken(target);
    } catch (err) {
        console.log(`[Twitch] Token request failed for ${rawUrl}: ${err.message}`);
        return { status: 'error', message: 'Could not reach Twitch to authorise playback' };
    }

    const url = buildUsherUrl(target, token);

    // A token is issued even for offline channels — usher is the source of truth:
    // it returns the master playlist (200) when live and 404 when there's nothing
    // to play. Verify here so the UI can show a meaningful message.
    try {
        const resp = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            httpsAgent,
            timeout: 8000,
            maxContentLength: 5 * 1024 * 1024,
            validateStatus: () => true
        });

        if (resp.status === 200 && typeof resp.data === 'string' && resp.data.includes('#EXTM3U')) {
            return { status: 'ok', url, referer: 'https://www.twitch.tv/' };
        }

        if (resp.status === 404) {
            return {
                status: 'offline',
                message: target.kind === 'live'
                    ? 'This Twitch channel is offline'
                    : 'This Twitch video is unavailable'
            };
        }

        console.log(`[Twitch] Unexpected usher response ${resp.status} for ${rawUrl}`);
        return { status: 'error', message: `Twitch returned an unexpected response (${resp.status})` };
    } catch (err) {
        console.log(`[Twitch] usher request failed for ${rawUrl}: ${err.message}`);
        return { status: 'error', message: 'Could not load the Twitch stream playlist' };
    }
}

module.exports = { isTwitchUrl, parseTwitchUrl, resolveTwitchStream };
