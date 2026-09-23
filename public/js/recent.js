// What the user cast before: recent page URLs (offered under the URL field)
// and the last device (preselected next time). Kept in this browser only.
import { recentUrls, recentList, recentClearBtn, videoUrlInput, resolvedUrlContainer } from './dom.js';

const RECENT_KEY = 'homecast_recent';
const LAST_DEVICE_KEY = 'homecast_last_device';
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

export function lastDevice() {
    const ip = read(LAST_DEVICE_KEY, null);
    return typeof ip === 'string' ? ip : null;
}

export function rememberDevice(ip) {
    write(LAST_DEVICE_KEY, ip);
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

// Shown only while the URL field is empty and nothing has been analysed.
export function renderRecent() {
    const list = loadRecent();
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
        li.appendChild(btn);
        recentList.appendChild(li);
    }
}

export function wireRecentControls({ onPick }) {
    recentList.addEventListener('click', (e) => {
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
