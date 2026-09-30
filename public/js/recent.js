// What the user cast before: recent page URLs (offered under the URL field),
// the last device (preselected next time), and devices that couldn't play a
// stream converted to 4K HEVC. Kept in this browser only.
import { recentUrls, recentList, recentClearBtn, videoUrlInput, resolvedUrlContainer } from './dom.js';
import { state } from './state.js';

const RECENT_KEY = 'homecast_recent';
const LAST_DEVICE_KEY = 'homecast_last_device';
const NO_CONVERSION_KEY = 'homecast_no_conversion';
const MAX_RECENT = 5;

function read(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value ?? fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable: nothing to remember */ }
}

function loadRecent() {
    const list = read(RECENT_KEY, []);
    return Array.isArray(list) ? list.filter(e => e && typeof e.url === 'string') : [];
}

export function addRecent(url, title) {
    const list = loadRecent().filter(e => e.url !== url);
    list.unshift({ url, title: title || null });
    write(RECENT_KEY, list.slice(0, MAX_RECENT));
    renderRecent();
}

function removeRecent(url) {
    const list = loadRecent().filter(e => e.url !== url);
    write(RECENT_KEY, list.length > 0 ? list : null);
    renderRecent();
}

// The device picker's option value: an IP, or `webos:<ip>` for an LG TV cast
// to through its browser (see devices.js).
export function lastDevice() {
    const value = read(LAST_DEVICE_KEY, null);
    return typeof value === 'string' ? value : null;
}

export function rememberDevice(value) {
    write(LAST_DEVICE_KEY, value);
}

// Devices that rejected a converted stream (the server recast them without):
// "Highest available" stops picking conversion for them.
export function cannotPlayConverted(ip) {
    const list = read(NO_CONVERSION_KEY, []);
    return Array.isArray(list) && list.includes(ip);
}

export function rememberCannotPlayConverted(ip) {
    if (cannotPlayConverted(ip)) return;
    const list = read(NO_CONVERSION_KEY, []);
    write(NO_CONVERSION_KEY, [...(Array.isArray(list) ? list : []), ip]);
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

// Shown only while the URL field is empty and nothing has been analysed.
// Queueing for a stream: what it's playing, and what's queued after it,
// aren't worth offering again.
function alreadyLined() {
    const stream = state.streams.get(state.compose.queueFor);
    if (!stream) return new Set();
    return new Set([stream.page, ...(stream.queue || []).map(item => item.url)].filter(Boolean));
}

export function renderRecent() {
    const lined = alreadyLined();
    const list = loadRecent().filter(entry => !lined.has(entry.url));
    const show = list.length > 0 && !videoUrlInput.value.trim() && resolvedUrlContainer.classList.contains('hidden');
    recentUrls.classList.toggle('hidden', !show);
    if (!show) return;

    recentList.innerHTML = '';
    for (const entry of list) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'recent-item';
        btn.dataset.url = entry.url;
        btn.title = entry.url;

        const title = document.createElement('span');
        title.className = 'recent-item-title';
        title.textContent = entry.title || entry.url;
        const host = document.createElement('span');
        host.className = 'recent-item-host';
        host.textContent = hostOf(entry.url);

        btn.append(title, host);

        // A sibling, not inside the row's button: a button can't hold another.
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'recent-remove';
        remove.dataset.url = entry.url;
        remove.title = 'Remove from recent';
        remove.setAttribute('aria-label', `Remove ${entry.title || hostOf(entry.url)} from recent`);
        remove.textContent = '\u00d7';

        li.append(btn, remove);
        recentList.appendChild(li);
    }
}

export function wireRecentControls({ onPick }) {
    recentList.addEventListener('click', (e) => {
        const remove = e.target.closest('.recent-remove');
        if (remove) {
            // Keep keyboard focus in the list: on the next row's remove
            // button, or the URL field once the list is gone.
            const row = remove.closest('li');
            const next = (row.nextElementSibling || row.previousElementSibling)?.querySelector('.recent-remove');
            const nextUrl = next?.dataset.url;
            removeRecent(remove.dataset.url);
            const target = nextUrl && [...recentList.querySelectorAll('.recent-remove')].find(b => b.dataset.url === nextUrl);
            (target || videoUrlInput).focus();
            return;
        }
        const item = e.target.closest('.recent-item');
        if (!item) return;
        videoUrlInput.value = item.dataset.url;
        onPick();
    });
    recentClearBtn.addEventListener('click', () => {
        write(RECENT_KEY, null);
        renderRecent();
        videoUrlInput.focus();
    });
    videoUrlInput.addEventListener('input', renderRecent);
    renderRecent();
}
