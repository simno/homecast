// Active streams: the pills along the top, which one the dashboard shows,
// and setup vs dashboard mode.
import { app, streamBar, addStreamBtn, stopBtn, stopBtnLabel } from './dom.js';
import { state, saveState, HEALTH_LABELS } from './state.js';
import { apiPost } from './api.js';
import { renderDashboard, updateConnectionHealthUI, setStreamNotice } from './dashboard.js';

export function createStreamEntry(ip, deviceName, deviceType) {
    state.streams.set(ip, {
        deviceName: deviceName || ip,
        deviceType: deviceType || 'chromecast',
        stats: {},
        rateHistory: [],
        delayHistory: [],
        currentRate: 0,
        currentDelay: 0,
        hasDelay: false,
        health: 'healthy',
        bufferHealth: null,
        notice: null,               // { message, type } shown above the dashboard
        playerState: 'PLAYING',
        position: null,             // { currentTime, duration, at } from the device
        live: false,
        volume: null,               // { level, muted }, Chromecast only
        subtitles: { tracks: [], activeTrackId: null },
        lastStatsAt: Date.now()
    });
}

export function removeStreamEntry(ip) {
    state.streams.delete(ip);
    if (state.activeStreamIp === ip) {
        // Switch to another stream or back to setup
        const remaining = Array.from(state.streams.keys());
        if (remaining.length > 0) {
            switchToStream(remaining[0]);
        } else {
            setMode('setup');
        }
    }
    renderStreamBar();
    saveState();
}

export function switchToStream(ip) {
    if (!state.streams.has(ip)) return;
    // A Stop armed for the previous stream mustn't stop this one.
    disarm(stopBtn, stopBtnLabel);
    state.activeStreamIp = ip;
    renderStreamBar();
    renderDashboard();
    saveState();
}

// ===== MODE =====

// Setup mode shows the compose form; the compose module resets it on entry.
const setupListeners = [];
export function onSetupMode(fn) {
    setupListeners.push(fn);
}

export function setMode(mode) {
    state.mode = mode;
    app.setAttribute('data-mode', mode);

    if (mode === 'setup') {
        state.activeStreamIp = null;
        setupListeners.forEach(fn => fn());
    }

    if (mode === 'dashboard' && state.activeStreamIp) {
        renderDashboard();
    }

    saveState();
}

// ===== STREAM BAR =====

function pillDotClass(health) {
    return `pill-dot${health !== 'healthy' ? ' ' + health : ''}`;
}

// Each pill holds two sibling buttons: one shows the stream, one stops it.
export function renderStreamBar() {
    // Remove existing pills (keep the add button)
    streamBar.querySelectorAll('.stream-entry').forEach(pill => pill.remove());

    state.streams.forEach((stream, ip) => {
        const active = ip === state.activeStreamIp;
        const pill = document.createElement('div');
        pill.className = `stream-pill stream-entry${active ? ' active' : ''}`;
        pill.dataset.ip = ip;

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'pill-main';
        if (active) main.setAttribute('aria-current', 'true');
        main.addEventListener('click', () => switchToStream(ip));

        const dot = document.createElement('span');
        dot.className = pillDotClass(stream.health);
        dot.title = HEALTH_LABELS[stream.health] || stream.health;

        const name = document.createElement('span');
        name.textContent = stream.deviceName;
        main.append(dot, name);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'pill-close';
        const closeLabel = document.createElement('span');
        closeLabel.textContent = '×';
        closeBtn.appendChild(closeLabel);
        closeBtn.title = `Stop streaming to ${stream.deviceName}`;
        closeBtn.setAttribute('aria-label', closeBtn.title);
        closeBtn.addEventListener('click', () => {
            confirmStop(closeBtn, closeLabel, 'Stop?', () => stopStreamByIp(ip, closeBtn));
        });

        pill.append(main, closeBtn);
        streamBar.insertBefore(pill, addStreamBtn);
    });
}

// Show a stream's health on its pill and, if it's the one being viewed, the dashboard.
export function setStreamHealth(ip, health) {
    const stream = state.streams.get(ip);
    if (!stream) return;
    stream.health = health;
    const dot = streamBar.querySelector(`.stream-pill[data-ip="${ip}"] .pill-dot`);
    if (dot) {
        dot.className = pillDotClass(health);
        dot.title = HEALTH_LABELS[health] || health;
    }
    if (ip === state.activeStreamIp) updateConnectionHealthUI(health);
}

// ===== STOPPING =====

// Stopping ends playback on the TV, so it takes two clicks: the first arms
// the button (its label asks to confirm) and a second within a few seconds
// stops. Left alone, the button goes back to normal.
const CONFIRM_MS = 4000;
const armed = new WeakMap(); // button -> { timer, label }

function disarm(button, labelEl) {
    const entry = armed.get(button);
    if (!entry) return;
    clearTimeout(entry.timer);
    armed.delete(button);
    button.classList.remove('armed');
    labelEl.textContent = entry.label;
}

export function confirmStop(button, labelEl, armedLabel, onConfirm) {
    if (armed.has(button)) {
        disarm(button, labelEl);
        onConfirm();
        return;
    }
    armed.set(button, {
        label: labelEl.textContent,
        timer: setTimeout(() => disarm(button, labelEl), CONFIRM_MS)
    });
    button.classList.add('armed');
    labelEl.textContent = armedLabel;
}

const stoppingIps = new Set();

// Resolves true once the stream has stopped. Failures are shown on the
// dashboard (the stream stays listed, since it may still be playing).
export async function stopStreamByIp(ip, closeBtn) {
    if (stoppingIps.has(ip)) return false; // already stopping, ignore duplicate clicks
    stoppingIps.add(ip);
    if (closeBtn) closeBtn.disabled = true;

    try {
        const response = await apiPost('/api/stop', { ip });
        const data = await response.json().catch(() => ({}));

        // 404: the server has no session left (it ended on its own), so
        // there's nothing more to stop.
        if (response.ok || response.status === 404) {
            removeStreamEntry(ip);
            return true;
        }
        console.error('Stop error:', data.error);
        setStreamNotice(ip, { type: 'error', message: data.error || `Could not stop the stream (HTTP ${response.status})` });
    } catch (err) {
        console.error('Failed to stop:', err.message);
        setStreamNotice(ip, { type: 'error', message: 'Could not reach HomeCast to stop the stream. Check the server is running and try again.' });
    } finally {
        stoppingIps.delete(ip);
        // closeBtn may already be gone if removeStreamEntry re-rendered the bar
        if (closeBtn && closeBtn.isConnected) closeBtn.disabled = false;
    }
    return false;
}
