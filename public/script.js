const deviceSelect = document.getElementById('device-select');
const manualIpContainer = document.getElementById('manual-ip-container');
const manualIpInput = document.getElementById('manual-ip');
const castBtn = document.getElementById('cast-btn');
const stopBtn = document.getElementById('stop-btn');
const statusText = document.getElementById('status-text');
const statusCard = document.getElementById('status-card');
const resolvedUrlSpan = document.getElementById('resolved-url');
const statusSpinner = document.getElementById('status-spinner');
const statusSuccess = document.getElementById('status-success');
const statusError = document.getElementById('status-error');

let currentReferer = '';
let currentDeviceIp = null;
let _isCasting = false;

// Transfer rate history for graph (last 60 data points = 60 seconds)
const rateHistory = [];
const delayHistory = [];
const MAX_HISTORY = 60;

// WebSocket for live updates
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'devices') updateDeviceList(data.devices);
    if (data.type === 'status') {
        updateStatus(data.status, 'info');
    }
    if (data.type === 'streamStats') {
        updateStreamStats(data.stats);
        // Update delay graph at same rate as transfer rate (when segments complete)
        if (data.stats.delay !== undefined && data.stats.delay > 0) {
            updateDelayGraph(data.stats.delay);
        }
    }
    if (data.type === 'playerStatus') {
        const state = data.status.playerState;
        const idleReason = data.status.idleReason;
        let message = `Playback: ${state}`;
        let type = 'info';

        if (state === 'PLAYING') {
            message = '🎬 Now Playing';
            type = 'success';
            // Show stats card when playing
            document.getElementById('stream-stats-card').style.display = 'block';
            // Show stop button
            document.getElementById('stop-btn').style.display = 'inline-flex';
            document.getElementById('cast-btn').style.display = 'none';
        } else if (state === 'BUFFERING') {
            message = '⏳ Buffering...';
            type = 'loading';
            // Show stop button while buffering
            document.getElementById('stop-btn').style.display = 'inline-flex';
            document.getElementById('cast-btn').style.display = 'none';
        } else if (state === 'PAUSED') {
            message = '⏸ Paused';
            type = 'info';
            // Show stop button when paused
            document.getElementById('stop-btn').style.display = 'inline-flex';
            document.getElementById('cast-btn').style.display = 'none';
        } else if (state === 'IDLE') {
            // Check if it's an error or normal stop
            if (idleReason === 'ERROR') {
                message = '❌ Playback Error';
                type = 'error';
            } else {
                message = '⏹ Stopped';
                type = 'info';
            }
            // Hide stats card and clear graph when stopped/error
            document.getElementById('stream-stats-card').style.display = 'none';
            rateHistory.length = 0; // Clear history
            delayHistory.length = 0; // Clear delay history
            // Show cast button, hide stop button
            document.getElementById('cast-btn').style.display = 'inline-flex';
            document.getElementById('stop-btn').style.display = 'none';
        }

        updateStatus(message, type);
    }
};

ws.onerror = () => {
    console.warn('WebSocket connection failed, falling back to polling');
};

deviceSelect.addEventListener('change', toggleManualInput);
manualIpInput.addEventListener('input', checkReady);

function toggleManualInput() {
    const isManual = deviceSelect.value === 'manual';
    console.log('[ManualIP] Toggle called, value:', deviceSelect.value, 'isManual:', isManual);
    manualIpContainer.style.display = isManual ? 'block' : 'none';
    if (isManual && document.activeElement !== manualIpInput) {
        manualIpInput.focus();
    }
    checkReady();
}

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

// Expose to global scope for HTML onclick handlers
window.fetchAndAnalyze = async function () {
    const url = document.getElementById('video-url').value.trim();
    if (!url) {
        alert('Please enter a URL first');
        return;
    }

    updateStatus('🔍 Analyzing URL...', 'loading');
    statusCard.style.display = 'block';

    try {
        const res = await fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await res.json();

        if (data.videoUrl) {
            resolvedUrlSpan.innerText = data.videoUrl;
            currentReferer = data.referer || '';
            document.getElementById('resolved-url-container').style.display = 'flex';
            updateStatus('✅ Video found! Ready to cast', 'success');
            checkReady();
        } else {
            updateStatus('❌ No video found at this URL', 'error');
        }
    } catch (e) {
        console.error('Extract error:', e);
        updateStatus('❌ Failed to analyze URL', 'error');
    }
};

function checkReady() {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const url = resolvedUrlSpan.innerText;
    castBtn.disabled = !(ip && url);
}

// Expose to global scope for HTML onclick handlers
window.startCasting = async function () {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const url = resolvedUrlSpan.innerText;
    const proxy = document.getElementById('use-proxy').checked;

    if (!ip || !url) return;

    castBtn.disabled = true;
    updateStatus('📡 Connecting to Chromecast...', 'loading');

    try {
        const res = await fetch('/api/cast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, url, proxy, referer: currentReferer })
        });

        const data = await res.json();

        if (data.error) {
            throw new Error(data.error);
        }

        if (data.troubleshooting) {
            updateStatus(`❌ ${data.error}`, 'error');
            console.error('Troubleshooting:', data.troubleshooting);
            castBtn.disabled = false;
        } else {
            updateStatus('✅ Casting started!', 'success');
            currentDeviceIp = ip;
            _isCasting = true;
            castBtn.style.display = 'none';
            stopBtn.style.display = 'block';
        }
    } catch (e) {
        console.error('Cast error:', e);
        updateStatus(`❌ Cast failed: ${e.message}`, 'error');
        castBtn.disabled = false;
    }
};

// Expose stop function to global scope
window.stopCasting = async function () {
    if (!currentDeviceIp) {
        updateStatus('No active casting session', 'error');
        return;
    }

    stopBtn.disabled = true;
    updateStatus('Stopping playback...', 'loading');

    try {
        const response = await fetch('/api/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip: currentDeviceIp })
        });

        const data = await response.json();

        if (response.ok) {
            updateStatus('⏹️ Playback stopped', 'success');
            _isCasting = false;
            currentDeviceIp = null;
            castBtn.style.display = 'block';
            castBtn.disabled = false;
            stopBtn.style.display = 'none';
            stopBtn.disabled = false;
        } else {
            updateStatus(`Error: ${data.error}`, 'error');
            stopBtn.disabled = false;
        }
    } catch (err) {
        updateStatus(`Failed to stop: ${err.message}`, 'error');
        stopBtn.disabled = false;
    }
};

function updateStatus(message, type = 'info') {
    statusText.innerText = message;

    // Hide all icons
    statusSpinner.style.display = 'none';
    statusSuccess.style.display = 'none';
    statusError.style.display = 'none';

    // Show appropriate icon
    if (type === 'loading') {
        statusSpinner.style.display = 'block';
    } else if (type === 'success') {
        statusSuccess.style.display = 'block';
    } else if (type === 'error') {
        statusError.style.display = 'block';
    }
}

function updateStreamStats(stats) {
    // Show resolution or estimate from bitrate
    let resolutionDisplay = stats.resolution || 'Unknown';
    if (stats.bitrate && (!stats.resolution || stats.resolution === 'Live Stream')) {
        // Estimate quality from bitrate
        if (stats.bitrate >= 8000) {
            resolutionDisplay = 'Live Stream (4K est.)';
        } else if (stats.bitrate >= 5000) {
            resolutionDisplay = 'Live Stream (1080p est.)';
        } else if (stats.bitrate >= 2500) {
            resolutionDisplay = 'Live Stream (720p est.)';
        } else if (stats.bitrate >= 1000) {
            resolutionDisplay = 'Live Stream (480p est.)';
        } else {
            resolutionDisplay = 'Live Stream';
        }
    }

    document.getElementById('stat-resolution').textContent = resolutionDisplay;
    document.getElementById('stat-bitrate').textContent = stats.bitrate ? `${stats.bitrate} Kbps` : '- Kbps';
    document.getElementById('stat-transferred').textContent = `${stats.totalMB} MB`;
    document.getElementById('stat-segments').textContent = stats.segmentCount || 0;
    document.getElementById('stat-duration').textContent = `${stats.duration}s`;
    document.getElementById('stat-cache').textContent = stats.cacheHits || 0;

    // Update graph
    updateRateGraph(stats.transferRate);
}

function updateRateGraph(currentRate) {
    // Add current rate to history
    rateHistory.push(currentRate);

    // Keep only last 60 data points
    if (rateHistory.length > MAX_HISTORY) {
        rateHistory.shift();
    }

    // Update current rate display
    document.getElementById('graph-current-rate').textContent = `${currentRate} KB/s`;

    // Draw graph
    const canvas = document.getElementById('rate-graph');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Don't draw if no data
    if (rateHistory.length < 2) return;

    // Calculate scale
    const maxRate = Math.max(...rateHistory, 100); // Minimum scale of 100 KB/s
    const minRate = 0;

    // Update Y-axis labels
    const yLabelsDiv = document.getElementById('graph-y-labels');
    if (yLabelsDiv) {
        const formatRate = (rate) => {
            if (rate >= 1000) {
                return `${(rate / 1000).toFixed(1)} MB/s`;
            }
            return `${Math.round(rate)} KB/s`;
        };
        yLabelsDiv.innerHTML = `
            <span>${formatRate(maxRate)}</span>
            <span>${formatRate(maxRate * 0.5)}</span>
            <span>${formatRate(minRate)}</span>
        `;
    }
    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;

    // Calculate spacing based on actual data points
    const dataPoints = rateHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);

    // Calculate starting X position (align right, grow left)
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Draw grid lines
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Draw the line graph (oldest to newest, ending at right edge)
    ctx.strokeStyle = '#0066cc';
    ctx.lineWidth = 2;
    ctx.beginPath();

    rateHistory.forEach((rate, index) => {
        const x = startX + (index * xStep);
        const y = height - padding - (rate / maxRate * graphHeight);

        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();

    // Draw filled area under the line
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 102, 204, 0.1)';
    ctx.fill();
}

function updateDelayGraph(currentDelay) {
    // Show the delay graph container
    const container = document.getElementById('delay-graph-container');
    if (container) {
        container.style.display = 'block';
    }

    // Add current delay to history
    delayHistory.push(currentDelay);

    // Keep only last 60 data points
    if (delayHistory.length > MAX_HISTORY) {
        delayHistory.shift();
    }

    // Update current delay display
    document.getElementById('graph-current-delay').textContent = `${currentDelay.toFixed(1)}s`;

    // Draw graph
    const canvas = document.getElementById('delay-graph');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Don't draw if no data
    if (delayHistory.length < 2) return;

    // Calculate scale
    const maxDelay = Math.max(...delayHistory, 1); // Minimum scale of 1 second
    const minDelay = 0;

    // Update Y-axis labels
    const yLabelsDiv = document.getElementById('delay-y-labels');
    if (yLabelsDiv) {
        yLabelsDiv.innerHTML = `
            <span>${maxDelay.toFixed(1)}s</span>
            <span>${(maxDelay * 0.5).toFixed(1)}s</span>
            <span>${minDelay.toFixed(1)}s</span>
        `;
    }

    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;

    // Calculate spacing based on actual data points
    const dataPoints = delayHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);

    // Calculate starting X position (align right, grow left)
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Draw grid lines
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Draw the line graph (oldest to newest, ending at right edge)
    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.beginPath();

    delayHistory.forEach((delay, index) => {
        const x = startX + (index * xStep);
        const y = height - padding - (delay / maxDelay * graphHeight);

        if (index === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    });

    ctx.stroke();

    // Draw filled area under the line
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = 'rgba(220, 38, 38, 0.1)';
    ctx.fill();
}

// Help modal functions - exposed to window for HTML onclick handlers
window.showHelp = function () {
    document.getElementById('help-modal').style.display = 'flex';
};

window.closeHelp = function () {
    document.getElementById('help-modal').style.display = 'none';
};

// Close modal on outside click
document.getElementById('help-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'help-modal') {
        window.closeHelp();
    }
});

// Initial device poll
fetch('/api/devices')
    .then(r => r.json())
    .then(updateDeviceList)
    .catch(err => {
        console.error('Failed to fetch devices:', err);
        updateDeviceList([]);
    });
