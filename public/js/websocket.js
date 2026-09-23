// Live updates from the server: devices, playback, stats, health, subtitles.
import { state } from './state.js';
import { updateStatus } from './status.js';
import { updateDeviceList, findDeviceName, deviceTypeOf } from './devices.js';
import { createStreamEntry, removeStreamEntry, renderStreamBar, setMode, setStreamHealth } from './streams.js';
import { renderStats, renderBufferHealth, setStreamNotice } from './dashboard.js';
import { renderDashboardSubtitles } from './subtitles.js';
import { applyPlayerStatus, renderPlayback } from './playback.js';

function onStreamStats(data) {
    const stream = state.streams.get(data.deviceIp);
    if (!stream) return;

    stream.stats = data.stats;
    stream.lastStatsAt = Date.now();

    // Data is flowing again
    if (stream.health === 'stale') setStreamHealth(data.deviceIp, 'healthy');

    // Update current values; the 1Hz tick samples these into history
    // so the graphs' x-axis is real time, not segment count.
    stream.currentRate = parseFloat(data.stats.transferRate) || 0;
    if (data.stats.delay !== undefined && data.stats.delay > 0) {
        stream.currentDelay = parseFloat(data.stats.delay) || 0;
        stream.hasDelay = true;
    }

    if (data.bufferHealth) {
        stream.bufferHealth = data.bufferHealth;
    }

    // Graphs are driven by the 1Hz tick; only the numbers need updating here.
    if (data.deviceIp === state.activeStreamIp) {
        renderStats(data.stats);
        if (data.bufferHealth) renderBufferHealth(data.bufferHealth);
    }
}

function onPlayerStatus(data) {
    const ip = data.deviceIp;
    const stream = state.streams.get(ip);
    const playerState = data.status.playerState;

    if (data.bufferHealth && stream) {
        stream.bufferHealth = data.bufferHealth;
    }

    if (playerState === 'PLAYING' || playerState === 'BUFFERING' || playerState === 'PAUSED') {
        // Ensure stream entry exists (e.g., after page reload)
        if (!stream && ip) {
            createStreamEntry(ip, findDeviceName(ip), deviceTypeOf(ip));
            if (state.mode === 'setup') {
                state.activeStreamIp = ip;
                setMode('dashboard');
            }
            renderStreamBar();
        }

        const entry = state.streams.get(ip);
        applyPlayerStatus(entry, data.status);
        if (ip === state.activeStreamIp) {
            renderPlayback(entry);
            if (playerState === 'PLAYING') updateStatus('Now Playing', 'success');
            else if (playerState === 'BUFFERING') updateStatus('Buffering...', 'loading');
            else if (playerState === 'PAUSED') updateStatus('Paused', 'info');
        }
    } else if (playerState === 'IDLE' && stream) {
        removeStreamEntry(ip);
    }
}

// Recovery runs whichever stream is being viewed, so it's reported on the
// stream itself: its pill and, when viewed, the dashboard banner.
function onStreamRecovery(data) {
    const ip = data.deviceIp;
    if (!state.streams.has(ip)) return;
    console.log('[Recovery]', data);
    if (data.status === 'attempting') {
        setStreamHealth(ip, 'reconnecting');
        setStreamNotice(ip, { type: 'warning', message: `Playback stalled. Restarting the stream (attempt ${data.attempt} of ${data.maxAttempts})…` });
    } else if (data.status === 'success') {
        setStreamHealth(ip, 'healthy');
        setStreamNotice(ip, { type: 'success', message: 'Stream restarted and playing again.' });
    } else if (data.status === 'failed') {
        setStreamNotice(ip, { type: 'warning', message: `Restart attempt ${data.attempt} failed. Trying again shortly…` });
    } else if (data.status === 'giveup') {
        setStreamHealth(ip, 'failed');
        setStreamNotice(ip, { type: 'error', message: 'HomeCast could not restart this stream. Stop it and cast again.' });
    }
}

function onConnectionHealth(data) {
    setStreamHealth(data.deviceIp, data.state);
    if (data.state === 'failed') {
        setStreamNotice(data.deviceIp, { type: 'error', message: data.message || 'Lost the connection to the device.' });
    }
}

function onVolume(data) {
    const stream = state.streams.get(data.deviceIp);
    if (!stream) return;
    stream.volume = data.volume;
    if (data.deviceIp === state.activeStreamIp) renderPlayback(stream);
}

function onSubtitleTracks(data) {
    const stream = state.streams.get(data.deviceIp);
    if (!stream) return;
    stream.subtitles = { tracks: data.tracks, activeTrackId: data.activeTrackId };
    if (data.deviceIp === state.activeStreamIp) renderDashboardSubtitles(stream);
}

const handlers = {
    devices: (data) => {
        state.devices = data.devices;
        updateDeviceList(data.devices);
    },
    status: (data) => updateStatus(data.status, 'info'),
    streamStats: onStreamStats,
    playerStatus: onPlayerStatus,
    connectionHealth: onConnectionHealth,
    streamRecovery: onStreamRecovery,
    volume: onVolume,
    subtitleTracks: onSubtitleTracks,
    pairingStatus: (data) => {
        if (data.status === 'paired') state.pairedDevices.add(data.deviceIp);
        else if (data.status === 'unpaired') state.pairedDevices.delete(data.deviceIp);
    }
};

export function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onmessage = (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.error('[WebSocket] Failed to parse message:', e);
            return;
        }
        handlers[data.type]?.(data);
    };

    ws.onerror = () => {
        console.warn('WebSocket connection failed, falling back to polling');
    };
}
