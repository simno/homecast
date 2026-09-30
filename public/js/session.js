// A stream's full state from the server (/api/session): for streams the page
// restores, and for ones it only learns of from a status update (cast from
// another browser, or the next video in a queue). What the server broadcast
// as such a stream started (its volume, its subtitles) arrived before the page
// had an entry to put it on, so it's asked for.
import { state } from './state.js';
import { checkSessionStatus } from './api.js';
import { applyPlayerStatus } from './playback.js';
import { renderDashboard } from './dashboard.js';

// Bring a stream's entry up to date with the server's view of its session.
export function applySession(stream, session) {
    if (session.stats) stream.stats = session.stats;
    if (session.subtitles) stream.subtitles = session.subtitles;
    if (session.volume) stream.volume = session.volume;
    if (session.bufferHealth) stream.bufferHealth = session.bufferHealth;
    // Where playback is: receivers say only when it changes, so without
    // this a page opened mid-stream has no position or timeline.
    if (session.playback?.status) {
        applyPlayerStatus(stream, session.playback.status, session.playback.ended);
        if (stream.position) stream.position.at -= session.playback.statusAgeMs;
        if (stream.liveRange) stream.liveRange.at -= session.playback.statusAgeMs;
    }
    const delay = session.tracking?.lastDelay;
    if (delay > 0 && !stream.ended) {
        stream.currentDelay = delay;
        stream.hasDelay = true;
    }
    // Fresh from the server: not stale, whatever went missing before.
    stream.lastStatsAt = Date.now();
}

// Fill in a stream the page has just made an entry for from a status update.
export async function hydrateStream(ip) {
    const session = await checkSessionStatus(ip);
    const stream = state.streams.get(ip);
    if (!session.active || !stream) return;
    applySession(stream, session);
    if (ip === state.activeStreamIp) renderDashboard();
}
