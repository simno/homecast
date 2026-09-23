// The remote control on the dashboard: play/pause, skip, position and volume
// for the stream being viewed.
import { playback } from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';
import { setStreamNotice } from './dashboard.js';

const SKIP_BACK_S = -10;
const SKIP_FORWARD_S = 30;
const VOLUME_DEBOUNCE_MS = 150;

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
    const el = playback.position;
    if (stream.playerState === 'BUFFERING') {
        el.textContent = 'Buffering…';
        return;
    }
    if (stream.live) {
        el.textContent = stream.currentDelay > 0 ? `Live · ${Math.round(stream.currentDelay)}s behind` : 'Live';
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

// Update what the dashboard shows from a device status report.
export function applyPlayerStatus(stream, status) {
    if (status.playerState) stream.playerState = status.playerState;
    if (status.liveSeekableRange) stream.live = !!status.liveSeekableRange.isMovingWindow;
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
