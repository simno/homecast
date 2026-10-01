const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// Rumble's video pages sit behind a Cloudflare challenge that neither a
// request nor a headless browser gets past, but its embed pages don't, and
// they name the playlist in their markup. oEmbed, also unchallenged, says
// which embed a video page belongs to (the IDs differ: /v7g69dk-….html
// embeds as /embed/v7dzwg2/).

const OEMBED = 'https://rumble.com/api/Media/oembed.json';
const TIMEOUT_MS = 8000;

// rumble.com/v<id>-<slug>.html
function isRumbleVideoUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.hostname.replace(/^www\./, '').toLowerCase() === 'rumble.com'
            && /^\/v[a-z0-9]+(?:-[^/]*)?\.html$/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

// Returns { status: 'page', url, title, thumbnail } naming the embed page to
// scan in the video page's place, or { status: 'offline' | 'error', message }.
async function resolveRumble(rawUrl, { signal } = {}) {
    const parsed = new URL(rawUrl);
    const pageUrl = `https://rumble.com${parsed.pathname}`;
    let reply;
    try {
        reply = await axios.get(OEMBED, {
            params: { url: pageUrl },
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            httpsAgent,
            signal,
            timeout: TIMEOUT_MS,
            validateStatus: () => true
        });
    } catch (err) {
        if (!signal?.aborted) console.log(`[Rumble] oEmbed failed for ${pageUrl}: ${err.message}`);
        return { status: 'error', message: 'Could not reach Rumble' };
    }
    if (reply.status === 404) return { status: 'offline', message: 'This Rumble video doesn\'t exist or has been removed' };

    const html = typeof reply.data?.html === 'string' ? reply.data.html : '';
    const embed = html.match(/src="(https:\/\/rumble\.com\/embed\/[A-Za-z0-9]+\/?)[^"]*"/);
    if (reply.status !== 200 || !embed) {
        console.log(`[Rumble] oEmbed for ${pageUrl} answered HTTP ${reply.status} without an embed`);
        return { status: 'error', message: `Rumble returned an unexpected response (${reply.status})` };
    }
    return {
        status: 'page',
        url: embed[1],
        title: reply.data.title || null,
        thumbnail: reply.data.thumbnail_url || null
    };
}

module.exports = { isRumbleVideoUrl, resolveRumble };
