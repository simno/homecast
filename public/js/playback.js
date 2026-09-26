// The remote control on the dashboard: play/pause, skip, position and volume
// for the stream being viewed.
import { playback } from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';
import { setStreamNotice } from './dashboard.js';
import { formatDelay } from './graphs.js';

const SKIP_BACK_S = -10;
const SKIP_FORWARD_S = 30;
const VOLUME_DEBOUNCE_MS = 150;
// HomeCast plays live streams ~15s behind the edge; offer a jump to live
// only once playback has fallen well behind that.
const GO_LIVE_THRESHOLD_S = 60;
// The server keeps seeks this far short of the live edge (LIVE_EDGE_OFFSET).
const LIVE_EDGE_OFFSET_S = 15;

function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const isAirPlay = (stream) => stream.deviceType === 'airplay';

// Where playback is now: the device reports its position on state changes,
// so between reports it's estimated from the clock.
export function renderPosition(stream) {
    renderTimeline(stream);
    const el = playback.position;
    playback.goLive.classList.toggle('hidden',
        !stream.live || isAirPlay(stream) || !(stream.currentDelay > GO_LIVE_THRESHOLD_S));
    if (stream.playerState === 'BUFFERING') {
        el.textContent = 'Buffering…';
        return;
    }
    if (stream.live) {
        el.textContent = stream.currentDelay > 0 ? `Live · ${formatDelay(stream.currentDelay)} behind` : 'Live';
        return;
    }
    if (stream.ended) {
        const win = timelineWindow(stream);
        const left = win && stream.position ? win.end - currentPosition(stream, stream.playerState) : 0;
        el.textContent = left >= 1 ? `Broadcast ended · ${formatDelay(left)} left` : 'Broadcast ended';
        return;
    }
    const pos = stream.position;
    if (!pos || pos.currentTime === undefined) {
        el.textContent = '';
        return;
    }
    let current = pos.currentTime;
    if (stream.playerState === 'PLAYING') current += (Date.now() - pos.at) / 1000;
    if (pos.duration > 0) {
        current = Math.min(current, pos.duration);
        el.textContent = `${formatTime(current)} / ${formatTime(pos.duration)}`;
    } else {
        el.textContent = formatTime(current);
    }
}

function renderPlayPause(stream) {
    const paused = stream.playerState === 'PAUSED';
    playback.playIcon.classList.toggle('hidden', !paused);
    playback.pauseIcon.classList.toggle('hidden', paused);
    const label = paused ? 'Play' : 'Pause';
    playback.playPause.title = label;
    playback.playPause.setAttribute('aria-label', label);
}

function renderVolume(stream) {
    const airplay = isAirPlay(stream);
    playback.volumeControl.classList.toggle('hidden', airplay);
    playback.volumeNote.classList.toggle('hidden', !airplay);
    if (airplay) return;

    const volume = stream.volume;
    playback.volumeSlider.disabled = !volume;
    playback.muteBtn.disabled = !volume;
    if (!volume) return;

    const muted = volume.muted || volume.level === 0;
    playback.volumeIcon.classList.toggle('hidden', muted);
    playback.mutedIcon.classList.toggle('hidden', !muted);
    const label = volume.muted ? 'Unmute' : 'Mute';
    playback.muteBtn.title = label;
    playback.muteBtn.setAttribute('aria-label', label);
    // Don't pull the slider out from under a drag in progress.
    if (document.activeElement !== playback.volumeSlider) {
        playback.volumeSlider.value = String(Math.round((volume.level ?? 0) * 100));
    }
}

export function renderPlayback(stream) {
    renderPlayPause(stream);
    // Skipping ahead of a live broadcast isn't possible.
    playback.seekForward.classList.toggle('hidden', stream.live);
    renderPosition(stream);
    renderVolume(stream);
}

// Update what the dashboard shows from a device status report. `ended`: the
// server's word that the live broadcast has finished.
export function applyPlayerStatus(stream, status, ended = false) {
    if (status.playerState) stream.playerState = status.playerState;
    if (status.liveSeekableRange) {
        const { start, end, isMovingWindow } = status.liveSeekableRange;
        stream.live = !!isMovingWindow;
        stream.liveRange = { start: start || 0, end, moving: !!isMovingWindow, at: Date.now() };
    }
    if (ended && !stream.ended) {
        // Nothing is live any more: stop sliding the window, and drop the
        // "behind live" figures in favour of a countdown to the end.
        stream.ended = true;
        stream.currentDelay = 0;
        stream.hasDelay = false;
        stream.delayHistory = [];
    }
    if (stream.ended) {
        stream.live = false;
        if (stream.liveRange) stream.liveRange.moving = false;
    }
    else if (status.media?.streamType) stream.live = status.media.streamType === 'LIVE';
    if (status.currentTime !== undefined) {
        stream.position = {
            currentTime: status.currentTime,
            duration: status.media?.duration ?? stream.position?.duration,
            at: Date.now()
        };
    }
}

async function send(action, value) {
    const ip = state.activeStreamIp;
    const stream = state.streams.get(ip);
    if (!stream) return null;
    try {
        const res = await apiPost('/api/playback', { ip, action, value });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data.volume) stream.volume = data.volume;
        return data;
    } catch (err) {
        console.error(`[Playback] ${action} failed:`, err.message);
        setStreamNotice(ip, { type: 'error', message: err.message });
        return null;
    }
}

function activeStream() {
    return state.streams.get(state.activeStreamIp);
}

export function wirePlaybackControls() {
    playback.playPause.addEventListener('click', async () => {
        const stream = activeStream();
        if (!stream) return;
        const action = stream.playerState === 'PAUSED' ? 'play' : 'pause';
        // Show the change straight away; the device's status report confirms it.
        const previous = stream.playerState;
        stream.playerState = action === 'play' ? 'PLAYING' : 'PAUSED';
        if (stream.position) stream.position = { ...stream.position, currentTime: currentPosition(stream, previous), at: Date.now() };
        renderPlayback(stream);
        if (!(await send(action))) {
            stream.playerState = previous;
            renderPlayback(stream);
        }
    });

    playback.seekBack.addEventListener('click', () => send('seek', SKIP_BACK_S));
    playback.seekForward.addEventListener('click', () => send('seek', SKIP_FORWARD_S));
    wireTimeline();
    playback.goLive.addEventListener('click', async () => {
        playback.goLive.disabled = true;
        await send('live');
        playback.goLive.disabled = false;
    });

    let volumeTimer = null;
    playback.volumeSlider.addEventListener('input', () => {
        const level = Number(playback.volumeSlider.value) / 100;
        const stream = activeStream();
        if (stream?.volume) {
            stream.volume = { level, muted: false };
            renderVolume(stream);
        }
        clearTimeout(volumeTimer);
        volumeTimer = setTimeout(() => send('volume', level), VOLUME_DEBOUNCE_MS);
    });

    playback.muteBtn.addEventListener('click', async () => {
        const stream = activeStream();
        if (!stream?.volume) return;
        const muted = !stream.volume.muted;
        stream.volume = { ...stream.volume, muted };
        renderVolume(stream);
        if (!(await send('mute', muted))) stream.volume = { ...stream.volume, muted: !muted };
        renderVolume(stream);
    });
}

// The position a paused/playing stream has reached right now.
function currentPosition(stream, playerState) {
    const pos = stream.position;
    if (!pos) return 0;
    return pos.currentTime + (playerState === 'PLAYING' ? (Date.now() - pos.at) / 1000 : 0);
}

// ===== Timeline =====

let dragging = false;

// The span the stream can be played across right now: a live stream's
// seekable window (which slides with the clock between reports) or 0 to the
// recording's duration. Null when the device hasn't said.
function timelineWindow(stream) {
    const range = stream.liveRange;
    if (range && Number.isFinite(range.end)) {
        const elapsed = range.moving ? (Date.now() - range.at) / 1000 : 0;
        return { start: range.start + elapsed, end: range.end + elapsed, live: stream.live };
    }
    const duration = stream.position?.duration;
    if (duration > 0) return { start: 0, end: duration, live: false };
    return null;
}

function renderTimeline(stream) {
    const el = playback.timeline;
    const win = timelineWindow(stream);
    const usable = win && stream.position && win.end - win.start > 1;
    el.classList.toggle('hidden', !usable);
    if (!usable || dragging) return;

    const current = Math.min(Math.max(currentPosition(stream, stream.playerState), win.start), win.end);
    setTimelineFraction((current - win.start) / (win.end - win.start));
    el.setAttribute('aria-valuemin', String(Math.floor(win.start)));
    el.setAttribute('aria-valuemax', String(Math.floor(win.end)));
    el.setAttribute('aria-valuenow', String(Math.floor(current)));
    el.setAttribute('aria-valuetext', timelineLabel(win, current));
}

function setTimelineFraction(fraction) {
    const pct = `${(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(2)}%`;
    playback.timelineFill.style.width = pct;
    playback.timelineThumb.style.left = pct;
}

// "12:34" into the stream, and for a live one how far that is behind live.
function timelineLabel(win, time) {
    const label = formatTime(time);
    if (!win.live) return label;
    const behind = win.end - time;
    return behind < 1 ? `${label} · Live` : `${label} · ${formatDelay(behind)} behind live`;
}

function wireTimeline() {
    const el = playback.timeline;
    const tip = playback.timelineTip;

    // Where along the stream a pointer at clientX points.
    const timeAt = (clientX) => {
        const stream = activeStream();
        const win = stream && timelineWindow(stream);
        if (!win) return null;
        const rect = el.getBoundingClientRect();
        const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
        return { stream, win, fraction, time: win.start + fraction * (win.end - win.start) };
    };

    const showTip = (clientX) => {
        const at = timeAt(clientX);
        if (!at) return;
        tip.textContent = timelineLabel(at.win, at.time);
        tip.classList.remove('hidden');
        // Keep the label inside the card at either end.
        const width = el.clientWidth;
        const half = tip.offsetWidth / 2;
        tip.style.left = `${Math.min(Math.max(at.fraction * width, half), width - half)}px`;
    };

    el.addEventListener('pointermove', (e) => {
        showTip(e.clientX);
        if (dragging) setTimelineFraction(timeAt(e.clientX)?.fraction ?? 0);
    });
    el.addEventListener('pointerleave', () => { if (!dragging) tip.classList.add('hidden'); });

    el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        el.classList.add('is-dragging');
        el.setPointerCapture(e.pointerId);
        showTip(e.clientX);
        setTimelineFraction(timeAt(e.clientX)?.fraction ?? 0);
    });

    const endDrag = (e, commit) => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('is-dragging');
        if (!el.matches(':hover')) tip.classList.add('hidden');
        const at = commit && timeAt(e.clientX);
        if (at) seekTo(at.stream, at.win, at.time);
        else if (activeStream()) renderTimeline(activeStream());
    };
    el.addEventListener('pointerup', (e) => endDrag(e, true));
    el.addEventListener('pointercancel', (e) => endDrag(e, false));

    el.addEventListener('keydown', (e) => {
        const stream = activeStream();
        const win = stream && timelineWindow(stream);
        if (!win) return;
        const current = currentPosition(stream, stream.playerState);
        const targets = {
            ArrowLeft: current + SKIP_BACK_S,
            ArrowRight: current - SKIP_BACK_S,
            Home: win.start,
            End: win.end
        };
        if (!(e.key in targets)) return;
        e.preventDefault();
        seekTo(stream, win, targets[e.key]);
    });
}

// Jump to `time`, showing the new position straight away; the device's
// status report confirms it.
async function seekTo(stream, win, time) {
    const latest = stream.liveRange && !stream.ended ? Math.max(win.start, win.end - LIVE_EDGE_OFFSET_S) : win.end;
    const target = Math.min(Math.max(time, win.start), latest);
    const previous = stream.position;
    stream.position = { ...stream.position, currentTime: target, at: Date.now() };
    if (win.live) stream.currentDelay = Math.max(0, win.end - target);
    renderPosition(stream);
    if (!(await send('seekTo', target))) {
        stream.position = previous;
        renderPosition(stream);
    }
}
