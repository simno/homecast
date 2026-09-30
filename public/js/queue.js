// The dashboard's Up next list. The queue itself is on the server
// (lib/queue.js), so it plays on with no page open; this shows it and edits it.
import { state } from './state.js';
import { apiPost } from './api.js';
import { setStreamNotice } from './dashboard.js';
import { queueList, queueNote, queueNextBtn, queueAddBtn } from './dom.js';

const EMPTY_NOTE = 'Nothing queued. Videos you add play when this one ends.';
const AIRPLAY_NOTE = 'An Apple TV doesn’t say when a video ends: press Play next now to move on.';

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

export function renderQueue(stream) {
    const items = stream?.queue || [];
    queueList.innerHTML = '';
    for (const item of items) {
        const li = document.createElement('li');
        li.title = item.url;
        const title = document.createElement('span');
        title.className = 'queue-item-title';
        title.textContent = item.title || item.url;
        const host = document.createElement('span');
        host.className = 'queue-item-host';
        host.textContent = hostOf(item.url);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'recent-remove';
        remove.dataset.id = item.id;
        remove.title = 'Remove from Up next';
        remove.setAttribute('aria-label', `Remove ${item.title || hostOf(item.url)} from Up next`);
        remove.textContent = '×';
        li.append(title, host, remove);
        queueList.appendChild(li);
    }
    const note = items.length === 0 ? EMPTY_NOTE : stream.deviceType === 'airplay' ? AIRPLAY_NOTE : '';
    queueNote.textContent = note;
    queueNote.classList.toggle('hidden', !note);
    queueNextBtn.classList.toggle('hidden', items.length === 0);
}

// The server's list for a device: on the stream, and shown if it's on screen.
export function applyQueue(ip, items) {
    const stream = state.streams.get(ip);
    if (!stream) return;
    stream.queue = items;
    if (ip === state.activeStreamIp) renderQueue(stream);
}

export async function loadQueue(ip) {
    try {
        const res = await fetch(`/api/queue/${encodeURIComponent(ip)}`);
        if (res.ok) applyQueue(ip, (await res.json()).items);
    } catch (err) {
        console.error('[Queue] Could not load the queue:', err);
    }
}

async function post(path, body) {
    const res = await apiPost(path, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// `onAdd(ip)`: open the compose form to queue a video for that stream.
export function wireQueueControls({ onAdd }) {
    queueAddBtn.addEventListener('click', () => {
        if (state.activeStreamIp) onAdd(state.activeStreamIp);
    });
    queueNextBtn.addEventListener('click', async () => {
        const ip = state.activeStreamIp;
        if (!ip) return;
        queueNextBtn.disabled = true;
        try {
            await post(`/api/queue/${encodeURIComponent(ip)}/next`, {});
        } catch (err) {
            setStreamNotice(ip, { type: 'error', message: `Could not play the next video: ${err.message}` });
        } finally {
            queueNextBtn.disabled = false;
        }
    });
    queueList.addEventListener('click', async (e) => {
        const remove = e.target.closest('.recent-remove');
        const ip = state.activeStreamIp;
        if (!remove || !ip) return;
        try {
            const { items } = await post(`/api/queue/${encodeURIComponent(ip)}/remove`, { id: remove.dataset.id });
            applyQueue(ip, items);
        } catch (err) {
            setStreamNotice(ip, { type: 'error', message: `Could not remove it from Up next: ${err.message}` });
        }
    });
}
