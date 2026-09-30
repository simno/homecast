// The device picker: discovered devices plus manual IP entry.
import {
    deviceSelect, devicePickerBtn, deviceList, manualIpContainer, manualIpInput, manualIpHint,
    rescanBtn, deviceHint, deviceHintText, manualIpLink
} from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';
import { lastDevice } from './recent.js';
import { icon, PROTOCOLS } from './icons.js';

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
        const addOption = (d, type) => {
            const opt = document.createElement('option');
            opt.value = optionValue(d.ip, type);
            opt.dataset.type = type;
            opt.dataset.name = displayName(d);
            opt.dataset.ip = d.ip;
            opt.innerText = `${displayName(d)} (${d.ip}) · ${PROTOCOLS[type]}`;
            deviceSelect.appendChild(opt);
        };
        devices.forEach(d => {
            const type = PROTOCOLS[d.type] ? d.type : 'chromecast';
            addOption(d, type);
            // An LG TV with Cast built in plays either way.
            if (d.webos && type !== 'webos') addOption(d, 'webos');
        });
    }

    const manualOpt = document.createElement('option');
    manualOpt.value = 'manual';
    manualOpt.innerText = MANUAL_LABEL;
    deviceSelect.appendChild(manualOpt);

    // With every real option disabled the browser would fall through to
    // "Enter IP address…", hiding the scanning / none-found hint.
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
    renderPicker();
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
        } else if (opt.value === 'manual') {
            opt.disabled = false;
        }
    });
    renderPicker();
}

// Queueing a video for a playing stream: its device is the only choice.
// One cast to by IP (not in the list) is picked as a manual entry.
export function pickOnlyDevice(ip, type) {
    const value = optionValue(ip, type);
    const listed = [...deviceSelect.options].some(o => o.value === value);
    deviceSelect.querySelectorAll('option').forEach(opt => {
        if (opt.value) opt.disabled = opt.value !== (listed ? value : 'manual');
    });
    deviceSelect.value = listed ? value : 'manual';
    if (!listed) manualIpInput.value = ip;
    toggleManualInput();
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
    renderPicker();
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
    wirePicker();
    manualIpInput.addEventListener('input', notifyChange);
    rescanBtn.addEventListener('click', rescanDevices);
    manualIpLink.addEventListener('click', () => {
        deviceSelect.value = 'manual';
        toggleManualInput();
    });
}

// ===== Picker =====
// A select can't draw icons, so the hidden #device-select holds the choice
// and this listbox draws it: one row per way of casting, named by protocol.

const MANUAL_LABEL = 'Enter IP address…';

// Fallback names repeat the IP ("Chromecast (192.168.2.18)"); the picker
// shows the IP beside every device anyway.
function displayName(device) {
    const suffix = ` (${device.ip})`;
    return device.name.endsWith(suffix) ? device.name.slice(0, -suffix.length) : device.name;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

let activeIndex = -1;

// The select's options as picker rows: devices first, then manual entry.
function pickerOptions() {
    return [...deviceSelect.options].filter(o => o.value);
}

function isOpen() {
    return !deviceList.classList.contains('hidden');
}

function renderTrigger() {
    const opt = deviceSelect.selectedOptions[0];
    let content;
    if (opt?.value === 'manual') {
        content = `${icon('plus', 'device-icon')}<span class="device-name">${MANUAL_LABEL}</span>`;
    } else if (opt?.value) {
        content = `${icon(opt.dataset.type, 'device-icon')}<span class="device-name">${escapeHtml(opt.dataset.name)}</span>` +
            `<span class="device-protocol">${PROTOCOLS[opt.dataset.type]}</span>`;
    } else {
        const empty = state.devices.length === 0;
        const text = !empty ? 'Choose a device' : (isScanning() ? 'Scanning for devices…' : 'No devices found');
        content = `<span class="device-name is-placeholder">${text}</span>`;
    }
    devicePickerBtn.innerHTML = `${content}${icon('chevron', 'device-chevron')}`;
}

function renderList() {
    const rows = pickerOptions().map((opt, i) => {
        const selected = opt.value === deviceSelect.value;
        const attrs = `id="device-opt-${i}" role="option" data-value="${escapeHtml(opt.value)}" aria-selected="${selected}"` +
            (opt.disabled ? ' aria-disabled="true"' : '');
        if (opt.value === 'manual') {
            return `<li class="device-option is-manual" ${attrs}>${icon('plus', 'device-icon')}<span class="device-text"><span class="device-name">${MANUAL_LABEL}</span></span></li>`;
        }
        const meta = opt.disabled ? 'Already streaming' : `${PROTOCOLS[opt.dataset.type]} · ${opt.dataset.ip}`;
        return `<li class="device-option" ${attrs}>${icon(opt.dataset.type, 'device-icon')}` +
            `<span class="device-text"><span class="device-name">${escapeHtml(opt.dataset.name)}</span>` +
            `<span class="device-meta">${escapeHtml(meta)}</span></span>` +
            `${selected ? icon('check', 'device-check') : ''}</li>`;
    });
    if (state.devices.length === 0) {
        const text = isScanning() ? 'Scanning for devices…' : 'No devices found';
        rows.unshift(`<li class="device-empty" role="presentation">${text}</li>`);
    }
    deviceList.innerHTML = rows.join('');
    setActive(activeIndex);
}

function renderPicker() {
    renderTrigger();
    if (isOpen()) renderList();
}

function optionRows() {
    return [...deviceList.querySelectorAll('[role="option"]')];
}

function setActive(index) {
    const rows = optionRows();
    activeIndex = Math.min(index, rows.length - 1);
    rows.forEach((row, i) => row.classList.toggle('is-active', i === activeIndex));
    const row = rows[activeIndex];
    if (row) {
        deviceList.setAttribute('aria-activedescendant', row.id);
        row.scrollIntoView({ block: 'nearest' });
    } else {
        deviceList.removeAttribute('aria-activedescendant');
    }
}

// The next row a key press lands on, skipping busy devices.
function stepActive(from, step) {
    const rows = optionRows();
    for (let i = from + step; i >= 0 && i < rows.length; i += step) {
        if (rows[i].getAttribute('aria-disabled') !== 'true') return i;
    }
    return from;
}

function openList() {
    if (isOpen()) return;
    activeIndex = -1;
    deviceList.classList.remove('hidden');
    devicePickerBtn.setAttribute('aria-expanded', 'true');
    renderList();
    const selected = optionRows().findIndex(r => r.getAttribute('aria-selected') === 'true');
    setActive(selected >= 0 ? selected : stepActive(-1, 1));
    deviceList.focus();
}

function closeList(refocus = true) {
    if (!isOpen()) return;
    deviceList.classList.add('hidden');
    devicePickerBtn.setAttribute('aria-expanded', 'false');
    if (refocus) devicePickerBtn.focus();
}

function choose(row) {
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    closeList();
    if (row.dataset.value === deviceSelect.value) return;
    deviceSelect.value = row.dataset.value;
    deviceSelect.dispatchEvent(new window.Event('change'));
}

function wirePicker() {
    renderTrigger();

    devicePickerBtn.addEventListener('click', () => (isOpen() ? closeList() : openList()));
    devicePickerBtn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openList();
        }
    });

    deviceList.addEventListener('click', (e) => choose(e.target.closest('[role="option"]')));
    deviceList.addEventListener('pointermove', (e) => {
        const row = e.target.closest('[role="option"]');
        const index = optionRows().indexOf(row);
        if (index >= 0 && index !== activeIndex && row.getAttribute('aria-disabled') !== 'true') setActive(index);
    });
    deviceList.addEventListener('keydown', (e) => {
        const last = optionRows().length - 1;
        const moves = {
            ArrowDown: () => stepActive(activeIndex, 1),
            ArrowUp: () => stepActive(activeIndex, -1),
            Home: () => stepActive(-1, 1),
            End: () => stepActive(last + 1, -1)
        };
        if (moves[e.key]) {
            e.preventDefault();
            setActive(moves[e.key]());
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(optionRows()[activeIndex]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeList();
        } else if (e.key === 'Tab') {
            closeList(false);
        }
    });

    // Clicking anywhere else puts the list away (Tab does, above).
    document.addEventListener('pointerdown', (e) => {
        if (isOpen() && !e.target.closest('.device-picker')) closeList(false);
    });
}
