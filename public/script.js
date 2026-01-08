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

// WebSocket for live updates
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'devices') updateDeviceList(data.devices);
    if (data.type === 'status') {
        updateStatus(data.status, 'info');
    }
    if (data.type === 'playerStatus') {
        const state = data.status.playerState;
        let message = `Playback: ${state}`;
        let type = 'info';

        if (state === 'PLAYING') {
            message = '🎬 Now Playing';
            type = 'success';
        } else if (state === 'BUFFERING') {
            message = '⏳ Buffering...';
            type = 'loading';
        } else if (state === 'PAUSED') {
            message = '⏸ Paused';
            type = 'info';
        } else if (state === 'IDLE') {
            message = '⏹ Stopped';
            type = 'info';
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
