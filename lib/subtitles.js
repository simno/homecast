// Subtitles: finding them, turning them into something a receiver accepts,
// and switching them on a Chromecast.
//
// Two kinds reach a cast:
//   sideloaded - a WebVTT or SRT file (a page's <track>, or a URL the user
//                gives). Sent with the LOAD as a text track that the receiver
//                fetches through /proxy?type=subtitle, which converts SRT and
//                adds the CORS headers receivers insist on for text tracks.
//   manifest   - renditions inside an HLS master or DASH MPD. The receiver
//                finds these itself; all we can do is pick one once it
//                reports its tracks after load, matching language and name.

const { activeSessions } = require('./state');
const { broadcast } = require('./websocket');

const SUBTITLE_URL_RE = /\.(?:vtt|webvtt|srt)(?:$|[?#])/i;
const SIDELOADED_TRACK_ID = 1;

function isSubtitleUrl(url) {
    return typeof url === 'string' && SUBTITLE_URL_RE.test(url);
}

// --- HLS ---

// Attribute list of an #EXT-X-... tag: KEY=value or KEY="quoted, value".
function parseAttributes(line) {
    const attrs = {};
    const body = line.slice(line.indexOf(':') + 1);
    for (const m of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)) {
        attrs[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    }
    return attrs;
}

// SUBTITLES renditions a master playlist offers, in playlist order:
// [{ language, label, default, forced }].
function parseHlsSubtitles(playlist) {
    if (typeof playlist !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const line of playlist.split(/\r?\n/)) {
        if (!/^#EXT-X-MEDIA:/i.test(line.trim())) continue;
        const a = parseAttributes(line.trim());
        if ((a.TYPE || '').toUpperCase() !== 'SUBTITLES') continue;
        const language = a.LANGUAGE || null;
        const label = a.NAME || language;
        if (!label) continue;
        const key = `${language}|${label}`;
        if (seen.has(key)) continue; // one entry per rendition, not per group
        seen.add(key);
        out.push({
            language,
            label,
            default: a.DEFAULT === 'YES',
            forced: a.FORCED === 'YES'
        });
    }
    return out;
}

// --- Converting to WebVTT ---

// Subtitle files come in whatever encoding their author's editor used; SRT
// in particular is often Windows-1252. UTF-8 is tried first and kept unless
// it produced replacement characters.
function decodeText(buf) {
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf.subarray(2));
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf.subarray(2));
    const utf8 = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '');
    if (!utf8.includes('\uFFFD')) return utf8;
    return new TextDecoder('windows-1252').decode(buf);
}

const SRT_TIMING_RE = /(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g;

// SRT and WebVTT cues differ only in the header and the decimal separator.
// Hours are padded because WebVTT requires two digits where SRT allows one.
function srtToVtt(text) {
    const body = text.replace(/\r\n?/g, '\n').trim()
        .replace(SRT_TIMING_RE, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms}`);
    return `WEBVTT\n\n${body}\n`;
}

// The file as WebVTT, or null if it is neither WebVTT nor SRT.
function toWebVtt(buf) {
    const text = decodeText(buf);
    if (/^WEBVTT/.test(text.trimStart())) return text.trimStart();
    if (/\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(text)) return srtToVtt(text);
    return null;
}

// --- Chromecast text tracks ---

// The LOAD request's text track for a sideloaded file. The receiver requires
// a language for SUBTITLES tracks; 'und' is the tag for "undetermined".
function sideloadedTrack(contentUrl, { language, label }) {
    return {
        trackId: SIDELOADED_TRACK_ID,
        type: 'TEXT',
        subtype: 'SUBTITLES',
        trackContentId: contentUrl,
        trackContentType: 'text/vtt',
        name: label || language || 'Subtitles',
        language: language || 'und'
    };
}

// The TEXT tracks in a receiver's media info, trimmed to what the UI shows.
function textTracks(media) {
    return (media?.tracks || [])
        .filter(t => t.type === 'TEXT')
        .map(t => ({ trackId: t.trackId, name: t.name || null, language: t.language || null }));
}

const primaryTag = (lang) => (lang || '').toLowerCase().split(/[-_]/)[0];

// The receiver track that best matches a rendition picked before casting:
// same name and language, then same language, then same base language
// ('en' for 'en-US').
function matchTrack(tracks, { language, label }) {
    const lang = (language || '').toLowerCase();
    return tracks.find(t => label && t.name === label && (t.language || '').toLowerCase() === lang)
        || (lang && tracks.find(t => (t.language || '').toLowerCase() === lang))
        || (lang && tracks.find(t => primaryTag(t.language) === primaryTag(lang)))
        || (label && tracks.find(t => t.name === label))
        || null;
}

// Switch the receiver's active text track (trackId null = subtitles off).
function setActiveTextTrack(player, trackId) {
    const activeTrackIds = trackId === null ? [] : [trackId];
    return new Promise((resolve, reject) => {
        const done = (err) => (err ? reject(err) : resolve(activeTrackIds));
        // The dev-mode mock player has no media controller.
        if (typeof player.editTracksInfo === 'function') return player.editTracksInfo(activeTrackIds, done);
        const media = player.media;
        if (!media?.sessionRequest) return reject(new Error('This receiver does not support switching subtitles'));
        const send = () => media.sessionRequest({ type: 'EDIT_TRACKS_INFO', activeTrackIds }, done);
        // sessionRequest needs the media session id, known once a status has arrived.
        if (media.currentSession) return send();
        media.getStatus((err) => (err ? reject(err) : send()));
    });
}

// --- Per-session state ---
//
// Each Chromecast session carries { tracks, activeTrackId, wanted }:
//   tracks        the receiver's TEXT tracks, as last reported
//   activeTrackId the one showing, or null
//   wanted        a manifest rendition picked before casting, applied as soon
//                 as the receiver lists its tracks (then cleared)

function newSubtitleState(choice) {
    return { tracks: [], activeTrackId: null, wanted: choice && !choice.url ? choice : null };
}

function subtitleState(ip) {
    const sub = activeSessions.get(ip)?.subtitles;
    return sub ? { tracks: sub.tracks, activeTrackId: sub.activeTrackId } : { tracks: [], activeTrackId: null };
}

function broadcastSubtitles(ip) {
    broadcast({ type: 'subtitleTracks', deviceIp: ip, ...subtitleState(ip) });
}

// Switch subtitles for a session and tell every open UI.
async function selectSubtitle(ip, trackId) {
    const session = activeSessions.get(ip);
    if (!session) throw new Error('No active session');
    await setActiveTextTrack(session.player, trackId);
    session.subtitles.activeTrackId = trackId;
    broadcastSubtitles(ip);
}

// Fold a receiver status into the session's subtitle state. Statuses carry
// `media` (and so the track list) only when it changes, and activeTrackIds
// covers audio/video tracks too, so both are read defensively.
function syncSubtitles(ip, status) {
    const sub = activeSessions.get(ip)?.subtitles;
    if (!sub || !status) return;
    let changed = false;

    if (status.media?.tracks) {
        const tracks = textTracks(status.media);
        if (JSON.stringify(tracks) !== JSON.stringify(sub.tracks)) {
            sub.tracks = tracks;
            changed = true;
        }
    }
    if (Array.isArray(status.activeTrackIds) || status.media) {
        const active = (status.activeTrackIds || []).find(id => sub.tracks.some(t => t.trackId === id)) ?? null;
        if (active !== sub.activeTrackId) {
            sub.activeTrackId = active;
            changed = true;
        }
    }

    if (sub.wanted && sub.tracks.length > 0) {
        const wanted = sub.wanted;
        sub.wanted = null;
        const track = matchTrack(sub.tracks, wanted);
        if (track) {
            console.log(`[Subtitles] Selecting "${track.name || track.language}" on ${ip}`);
            selectSubtitle(ip, track.trackId).catch(err => {
                console.error(`[Subtitles] Could not select a track on ${ip}:`, err.message);
            });
        } else {
            console.log(`[Subtitles] Receiver on ${ip} has no track matching "${wanted.label || wanted.language}"`);
        }
    }

    if (changed) broadcastSubtitles(ip);
}

// LOAD options for reloading a session's media (stall recovery) without
// losing its subtitles. A sideloaded track keeps its fixed id; a manifest
// track's id may change on reload, so it is re-picked by language and name.
function reloadOptions(ip, media) {
    const sub = activeSessions.get(ip)?.subtitles;
    const active = sub?.tracks.find(t => t.trackId === sub.activeTrackId);
    if (!active) return {};
    if (media.tracks?.some(t => t.trackId === active.trackId)) return { activeTrackIds: [active.trackId] };
    sub.wanted = { language: active.language, label: active.name };
    return {};
}

module.exports = {
    newSubtitleState,
    subtitleState,
    selectSubtitle,
    syncSubtitles,
    reloadOptions,
    SIDELOADED_TRACK_ID,
    isSubtitleUrl,
    parseHlsSubtitles,
    decodeText,
    srtToVtt,
    toWebVtt,
    sideloadedTrack,
    textTracks,
    matchTrack,
    setActiveTextTrack
};
