// Active streams: the pills along the top, which one the dashboard shows,
// and setup vs dashboard mode.
import { app, streamBar, addStreamBtn } from './dom.js';
import { state, saveState, HEALTH_LABELS } from './state.js';
import { apiPost } from './api.js';
import { renderDashboard, updateConnectionHealthUI } from './dashboard.js';

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

export function renderStreamBar() {
    // Remove existing pills (keep the add button)
    streamBar.querySelectorAll('.stream-pill:not(.add-pill)').forEach(pill => pill.remove());

    state.streams.forEach((stream, ip) => {
        const pill = document.createElement('button');
        pill.className = `stream-pill${ip === state.activeStreamIp ? ' active' : ''}`;
        pill.dataset.ip = ip;

        const dot = document.createElement('span');
        dot.className = pillDotClass(stream.health);
        dot.title = HEALTH_LABELS[stream.health] || stream.health;

        const name = document.createElement('span');
        name.textContent = stream.deviceName;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pill-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Stop stream';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            stopStreamByIp(ip, closeBtn);
        });

        pill.appendChild(dot);
        pill.appendChild(name);
        pill.appendChild(closeBtn);

        pill.addEventListener('click', () => switchToStream(ip));

        // Insert before the add button
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

const stoppingIps = new Set();

export async function stopStreamByIp(ip, closeBtn) {
    if (stoppingIps.has(ip)) return; // already stopping, ignore duplicate clicks
    stoppingIps.add(ip);
    if (closeBtn) closeBtn.disabled = true;

    try {
        const response = await apiPost('/api/stop', { ip });
        const data = await response.json();

        if (response.ok) {
            removeStreamEntry(ip);
        } else {
            console.error('Stop error:', data.error);
        }
    } catch (err) {
        console.error('Failed to stop:', err.message);
    } finally {
        stoppingIps.delete(ip);
        // closeBtn may already be gone if removeStreamEntry re-rendered the bar
        if (closeBtn && closeBtn.isConnected) closeBtn.disabled = false;
    }
}
