const axios = require('axios');
const { httpAgent, httpsAgent, USER_AGENT } = require('./utils');
const { safeRequestOptions } = require('./security');
const { scanText, rankCandidates, PLAYABLE_TYPES } = require('./media-scan');
const { describeMpd } = require('./dash');

// The single most likely stream URL in a blob of HTML/JS, or null. Page-level
// discovery (markup, embeds, probing) lives in stream-finder.js; this is the
// quick text-only answer.
function extractVideoFromHtml(html) {
    const playable = scanText(html, 'https://invalid.local/')
        .filter(c => PLAYABLE_TYPES.has(c.type) && !c.url.startsWith('https://invalid.local/'))
        .map(c => ({ ...c, source: 'page-text' }));
    const [best] = rankCandidates(playable);
    return best ? best.url : null;
}

// --- Helper: Detect Frame Rate ---
async function detectFrameRate(videoUrl, type) {
    try {
        if (type === 'mp4') {
            try {
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    timeout: 3000,
                    responseType: 'arraybuffer',
                    headers: {
                        'Range': 'bytes=0-65535'
                    },
                    ...safeRequestOptions,
                    validateStatus: (status) => status === 200 || status === 206
                });

                const buffer = Buffer.from(response.data);
                const timescale = findMvhdTimescale(buffer);
                if (timescale) {
                    if (timescale === 600) return 24;
                    if (timescale === 24000) return 24;
                    if (timescale === 23976) return 24;
                    if (timescale === 25000) return 25;
                    if (timescale === 1000) return 30;
                    if (timescale === 30000) return 30;
                    if (timescale === 29970) return 30;
                    if (timescale === 48000) return 48;
                    if (timescale === 50000) return 50;
                    if (timescale === 60000) return 60;
                    if (timescale === 59940) return 60;

                    const estimatedFps = Math.round(timescale / 1000);
                    if (estimatedFps >= 15 && estimatedFps <= 120) return estimatedFps;
                }
            } catch {
                // Silently fail - frame rate detection is optional
            }
        }

        return null;
    } catch {
        return null;
    }
}

function findMvhdTimescale(buffer) {
    try {
        const mvhdIndex = buffer.indexOf('mvhd');
        if (mvhdIndex === -1) return null;

        const versionOffset = mvhdIndex + 4;
        if (versionOffset >= buffer.length) return null;

        const version = buffer[versionOffset];
        let timescaleOffset;

        if (version === 1) {
            timescaleOffset = mvhdIndex + 4 + 20;
        } else {
            timescaleOffset = mvhdIndex + 4 + 12;
        }

        if (timescaleOffset + 4 > buffer.length) return null;

        const timescale = buffer.readUInt32BE(timescaleOffset);
        if (timescale < 1 || timescale > 600000) return null;

        return timescale;
    } catch {
        return null;
    }
}

// --- Helper: Is this HLS URL a live stream or a finished recording? ---
// The URL cannot answer this. Periscope/X serve finished replays from
// `master_dynamic_*.m3u8?type=replay`, so any name-based guess gets them
// backwards — and telling the receiver a completed VOD is LIVE makes it start
// at the "live edge", which is the end of the playlist, so playback ends the
// moment it begins.
//
// The manifest does answer it: #EXT-X-ENDLIST (or PLAYLIST-TYPE:VOD) means the
// recording is complete. Those live in the media playlist, so a master has to
// be resolved to a variant first.
//
// Returns true (live), false (VOD), or null when it could not be determined —
// callers should fall back to their own heuristic on null.
async function isLiveHlsStream(url) {
    if (!url || !url.includes('.m3u8')) return null;
    try {
        const master = await fetchPlaylist(url);
        if (!master) return null;

        let mediaPlaylist = master;
        if (/#EXT-X-STREAM-INF/i.test(master)) {
            const variantUrl = firstVariantUrl(master, url);
            if (!variantUrl) return null;
            mediaPlaylist = await fetchPlaylist(variantUrl);
            if (!mediaPlaylist) return null;
        }

        if (/#EXT-X-ENDLIST/i.test(mediaPlaylist)) return false;
        if (/#EXT-X-PLAYLIST-TYPE\s*:\s*VOD/i.test(mediaPlaylist)) return false;
        return true;
    } catch {
        return null;
    }
}

// Fetch a playlist as text. Media playlists for multi-hour recordings run to
// megabytes, so cap the read — #EXT-X-ENDLIST may be past the cap, but
// PLAYLIST-TYPE is in the header and a truncated body still tells us the
// playlist is long enough to be a recording rather than a rolling live window.
async function fetchPlaylist(url) {
    try {
        const response = await axios({
            method: 'get',
            url,
            timeout: 5000,
            maxContentLength: 4 * 1024 * 1024,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            headers: { 'User-Agent': USER_AGENT },
            ...safeRequestOptions,
            validateStatus: (status) => status === 200
        });
        return typeof response.data === 'string' ? response.data : null;
    } catch {
        return null;
    }
}

// First variant URI in a master playlist, resolved against the master's URL.
function firstVariantUrl(master, masterUrl) {
    const lines = master.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
        for (let j = i + 1; j < lines.length; j++) {
            const candidate = lines[j].trim();
            if (candidate === '' || candidate.startsWith('#')) continue;
            try {
                return new URL(candidate, masterUrl).href;
            } catch {
                return null;
            }
        }
    }
    return null;
}

// --- Helper: Is this DASH manifest live? ---
// An MPD says so outright: type="dynamic" is live, "static" (the default) is
// on-demand. Returns true, false, or null when the MPD can't be read.
async function isLiveDashStream(url) {
    const mpd = describeMpd(await fetchPlaylist(url));
    return mpd ? mpd.live : null;
}

module.exports = {
    extractVideoFromHtml,
    detectFrameRate,
    isLiveHlsStream,
    isLiveDashStream
};
