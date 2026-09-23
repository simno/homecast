// Live updates from the server: devices, playback, stats, health, subtitles.
import { state } from './state.js';
import { updateStatus, handleStreamRecovery } from './status.js';
import { updateDeviceList, findDeviceName, deviceTypeOf } from './devices.js';
import { createStreamEntry, removeStreamEntry, renderStreamBar, setMode, setStreamHealth } from './streams.js';
import { renderStats, renderBufferHealth } from './dashboard.js';
import { renderDashboardSubtitles } from './subtitles.js';

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

        if (ip === state.activeStreamIp) {
            if (playerState === 'PLAYING') updateStatus('Now Playing', 'success');
            else if (playerState === 'BUFFERING') updateStatus('Buffering...', 'loading');
            else if (playerState === 'PAUSED') updateStatus('Paused', 'info');
        }
    } else if (playerState === 'IDLE' && stream) {
        removeStreamEntry(ip);
    }
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
    connectionHealth: (data) => setStreamHealth(data.deviceIp, data.state),
    streamRecovery: (data) => {
        if (data.deviceIp === state.activeStreamIp) handleStreamRecovery(data);
    },
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
