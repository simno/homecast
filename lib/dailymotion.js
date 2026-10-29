const { runYtDlp, ytDlpReason } = require('./youtube');

// Dailymotion videos and live streams through yt-dlp, when it is installed.
// Dailymotion's APIs still name a manifest (geo.dailymotion.com/videos/<id>,
// /player/metadata), but its CDN refuses those manifests (HTTP 403, X-Error-Code
// E005) to clients it takes for bots; yt-dlp keeps up with what it lets
// through, so HomeCast asks it rather than chasing the CDN itself.
//
// What it hands back are the master's variant playlists, H.264 with AAC
// muxed in. Those load without the master's checks, so the best of them is
// played rather than the master.

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

// The best variant yt-dlp lists: the tallest, then the highest bitrate.
function pickVariant(info) {
    const formats = Array.isArray(info?.formats) ? info.formats : [];
    return formats
        .filter(f => f.url && /^m3u8/.test(f.protocol || '') && f.vcodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))[0] || null;
}

// Reasons that mean the video itself can't be played, not that yt-dlp broke:
// "Not found.", "dailymotion said: Private content", geo restrictions.
const UNAVAILABLE_RE = /not found|said:|private|removed|deleted|not available|geo.?restrict/i;

// Resolves a Dailymotion URL to its HLS playlist. Returns one of:
//   { status: 'ok', url, type, referer, live, title, thumbnail }
//   { status: 'offline', message }       — removed, private, or not playable here
//   { status: 'unavailable', message }   — yt-dlp isn't installed
//   { status: 'error', message }         — yt-dlp failed
async function resolveDailymotion(rawUrl, { signal } = {}) {
    const id = videoIdFromUrl(rawUrl);
    if (!id) return { status: 'error', message: 'Unrecognised Dailymotion URL' };

    let stdout;
    try {
        ({ stdout } = await runYtDlp(['-j', '--no-playlist', '--no-warnings', '--', `https://www.dailymotion.com/video/${id}`], { signal }));
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { status: 'unavailable', message: 'Playing Dailymotion needs yt-dlp, which isn\'t installed on the HomeCast server' };
        }
        if (signal?.aborted) return { status: 'error', message: 'Cancelled' };
        // "x8j6bwk: dailymotion said: Private content" → "Private content"
        const raw = ytDlpReason(err.stderr);
        const reason = raw?.replace(new RegExp(`^${id}:\\s*`), '').replace(/^dailymotion said:\s*/i, '');
        console.log(`[Dailymotion] yt-dlp failed for ${id}: ${reason || err.message}`);
        if (reason && UNAVAILABLE_RE.test(raw)) return { status: 'offline', message: `Dailymotion: ${reason}` };
        if (err.killed) return { status: 'error', message: 'yt-dlp took too long to answer for this Dailymotion video' };
        return { status: 'error', message: `yt-dlp couldn't read this Dailymotion video${reason ? `: ${reason}` : ''}. Updating yt-dlp often fixes this` };
    }

    let info;
    try {
        info = JSON.parse(stdout);
    } catch {
        return { status: 'error', message: 'yt-dlp gave an answer HomeCast couldn\'t read' };
    }
    const variant = pickVariant(info);
    if (!variant) return { status: 'error', message: 'Dailymotion offered no stream a TV can play for this video' };
    return {
        status: 'ok',
        url: variant.url,
        type: 'hls',
        referer: 'https://www.dailymotion.com/',
        live: info.is_live === true,
        title: info.title || null,
        thumbnail: info.thumbnail || null
    };
}

module.exports = { isDailymotionUrl, videoIdFromUrl, resolveDailymotion, pickVariant };
