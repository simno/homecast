const { execFile } = require('child_process');

// YouTube through yt-dlp, when it is installed. YouTube's player hides its
// streams behind signature and "n" challenges that only running YouTube's own
// JavaScript answers, and the rules change every few weeks; yt-dlp keeps up
// with them, so HomeCast asks it rather than reimplementing it.
//
// What it hands back is YouTube's HLS master: H.264 up to 1080p and VP9 up to
// 4K, audio as separate renditions, the same for live streams and videos.
// Its URLs are signed for this server's address and expire after about six
// hours; a receiver on the same network fetches them fine.

// Read per call, so a test can point it at a stand-in.
const ytDlpPath = () => process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 45000;

const HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be']);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Video pages, and a channel's /live (its current broadcast). Other YouTube
// pages (a channel's videos, a playlist on its own) would have yt-dlp walk
// every entry, so they are left to the ordinary scan.
function isYouTubeUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (!HOSTS.has(host)) return false;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be') return ID_RE.test(segments[0] || '');
    if (segments[0] === 'watch') return ID_RE.test(parsed.searchParams.get('v') || '');
    if (['live', 'shorts', 'embed', 'v'].includes(segments[0])) return ID_RE.test(segments[1] || '');
    // /@handle/live, /channel/<id>/live, /c/<name>/live, /user/<name>/live
    const channelLive = segments[0]?.startsWith('@') ? segments[1] : segments[2];
    return channelLive === 'live' && (segments[0]?.startsWith('@') || ['channel', 'c', 'user'].includes(segments[0]));
}

// Runs yt-dlp; resolves to { stdout } or rejects with the error, whose
// `stderr` carries yt-dlp's own explanation.
function runYtDlp(args, { signal, timeout = TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        execFile(ytDlpPath(), args, { signal, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
            resolve({ stdout: String(stdout) });
        });
    });
}

// yt-dlp's "ERROR: [youtube] <id>: <reason>" line, without the prefix.
function ytDlpReason(stderr) {
    const line = String(stderr || '').split('\n').reverse().find(l => l.startsWith('ERROR:'));
    return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([A-Za-z0-9_-]{11}:\s*)?/, '').trim() : null;
}

// Reasons that mean the video itself can't be played, not that yt-dlp broke.
const UNAVAILABLE_RE = /private video|video unavailable|not available|removed|has been terminated|members-only|sign in to confirm your age|premieres in|live event will begin|this live event has ended|does not exist/i;

// The streams in yt-dlp's answer, best first: the HLS master, then a
// progressive MP4 with sound, for the videos that have no HLS.
function pickStreams(info) {
    const formats = Array.isArray(info?.formats) ? info.formats : [];
    const streams = [];
    const master = formats.find(f => f.manifest_url && /^m3u8/.test(f.protocol || ''));
    if (master) streams.push({ url: master.manifest_url, type: 'hls' });
    const progressive = formats
        .filter(f => f.protocol === 'https' && f.ext === 'mp4' && f.url
            && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (progressive) streams.push({ url: progressive.url, type: 'mp4' });
    return streams;
}

// Returns one of:
//   { status: 'ok', streams: [{ url, type }], referer, live, title, thumbnail }
//   { status: 'offline', message }       — private, removed, not started, …
//   { status: 'unavailable', message }   — yt-dlp isn't installed
//   { status: 'error', message }         — yt-dlp failed
async function resolveYouTube(rawUrl, { signal } = {}) {
    let stdout;
    try {
        // Node runs YouTube's challenge script (yt-dlp looks for Deno unless told).
        ({ stdout } = await runYtDlp(['-j', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', '--', rawUrl], { signal }));
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { status: 'unavailable', message: 'Playing YouTube needs yt-dlp, which isn\'t installed on the HomeCast server' };
        }
        if (signal?.aborted) return { status: 'error', message: 'Cancelled' };
        const reason = ytDlpReason(err.stderr);
        console.log(`[YouTube] yt-dlp failed for ${rawUrl}: ${reason || err.message}`);
        if (reason && UNAVAILABLE_RE.test(reason)) return { status: 'offline', message: `YouTube: ${reason}` };
        // YouTube asks this of addresses it distrusts, data centres and VPNs above all.
        if (reason && /not a bot/i.test(reason)) {
            return { status: 'error', message: 'YouTube is refusing this server\'s address as a possible bot. That happens to data-centre and VPN addresses' };
        }
        if (err.killed) return { status: 'error', message: 'yt-dlp took too long to answer for this YouTube video' };
        return { status: 'error', message: `yt-dlp couldn't read this YouTube video${reason ? `: ${reason}` : ''}. Updating yt-dlp often fixes this` };
    }

    let info;
    try {
        info = JSON.parse(stdout);
    } catch {
        return { status: 'error', message: 'yt-dlp gave an answer HomeCast couldn\'t read' };
    }
    const streams = pickStreams(info);
    if (streams.length === 0) {
        return { status: 'error', message: 'YouTube offered no stream a TV can play for this video' };
    }
    return {
        status: 'ok',
        streams,
        referer: 'https://www.youtube.com/',
        live: info.is_live === true,
        title: info.title || null,
        thumbnail: info.thumbnail || null
    };
}

module.exports = { isYouTubeUrl, resolveYouTube, pickStreams, ytDlpReason };
