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
const { declaredFrameRate, measuredFrameRate, tickRateFor, inspectSegment, patchSegmentTiming, rewriteSps } = require('../lib/h264-timing');

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

// Several chunks long, so it is still arriving when the proxy looks at its start.
const NOT_TS = Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 7) % 256));

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10M">
  <Period id="1">
    <AdaptationSet contentType="video" mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4" duration="4" timescale="1"/>
      <Representation id="v2160" codecs="avc1.640033" bandwidth="15000000" width="3840" height="2160"/>
      <Representation id="v1080" codecs="avc1.640028" bandwidth="8000000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;

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
    // A CDN that names and labels its segments generically.
    if (path === '/show/chunk/42' && SEGMENT) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(SEGMENT);
    }
    if (path === '/show/manifest.mpd') {
        res.writeHead(200, { 'Content-Type': 'application/dash+xml' });
        return res.end(MPD);
    }
    if (path === '/show/clip.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(NOT_TS);
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

test('rewrites the SPS timing, re-escaping it', () => {
    const fixed = rewriteSps(Buffer.from(SPS_X, 'hex'), 1001, 60000);
    assert.strictEqual(fixed.toString('hex'), SPS_FIXED);
});

test('leaves segments that are not MPEG-TS alone', () => {
    assert.strictEqual(inspectSegment(Buffer.alloc(1000, 1)), null);
});

test('finds the wrong header in a mislabelled segment', { skip: !SEGMENT && 'ffmpeg with libx264 not available' }, () => {
    const info = inspectSegment(SEGMENT);
    assert.strictEqual(info.declared, 1000);
    assert.strictEqual(info.fix, '60000/1001');
});

test('corrects the header in place, moving nothing else', { skip: !SEGMENT && 'ffmpeg with libx264 not available' }, () => {
    const patched = patchSegmentTiming(SEGMENT, '60000/1001');
    assert.strictEqual(patched.length, SEGMENT.length);
    assert.ok(Math.abs(inspectSegment(patched).declared - 29.97) < 0.01);
    let changed = 0;
    for (let i = 0; i < SEGMENT.length; i++) if (patched[i] !== SEGMENT[i]) changed++;
    assert.ok(changed > 0 && changed < 32, `${changed} bytes changed`);
});

// ===== Proxy =====

test('keeps the 4K H.264 variant for an LG TV and flags its child requests', async () => {
    const body = await (await fetch(proxyUrl(`${cdn}/show/master.m3u8`, '&type=hls&device=webos'))).text();
    assert.match(body, /RESOLUTION=3840x2160/);
    assert.doesNotMatch(body, /RESOLUTION=1920x1080/);
    const child = body.split('\n').find(l => l.startsWith('http'));
    assert.match(child, /&device=webos$/);
});

test('keeps the 4K H.264 rendition of a DASH stream for an LG TV', async () => {
    const lg = await (await fetch(proxyUrl(`${cdn}/show/manifest.mpd`, '&type=dash&device=webos'))).text();
    assert.match(lg, /id="v2160"/);
    assert.doesNotMatch(lg, /id="v1080"/);
    const cast = await (await fetch(proxyUrl(`${cdn}/show/manifest.mpd`, '&type=dash'))).text();
    assert.match(cast, /id="v1080"/);
    assert.doesNotMatch(cast, /id="v2160"/);
});

test('the player page may play Media Source blobs (dash.js)', async () => {
    const res = await fetch(`${base}/webos-player.html`);
    await res.text();
    assert.match(res.headers.get('content-security-policy'), /media-src 'self' blob:/);
    const script = await fetch(`${base}/vendor/dash.all.min.js`);
    await script.arrayBuffer();
    assert.strictEqual(script.status, 200);
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

test('recognises a TS segment by its content, not its name', { skip: !SEGMENT && 'ffmpeg with libx264 not available' }, async () => {
    const res = await fetch(proxyUrl(`${cdn}/show/chunk/42`, '&device=webos'));
    const fixed = Buffer.from(await res.arrayBuffer());
    assert.ok(Math.abs(inspectSegment(fixed).declared - 29.97) < 0.01);
});

test('passes anything that is not TS through to an LG TV untouched', async () => {
    const res = await fetch(proxyUrl(`${cdn}/show/clip.mp4`, '&device=webos'));
    assert.strictEqual(res.status, 200);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(NOT_TS));
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
