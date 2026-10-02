// A fake LG webOS TV for tests: its second-screen API (SSAP, JSON over a
// WebSocket) with the "allow this device?" prompt, the pointer input socket,
// and a browser that "loads" HomeCast's player page by connecting to
// HomeCast's WebSocket and checking in the way public/js/webos-player.js does.
const http = require('http');
const WebSocket = require('ws');

// `soundOutput`: 'external_arc' plays through a soundbar, which (like a real
// one) ignores setVolume and only follows volume key presses.
function createFakeLgTv({ knownKey = null, prompt = 'accept', foregroundApp = 'com.webos.app.livetv', volume = 12, soundOutput = 'tv_speaker' } = {}) {
    const state = {
        knownKey,
        prompts: 0,
        requests: [],
        launched: [],
        closed: [],
        volume,
        muted: false,
        pointer: [],
        players: []
    };
    const subscribers = new Set();

    const volumePayload = () => ({ volumeStatus: { volume: state.volume, muteStatus: state.muted, soundOutput } });
    const soundbar = soundOutput === 'external_arc';

    // The browser opening HomeCast's player page: it connects and says hello.
    function openPlayer(target) {
        const url = new URL(target);
        const session = url.searchParams.get('session');
        const player = { session, messages: [], ws: new WebSocket(`ws://${url.host}`) };
        player.ready = new Promise((resolve) => {
            player.ws.on('open', () => {
                player.ws.send(JSON.stringify({ type: 'webosPlayer', session, event: 'hello' }));
                resolve();
            });
        });
        player.ws.on('message', (data) => player.messages.push(JSON.parse(data)));
        player.report = (status) => player.ws.send(JSON.stringify({ type: 'webosPlayer', session, event: 'status', status }));
        player.commands = () => player.messages.filter(m => m.type === 'webosCommand').map(m => m.action);
        state.players.push(player);
    }

    const handlers = {
        'ssap://com.webos.applicationManager/getForegroundAppInfo': () => ({ appId: foregroundApp }),
        'ssap://system.launcher/launch': (payload) => {
            state.launched.push(payload);
            if (payload.params?.target) openPlayer(payload.params.target);
            return { sessionId: `browser-${state.launched.length}` };
        },
        'ssap://system.launcher/close': (payload) => {
            state.closed.push(payload);
            return {};
        },
        'ssap://audio/getVolume': volumePayload,
        'ssap://audio/setVolume': (payload) => {
            if (!soundbar) state.volume = payload.volume;
            return {};
        },
        'ssap://audio/volumeUp': () => {
            state.volume = Math.min(100, state.volume + 1);
            return {};
        },
        'ssap://audio/volumeDown': () => {
            state.volume = Math.max(0, state.volume - 1);
            return {};
        },
        'ssap://audio/setMute': (payload) => {
            state.muted = payload.mute;
            return {};
        },
        'ssap://com.webos.service.networkinput/getPointerInputSocket': () => ({ socketPath: `ws://127.0.0.1:${port}/pointer` })
    };

    const server = http.createServer();
    const wss = new WebSocket.Server({ server });
    let port;

    wss.on('connection', (ws, req) => {
        if (req.url === '/pointer') {
            ws.on('message', (data) => state.pointer.push(String(data).split('\n')[0]));
            return;
        }
        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            const reply = (body) => ws.send(JSON.stringify({ id: msg.id, ...body }));
            if (msg.type === 'register') {
                const key = msg.payload['client-key'];
                if (key && key === state.knownKey) return reply({ type: 'registered', payload: { 'client-key': key } });
                state.prompts++;
                reply({ type: 'response', payload: { pairingType: 'PROMPT', returnValue: true } });
                if (prompt === 'decline') return reply({ type: 'error', error: '403 User denied access' });
                if (prompt === 'ignore') return;
                state.knownKey = `key-${state.prompts}`;
                return reply({ type: 'registered', payload: { 'client-key': state.knownKey } });
            }
            if (msg.type === 'subscribe' && msg.uri === 'ssap://audio/getVolume') {
                subscribers.add({ ws, id: msg.id });
                return reply({ type: 'response', payload: volumePayload() });
            }
            state.requests.push(msg.uri);
            const handler = handlers[msg.uri];
            if (!handler) return reply({ type: 'error', error: `404 no such service ${msg.uri}` });
            reply({ type: 'response', payload: handler(msg.payload || {}) });
        });
    });

    return {
        state,
        // The volume changed on the TV (its own remote): tell subscribers.
        changeVolume(level) {
            state.volume = level;
            for (const { ws, id } of subscribers) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, type: 'response', payload: volumePayload() }));
            }
        },
        lastPlayer: () => state.players[state.players.length - 1],
        listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve(port);
        })),
        close: async () => {
            for (const p of state.players) p.ws.terminate();
            for (const ws of wss.clients) ws.terminate();
            await new Promise(resolve => wss.close(() => server.close(resolve)));
        }
    };
}

module.exports = { createFakeLgTv };
