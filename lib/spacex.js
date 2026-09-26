const axios = require('axios');
const { httpsAgent, USER_AGENT } = require('./utils');

// spacex.com launch pages are an Angular app: the HTML is an empty shell, and
// the webcast only becomes an iframe once the viewer presses WATCH. What a scan
// or a headless browser does see is the looping background clip, so the
// webcast is read from the mission record the page itself loads instead.

const MISSION_API = 'https://content.spacex.com/api/spacex-website/missions/';

// www.spacex.com/launches/<slug>
function launchSlugFromUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname.replace(/^www\./, '').toLowerCase() !== 'spacex.com') return null;
        const m = parsed.pathname.match(/^\/launches\/([A-Za-z0-9_-]+)\/?$/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

function isSpacexLaunchUrl(rawUrl) {
    return launchSlugFromUrl(rawUrl) !== null;
}

// The player URL the page would build for a webcast, as calculateWebcastUrl
// does in the site's own bundle.
function webcastUrl({ streamingVideoType, videoId }) {
    if (!videoId) return null;
    if (streamingVideoType === 'x-live-studio') return `https://studio.x.com/embed/broadcast/${videoId}`;
    if (streamingVideoType === 'youtube') return `https://www.youtube.com/watch?v=${videoId}`;
    if (streamingVideoType === 'x.com') return `https://x.com/i/status/${videoId}`;
    return null;
}

// Returns { title, webcasts: [url] } — the featured webcast first — or null
// when the mission can't be read.
async function fetchLaunchWebcasts(rawUrl, { signal } = {}) {
    const slug = launchSlugFromUrl(rawUrl);
    if (!slug) return null;
    try {
        const { data } = await axios.get(MISSION_API + slug, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            httpsAgent,
            signal,
            timeout: 8000
        });
        const webcasts = Array.isArray(data?.webcasts) ? data.webcasts : [];
        const ordered = [...webcasts.filter(w => w.isFeatured), ...webcasts.filter(w => !w.isFeatured)];
        return {
            title: data?.title || null,
            webcasts: [...new Set(ordered.map(webcastUrl).filter(Boolean))]
        };
    } catch (err) {
        if (!signal?.aborted) console.log(`[SpaceX] Mission lookup failed for ${slug}: ${err.message}`);
        return null;
    }
}

module.exports = { isSpacexLaunchUrl, launchSlugFromUrl, webcastUrl, fetchLaunchWebcasts };
