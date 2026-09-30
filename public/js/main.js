// Entry point: wires the modules to the page and restores the streams that
// are playing — on the server, whichever browser started them.
import { refreshGraphColors } from './graphs.js';
import {
    videoUrlInput, analyzeBtn, castBtn, stopBtn, stopBtnLabel, addStreamBtn, composeOverlay,
    helpBtn, helpModal, helpCloseBtn, useProxyCheckbox, advancedNote, bookmarkletLink, shareLinkFormat,
    bookmarkletCopyBtn, bookmarkletCopied, bookmarksBarKeys
} from './dom.js';
import { state, loadState, clearState } from './state.js';
import { fetchCsrfToken, checkSessionStatus, fetchRunningSessions } from './api.js';
import { redrawActiveGraphs, startDashboardTimers, renderDashboard } from './dashboard.js';
import {
    createStreamEntry, removeStreamEntry, renderStreamBar, setMode, onSetupMode, stopStreamByIp, setStreamHealth, confirmStop
} from './streams.js';
import { updateDeviceList, findDeviceName, onDeviceChange, wireDeviceControls } from './devices.js';
import {
    resetComposeForm, openComposeOverlay, closeComposeOverlay, isComposeOverlayOpen,
    checkReady, onDeviceChanged, fetchAndAnalyze, startCasting
} from './compose.js';
import { wirePairingControls, hidePinPrompt, isPinPromptOpen } from './pairing.js';
import { wireSubtitleControls } from './subtitles.js';
import { wirePlaybackControls, applyPlayerStatus } from './playback.js';
import { wireRecentControls } from './recent.js';
import { connectWebSocket } from './websocket.js';
import { wireQueueControls } from './queue.js';

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
wirePlaybackControls();
wireRecentControls({ onPick: () => fetchAndAnalyze({ restart: true }) });
wireQueueControls({ onAdd: (ip) => openComposeOverlay({ queueFor: ip }) });

// Proxying is on by default and tucked under Advanced; say so on the
// collapsed section when it's been turned off.
useProxyCheckbox.addEventListener('change', () => {
    advancedNote.classList.toggle('hidden', useProxyCheckbox.checked);
});

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
stopBtn.addEventListener('click', () => {
    const ip = state.activeStreamIp;
    if (!ip) return;
    confirmStop(stopBtn, stopBtnLabel, 'Confirm stop', async () => {
        stopBtn.disabled = true;
        stopBtnLabel.textContent = 'Stopping…';
        await stopStreamByIp(ip);
        stopBtnLabel.textContent = 'Stop';
        stopBtn.disabled = false;
    });
});
addStreamBtn.addEventListener('click', () => openComposeOverlay());
composeOverlay.querySelector('.compose-overlay-backdrop').addEventListener('click', closeComposeOverlay);

// ===== SENDING PAGES FROM ELSEWHERE =====
// A page handed over in the address, as ?url= (the bookmarklet, shortcuts)
// or as a share (share_target in manifest.json: apps often put the link in
// `text`). Taken out of the address so a reload doesn't analyse it again.
function takeSharedUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.size === 0) return null;
    window.history.replaceState(null, '', window.location.pathname);
    return ['url', 'text', 'title']
        .map(name => params.get(name)?.match(/https?:\/\/\S+/i)?.[0])
        .find(Boolean) || null;
}

// Analyse a handed-over page: in the compose form, or over the dashboard
// when streams are already playing.
function analyzeSharedUrl(url) {
    if (state.streams.size > 0) openComposeOverlay();
    videoUrlInput.value = url;
    fetchAndAnalyze({ restart: true });
}

const homecastUrl = `${window.location.origin}/?url=`;
const bookmarklet = `javascript:(()=>{window.open(${JSON.stringify(homecastUrl)}+encodeURIComponent(location.href),'homecast')})()`;
bookmarkletLink.href = bookmarklet;
shareLinkFormat.textContent = `${homecastUrl}…`;
// Clicked here instead of dragged, it would only open HomeCast in HomeCast.
bookmarkletLink.addEventListener('click', (e) => e.preventDefault());

// The shortcut that shows the bookmarks bar, for this computer.
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
bookmarksBarKeys.textContent = isMac ? '\u2318\u21e7B' : 'Ctrl+Shift+B';

// The clipboard API needs HTTPS (or localhost), and HomeCast is usually on a
// plain http:// LAN address: there, copy the way browsers always have.
async function copyText(text) {
    if (window.isSecureContext && navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch { /* refused (permissions): try the old way */ }
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('copy refused');
}

let copiedTimer = null;
bookmarkletCopyBtn.addEventListener('click', async () => {
    try {
        // As written: the link's href property reads back percent-encoded.
        await copyText(bookmarklet);
        bookmarkletCopied.textContent = 'Copied. Paste it as the address of a new bookmark.';
    } catch {
        bookmarkletCopied.textContent = 'Couldn\u2019t copy it. Right-click \u201cCast with HomeCast\u201d and copy the link address instead.';
    }
    bookmarkletCopied.classList.remove('hidden');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => bookmarkletCopied.classList.add('hidden'), 6000);
});

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
connectWebSocket({ onReconnect: resyncStreams });
startDashboardTimers({ onStale: (ip) => setStreamHealth(ip, 'stale') });

// ===== RESTORE AND RESYNC STREAMS =====

// Bring a stream's entry up to date with the server's view of its session.
function applySession(stream, session) {
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

// Match the page to the server: `candidates` ([{ ip, deviceName, deviceType }])
// are checked, those still playing are shown (new entries created, existing
// ones updated in place, keeping their graphs), and entries whose session has
// ended in the meantime are removed.
async function syncStreams(candidates, { activeStreamIp } = {}) {
    // Check every stream's session concurrently — sequential awaits would
    // add one round-trip of latency per stream.
    const sessions = await Promise.all(candidates.map(async (candidate) => ({
        candidate,
        session: await checkSessionStatus(candidate.ip)
    })));

    for (const { candidate: { ip, deviceName, deviceType }, session } of sessions) {
        if (!session.active) {
            if (state.streams.has(ip)) removeStreamEntry(ip);
            continue;
        }
        if (!state.streams.has(ip)) {
            createStreamEntry(ip, findDeviceName(ip) || deviceName || ip, deviceType || session.type || 'chromecast');
        }
        applySession(state.streams.get(ip), session);
        setStreamHealth(ip, 'healthy');
    }

    if (state.streams.size === 0) {
        console.log('[State] No streams are active');
        clearState();
        return;
    }

    const ips = Array.from(state.streams.keys());
    if (!state.streams.has(state.activeStreamIp)) {
        state.activeStreamIp = state.streams.has(activeStreamIp) ? activeStreamIp : ips[0];
    }
    renderStreamBar();
    setMode('dashboard');
    renderDashboard();
    console.log('[State] Showing', ips.length, 'active stream(s)');
}

// After the live connection to the server was lost and is back: whatever
// happened meanwhile (streams ended, started elsewhere, moved on) arrived
// nowhere, so ask.
async function resyncStreams() {
    const known = new Map([...state.streams].map(([ip, s]) => [ip, { ip, deviceName: s.deviceName, deviceType: s.deviceType }]));
    for (const { ip, type, deviceName } of await fetchRunningSessions()) {
        if (!known.has(ip)) known.set(ip, { ip, deviceName, deviceType: type });
    }
    if (known.size > 0) await syncStreams([...known.values()]);
}

// Streams to restore: what the server is playing, plus what this browser
// remembers (its names and which one was on screen).
async function streamsToRestore() {
    let saved = loadState();
    if (saved && Date.now() - saved.timestamp >= 24 * 60 * 60 * 1000) {
        console.log('[State] Saved state is too old, clearing');
        clearState();
        saved = null;
    }
    const known = new Map((saved?.activeStreams || []).map(s => [s.ip, s]));
    for (const { ip, type, deviceName } of await fetchRunningSessions()) {
        if (!known.has(ip)) known.set(ip, { ip, deviceName, deviceType: type });
    }
    return known.size > 0 ? { activeStreams: [...known.values()], activeStreamIp: saved?.activeStreamIp } : null;
}

const sharedUrl = takeSharedUrl();

window.addEventListener('load', () => {
    // Wait a moment for the device list to arrive via WebSocket
    setTimeout(async () => {
        const toRestore = await streamsToRestore();
        if (toRestore) await syncStreams(toRestore.activeStreams, { activeStreamIp: toRestore.activeStreamIp });
        if (sharedUrl) analyzeSharedUrl(sharedUrl);
    }, 1000);
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
