// Entry point: wires the modules to the page and restores streams that
// were playing when the page was last open.
import { refreshGraphColors } from './graphs.js';
import {
    videoUrlInput, analyzeBtn, castBtn, stopBtn, addStreamBtn, composeOverlay,
    helpBtn, helpModal, helpCloseBtn
} from './dom.js';
import { state, loadState, clearState } from './state.js';
import { fetchCsrfToken, checkSessionStatus } from './api.js';
import { redrawActiveGraphs, startDashboardTimers } from './dashboard.js';
import {
    createStreamEntry, renderStreamBar, setMode, onSetupMode, stopStreamByIp, setStreamHealth
} from './streams.js';
import { updateDeviceList, findDeviceName, onDeviceChange, wireDeviceControls } from './devices.js';
import {
    resetComposeForm, openComposeOverlay, closeComposeOverlay, isComposeOverlayOpen,
    checkReady, onDeviceChanged, fetchAndAnalyze, startCasting
} from './compose.js';
import { wirePairingControls, hidePinPrompt, isPinPromptOpen } from './pairing.js';
import { wireSubtitleControls } from './subtitles.js';
import { connectWebSocket } from './websocket.js';

fetchCsrfToken();

// ===== THEME =====
refreshGraphColors();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    refreshGraphColors();
    redrawActiveGraphs();
});

// ===== MATERIAL RIPPLE EFFECT =====
document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('button, .stream-pill, .stream-option');
    if (!target) return;

    const ripple = document.createElement('span');
    ripple.classList.add('ripple-effect');

    const rect = target.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

    target.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
});

// ===== HELP MODAL =====
function openHelp() {
    helpModal.classList.remove('hidden');
    helpCloseBtn.focus();
}

function closeHelp() {
    helpModal.classList.add('hidden');
    helpBtn.focus();
}

// ===== EVENT WIRING =====
onSetupMode(() => {
    resetComposeForm();
    closeComposeOverlay();
});
onDeviceChange(onDeviceChanged);
wireDeviceControls();
wirePairingControls();
wireSubtitleControls({ onComposeChange: checkReady });

analyzeBtn.addEventListener('click', () => fetchAndAnalyze());
videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        fetchAndAnalyze({ restart: true });
    }
});
// Pasting a link is the common case: start analysing straight away.
videoUrlInput.addEventListener('paste', () => {
    setTimeout(() => {
        const value = videoUrlInput.value.trim();
        if (/^https?:\/\/\S+$/i.test(value)) fetchAndAnalyze({ restart: true });
    }, 0);
});
castBtn.addEventListener('click', startCasting);
stopBtn.addEventListener('click', async () => {
    if (!state.activeStreamIp) return;
    stopBtn.disabled = true;
    await stopStreamByIp(state.activeStreamIp);
    stopBtn.disabled = false;
});
addStreamBtn.addEventListener('click', openComposeOverlay);
composeOverlay.querySelector('.compose-overlay-backdrop').addEventListener('click', closeComposeOverlay);

helpBtn.addEventListener('click', openHelp);
helpCloseBtn.addEventListener('click', closeHelp);
helpModal.addEventListener('click', (e) => {
    if (e.target === helpModal) closeHelp();
});

// Global Escape: close whichever overlay is open (most transient first).
// The PIN input has its own Escape handler, but that only fires when focus
// is inside it; this covers the modal's other controls.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isPinPromptOpen()) hidePinPrompt();
    else if (!helpModal.classList.contains('hidden')) closeHelp();
    else if (isComposeOverlayOpen()) closeComposeOverlay();
});

// ===== LIVE UPDATES =====
connectWebSocket();
startDashboardTimers({ onStale: (ip) => setStreamHealth(ip, 'stale') });

// ===== RESTORE STREAMS AFTER A RELOAD =====
async function restoreStreams(savedState) {
    // Check every saved stream's session concurrently — sequential awaits
    // would add one round-trip of latency per stream to the restore.
    const sessions = await Promise.all(
        savedState.activeStreams.map(async (saved) => ({
            saved,
            session: await checkSessionStatus(saved.ip)
        }))
    );

    let anyActive = false;
    for (const { saved: { ip, deviceName, deviceType }, session } of sessions) {
        if (!session.active) continue;
        createStreamEntry(ip, findDeviceName(ip) || deviceName || ip, deviceType || 'chromecast');
        const stream = state.streams.get(ip);
        if (session.stats) stream.stats = session.stats;
        if (session.subtitles) stream.subtitles = session.subtitles;
        anyActive = true;
    }

    if (!anyActive) {
        console.log('[State] No saved sessions are still active');
        clearState();
        return;
    }

    const ips = Array.from(state.streams.keys());
    state.activeStreamIp = state.streams.has(savedState.activeStreamIp) ? savedState.activeStreamIp : ips[0];
    renderStreamBar();
    setMode('dashboard');
    console.log('[State] Restored', ips.length, 'active stream(s)');
}

window.addEventListener('load', () => {
    const savedState = loadState();
    if (!savedState?.activeStreams?.length) return;

    if (Date.now() - savedState.timestamp >= 24 * 60 * 60 * 1000) {
        console.log('[State] Saved state is too old, clearing');
        clearState();
        return;
    }
    // Wait a moment for the device list to arrive via WebSocket
    setTimeout(() => restoreStreams(savedState), 1000);
});

// Initial device poll
fetch('/api/devices')
    .then(r => r.json())
    .then(devices => {
        state.devices = devices; // names for streams cast before any WebSocket update
        updateDeviceList(devices);
    })
    .catch(err => {
        console.error('Failed to fetch devices:', err);
        updateDeviceList([]);
    });
