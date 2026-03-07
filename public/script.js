// ===== DOM REFS =====
const app = document.getElementById('app');
const deviceSelect = document.getElementById('device-select');
const manualIpContainer = document.getElementById('manual-ip-container');
const manualIpInput = document.getElementById('manual-ip');
const castBtn = document.getElementById('cast-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status-text');
const statusCard = document.getElementById('status-card');
const streamOptionsContainer = document.getElementById('stream-options');
const statusSpinner = document.getElementById('status-spinner');
const statusSuccess = document.getElementById('status-success');
const statusError = document.getElementById('status-error');
const streamBar = document.getElementById('stream-bar');
const addStreamBtn = document.getElementById('add-stream-btn');
const composePanel = document.getElementById('compose-panel');
const dashboard = document.getElementById('dashboard');
const composeOverlay = document.getElementById('compose-overlay');

// ===== STATE =====
const MAX_HISTORY = 60;

const state = {
    mode: 'setup',              // 'setup' | 'dashboard'
    devices: [],                // from WebSocket
    streams: new Map(),         // deviceIp -> { deviceName, stats, rateHistory, delayHistory, health, bufferHealth }
    activeStreamIp: null,       // currently viewed stream
    compose: {
        analyzedStreams: [],
        status: null
    }
};

let csrfToken = null;

// ===== CACHED GRAPH COLORS =====
const graphColors = {};
function refreshGraphColors() {
    const s = getComputedStyle(document.documentElement);
    graphColors.rate = s.getPropertyValue('--graph-rate').trim();
    graphColors.rateFill = s.getPropertyValue('--graph-rate-fill').trim();
    graphColors.delay = s.getPropertyValue('--graph-delay').trim();
    graphColors.delayFill = s.getPropertyValue('--graph-delay-fill').trim();
    graphColors.grid = s.getPropertyValue('--graph-grid').trim();
}
refreshGraphColors();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    refreshGraphColors();
    // Redraw active graphs with new colors
    const stream = state.streams.get(state.activeStreamIp);
    if (stream) {
        drawRateGraph(stream.rateHistory);
        drawDelayGraph(stream.delayHistory);
    }
});

// ===== CSRF =====
async function fetchCsrfToken() {
    try {
        const res = await fetch('/api/csrf-token');
        if (res.ok) {
            const data = await res.json();
            csrfToken = data.token;
            console.log('[CSRF] Token acquired');
        }
    } catch {
        console.log('[CSRF] Token endpoint not available (CSRF may be disabled)');
    }
}
fetchCsrfToken();

// ===== STATE PERSISTENCE =====
const STATE_KEY = 'homecast_state';

function loadState() {
    try {
        const saved = localStorage.getItem(STATE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            console.log('[State] Loaded persisted state:', parsed);
            return parsed;
        }
    } catch (e) {
        console.error('[State] Failed to load state:', e);
    }
    return null;
}

function saveState() {
    try {
        const activeStreams = [];
        state.streams.forEach((stream, ip) => {
            activeStreams.push({ ip, deviceName: stream.deviceName });
        });
        const saved = {
            activeStreams,
            activeStreamIp: state.activeStreamIp,
            timestamp: Date.now()
        };
        localStorage.setItem(STATE_KEY, JSON.stringify(saved));
        console.log('[State] Saved state:', saved);
    } catch (e) {
        console.error('[State] Failed to save state:', e);
    }
}

function clearState() {
    try {
        localStorage.removeItem(STATE_KEY);
        console.log('[State] Cleared persisted state');
    } catch (e) {
        console.error('[State] Failed to clear state:', e);
    }
}

// ===== SESSION CHECK =====
async function checkSessionStatus(deviceIp) {
    try {
        const res = await fetch(`/api/session/${encodeURIComponent(deviceIp)}`);
        const data = await res.json();
        console.log(`[State] Session check for ${deviceIp}:`, data.active ? 'active' : 'inactive');
        return data;
    } catch (e) {
        console.error('[State] Failed to check session status:', e);
        return { active: false };
    }
}

// ===== STREAM MANAGEMENT =====
const STALE_TIMEOUT = 15000; // 15s without stats = stale

function createStreamEntry(ip, deviceName) {
    state.streams.set(ip, {
        deviceName: deviceName || ip,
        stats: {},
        rateHistory: [],
        delayHistory: [],
        health: 'healthy',
        bufferHealth: null,
        lastStatsAt: Date.now()
    });
}

function removeStreamEntry(ip) {
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

function switchToStream(ip) {
    if (!state.streams.has(ip)) return;
    state.activeStreamIp = ip;
    renderStreamBar();
    renderDashboard();
    saveState();
}

// ===== MODE MANAGEMENT =====
function setMode(mode) {
    state.mode = mode;
    app.setAttribute('data-mode', mode);

    if (mode === 'setup') {
        state.activeStreamIp = null;
        // Reset compose form
        resetComposeForm();
        // Remove overlay state if active
        closeComposeOverlay();
    }

    if (mode === 'dashboard' && state.activeStreamIp) {
        renderDashboard();
    }

    saveState();
}

function resetComposeForm() {
    document.getElementById('video-url').value = '';
    document.getElementById('resolved-url-container').classList.add('hidden');
    streamOptionsContainer.innerHTML = '';
    statusCard.classList.add('hidden');
    castBtn.disabled = true;
    state.compose.analyzedStreams = [];
    state.compose.status = null;
}

// ===== STREAM BAR RENDERING =====
function renderStreamBar() {
    // Remove existing pills (keep the add button)
    const existingPills = streamBar.querySelectorAll('.stream-pill:not(.add-pill)');
    existingPills.forEach(pill => pill.remove());

    // Add a pill for each stream
    state.streams.forEach((stream, ip) => {
        const pill = document.createElement('button');
        pill.className = `stream-pill${ip === state.activeStreamIp ? ' active' : ''}`;
        pill.dataset.ip = ip;

        const dot = document.createElement('span');
        dot.className = `pill-dot${stream.health !== 'healthy' ? ' ' + stream.health : ''}`;

        const name = document.createElement('span');
        name.textContent = stream.deviceName;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'pill-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Stop stream';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            stopStreamByIp(ip);
        });

        pill.appendChild(dot);
        pill.appendChild(name);
        pill.appendChild(closeBtn);

        pill.addEventListener('click', () => switchToStream(ip));

        // Insert before the add button
        streamBar.insertBefore(pill, addStreamBtn);
    });
}

// ===== DASHBOARD RENDERING =====
function renderDashboard() {
    const stream = state.streams.get(state.activeStreamIp);
    if (!stream) return;

    // Update device name
    document.getElementById('dashboard-device-name').textContent = stream.deviceName;

    // Update health indicator
    updateConnectionHealthUI(stream.health);

    // Update stats
    if (stream.stats && Object.keys(stream.stats).length > 0) {
        renderStats(stream.stats);
    } else {
        resetDashboardStats();
    }

    // Update buffer health
    if (stream.bufferHealth) {
        renderBufferHealth(stream.bufferHealth);
    }

    // Redraw graphs from stored history
    requestAnimationFrame(() => {
        drawRateGraph(stream.rateHistory);
        drawDelayGraph(stream.delayHistory);
    });
}

function renderStats(stats) {
    let resolutionDisplay = stats.resolution || 'Unknown';
    if (stats.bitrate && (!stats.resolution || stats.resolution === 'Live Stream')) {
        if (stats.bitrate >= 8000) resolutionDisplay = 'Live Stream (4K est.)';
        else if (stats.bitrate >= 5000) resolutionDisplay = 'Live Stream (1080p est.)';
        else if (stats.bitrate >= 2500) resolutionDisplay = 'Live Stream (720p est.)';
        else if (stats.bitrate >= 1000) resolutionDisplay = 'Live Stream (480p est.)';
        else resolutionDisplay = 'Live Stream';
    }

    let bitrateDisplay = '- Kbps';
    if (stats.bitrate) {
        bitrateDisplay = stats.bitrate >= 1000
            ? `${(stats.bitrate / 1000).toFixed(1)} Mbps`
            : `${stats.bitrate} Kbps`;
    }

    let transferredDisplay = '0 MB';
    if (stats.totalMB) {
        const mb = parseFloat(stats.totalMB);
        transferredDisplay = mb >= 1000
            ? `${(mb / 1024).toFixed(2)} GB`
            : `${mb.toFixed(2)} MB`;
    }

    let durationDisplay = '0s';
    if (stats.duration) {
        const totalSeconds = parseInt(stats.duration);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) durationDisplay = `${hours}h ${minutes}m ${seconds}s`;
        else if (minutes > 0) durationDisplay = `${minutes}m ${seconds}s`;
        else durationDisplay = `${seconds}s`;
    }

    document.getElementById('stat-resolution').textContent = resolutionDisplay;
    document.getElementById('stat-bitrate').textContent = bitrateDisplay;
    document.getElementById('stat-transferred').textContent = transferredDisplay;
    document.getElementById('stat-segments').textContent = stats.segmentCount || 0;
    document.getElementById('stat-duration').textContent = durationDisplay;
    document.getElementById('stat-cache').textContent = stats.cacheHits || 0;
    document.getElementById('stat-framerate').textContent = stats.frameRate
        ? `${Math.round(stats.frameRate)} FPS`
        : '-';
}

function resetDashboardStats() {
    document.getElementById('stat-resolution').textContent = 'Unknown';
    document.getElementById('stat-framerate').textContent = '-';
    document.getElementById('stat-bitrate').textContent = '- Kbps';
    document.getElementById('stat-transferred').textContent = '0 MB';
    document.getElementById('stat-segments').textContent = '0';
    document.getElementById('stat-duration').textContent = '0s';
    document.getElementById('stat-cache').textContent = '0';
    document.getElementById('stat-buffer-health').textContent = '-';
    document.getElementById('stat-buffer-health').style.color = '';
}

function renderBufferHealth(bufferHealth) {
    if (!bufferHealth) return;
    const { healthScore, bufferingEvents, totalBufferingTime } = bufferHealth;
    const el = document.getElementById('stat-buffer-health');
    if (!el) return;

    let text = `${healthScore}%`;
    if (bufferingEvents > 0) {
        text += ` (${bufferingEvents} events, ${totalBufferingTime}s)`;
    }
    el.textContent = text;

    if (healthScore >= 95) el.style.color = '#34d399';
    else if (healthScore >= 85) el.style.color = '#fbbf24';
    else el.style.color = '#f87171';
}

function updateConnectionHealthUI(healthState) {
    const dot = document.getElementById('health-dot');
    const text = document.getElementById('health-text');
    if (!dot || !text) return;

    dot.className = 'health-dot';
    if (healthState) dot.classList.add(healthState);

    // Map 'stale' to the 'degraded' CSS class for the yellow dot
    if (healthState === 'stale') dot.classList.add('degraded');

    const messages = {
        healthy: 'Connected',
        stale: 'No data received',
        degraded: 'Connection unstable',
        unhealthy: 'Connection lost',
        reconnecting: 'Reconnecting...',
        failed: 'Connection failed'
    };
    text.textContent = messages[healthState] || 'Connected';
}

// ===== COMPOSE OVERLAY =====
function openComposeOverlay() {
    resetComposeForm();
    // Filter out devices that already have active streams
    filterDeviceDropdown();
    composeOverlay.classList.remove('hidden');
    composePanel.classList.add('overlay-active');
}

function closeComposeOverlay() {
    composeOverlay.classList.add('hidden');
    composePanel.classList.remove('overlay-active');
}

function filterDeviceDropdown() {
    const options = deviceSelect.querySelectorAll('option');
    options.forEach(opt => {
        if (opt.value && opt.value !== '' && opt.value !== 'manual') {
            opt.disabled = state.streams.has(opt.value);
        }
    });
}

// ===== GRAPH DRAWING =====
function drawRateGraph(rateHistory) {
    const canvas = document.getElementById('rate-graph');
    if (!canvas) return;

    const rate = rateHistory.length > 0 ? rateHistory[rateHistory.length - 1] : 0;
    document.getElementById('graph-current-rate').textContent = `${rate} KB/s`;

    canvas.width = canvas.clientWidth;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (rateHistory.length < 2) return;

    const validRates = rateHistory.filter(r => !isNaN(r) && r !== null && r !== undefined);
    if (validRates.length === 0) return;

    const maxRate = Math.max(...validRates, 100);
    const minRate = 0;

    const yLabelsDiv = document.getElementById('graph-y-labels');
    if (yLabelsDiv) {
        const fmt = (r) => r >= 1000 ? `${(r / 1000).toFixed(1)} MB/s` : `${Math.round(r)} KB/s`;
        yLabelsDiv.innerHTML = `<span>${fmt(maxRate)}</span><span>${fmt(maxRate * 0.5)}</span><span>${fmt(minRate)}</span>`;
    }

    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;
    const dataPoints = rateHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Grid
    ctx.strokeStyle = graphColors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Line
    ctx.strokeStyle = graphColors.rate;
    ctx.lineWidth = 2;
    ctx.beginPath();
    rateHistory.forEach((r, i) => {
        const x = startX + (i * xStep);
        const y = height - padding - (r / maxRate * graphHeight);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = graphColors.rateFill;
    ctx.fill();
}

function drawDelayGraph(delayHistory) {
    const section = document.getElementById('delay-graph-section');
    if (!section) return;

    if (!delayHistory || delayHistory.length === 0) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    const delay = delayHistory[delayHistory.length - 1] || 0;
    document.getElementById('graph-current-delay').textContent = `${delay.toFixed(1)}s`;

    const canvas = document.getElementById('delay-graph');
    if (!canvas) return;

    canvas.width = canvas.clientWidth;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (delayHistory.length < 2) return;

    const validDelays = delayHistory.filter(d => !isNaN(d) && d !== null && d !== undefined);
    if (validDelays.length === 0) return;

    const maxDelay = Math.max(...validDelays, 1);

    const yLabelsDiv = document.getElementById('delay-y-labels');
    if (yLabelsDiv) {
        yLabelsDiv.innerHTML = `<span>${maxDelay.toFixed(1)}s</span><span>${(maxDelay * 0.5).toFixed(1)}s</span><span>0.0s</span>`;
    }

    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;
    const dataPoints = delayHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Grid
    ctx.strokeStyle = graphColors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Line
    ctx.strokeStyle = graphColors.delay;
    ctx.lineWidth = 2;
    ctx.beginPath();
    delayHistory.forEach((d, i) => {
        const x = startX + (i * xStep);
        const y = height - padding - (d / maxDelay * graphHeight);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = graphColors.delayFill;
    ctx.fill();
}

// ===== WEBSOCKET =====
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'devices') {
        state.devices = data.devices;
        updateDeviceList(data.devices);
    }

    if (data.type === 'status') {
        updateStatus(data.status, 'info');
    }

    if (data.type === 'streamStats') {
        const stream = state.streams.get(data.deviceIp);
        if (!stream) return;

        // Store stats
        stream.stats = data.stats;
        stream.lastStatsAt = Date.now();

        // Clear stale state if it was showing
        if (stream.health === 'stale') {
            stream.health = 'healthy';
            renderStreamBar();
        }

        // Update rate history
        const rate = parseFloat(data.stats.transferRate) || 0;
        stream.rateHistory.push(rate);
        if (stream.rateHistory.length > MAX_HISTORY) stream.rateHistory.shift();

        // Update delay history
        if (data.stats.delay !== undefined && data.stats.delay > 0) {
            const delay = parseFloat(data.stats.delay) || 0;
            stream.delayHistory.push(delay);
            if (stream.delayHistory.length > MAX_HISTORY) stream.delayHistory.shift();
        }

        // Update buffer health
        if (data.bufferHealth) {
            stream.bufferHealth = data.bufferHealth;
        }

        // Only re-render if this is the active stream
        if (data.deviceIp === state.activeStreamIp) {
            renderStats(data.stats);
            if (data.bufferHealth) renderBufferHealth(data.bufferHealth);
            drawRateGraph(stream.rateHistory);
            if (stream.delayHistory.length > 0) drawDelayGraph(stream.delayHistory);
        }
    }

    if (data.type === 'playerStatus') {
        const ip = data.deviceIp;
        const stream = state.streams.get(ip);
        const playerState = data.status.playerState;

        if (data.bufferHealth && stream) {
            stream.bufferHealth = data.bufferHealth;
        }

        if (playerState === 'PLAYING' || playerState === 'BUFFERING' || playerState === 'PAUSED') {
            // Ensure stream entry exists (e.g., after page reload)
            if (!stream && ip) {
                const deviceName = findDeviceName(ip);
                createStreamEntry(ip, deviceName);
                if (state.mode === 'setup') {
                    state.activeStreamIp = ip;
                    setMode('dashboard');
                }
                renderStreamBar();
            }

            if (ip === state.activeStreamIp) {
                if (playerState === 'PLAYING') {
                    updateStatus('Now Playing', 'success');
                } else if (playerState === 'BUFFERING') {
                    updateStatus('Buffering...', 'loading');
                } else if (playerState === 'PAUSED') {
                    updateStatus('Paused', 'info');
                }
            }
        } else if (playerState === 'IDLE') {
            if (stream) {
                removeStreamEntry(ip);
            }
        }
    }

    if (data.type === 'connectionHealth') {
        const stream = state.streams.get(data.deviceIp);
        if (stream) {
            stream.health = data.state;
            // Update pill dot
            const pill = streamBar.querySelector(`.stream-pill[data-ip="${data.deviceIp}"]`);
            if (pill) {
                const dot = pill.querySelector('.pill-dot');
                if (dot) {
                    dot.className = `pill-dot${data.state !== 'healthy' ? ' ' + data.state : ''}`;
                }
            }
            // Update dashboard if active
            if (data.deviceIp === state.activeStreamIp) {
                updateConnectionHealthUI(data.state, data.message);
            }
        }
    }

    if (data.type === 'streamRecovery') {
        if (data.deviceIp === state.activeStreamIp) {
            handleStreamRecovery(data);
        }
    }
};

ws.onerror = () => {
    console.warn('WebSocket connection failed, falling back to polling');
};

// ===== DEVICE LIST =====
function updateDeviceList(devices) {
    const currentVal = deviceSelect.value;
    deviceSelect.innerHTML = '<option value="" disabled>Select Device</option>';

    if (devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.innerText = 'No devices found';
        deviceSelect.appendChild(opt);
    } else {
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.ip;
            opt.innerText = `${d.name} (${d.ip})`;
            deviceSelect.appendChild(opt);
        });
    }

    const manualOpt = document.createElement('option');
    manualOpt.value = 'manual';
    manualOpt.innerText = 'Enter IP Manually...';
    deviceSelect.appendChild(manualOpt);

    if (currentVal && (devices.find(d => d.ip === currentVal) || currentVal === 'manual')) {
        deviceSelect.value = currentVal;
    }
    toggleManualInput();
}

function findDeviceName(ip) {
    const device = state.devices.find(d => d.ip === ip);
    return device ? device.name : ip;
}

// ===== FORM HANDLERS =====
function toggleManualInput() {
    const isManual = deviceSelect.value === 'manual';
    if (isManual) {
        manualIpContainer.classList.remove('hidden');
    } else {
        manualIpContainer.classList.add('hidden');
    }
    if (isManual && document.activeElement !== manualIpInput) {
        manualIpInput.focus();
    }
    checkReady();
}

function checkReady() {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const selectedStream = document.querySelector('input[name="stream-select"]:checked');
    castBtn.disabled = !(ip && selectedStream);
}

async function fetchAndAnalyze() {
    const url = document.getElementById('video-url').value.trim();
    if (!url) {
        alert('Please enter a URL first');
        return;
    }

    updateStatus('Analyzing URL...', 'loading');
    statusCard.classList.remove('hidden');

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        const res = await fetch('/api/extract', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url })
        });

        const data = await res.json();

        if (data.videos && data.videos.length > 0) {
            state.compose.analyzedStreams = data.videos;
            displayStreamOptions(data.videos);
            updateStatus(`Found ${data.videos.length} stream${data.videos.length > 1 ? 's' : ''}`, 'success');
            checkReady();
        } else {
            updateStatus('No video found at this URL', 'error');
        }
    } catch (e) {
        console.error('Extract error:', e);
        updateStatus('Failed to analyze URL', 'error');
    }
}

function displayStreamOptions(videos) {
    streamOptionsContainer.innerHTML = '';
    document.getElementById('streams-found-text').textContent =
        videos.length > 1 ? `${videos.length} streams found:` : 'Video found:';
    document.getElementById('resolved-url-container').classList.remove('hidden');

    videos.forEach((video, index) => {
        const option = document.createElement('div');
        option.className = `stream-option${video.unsupported ? ' stream-option-unsupported' : ''}`;

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'stream-select';
        radio.value = index;
        radio.id = `stream-${index}`;
        radio.disabled = video.unsupported;
        if (index === 0 && !video.unsupported) radio.checked = true;

        const label = document.createElement('label');
        label.setAttribute('for', `stream-${index}`);
        label.className = 'stream-option-content';
        label.style.cursor = video.unsupported ? 'not-allowed' : 'pointer';

        const urlSpan = document.createElement('div');
        urlSpan.className = 'stream-option-url';
        urlSpan.textContent = video.url;

        const badgesContainer = document.createElement('div');
        badgesContainer.className = 'stream-option-badges';

        const typeSpan = document.createElement('span');
        typeSpan.className = `stream-option-type ${video.type}`;
        typeSpan.textContent = video.type.toUpperCase();
        if (video.unsupported) typeSpan.textContent += ' (UNSUPPORTED)';

        badgesContainer.appendChild(typeSpan);

        if (video.resolution) {
            const resSpan = document.createElement('span');
            resSpan.className = 'stream-option-type resolution';
            resSpan.textContent = video.resolution;
            badgesContainer.appendChild(resSpan);
        }

        label.appendChild(urlSpan);
        label.appendChild(badgesContainer);

        option.appendChild(radio);
        option.appendChild(label);

        if (!video.unsupported) {
            option.onclick = () => {
                radio.checked = true;
                checkReady();
            };
        }

        streamOptionsContainer.appendChild(option);
    });
}

// ===== CASTING =====
async function startCasting() {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const selectedRadio = document.querySelector('input[name="stream-select"]:checked');

    if (!ip || !selectedRadio) return;

    const selectedIndex = parseInt(selectedRadio.value);
    const selectedStream = state.compose.analyzedStreams[selectedIndex];
    const url = selectedStream.url;
    const referer = selectedStream.referer;
    const proxy = document.getElementById('use-proxy').checked;

    castBtn.disabled = true;
    updateStatus('Connecting to Chromecast...', 'loading');

    try {
        const castHeaders = { 'Content-Type': 'application/json' };
        if (csrfToken) castHeaders['X-CSRF-Token'] = csrfToken;
        const res = await fetch('/api/cast', {
            method: 'POST',
            headers: castHeaders,
            body: JSON.stringify({ ip, url, proxy, referer })
        });

        const data = await res.json();

        if (data.error) {
            throw new Error(data.error);
        }

        if (data.troubleshooting) {
            updateStatus(`Cast failed: ${data.error}`, 'error');
            console.error('Troubleshooting:', data.troubleshooting);
            castBtn.disabled = false;
        } else {
            // Success: create stream entry and transition to dashboard
            const deviceName = findDeviceName(ip);
            createStreamEntry(ip, deviceName);
            state.activeStreamIp = ip;
            renderStreamBar();

            // Close overlay if open, then switch to dashboard
            closeComposeOverlay();
            setMode('dashboard');

            updateStatus('Casting started!', 'success');
            saveState();
        }
    } catch (e) {
        console.error('Cast error:', e);
        updateStatus(`Cast failed: ${e.message}`, 'error');
        castBtn.disabled = false;
    }
}

async function stopStreamByIp(ip) {
    try {
        const stopHeaders = { 'Content-Type': 'application/json' };
        if (csrfToken) stopHeaders['X-CSRF-Token'] = csrfToken;
        const response = await fetch('/api/stop', {
            method: 'POST',
            headers: stopHeaders,
            body: JSON.stringify({ ip })
        });

        const data = await response.json();

        if (response.ok) {
            removeStreamEntry(ip);
        } else {
            console.error('Stop error:', data.error);
        }
    } catch (err) {
        console.error('Failed to stop:', err.message);
    }
}

async function stopCasting() {
    if (!state.activeStreamIp) return;
    stopBtn.disabled = true;
    await stopStreamByIp(state.activeStreamIp);
    stopBtn.disabled = false;
}

// ===== STATUS =====
function updateStatus(message, type = 'info') {
    statusText.innerText = message;
    statusSpinner.classList.add('hidden');
    statusSuccess.classList.add('hidden');
    statusError.classList.add('hidden');

    if (type === 'loading') statusSpinner.classList.remove('hidden');
    else if (type === 'success') statusSuccess.classList.remove('hidden');
    else if (type === 'error') statusError.classList.remove('hidden');
}

function handleStreamRecovery(data) {
    console.log('[Recovery]', data);
    if (data.status === 'attempting') {
        updateStatus(`Recovering stream (attempt ${data.attempt}/${data.maxAttempts})...`, 'loading');
    } else if (data.status === 'success') {
        updateStatus('Stream recovered successfully', 'success');
    } else if (data.status === 'failed') {
        updateStatus(`Recovery attempt ${data.attempt} failed`, 'error');
    } else if (data.status === 'giveup') {
        updateStatus('Stream recovery failed - please restart manually', 'error');
    }
}

// ===== HELP MODAL =====
function closeHelp() {
    document.getElementById('help-modal').classList.add('hidden');
}

// ===== EVENT LISTENERS =====
document.getElementById('analyze-btn').addEventListener('click', fetchAndAnalyze);
castBtn.addEventListener('click', startCasting);
stopBtn.addEventListener('click', stopCasting);
deviceSelect.addEventListener('change', toggleManualInput);
manualIpInput.addEventListener('input', checkReady);

addStreamBtn.addEventListener('click', openComposeOverlay);

document.querySelector('.compose-overlay-backdrop')?.addEventListener('click', closeComposeOverlay);

document.getElementById('help-close-btn')?.addEventListener('click', closeHelp);
document.getElementById('help-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'help-modal') closeHelp();
});

// ===== INITIALIZATION =====
window.addEventListener('load', async () => {
    console.log('[State] Page loaded, checking for persisted state...');

    const savedState = loadState();
    if (savedState && savedState.activeStreams && savedState.activeStreams.length > 0) {
        const age = Date.now() - savedState.timestamp;
        if (age < 24 * 60 * 60 * 1000) {
            console.log('[State] Found recent saved state, checking sessions...');

            // Wait a moment for device list to arrive via WebSocket
            setTimeout(async () => {
                let anyActive = false;
                for (const { ip, deviceName } of savedState.activeStreams) {
                    const session = await checkSessionStatus(ip);
                    if (session.active) {
                        const name = findDeviceName(ip) || deviceName || ip;
                        createStreamEntry(ip, name);
                        if (session.stats) {
                            state.streams.get(ip).stats = session.stats;
                        }
                        anyActive = true;
                    }
                }

                if (anyActive) {
                    // Restore active stream IP or pick first
                    const ips = Array.from(state.streams.keys());
                    if (savedState.activeStreamIp && state.streams.has(savedState.activeStreamIp)) {
                        state.activeStreamIp = savedState.activeStreamIp;
                    } else {
                        state.activeStreamIp = ips[0];
                    }
                    renderStreamBar();
                    setMode('dashboard');
                    console.log('[State] Restored', ips.length, 'active stream(s)');
                } else {
                    console.log('[State] No saved sessions are still active');
                    clearState();
                }
            }, 1000);
        } else {
            console.log('[State] Saved state is too old, clearing');
            clearState();
        }
    }
});

// ===== STALENESS CHECK =====
setInterval(() => {
    const now = Date.now();
    state.streams.forEach((stream, ip) => {
        if (stream.health !== 'stale' && stream.lastStatsAt && (now - stream.lastStatsAt > STALE_TIMEOUT)) {
            stream.health = 'stale';
            console.log(`[Health] Stream ${ip} marked stale (no stats for ${STALE_TIMEOUT / 1000}s)`);
            // Update pill dot
            const pill = streamBar.querySelector(`.stream-pill[data-ip="${ip}"]`);
            if (pill) {
                const dot = pill.querySelector('.pill-dot');
                if (dot) dot.className = 'pill-dot degraded';
            }
            // Update dashboard if active
            if (ip === state.activeStreamIp) {
                updateConnectionHealthUI('stale');
            }
        }
    });
}, 5000);

// Initial device poll
fetch('/api/devices')
    .then(r => r.json())
    .then(updateDeviceList)
    .catch(err => {
        console.error('Failed to fetch devices:', err);
        updateDeviceList([]);
    });
