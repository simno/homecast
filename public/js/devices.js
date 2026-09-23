// The device picker: discovered devices plus manual IP entry.
import { deviceSelect, manualIpContainer, manualIpInput, manualIpHint } from './dom.js';
import { state } from './state.js';

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;

// Notified when the picked device changes (the compose form re-checks
// whether it can cast, and which subtitles the device can show).
const changeListeners = [];
export function onDeviceChange(fn) {
    changeListeners.push(fn);
}
const notifyChange = () => changeListeners.forEach(fn => fn());

export function updateDeviceList(devices) {
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
            opt.dataset.type = d.type || 'chromecast';
            const typeIcon = d.type === 'airplay' ? ' ' : '';
            opt.innerText = `${d.name} (${d.ip})${typeIcon}`;
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

export function findDeviceName(ip) {
    const device = state.devices.find(d => d.ip === ip);
    return device ? device.name : ip;
}

export function deviceTypeOf(ip) {
    return state.devices.find(d => d.ip === ip)?.type || 'chromecast';
}

// Devices that already have a stream can't take a second one.
export function filterDeviceDropdown() {
    deviceSelect.querySelectorAll('option').forEach(opt => {
        if (opt.value && opt.value !== 'manual') {
            opt.disabled = state.streams.has(opt.value);
        }
    });
}

function isManual() {
    return deviceSelect.value === 'manual';
}

export function toggleManualInput() {
    manualIpContainer.classList.toggle('hidden', !isManual());
    if (isManual() && document.activeElement !== manualIpInput) {
        manualIpInput.focus();
    }
    notifyChange();
}

// The picked device's IP, or null if none (or an invalid manual IP).
export function selectedDeviceIp() {
    if (!isManual()) return deviceSelect.value || null;
    const ip = manualIpInput.value.trim();
    return IPV4_RE.test(ip) ? ip : null;
}

export function selectedDeviceType() {
    return deviceSelect.selectedOptions[0]?.dataset?.type || 'chromecast';
}

// Flag a malformed manual IP (but not an empty one: the user hasn't typed yet).
export function showManualIpHint() {
    const ip = manualIpInput.value.trim();
    manualIpHint.classList.toggle('hidden', !isManual() || ip === '' || IPV4_RE.test(ip));
}

export function wireDeviceControls() {
    deviceSelect.addEventListener('change', toggleManualInput);
    manualIpInput.addEventListener('input', notifyChange);
}
