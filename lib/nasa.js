const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// NASA+ (plus.nasa.gov) is a WordPress site. Its video and scheduled-event
// pages carry their playlist in their markup, which the ordinary scan finds;
// the home page doesn't, and it is where the live channel plays. The site's
// own REST API names both what is airing and the channel.
//
// nasa.gov/live is the same programme, embedded from YouTube.

const API = 'https://plus.nasa.gov/wp-json';
const TIMEOUT_MS = 8000;

function isNasaLiveUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
        if (host === 'plus.nasa.gov') return path === '' || path === '/live';
        if (host === 'nasa.gov') return path === '/live' || path === '/nasatv' || path === '/nasalive';
        return false;
    } catch {
        return false;
    }
}

async function getJson(path, signal) {
    const { data } = await axios.get(`${API}${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        httpsAgent,
        signal,
        timeout: TIMEOUT_MS
    });
    return data;
}

// A scheduled event (a launch, a spacewalk) on air now, if NASA+ has one with
// its own playlist: { url, title } or null.
async function airingEvent(signal, now = Date.now()) {
    const events = await getJson('/wp/v2/scheduled_video?per_page=20', signal);
    if (!Array.isArray(events)) return null;
    const seconds = now / 1000;
    const onAir = events.find(e => {
        const start = Number(e?.meta?.first_aired_date);
        const end = Number(e?.meta?.end_aired_date);
        return e?.meta?.['video-url'] && start <= seconds && seconds < end;
    });
    return onAir ? { url: onAir.meta['video-url'], title: decodeEntities(onAir.title?.rendered) } : null;
}

// WordPress renders titles with HTML entities (&#8217; and the like).
function decodeEntities(text) {
    if (typeof text !== 'string') return null;
    return text
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Returns { status: 'ok', url, type, referer, live, title, thumbnail } for
// what NASA+ is showing now, or { status: 'offline' | 'error', message }.
async function resolveNasaLive(rawUrl, { signal, now } = {}) {
    try {
        // An event first: during a launch the channel may still be showing
        // something else, and the event is what the page leads with.
        const event = await airingEvent(signal, now).catch((err) => {
            if (!signal?.aborted) console.log(`[NASA] Schedule lookup failed: ${err.message}`);
            return null;
        });
        if (event) {
            return { status: 'ok', url: event.url, type: 'hls', referer: 'https://plus.nasa.gov/', live: true, title: event.title, thumbnail: null };
        }
        const channels = await getJson('/nasaplus/v1/live-streams', signal);
        const channel = Array.isArray(channels) ? channels.find(c => c?.['live-stream-link']) : null;
        if (!channel) return { status: 'offline', message: 'NASA+ isn\'t streaming live right now' };
        return {
            status: 'ok',
            url: channel['live-stream-link'],
            type: 'hls',
            referer: 'https://plus.nasa.gov/',
            live: true,
            title: 'NASA+ Live',
            thumbnail: null
        };
    } catch (err) {
        if (!signal?.aborted) console.log(`[NASA] Live lookup failed: ${err.message}`);
        return { status: 'error', message: 'Could not reach NASA+' };
    }
}

module.exports = { isNasaLiveUrl, resolveNasaLive, decodeEntities };
