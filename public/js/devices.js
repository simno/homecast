// The device picker: discovered devices plus manual IP entry.
import {
    deviceSelect, manualIpContainer, manualIpInput, manualIpHint,
    rescanBtn, deviceHint, deviceHintText, manualIpLink
} from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';
import { lastDevice } from './recent.js';

// Discovery answers trickle in over a few seconds, so an empty list only
// means "none found" once a scan has had time to run.
const SCAN_MS = 6000;
let scanningUntil = Date.now() + SCAN_MS;
let scanTimer = null;

function isScanning() {
    return Date.now() < scanningUntil;
}

function startScanWindow() {
    scanningUntil = Date.now() + SCAN_MS;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
        rescanBtn.classList.remove('is-spinning');
        updateDeviceList(state.devices);
    }, SCAN_MS);
}
startScanWindow();

function renderDeviceHint(devices) {
    const scanning = isScanning();
    rescanBtn.classList.toggle('is-spinning', scanning);
    if (devices.length > 0 || isManual()) {
        deviceHint.classList.add('hidden');
        return;
    }
    deviceHintText.textContent = scanning
        ? 'Looking for Chromecasts, Apple TVs and LG TVs on your network…'
        : 'No devices found. Check the device is on the same network as HomeCast and rescan, or';
    manualIpLink.classList.toggle('hidden', scanning);
    deviceHint.classList.remove('hidden');
}
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
        opt.innerText = isScanning() ? 'Scanning for devices…' : 'No devices found';
        deviceSelect.appendChild(opt);
    } else {
        const addOption = (d, type, label) => {
            const opt = document.createElement('option');
            opt.value = optionValue(d.ip, type);
            opt.dataset.type = type;
            opt.innerText = `${d.name} (${d.ip})${label}`;
            deviceSelect.appendChild(opt);
        };
        devices.forEach(d => {
            const type = d.type || 'chromecast';
            // Text, not an icon: the Apple logo glyph only exists in Apple's fonts.
            const label = { airplay: ' · AirPlay', webos: ' · LG webOS' }[type] || (d.webos ? ' · Cast' : '');
            addOption(d, type, label);
            // An LG TV with Cast built in plays either way.
            if (d.webos && type !== 'webos') addOption(d, 'webos', ' · LG webOS');
        });
    }

    const manualOpt = document.createElement('option');
    manualOpt.value = 'manual';
    manualOpt.innerText = 'Enter IP Manually...';
    deviceSelect.appendChild(manualOpt);

    // With every real option disabled the browser would fall through to
    // "Enter IP Manually", hiding the scanning / none-found hint.
    deviceSelect.selectedIndex = 0;
    const offered = (value) => [...deviceSelect.options].some(o => o.value === value);
    if (currentVal && offered(currentVal)) {
        deviceSelect.value = currentVal;
    } else {
        // Nothing picked yet: offer the device used last time, if it's free.
        const last = lastDevice();
        if (last && offered(last) && !state.streams.has(ipOf(last))) deviceSelect.value = last;
    }
    toggleManualInput();
}

export async function rescanDevices() {
    startScanWindow();
    renderDeviceHint(state.devices);
    try {
        await apiPost('/api/devices/rescan', {});
    } catch (err) {
        console.error('Rescan failed:', err);
    }
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
            opt.disabled = state.streams.has(ipOf(opt.value));
        }
    });
}

// A picker option's value: the IP, prefixed for the LG webOS way of casting
// to a TV that can also be cast to over Cast (the same IP twice).
function optionValue(ip, type) {
    return type === 'webos' ? `webos:${ip}` : ip;
}

function ipOf(value) {
    return value.startsWith('webos:') ? value.slice('webos:'.length) : value;
}

// The picked option, to remember as the last device used.
export function selectedDeviceKey() {
    return isManual() ? null : deviceSelect.value || null;
}

function isManual() {
    return deviceSelect.value === 'manual';
}

export function toggleManualInput() {
    manualIpContainer.classList.toggle('hidden', !isManual());
    renderDeviceHint(state.devices);
    if (isManual() && document.activeElement !== manualIpInput) {
        manualIpInput.focus();
    }
    notifyChange();
}

// The picked device's IP, or null if none (or an invalid manual IP).
export function selectedDeviceIp() {
    if (!isManual()) return deviceSelect.value ? ipOf(deviceSelect.value) : null;
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
    rescanBtn.addEventListener('click', rescanDevices);
    manualIpLink.addEventListener('click', () => {
        deviceSelect.value = 'manual';
        toggleManualInput();
    });
}
