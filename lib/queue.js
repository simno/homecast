const crypto = require('crypto');
const { broadcast } = require('./websocket');

// What plays next on each device, kept on the server so it carries on with
// no page open. A Chromecast or LG TV moves on by itself when a video plays
// to its end (lib/cast.js, lib/webos.js call playedToEnd); an Apple TV says
// nothing when it finishes, so there it's the dashboard's Next button.
// Casting something new or stopping clears a device's queue.

const MAX_ITEMS = 50;
// A little room between one video ending and the next starting: the
// receiver is still tearing down the old session.
const ADVANCE_DELAY_MS = 1500;

// ip -> [{ id, title, url, cast }]; `cast` is a parsed request (lib/dispatch.js).
const queues = new Map();
const advancing = new Map();

const hasNext = (ip) => queues.has(ip);

function items(ip) {
    return (queues.get(ip) || []).map(({ id, title, url }) => ({ id, title, url }));
}

function announce(ip) {
    broadcast({ type: 'queue', deviceIp: ip, items: items(ip) });
}

// `title`: what the page called it; `url`: the page it came from, shown
// with it (the cast's own URL is often a long CDN address).
function enqueue(cast, { title, url } = {}) {
    const queue = queues.get(cast.ip) || [];
    if (queue.length >= MAX_ITEMS) throw new Error(`The queue holds ${MAX_ITEMS} videos at most`);
    const item = {
        id: crypto.randomUUID(),
        title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : null,
        url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url.slice(0, 2048) : cast.url,
        cast
    };
    queue.push(item);
    queues.set(cast.ip, queue);
    announce(cast.ip);
    return item;
}

function removeItem(ip, id) {
    const queue = queues.get(ip) || [];
    const index = queue.findIndex(item => item.id === id);
    if (index === -1) return false;
    queue.splice(index, 1);
    if (queue.length === 0) queues.delete(ip);
    announce(ip);
    return true;
}

function clearQueue(ip) {
    clearTimeout(advancing.get(ip));
    advancing.delete(ip);
    if (!queues.has(ip)) return;
    queues.delete(ip);
    announce(ip);
}

// A stand-in for the HTTP response a cast answers on: resolves with what
// the receiver's module would have sent the page.
function capturedResponse() {
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const res = {
        headersSent: false,
        statusCode: 200,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            if (!this.headersSent) {
                this.headersSent = true;
                settle({ status: this.statusCode, body });
            }
            return this;
        }
    };
    return { res, done };
}

// Start the next item now. Resolves with { item, status, body } (the cast's
// answer), or null when nothing is queued.
async function playNext(ip) {
    clearTimeout(advancing.get(ip));
    advancing.delete(ip);
    const queue = queues.get(ip);
    const item = queue?.shift();
    if (!item) return null;
    if (queue.length === 0) queues.delete(ip);
    announce(ip);

    console.log(`[Queue] Playing next on ${ip}: ${item.title || item.url}`);
    broadcast({ type: 'status', status: `Up next: ${item.title || item.url}` });
    // Required here: lib/dispatch requires the receiver modules, which require this one.
    const { startCast } = require('./dispatch');
    const { res, done } = capturedResponse();
    startCast(item.cast, res);
    const { status, body } = await done;
    if (status >= 400 || body?.error) {
        const message = body?.needsPairing
            ? 'The next video needs the Apple TV to be paired again. Cast it from the dashboard.'
            : `Could not play the next video: ${body?.error || `HTTP ${status}`}`;
        console.warn(`[Queue] ${message}`);
        broadcast({ type: 'queueError', deviceIp: ip, message });
    }
    return { item: { id: item.id, title: item.title, url: item.url }, status, body };
}

// The receiver finished a video by playing it to the end (not a stop or an
// error): move on to the next one, if there is one.
function playedToEnd(ip) {
    if (!queues.has(ip) || advancing.has(ip)) return;
    advancing.set(ip, setTimeout(() => {
        advancing.delete(ip);
        playNext(ip).catch(err => console.error(`[Queue] Advancing on ${ip} failed:`, err.message));
    }, ADVANCE_DELAY_MS));
}

module.exports = { items, hasNext, enqueue, removeItem, clearQueue, playNext, playedToEnd, MAX_ITEMS };
