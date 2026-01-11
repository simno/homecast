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

let currentReferer = '';
let currentDeviceIp = null;
let _isCasting = false;
let availableStreams = []; // Store all found streams

// Transfer rate history for graph (last 60 data points = 60 seconds)
const rateHistory = [];
const delayHistory = [];
const MAX_HISTORY = 60;

// State persistence
const STATE_KEY = 'homecast_state';

// Load persisted state on startup
function loadState() {
    try {
        const saved = localStorage.getItem(STATE_KEY);
        if (saved) {
            const state = JSON.parse(saved);
            console.log('[State] Loaded persisted state:', state);
            return state;
        }
    } catch (e) {
        console.error('[State] Failed to load state:', e);
    }
    return null;
}

// Save state to localStorage
function saveState(deviceIp) {
    try {
        const state = {
            deviceIp: deviceIp,
            timestamp: Date.now()
        };
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        console.log('[State] Saved state:', state);
    } catch (e) {
        console.error('[State] Failed to save state:', e);
    }
}

// Clear persisted state
function clearState() {
    try {
        localStorage.removeItem(STATE_KEY);
        console.log('[State] Cleared persisted state');
    } catch (e) {
        console.error('[State] Failed to clear state:', e);
    }
}

// Check session status for a device
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

// Restore UI state for active session
function restoreSessionUI(deviceIp, sessionData) {
    currentDeviceIp = deviceIp;
    _isCasting = true;

    // Update UI to show active session
    document.getElementById('cast-btn').style.display = 'none';
    document.getElementById('stop-btn').style.display = 'inline-flex';
    document.getElementById('stream-stats-card').style.display = 'block';
    statusCard.style.display = 'block';

    // If we have current stats, display them immediately
    if (sessionData && sessionData.stats) {
        updateStreamStats(sessionData.stats);
    } else {
        // Reset stats to defaults if no stats available yet
        resetStreamStats();
    }

    updateStatus('🎬 Restored active session', 'success');
    console.log('[State] UI restored for active session on', deviceIp);
}

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
        // Only update stats if they're for the currently selected device
        const selectedDeviceIp = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
        if (data.deviceIp === selectedDeviceIp) {
            updateStreamStats(data.stats);
            // Update delay graph at same rate as transfer rate (when segments complete)
            if (data.stats.delay !== undefined && data.stats.delay > 0) {
                updateDelayGraph(data.stats.delay);
            }
        } else {
            console.log(`[Stats] Ignoring stats for ${data.deviceIp}, currently viewing ${selectedDeviceIp}`);
        }
    }
    if (data.type === 'playerStatus') {
        // Only update UI if status is for the currently selected device
        const selectedDeviceIp = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;

        // Check if this status update is for a different device
        if (data.deviceIp && data.deviceIp !== selectedDeviceIp) {
            console.log(`[Status] Ignoring player status for ${data.deviceIp}, currently viewing ${selectedDeviceIp}`);
            return;
        }

        const state = data.status.playerState;
        const idleReason = data.status.idleReason;
        let message = `Playback: ${state}`;
        let type = 'info';

        // Update buffer health if available
        if (data.bufferHealth) {
            updateBufferHealth(data.bufferHealth);
        }

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

            // Clear state when playback ends
            _isCasting = false;
            currentDeviceIp = null;
            clearState();
        }

        updateStatus(message, type);
    }
    if (data.type === 'connectionHealth') {
        console.log('[ConnectionHealth] Received:', data);
        // Only show health updates for the currently selected device
        const selectedDeviceIp = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
        console.log('[ConnectionHealth] Selected device:', selectedDeviceIp, 'Message device:', data.deviceIp);
        if (data.deviceIp === selectedDeviceIp) {
            console.log('[ConnectionHealth] Updating health UI');
            updateConnectionHealth(data.state, data.message);
        }
    }
    if (data.type === 'streamRecovery') {
        // Only show recovery updates for the currently selected device
        const selectedDeviceIp = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
        if (data.deviceIp === selectedDeviceIp) {
            handleStreamRecovery(data);
        }
    }
};

ws.onerror = () => {
    console.warn('WebSocket connection failed, falling back to polling');
};

// Device select change handler - check for active sessions
deviceSelect.addEventListener('change', async function () {
    toggleManualInput();

    const selectedIp = deviceSelect.value;
    if (selectedIp && selectedIp !== 'manual') {
        console.log('[State] Device changed to:', selectedIp);

        // Always reset UI first, then conditionally restore if session exists
        currentDeviceIp = null;
        _isCasting = false;

        // Reset buttons
        document.getElementById('cast-btn').style.display = 'inline-flex';
        document.getElementById('cast-btn').disabled = true; // Disabled until stream selected
        document.getElementById('stop-btn').style.display = 'none';

        // Hide status and stats
        statusCard.style.display = 'none';
        document.getElementById('stream-stats-card').style.display = 'none';

        // Clear stats display
        resetStreamStats();

        // Clear graphs
        rateHistory.length = 0;
        delayHistory.length = 0;

        // Check if this device has an active session
        const sessionStatus = await checkSessionStatus(selectedIp);

        if (sessionStatus && sessionStatus.active) {
            restoreSessionUI(selectedIp, sessionStatus);
            saveState(selectedIp);
        }
    }
});

manualIpInput.addEventListener('input', checkReady);

// Initialize state on page load
window.addEventListener('load', async () => {
    console.log('[State] Page loaded, checking for persisted state...');

    const savedState = loadState();
    if (savedState && savedState.deviceIp) {
        // Check if state is not too old (< 24 hours)
        const age = Date.now() - savedState.timestamp;
        if (age < 24 * 60 * 60 * 1000) {
            console.log('[State] Found recent saved state, checking session...');

            // Wait for device list to load
            setTimeout(async () => {
                const sessionStatus = await checkSessionStatus(savedState.deviceIp);
                if (sessionStatus.active) {
                    console.log('[State] Restoring active session');

                    // Set device in dropdown if it exists
                    const deviceOption = Array.from(deviceSelect.options).find(
                        opt => opt.value === savedState.deviceIp
                    );
                    if (deviceOption) {
                        deviceSelect.value = savedState.deviceIp;
                    }

                    restoreSessionUI(savedState.deviceIp, sessionStatus);
                } else {
                    console.log('[State] Saved session is no longer active');
                    clearState();
                }
            }, 1000); // Wait 1 second for devices to populate
        } else {
            console.log('[State] Saved state is too old, clearing');
            clearState();
        }
    }
});

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

        if (data.videos && data.videos.length > 0) {
            availableStreams = data.videos;
            displayStreamOptions(data.videos);
            updateStatus(`✅ Found ${data.videos.length} stream${data.videos.length > 1 ? 's' : ''}!`, 'success');
            checkReady();
        } else {
            updateStatus('❌ No video found at this URL', 'error');
        }
    } catch (e) {
        console.error('Extract error:', e);
        updateStatus('❌ Failed to analyze URL', 'error');
    }
};

function displayStreamOptions(videos) {
    streamOptionsContainer.innerHTML = '';
    document.getElementById('streams-found-text').textContent =
        videos.length > 1 ? `${videos.length} streams found:` : 'Video found:';
    document.getElementById('resolved-url-container').style.display = 'flex';

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
        badgesContainer.style.marginTop = '4px';
        badgesContainer.style.display = 'flex';
        badgesContainer.style.gap = '6px';

        const typeSpan = document.createElement('span');
        typeSpan.className = `stream-option-type ${video.type}`;
        typeSpan.textContent = video.type.toUpperCase();

        if (video.unsupported) {
            typeSpan.textContent += ' (UNSUPPORTED)';
        }

        badgesContainer.appendChild(typeSpan);

        // Add resolution badge if available
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

function checkReady() {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const selectedStream = document.querySelector('input[name="stream-select"]:checked');
    castBtn.disabled = !(ip && selectedStream);
}

// Expose to global scope for HTML onclick handlers
window.startCasting = async function () {
    const ip = deviceSelect.value === 'manual' ? manualIpInput.value.trim() : deviceSelect.value;
    const selectedRadio = document.querySelector('input[name="stream-select"]:checked');

    if (!ip || !selectedRadio) return;

    const selectedIndex = parseInt(selectedRadio.value);
    const selectedStream = availableStreams[selectedIndex];
    const url = selectedStream.url;
    currentReferer = selectedStream.referer;

    const proxy = document.getElementById('use-proxy').checked;

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

            // Save state for persistence
            saveState(ip);
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

            // Clear saved state
            clearState();
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

    // Display frame rate if available
    if (stats.frameRate) {
        const fps = Math.round(stats.frameRate);
        document.getElementById('stat-framerate').textContent = `${fps} FPS`;
    } else {
        document.getElementById('stat-framerate').textContent = '-';
    }

    // Update graph
    updateRateGraph(stats.transferRate);
}

function updateBufferHealth(bufferHealth) {
    if (!bufferHealth) return;

    const { healthScore, bufferingEvents, totalBufferingTime } = bufferHealth;
    const healthEl = document.getElementById('stat-buffer-health');

    if (healthEl) {
        let displayText = `${healthScore}%`;
        if (bufferingEvents > 0) {
            displayText += ` (${bufferingEvents} events, ${totalBufferingTime}s)`;
        }

        healthEl.textContent = displayText;

        // Color code based on health score
        if (healthScore >= 95) {
            healthEl.style.color = '#00aa00'; // Green
        } else if (healthScore >= 85) {
            healthEl.style.color = '#ff9900'; // Orange
        } else {
            healthEl.style.color = '#cc0000'; // Red
        }
    }
}

function resetStreamStats() {
    // Reset all stat displays to default values
    document.getElementById('stat-resolution').textContent = 'Unknown';
    document.getElementById('stat-framerate').textContent = '-';
    document.getElementById('stat-bitrate').textContent = '- Kbps';
    document.getElementById('stat-transferred').textContent = '0 MB';
    document.getElementById('stat-segments').textContent = '0';
    document.getElementById('stat-duration').textContent = '0s';
    document.getElementById('stat-cache').textContent = '0';
    document.getElementById('stat-buffer-health').textContent = '-';
    document.getElementById('stat-buffer-health').style.color = '#0066cc';
}

function updateConnectionHealth(state, message) {
    console.log('[ConnectionHealth] updateConnectionHealth called:', state, message, '_isCasting:', _isCasting);
    const healthContainer = document.getElementById('connection-health');
    const healthDot = document.getElementById('health-dot');
    const healthText = document.getElementById('health-text');

    // Show health indicator when we have a state (connection monitoring is active)
    if (state) {
        console.log('[ConnectionHealth] Showing health indicator');
        healthContainer.style.display = 'block';

        // Remove all state classes
        healthDot.className = 'health-dot';

        // Add appropriate state class
        healthDot.classList.add(state);

        // Update text
        healthText.textContent = message || {
            'healthy': 'Connected',
            'degraded': 'Connection unstable',
            'unhealthy': 'Connection lost',
            'reconnecting': 'Reconnecting...',
            'failed': 'Connection failed'
        }[state];

        // If connection is unhealthy or failed, show warning in status
        if (state === 'unhealthy' || state === 'failed') {
            updateStatus(`⚠️ ${healthText.textContent}`, 'error');
        } else if (state === 'healthy') {
            updateStatus('🎬 Streaming', 'success');
        }
    } else {
        healthContainer.style.display = 'none';
    }
}

function handleStreamRecovery(data) {
    console.log('[Recovery]', data);

    if (data.status === 'attempting') {
        updateStatus(`🔄 Recovering stream (attempt ${data.attempt}/${data.maxAttempts})...`, 'loading');
    } else if (data.status === 'success') {
        updateStatus('✅ Stream recovered successfully', 'success');
    } else if (data.status === 'failed') {
        updateStatus(`⚠️ Recovery attempt ${data.attempt} failed`, 'error');
    } else if (data.status === 'giveup') {
        updateStatus('❌ Stream recovery failed - please restart manually', 'error');
    }
}

function updateRateGraph(currentRate) {
    // Add current rate to history (ensure it's a valid number)
    const rate = parseFloat(currentRate) || 0;
    rateHistory.push(rate);

    // Keep only last 60 data points
    if (rateHistory.length > MAX_HISTORY) {
        rateHistory.shift();
    }

    // Update current rate display
    document.getElementById('graph-current-rate').textContent = `${rate} KB/s`;

    // Draw graph
    const canvas = document.getElementById('rate-graph');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Don't draw if no data or all zeros
    if (rateHistory.length < 2) return;

    // Filter out invalid values for calculating scale
    const validRates = rateHistory.filter(r => !isNaN(r) && r !== null && r !== undefined);
    if (validRates.length === 0) return;

    // Calculate scale
    const maxRate = Math.max(...validRates, 100); // Minimum scale of 100 KB/s
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

    // Add current delay to history (ensure it's a valid number)
    const delay = parseFloat(currentDelay) || 0;
    delayHistory.push(delay);

    // Keep only last 60 data points
    if (delayHistory.length > MAX_HISTORY) {
        delayHistory.shift();
    }

    // Update current delay display
    document.getElementById('graph-current-delay').textContent = `${delay.toFixed(1)}s`;

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

    // Filter out invalid values for calculating scale
    const validDelays = delayHistory.filter(d => !isNaN(d) && d !== null && d !== undefined);
    if (validDelays.length === 0) return;

    // Calculate scale
    const maxDelay = Math.max(...validDelays, 1); // Minimum scale of 1 second
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
