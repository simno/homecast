// Casting to LG TVs (lib/webos.js, lib/h264-timing.js) through the fully wired
// app: the proxy's device=webos mode (every variant kept, frame-rate headers
// corrected) and the player page's WebSocket protocol. The TV's own API isn't
// exercised; the fixtures live on 127.0.0.1, so the SSRF guard is off.
process.env.DISABLE_SSRF_PROTECTION = 'true';

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const { server } = require('../server');
const { activeWebOsSessions } = require('../lib/state');
const { declaredFrameRate, measuredFrameRate, tickRateFor, inspectSegment } = require('../lib/h264-timing');

// SPS NAL units from real streams: X/Periscope 4K declaring 1000 fps, the same
// after correction, and a plain x264 30 fps encode.
const SPS_X = '67640033acd9403c0043e84000000300400001f403c60c6580';
const SPS_FIXED = '67640033acd9403c0043e8400000fa40003a9803c60c6580';
const SPS_30 = '67640033acd9403c0043ec0440000003004000000f03c60c6580';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"
uhd/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
hd/index.m3u8
`;

// A short H.264 TS segment whose header claims 1000 fps, like X's; null when
// this machine's ffmpeg can't make one.
function makeMislabelledSegment() {
    try {
        return execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=30000/1001', '-t', '1',
            '-c:v', 'libx264', '-bsf:v', 'h264_metadata=tick_rate=2000/1',
            '-f', 'mpegts', 'pipe:1'
        ], { maxBuffer: 16 * 1024 * 1024 });
    } catch {
        return null;
    }
}
const SEGMENT = makeMislabelledSegment();

let base;
let cdn;

const upstream = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/show/master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(MASTER);
    }
    if (path === '/show/seg.ts' && SEGMENT) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        return res.end(SEGMENT);
    }
    res.writeHead(404);
    res.end();
});

before(async () => {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    cdn = `http://127.0.0.1:${upstream.address().port}`;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
});

function proxyUrl(url, extra = '') {
    return `${base}/proxy?url=${encodeURIComponent(url)}&quality=highest${extra}`;
}

// ===== Frame-rate headers =====

test('reads the frame rate an SPS declares', () => {
    assert.strictEqual(declaredFrameRate(Buffer.from(SPS_X, 'hex')), 1000);
    assert.ok(Math.abs(declaredFrameRate(Buffer.from(SPS_FIXED, 'hex')) - 29.97) < 0.01);
    assert.strictEqual(declaredFrameRate(Buffer.from(SPS_30, 'hex')), 30);
});

test('measures the frame rate from millisecond-rounded timestamps', () => {
    // 29.97 fps, rounded to whole milliseconds the way X's are, in decode order.
    const pts = Array.from({ length: 60 }, (_, i) => Math.round(i * 1001 / 30) * 90);
    [pts[1], pts[3]] = [pts[3], pts[1]];
    assert.ok(Math.abs(measuredFrameRate(pts) - 29.97) < 0.05);
});

test('picks the standard tick rate for a measured frame rate', () => {
    assert.strictEqual(tickRateFor(29.98), '60000/1001');
    assert.strictEqual(tickRateFor(25), '50/1');
    assert.strictEqual(tickRateFor(59.94), '120000/1001');
    assert.strictEqual(tickRateFor(12), '24000/1000');
});

test('leaves segments that are not MPEG-TS alone', () => {
    assert.strictEqual(inspectSegment(Buffer.alloc(1000, 1)), null);
});

test('finds the wrong header in a mislabelled segment', { skip: !SEGMENT && 'ffmpeg with libx264 not available' }, () => {
    const info = inspectSegment(SEGMENT);
    assert.strictEqual(info.declared, 1000);
    assert.strictEqual(info.fix, '60000/1001');
});

// ===== Proxy =====

test('keeps the 4K H.264 variant for an LG TV and flags its child requests', async () => {
    const body = await (await fetch(proxyUrl(`${cdn}/show/master.m3u8`, '&type=hls&device=webos'))).text();
    assert.match(body, /RESOLUTION=3840x2160/);
    assert.doesNotMatch(body, /RESOLUTION=1920x1080/);
    const child = body.split('\n').find(l => l.startsWith('http'));
    assert.match(child, /&device=webos$/);
});

test('still skips 4K H.264 for a Chromecast', async () => {
    const body = await (await fetch(proxyUrl(`${cdn}/show/master.m3u8`, '&type=hls'))).text();
    assert.match(body, /RESOLUTION=1920x1080/);
    assert.doesNotMatch(body, /3840x2160/);
});

test('corrects the frame-rate header of a segment sent to an LG TV', { skip: !SEGMENT && 'ffmpeg with libx264 not available' }, async () => {
    const res = await fetch(proxyUrl(`${cdn}/show/seg.ts`, '&device=webos'));
    assert.strictEqual(res.status, 200);
    const fixed = Buffer.from(await res.arrayBuffer());
    const info = inspectSegment(fixed);
    assert.ok(Math.abs(info.declared - 29.97) < 0.01);
    assert.strictEqual(info.fix, null);

    // Other receivers get the bytes as they came.
    const plain = Buffer.from(await (await fetch(proxyUrl(`${cdn}/show/seg.ts`))).arrayBuffer());
    assert.ok(plain.equals(SEGMENT));
});

// ===== Player page =====

function openSocket() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace('http', 'ws'));
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function nextMessage(ws, predicate) {
    return new Promise((resolve) => {
        const onMessage = (data) => {
            const msg = JSON.parse(data);
            if (!predicate(msg)) return;
            ws.off('message', onMessage);
            resolve(msg);
        };
        ws.on('message', onMessage);
    });
}

test('the player page gets its stream and reports playback to the dashboard', async () => {
    // No TV API listens here, so ending the session fails fast to reach one.
    const ip = '127.0.0.1';
    const media = { src: `${base}/proxy?url=x`, sub: null, subLang: 'en' };
    activeWebOsSessions.set(ip, { id: 'session-1', ip, media, startTime: Date.now(), socket: null });
    const dashboard = await openSocket();
    const player = await openSocket();

    try {
        const loaded = nextMessage(player, m => m.type === 'webosMedia');
        player.send(JSON.stringify({ type: 'webosPlayer', session: 'session-1', event: 'hello' }));
        assert.deepStrictEqual(await loaded, { type: 'webosMedia', session: 'session-1', ...media });

        const reported = nextMessage(dashboard, m => m.type === 'playerStatus' && m.deviceIp === ip);
        player.send(JSON.stringify({
            type: 'webosPlayer', session: 'session-1', event: 'status',
            status: { playerState: 'PLAYING', currentTime: 12, duration: 600, live: false, fullscreen: true }
        }));
        const { status } = await reported;
        assert.strictEqual(status.playerState, 'PLAYING');
        assert.strictEqual(status.currentTime, 12);
        assert.deepStrictEqual(status.media, { duration: 600, streamType: 'BUFFERED' });

        // Played to the end: the session is over.
        const ended = nextMessage(dashboard, m => m.type === 'playerStatus' && m.status.playerState === 'IDLE');
        player.send(JSON.stringify({ type: 'webosPlayer', session: 'session-1', event: 'status', status: { playerState: 'IDLE' } }));
        await ended;
        assert.strictEqual(activeWebOsSessions.has(ip), false);
    } finally {
        activeWebOsSessions.delete(ip);
        dashboard.close();
        player.close();
    }
});

test('messages for an unknown session are ignored', async () => {
    const player = await openSocket();
    try {
        player.send(JSON.stringify({ type: 'webosPlayer', session: 'nope', event: 'hello' }));
        const reply = await Promise.race([
            nextMessage(player, m => m.type === 'webosMedia'),
            new Promise(resolve => setTimeout(() => resolve(null), 300))
        ]);
        assert.strictEqual(reply, null);
    } finally {
        player.close();
    }
});
