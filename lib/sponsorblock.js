const crypto = require('crypto');
const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');
const { activeSessions, activeAirPlaySessions, activeWebOsSessions } = require('./state');
const { broadcast } = require('./websocket');
const { controlPlayback } = require('./cast');
const { controlAirPlayPlayback, airPlayPosition } = require('./airplay');
const { controlWebOsPlayback } = require('./webos');

// SponsorBlock for YouTube casts: the segments its users have marked
// (sponsors, self-promotion, subscribe reminders by default) are skipped on
// the receiver. HomeCast follows where playback is and seeks past each one,
// once: seeking back into a skipped segment plays it.
//
// Segments are looked up by the first characters of the video ID's SHA-256,
// as SponsorBlock suggests, so its server never learns which video plays.
//
// SPONSORBLOCK_CATEGORIES lists the categories to skip, comma-separated;
// 'none' turns skipping off.

const API = 'https://sponsor.ajay.app/api/skipSegments/';
const TIMEOUT_MS = 8000;

const CATEGORY_NAMES = {
    sponsor: 'sponsor',
    selfpromo: 'self-promotion',
    interaction: 'subscribe reminder',
    intro: 'intro',
    outro: 'outro',
    preview: 'preview',
    hook: 'hook',
    filler: 'filler',
    music_offtopic: 'non-music section'
};
const DEFAULT_CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];

// How often playback is checked: Cast and LG positions come from their last
// status (no request); an Apple TV is asked each time.
const POLL_MS = 500;
const AIRPLAY_POLL_MS = 1000;
// Give up on a cast whose session never appears, or has ended for this long.
const SESSION_WAIT_MS = 60000;
const SESSION_GONE_MS = 10000;
// A segment ending this close to where playback is isn't worth a seek.
const MIN_SKIP_S = 1;

function categories(env = process.env.SPONSORBLOCK_CATEGORIES) {
    if (env === undefined || env.trim() === '') return DEFAULT_CATEGORIES;
    if (env.trim().toLowerCase() === 'none') return [];
    const wanted = env.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
    const unknown = wanted.filter(c => !CATEGORY_NAMES[c]);
    if (unknown.length > 0) console.log(`[SponsorBlock] Ignoring unknown categories: ${unknown.join(', ')}`);
    return wanted.filter(c => CATEGORY_NAMES[c]);
}

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// The video ID of a YouTube watch, share, Shorts, live or embed URL, or null.
function youTubeVideoId(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    const host = parsed.hostname.replace(/^(www|m|music)\./, '').toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);
    let id = null;
    if (host === 'youtu.be') id = segments[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        id = segments[0] === 'watch' ? parsed.searchParams.get('v')
            : ['live', 'shorts', 'embed', 'v'].includes(segments[0]) ? segments[1] : null;
    }
    return id && ID_RE.test(id) ? id : null;
}

// The video's segments in `wanted` categories, in order: [{ start, end, category }].
async function fetchSegments(videoId, wanted, { signal } = {}) {
    if (wanted.length === 0) return [];
    const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const { status, data } = await axios.get(API + prefix, {
        params: { categories: JSON.stringify(wanted), actionTypes: JSON.stringify(['skip']) },
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        httpsAgent,
        signal,
        timeout: TIMEOUT_MS,
        validateStatus: (s) => s === 200 || s === 404
    });
    if (status === 404 || !Array.isArray(data)) return [];
    const video = data.find(v => v?.videoID === videoId);
    return (video?.segments || [])
        .map(s => ({ start: Number(s.segment?.[0]), end: Number(s.segment?.[1]), category: s.category }))
        .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start >= MIN_SKIP_S)
        .sort((a, b) => a.start - b.start);
}

// Where playback is on the receiver playing on `ip`: { kind, time, playing },
// or null when nothing is playing there.
async function receiverPosition(ip) {
    const cast = activeSessions.get(ip);
    if (cast) {
        const status = cast.lastStatus;
        if (!status || status.currentTime === undefined) return { kind: 'chromecast', time: null };
        const playing = status.playerState === 'PLAYING';
        const elapsed = playing ? (Date.now() - cast.lastStatusAt) / 1000 * (status.playbackRate || 1) : 0;
        return { kind: 'chromecast', time: status.currentTime + elapsed, playing };
    }
    const webos = activeWebOsSessions.get(ip);
    if (webos) {
        const last = webos.lastStatus;
        if (!last?.status || last.status.currentTime === undefined) return { kind: 'webos', time: null };
        const playing = last.status.playerState === 'PLAYING';
        return { kind: 'webos', time: last.status.currentTime + (playing ? (Date.now() - last.at) / 1000 : 0), playing };
    }
    if (activeAirPlaySessions.has(ip)) {
        const { position } = await airPlayPosition(ip);
        return { kind: 'airplay', time: position, playing: true };
    }
    return null;
}

const CONTROLS = { chromecast: controlPlayback, webos: controlWebOsPlayback, airplay: controlAirPlayPlayback };

// The segment to skip at `time`: one it falls in, not skipped before, and
// with enough left of it to be worth a seek.
function segmentAt(segments, time, skipped) {
    return segments.find(s => !skipped.has(s) && time >= s.start && time < s.end - MIN_SKIP_S) || null;
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ip -> { stop }
const skippers = new Map();

function stopSkipping(ip) {
    skippers.get(ip)?.stop();
    skippers.delete(ip);
}

// Skip `page`'s segments on whatever plays on `ip` from now on, until another
// cast starts there or the session ends. `page` that isn't a YouTube video,
// or a video with no segments, does nothing.
function startSkipping(ip, page, { wanted = categories(), now = Date.now } = {}) {
    stopSkipping(ip);
    const videoId = youTubeVideoId(page);
    if (!videoId || wanted.length === 0) return null;

    const controller = new AbortController();
    let timer = null;
    const skipper = {
        stop() {
            controller.abort();
            clearTimeout(timer);
        }
    };
    skippers.set(ip, skipper);

    const skipped = new Set();
    const started = now();
    let lastSeen = null;
    let segments = [];

    const tick = async () => {
        if (controller.signal.aborted) return;
        let position = null;
        try {
            position = await receiverPosition(ip);
        } catch (err) {
            console.log(`[SponsorBlock] Couldn't read the position on ${ip}: ${err.message}`);
        }
        if (controller.signal.aborted) return;
        if (position) lastSeen = now();
        const gone = lastSeen === null ? now() - started > SESSION_WAIT_MS : now() - lastSeen > SESSION_GONE_MS;
        if (gone) {
            if (skippers.get(ip) === skipper) skippers.delete(ip);
            return;
        }

        const segment = position?.time !== null && position?.time !== undefined && position.playing
            ? segmentAt(segments, position.time, skipped) : null;
        if (segment) {
            skipped.add(segment);
            try {
                await CONTROLS[position.kind](ip, 'seekTo', segment.end);
                const name = CATEGORY_NAMES[segment.category] || segment.category;
                console.log(`[SponsorBlock] Skipped ${name} on ${ip}: ${formatTime(segment.start)}–${formatTime(segment.end)}`);
                broadcast({
                    type: 'castNotice',
                    deviceIp: ip,
                    level: 'info',
                    message: `Skipped a ${name} segment (${Math.round(segment.end - segment.start)}s)`
                });
            } catch (err) {
                console.log(`[SponsorBlock] Skipping on ${ip} failed: ${err.message}`);
            }
        }
        if (!controller.signal.aborted) {
            timer = setTimeout(tick, position?.kind === 'airplay' ? AIRPLAY_POLL_MS : POLL_MS);
            timer.unref?.();
        }
    };

    fetchSegments(videoId, wanted, { signal: controller.signal })
        .then((found) => {
            if (controller.signal.aborted) return;
            if (found.length === 0) {
                if (skippers.get(ip) === skipper) skippers.delete(ip);
                return;
            }
            segments = found;
            console.log(`[SponsorBlock] ${found.length} segment(s) to skip in ${videoId} on ${ip}`);
            tick();
        })
        .catch((err) => {
            if (!controller.signal.aborted) console.log(`[SponsorBlock] Lookup failed for ${videoId}: ${err.message}`);
            if (skippers.get(ip) === skipper) skippers.delete(ip);
        });
    return skipper;
}

module.exports = { CATEGORY_NAMES, categories, youTubeVideoId, fetchSegments, segmentAt, receiverPosition, startSkipping, stopSkipping };
