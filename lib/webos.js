const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { devices, deviceLastSeen, activeWebOsSessions, streamStats } = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT } = require('./utils');
const { buildProxyUrl } = require('./proxy');
const { onRescan } = require('./discovery');
const { sendWOL, resolveMACFromARP } = require('./wol');

// LG webOS TVs, cast to through their own web browser.
//
// LG TVs play AirPlay 2 video only over a protocol Apple hasn't opened up, and
// their built-in Cast receiver shares Chromecast's limits (4K only as HEVC). But
// the TV's browser plays HLS natively, 4K H.264 included, so a cast here is:
// open HomeCast's player page (public/webos-player.html) on the TV with the
// stream's proxy URL. The page reports playback back over HomeCast's WebSocket
// and takes play/pause/seek from it; volume goes through the TV itself.
//
// The TV is driven over its second-screen API (SSAP): JSON over a WebSocket on
// port 3001 (TLS, self-signed) or 3000 on older models. The first connection
// shows an "allow this device?" prompt on the TV; accepting it returns a
// client key, kept in the key store so later casts connect silently.

const SSAP_ST = 'urn:lge-com:service:webos-second-screen:1';
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const BROWSER_APP = 'com.webos.app.browser';

const KEY_STORE_PATH = process.env.WEBOS_KEY_STORE ||
    path.join(__dirname, '..', 'data', 'webos-keys.json');

const REQUEST_TIMEOUT_MS = 10000;
// Long enough for someone to find the remote and accept the prompt.
const PROMPT_TIMEOUT_MS = 60000;
// A TV that knows HomeCast registers it at once; one that doesn't answer in
// this time is in standby (its network stays up, its API doesn't).
const KNOWN_REGISTER_TIMEOUT_MS = 6000;
// How long a woken TV gets to start answering.
const WAKE_TIMEOUT_MS = 30000;
const WAKE_RETRY_MS = 3000;
// From opening the browser to the player page checking in.
const PLAYER_CONNECT_TIMEOUT_MS = 20000;
// A player page that drops off (a reload, a Wi-Fi blip) gets this long to come
// back before its session is treated as ended.
const PLAYER_GRACE_MS = 8000;
// Clicks to get the player full screen (see ensureFullScreen).
const MAX_CLICKS = 3;
const CLICK_INTERVAL_MS = 4000;

// What HomeCast asks the TV for. Without a signed manifest the TV grants
// exactly these once the prompt is accepted.
const MANIFEST = {
    manifestVersion: 1,
    appVersion: '1.1',
    permissions: [
        'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE',
        'CONTROL_AUDIO', 'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_INPUT_MEDIA_PLAYBACK',
        'READ_APP_STATUS', 'READ_RUNNING_APPS', 'READ_INSTALLED_APPS', 'READ_POWER_STATE'
    ]
};

// ===== KEY STORE =====

let keys = {};
let keysLoaded = false;

async function initKeyStore() {
    try {
        keys = JSON.parse(await fs.promises.readFile(KEY_STORE_PATH, 'utf8')).keys || {};
        console.log('[webOS] Loaded', Object.keys(keys).length, 'TV key(s) from', KEY_STORE_PATH);
    } catch {
        keys = {};
    }
    keysLoaded = true;
}

// Remember the TV's key, and its MAC address to wake it with later (read from
// the ARP table while the TV is known to be on).
async function saveKey(ip, clientKey) {
    if (!keysLoaded) await initKeyStore();
    const mac = resolveMACFromARP(ip) || keys[ip]?.mac || null;
    keys[ip] = { key: clientKey, mac, name: devices.get(ip)?.name || ip, pairedAt: keys[ip]?.pairedAt || Date.now() };
    await fs.promises.mkdir(path.dirname(KEY_STORE_PATH), { recursive: true });
    const tmp = KEY_STORE_PATH + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, keys }, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, KEY_STORE_PATH);
}

// ===== SSAP CONNECTION =====

function openSocket(url) {
    return new Promise((resolve, reject) => {
        // The TV's certificate is self-signed; it's only ever reached on the LAN.
        const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

class TvConnection {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        ws.on('message', (data) => this.onMessage(data));
        ws.on('close', () => {
            for (const { reject } of this.pending.values()) reject(new Error('TV closed the connection'));
            this.pending.clear();
        });
        ws.on('error', () => { /* surfaced through close */ });
    }

    static async open(ip) {
        let ws;
        try {
            ws = await openSocket(`wss://${ip}:3001`);
        } catch {
            ws = await openSocket(`ws://${ip}:3000`);
        }
        return new TvConnection(ws);
    }

    onMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        if (msg.type === 'error') entry.reject(new Error(msg.error || 'TV refused the request'));
        else if (entry.onMessage) entry.onMessage(msg, entry);
        else entry.resolve(msg.payload || {});
    }

    // Send a message and wait for its answer. `onMessage(msg, entry)`, when
    // given, sees every reply to it and settles through entry.resolve.
    send(message, { onMessage, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        const id = `hc${++this.nextId}`;
        return new Promise((resolve, reject) => {
            const finish = (fn) => (value) => {
                clearTimeout(timer);
                this.pending.delete(id);
                fn(value);
            };
            const timer = setTimeout(finish(reject), timeoutMs, new Error('TV did not answer'));
            this.pending.set(id, { onMessage, resolve: finish(resolve), reject: finish(reject) });
            this.ws.send(JSON.stringify({ id, ...message }));
        });
    }

    request(uri, payload) {
        return this.send({ type: 'request', uri, payload });
    }

    // Resolves with the client key; `onPrompt` runs if the TV asks its viewer.
    register(clientKey, onPrompt) {
        return this.send({
            type: 'register',
            payload: { forcePairing: false, pairingType: 'PROMPT', 'client-key': clientKey, manifest: MANIFEST }
        }, {
            timeoutMs: clientKey ? KNOWN_REGISTER_TIMEOUT_MS : PROMPT_TIMEOUT_MS,
            onMessage: (msg, entry) => {
                if (msg.type === 'registered') entry.resolve(msg.payload['client-key']);
                else if (msg.payload?.pairingType === 'PROMPT') onPrompt?.();
            }
        });
    }

    close() {
        try { this.ws.close(); } catch { /* ignore */ }
    }
}

// Connect and register with the TV. A TV not yet paired shows its prompt;
// `onPrompt` lets the caller tell the user to look at it.
async function connect(ip, onPrompt) {
    const tv = await TvConnection.open(ip);
    const stored = keys[ip]?.key;
    try {
        const clientKey = await tv.register(stored, onPrompt);
        if (clientKey && (clientKey !== stored || !keys[ip]?.mac)) await saveKey(ip, clientKey);
        return tv;
    } catch (err) {
        tv.close();
        if (/denied|reject|cancel/i.test(err.message)) throw new Error('The TV declined the connection', { cause: err });
        if (!stored && /did not answer/.test(err.message)) throw new Error('Nobody accepted the prompt on the TV', { cause: err });
        throw err;
    }
}

// Wake a TV in standby and connect once it answers.
async function wakeAndConnect(ip, onWake) {
    const mac = keys[ip]?.mac || resolveMACFromARP(ip);
    if (!mac) throw new Error('The TV is off, and HomeCast does not know its MAC address to wake it');
    onWake?.();
    console.log(`[webOS] ${ip} is not answering; waking it (${mac})`);
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    let lastError;
    while (Date.now() < deadline) {
        await sendWOL(mac).catch(() => { /* retried */ });
        await new Promise(resolve => setTimeout(resolve, WAKE_RETRY_MS));
        try {
            return await connect(ip);
        } catch (err) {
            lastError = err;
        }
    }
    throw new Error('The TV did not wake up. Turn it on, or allow it to be turned on over the network ' +
        '("TV On With Mobile" or "Turn on via Wi-Fi" in its settings)', { cause: lastError });
}

// Connect to the TV, run `fn`, disconnect. `wake`: a paired TV that doesn't
// answer is woken with Wake-on-LAN first (casting does; stopping doesn't).
async function withTv(ip, fn, { onPrompt, onWake, wake = false } = {}) {
    if (!keysLoaded) await initKeyStore();
    let tv;
    try {
        tv = await connect(ip, onPrompt);
    } catch (err) {
        if (!wake || !keys[ip]?.key || /declined/.test(err.message)) throw err;
        tv = await wakeAndConnect(ip, onWake);
    }
    try {
        return await fn(tv);
    } finally {
        tv.close();
    }
}

// Click the page with the remote's pointer. The browser only goes full screen
// after a user gesture, and a click sent over the network counts. A key press
// doesn't: the browser's toolbar has keyboard focus, not the page. The pointer
// only clicks once it's showing, so it's nudged first, and hidden again after.
async function clickPage(tv) {
    const { socketPath } = await tv.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    const input = await openSocket(socketPath);
    const pause = () => new Promise(resolve => setTimeout(resolve, 200));
    input.send('type:move\ndx:5\ndy:5\ndown:0\n\n');
    await pause();
    input.send('type:move\ndx:-5\ndy:-5\ndown:0\n\n');
    await pause();
    input.send('type:click\n\n');
    await pause();
    // Then out of the picture: the TV hides the pointer when a button is
    // pressed (moving it can't: it stays inside the screen). Down does nothing
    // on the player page.
    input.send('type:button\nname:DOWN\n\n');
    await pause();
    input.close();
}

// ===== DISCOVERY =====

function fetchFriendlyName(location) {
    return new Promise((resolve) => {
        const req = http.get(location, { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body.match(/<friendlyName>([^<]+)<\/friendlyName>/)?.[1] || null));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Devices are one entry per IP. A TV whose Cast receiver answers on the same
// address stays a Cast device, flagged `webos` so it can be cast to either way.
function registerTv(ip, name, deviceId) {
    const existing = devices.get(ip);
    if (existing?.type === 'airplay') return;
    deviceLastSeen.set(ip, Date.now());
    if (existing?.type === 'webos' || existing?.webos) return;
    if (existing) {
        console.log(`[webOS] ${existing.name} (${ip}) also plays casts in its browser (webOS)`);
        existing.webos = true;
    } else {
        console.log(`[webOS] Found LG TV: ${name} (${ip})`);
        devices.set(ip, { name, ip, host: ip, id: deviceId, type: 'webos' });
    }
    broadcast({ type: 'devices', devices: [...devices.values()] });
}

function initWebOsDiscovery() {
    console.log('[webOS] Initializing SSDP scanner for LG TVs...');
    const search = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${SSAP_ST}\r\n` +
        '\r\n'
    );
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => {
        console.error('[webOS] SSDP socket error:', err.message);
        socket.close();
    });
    socket.on('message', async (msg, rinfo) => {
        const text = msg.toString();
        if (!text.includes(SSAP_ST)) return;
        const location = text.match(/^LOCATION:\s*(\S+)/im)?.[1];
        const deviceId = text.match(/^USN:\s*uuid:([^\s:]+)/im)?.[1] || null;
        const name = (location && await fetchFriendlyName(location)) || `LG TV (${rinfo.address})`;
        registerTv(rinfo.address, name, deviceId);
    });
    const send = () => socket.send(search, 0, search.length, SSDP_PORT, SSDP_ADDR, (err) => {
        if (err) console.error('[webOS] SSDP send error:', err.message);
    });
    socket.bind(() => send());
    onRescan(() => { try { send(); } catch { /* ignore */ } });
    setInterval(() => { try { send(); } catch { /* ignore */ } }, 30000).unref();
    return socket;
}

// ===== PLAYER PAGE =====

// Sessions waiting for their player page to check in (session id -> resolve).
const awaitingPlayer = new Map();

function sessionById(id) {
    return [...activeWebOsSessions.values()].find(s => s.id === id) || null;
}

// A message from a player page, over HomeCast's own WebSocket:
// { type: 'webosPlayer', session, event: 'hello' | 'status', status }.
// A hello is answered with what to play: { type: 'webosMedia', src, sub, subLang }.
function handlePlayerMessage(ws, msg) {
    const session = sessionById(msg.session);
    if (!session) return;
    if (msg.event === 'hello') {
        session.socket = ws;
        ws.send(JSON.stringify({ type: 'webosMedia', session: session.id, ...session.media }));
        clearTimeout(session.graceTimer);
        ws.once('close', () => onPlayerGone(session, ws));
        awaitingPlayer.get(session.id)?.();
        return;
    }
    if (msg.event !== 'status' || !msg.status) return;
    const status = msg.status;
    if (status.fullscreenError) {
        console.warn(`[webOS] Player could not go full screen: ${status.fullscreenError}`);
        return;
    }
    if (status.fullscreen && !session.fullscreen) console.log(`[webOS] Player on ${session.ip} is full screen`);
    if (status.fullscreen !== undefined) session.fullscreen = status.fullscreen;
    if (status.fullscreen === false && status.playerState === 'PLAYING') ensureFullScreen(session);
    if (status.playerState === 'IDLE') {
        // Played to the end: leave the browser the way Stop does.
        stopWebOsCasting(session.ip).catch(() => { /* logged there */ });
        return;
    }
    if (status.error) {
        broadcast({ type: 'castError', deviceIp: session.ip, message: `The TV could not play this stream (${status.error})` });
        return;
    }
    broadcast({
        type: 'playerStatus',
        deviceIp: session.ip,
        status: {
            playerState: status.playerState,
            currentTime: status.currentTime,
            media: {
                duration: status.live ? null : status.duration,
                streamType: status.live ? 'LIVE' : 'BUFFERED'
            },
            ...(status.live && status.seekableEnd ? {
                liveSeekableRange: { start: status.seekableStart || 0, end: status.seekableEnd, isMovingWindow: true }
            } : {})
        },
        delay: status.live && status.seekableEnd ? Math.max(0, status.seekableEnd - status.currentTime) : 0
    });
}

// The browser only goes full screen after a user gesture, so HomeCast clicks
// the page once the video plays. The page keeps reporting whether it's full
// screen, so a click that didn't land is tried again a few times.
function ensureFullScreen(session) {
    const now = Date.now();
    session.clicks = session.clicks || 0;
    if (session.clicks >= MAX_CLICKS || now - (session.lastClick || 0) < CLICK_INTERVAL_MS) return;
    session.clicks++;
    session.lastClick = now;
    console.log(`[webOS] Clicking the player for full screen on ${session.ip} (attempt ${session.clicks})`);
    withTv(session.ip, clickPage).catch(err => console.warn(`[webOS] Full screen click failed: ${err.message}`));
}

// The page closed its connection: the viewer pressed Back or Exit, or the TV
// went off. Unless it reconnects shortly, the cast is over.
function onPlayerGone(session, ws) {
    if (session.socket !== ws || activeWebOsSessions.get(session.ip) !== session) return;
    session.socket = null;
    clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => {
        if (activeWebOsSessions.get(session.ip) !== session || session.socket) return;
        console.log(`[webOS] Player page on ${session.ip} is gone; ending the session`);
        endSession(session.ip, 'Playback stopped on the TV');
    }, PLAYER_GRACE_MS);
}

function endSession(ip, message) {
    const session = activeWebOsSessions.get(ip);
    if (!session) return;
    clearTimeout(session.graceTimer);
    activeWebOsSessions.delete(ip);
    streamStats.delete(ip);
    broadcast({ type: 'playerStatus', deviceIp: ip, status: { playerState: 'IDLE' }, delay: 0 });
    broadcast({ type: 'status', status: message });
}

function sendToPlayer(session, command) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
        throw new Error('The player on the TV is not connected');
    }
    session.socket.send(JSON.stringify({ type: 'webosCommand', session: session.id, ...command }));
}

// ===== CASTING =====

// The TV app to go back to when the cast stops (the input or app it was on).
async function foregroundApp(tv) {
    try {
        const { appId } = await tv.request('ssap://com.webos.applicationManager/getForegroundAppInfo');
        return appId && appId !== BROWSER_APP ? appId : null;
    } catch {
        return null;
    }
}

async function castToWebOsDevice(ip, url, referer, quality, res, type, subtitle) {
    const host = `${getLocalIp()}:${PORT}`;
    // Always through the proxy: the TV's browser sends an Origin header some
    // CDNs refuse (pscp.tv answers 403), and the proxy fixes frame-rate headers.
    const src = buildProxyUrl(host, { url, referer, quality, type, device: 'webos' });
    const id = crypto.randomUUID();
    // What the player page plays, sent to it when it checks in. The URL the
    // TV opens stays short: with a long one, the browser keeps focus in its
    // address bar and the page never gets the OK press it needs.
    const media = {
        src,
        sub: subtitle?.url ? buildProxyUrl(host, { url: subtitle.url, referer, type: 'subtitle' }) : null,
        subLang: subtitle?.language || subtitle?.label || null
    };
    const playerUrl = `http://${host}/webos-player.html?session=${id}`;

    console.log(`[webOS] Casting to ${ip}: ${src}`);
    const previous = activeWebOsSessions.get(ip);
    if (previous) endSession(ip, 'Replaced by a new cast');

    const session = { id, ip, url, referer, media, finalUrl: src, startTime: Date.now(), socket: null, returnTo: previous?.returnTo || null };
    activeWebOsSessions.set(ip, session);
    const playerReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
            `The TV opened its browser, but the player page did not load. Check that the TV can reach http://${host}`
        )), PLAYER_CONNECT_TIMEOUT_MS);
        awaitingPlayer.set(id, () => { clearTimeout(timer); resolve(); });
    });

    const name = devices.get(ip)?.name || ip;
    try {
        await withTv(ip, async (tv) => {
            session.returnTo = session.returnTo || await foregroundApp(tv);
            // Launched rather than opened: the TV only lets HomeCast close an
            // app session it started, by its id.
            const launched = await tv.request('ssap://system.launcher/launch', { id: BROWSER_APP, params: { target: playerUrl } });
            session.browserSession = launched.sessionId || null;
            await playerReady;
        }, {
            wake: true,
            onPrompt: () => broadcast({ type: 'status', status: `Accept HomeCast on ${name}: a prompt is showing on the TV` }),
            onWake: () => broadcast({ type: 'status', status: `Waking ${name}…` })
        });
    } catch (err) {
        awaitingPlayer.delete(id);
        if (activeWebOsSessions.get(ip) === session) activeWebOsSessions.delete(ip);
        console.error(`[webOS] Cast to ${ip} failed: ${err.message}`);
        if (!res.headersSent) {
            const unreachable = /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|handshake/i.test(err.message);
            res.status(502).json({
                error: unreachable
                    ? `Could not reach ${name}. Make sure the TV is on (LG Connect Apps / Mobile TV On in its settings keeps it reachable).`
                    : err.message
            });
        }
        return;
    }
    awaitingPlayer.delete(id);

    streamStats.set(ip, { totalBytes: 0, segmentCount: 0, startTime: Date.now(), lastActivity: Date.now() });
    broadcast({ type: 'status', status: `Playing on ${name}` });
    if (!res.headersSent) res.json({ status: 'casting', deviceType: 'webos' });
}

async function stopWebOsCasting(ip) {
    const session = activeWebOsSessions.get(ip);
    if (!session) return;
    console.log(`[webOS] Stopping playback on ${ip}`);
    try { sendToPlayer(session, { action: 'stop' }); } catch { /* page already gone */ }
    endSession(ip, 'Playback stopped on ' + (devices.get(ip)?.name || ip));
    if (!session.returnTo && !session.browserSession) return;
    try {
        await withTv(ip, async (tv) => {
            // Back to what the TV showed before, or just close the browser.
            if (session.returnTo) await tv.request('ssap://system.launcher/launch', { id: session.returnTo });
            else if (session.browserSession) {
                await tv.request('ssap://system.launcher/close', { id: BROWSER_APP, sessionId: session.browserSession });
            }
        });
    } catch (err) {
        console.warn(`[webOS] Could not leave the browser on ${ip}: ${err.message}`);
    }
}

// Transport controls go to the player page; the volume is the TV's own.
async function controlWebOsPlayback(ip, action, value) {
    const session = activeWebOsSessions.get(ip);
    if (!session) throw new Error('No active session found for this device');

    if (action === 'volume' || action === 'mute') {
        return withTv(ip, async (tv) => {
            if (action === 'volume') await tv.request('ssap://audio/setVolume', { volume: Math.round(value * 100) });
            else await tv.request('ssap://audio/setMute', { mute: value });
            const status = await tv.request('ssap://audio/getVolume');
            const volume = readVolume(status);
            broadcast({ type: 'volume', deviceIp: ip, volume });
            return { volume };
        });
    }
    sendToPlayer(session, { action, value });
    return { volume: null };
}

function readVolume(status) {
    const v = status.volumeStatus || status;
    return { level: (v.volume ?? 0) / 100, muted: !!(v.muteStatus ?? v.mute) };
}

// The TV's volume, for a dashboard showing its session.
async function webOsVolume(ip) {
    try {
        return await withTv(ip, async (tv) => readVolume(await tv.request('ssap://audio/getVolume')));
    } catch {
        return null;
    }
}

module.exports = {
    initWebOsDiscovery,
    initKeyStore,
    castToWebOsDevice,
    stopWebOsCasting,
    controlWebOsPlayback,
    webOsVolume,
    handlePlayerMessage
};
