// HEVC conversion for Chromecast: the playlist and fMP4 helpers, then the whole
// path through /proxy with a real ffmpeg (software x265, so it runs without a
// GPU; skipped where ffmpeg isn't installed). The fixture CDN lives on
// 127.0.0.1, so the SSRF guard is off for this run.
process.env.DISABLE_SSRF_PROTECTION = 'true';
process.env.TRANSCODE_ENCODER = 'x265';

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');
const transcoder = require('../lib/transcode');

const box = (type, body = Buffer.alloc(0)) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
};

// Every tfdt (baseMediaDecodeTime) in an fMP4 fragment, in order.
function tfdts(mp4) {
    const out = [];
    const walk = (start, end) => {
        for (let o = start; o + 8 <= end;) {
            const size = mp4.readUInt32BE(o);
            const type = mp4.toString('latin1', o + 4, o + 8);
            if (type === 'moof' || type === 'traf') walk(o + 8, o + size);
            if (type === 'tfdt') out.push(Number(mp4[o + 8] === 1 ? mp4.readBigUInt64BE(o + 12) : mp4.readUInt32BE(o + 12)));
            o += size;
        }
    };
    walk(0, mp4.length);
    return out;
}

// The AAC AudioSpecificConfig in an init segment's esds box: the
// DecoderSpecificInfo (tag 5) inside the DecoderConfigDescriptor (tag 4)
// inside the ES_Descriptor (tag 3). Null if absent.
function audioSpecificConfig(mp4) {
    const at = mp4.indexOf('esds');
    if (at === -1) return null;
    const end = at - 4 + mp4.readUInt32BE(at - 4);
    const find = (tag, start, stop) => {
        for (let o = start; o < stop;) {
            const t = mp4[o++];
            let len = 0;
            for (let i = 0; i < 4; i++) {
                const b = mp4[o++];
                len = (len << 7) | (b & 0x7f);
                if (!(b & 0x80)) break;
            }
            if (t === tag) return { start: o, stop: o + len };
            o += len;
        }
        return null;
    };
    const es = find(0x03, at + 8, end); // after the box's version/flags
    const config = es && find(0x04, es.start + 3, es.stop); // ES_ID + flags
    const info = config && find(0x05, config.start + 13, config.stop); // fixed fields
    return info ? mp4.subarray(info.start, info.stop) : null;
}

// --- Helpers ---

test('an fMP4 splits into its init section and media fragments', () => {
    const init = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(16))]);
    const media = Buffer.concat([box('moof', Buffer.alloc(4)), box('mdat', Buffer.alloc(32))]);
    const parts = transcoder.splitInit(Buffer.concat([init, media]));
    assert.ok(parts.init.equals(init));
    assert.ok(parts.media.equals(media));
    assert.strictEqual(transcoder.splitInit(init), null, 'no fragments, nothing to serve');
});

test('a converted media playlist gets one init map before its first segment', () => {
    const out = transcoder.addInitMap([
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
        '#EXT-X-PROGRAM-DATE-TIME:2026-09-28T12:00:00Z', '#EXTINF:2.0,', 'a', '#EXTINF:2.0,', 'b'
    ].join('\n'), 'http://h/init');
    const lines = out.split('\n');
    assert.strictEqual(lines.filter(l => l.startsWith('#EXT-X-MAP')).length, 1);
    assert.strictEqual(lines.indexOf('#EXT-X-MAP:URI="http://h/init"'), lines.indexOf('#EXTINF:2.0,') - 1);
    assert.ok(out.includes('#EXT-X-VERSION:6'), 'EXT-X-MAP needs version 6');
});

test('the master declares HEVC for the converted variant and keeps the audio codec', () => {
    const out = transcoder.declareHevc('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"\nv.m3u8\n');
    assert.ok(out.includes(`CODECS="${transcoder.HEVC_CODEC},mp4a.40.2"`));
});

test('only unencrypted MPEG-TS segments can be converted', () => {
    assert.strictEqual(transcoder.canConvertMediaPlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n'), true);
    assert.strictEqual(transcoder.canConvertMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\na.ts\n'), true);
    assert.strictEqual(transcoder.canConvertMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n'), false);
    assert.strictEqual(transcoder.canConvertMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n'), false);
});

// --- Through the proxy ---

let hasX265 = false;
try {
    hasX265 = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx265');
} catch { /* no ffmpeg */ }

// Two consecutive 1s segments of one H.264/AAC stream, cut the way a live
// packager does: each starts on a keyframe and carries on the timeline.
function makeSegments() {
    const ts = (start) => execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-ss', String(start), '-t', '1', '-c:v', 'libx264', '-g', '30', '-c:a', 'aac',
        '-output_ts_offset', String(100 + start), '-muxdelay', '0', '-muxpreload', '0',
        '-f', 'mpegts', 'pipe:1'
    ], { maxBuffer: 16 * 1024 * 1024 });
    return [ts(0), ts(1)];
}

// Declared as 4K H.264, which is what decides conversion; the pixels can be small.
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"
uhd/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
hd/index.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:1
#EXTINF:1.0,
seg0.ts
#EXTINF:1.0,
seg1.ts
`;

let base;
let cdn;
let server;
let segments;

before(async () => {
    if (!hasX265) return;
    segments = makeSegments();
    await transcoder.detect();
    cdn = http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        if (path === '/show/master.m3u8') return res.end(MASTER);
        if (path === '/show/uhd/index.m3u8') return res.end(MEDIA);
        const seg = /^\/show\/uhd\/seg(\d)\.ts$/.exec(path);
        if (seg) return res.end(segments[Number(seg[1])]);
        res.statusCode = 404;
        res.end();
    });
    await new Promise(r => cdn.listen(0, '127.0.0.1', r));
    ({ server } = require('../server'));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    cdn?.close();
    server?.close();
});

const proxied = (url, extra = '') => `${base}/proxy?url=${encodeURIComponent(url)}&quality=2160&type=hls${extra}`;
const get = async (url) => {
    const res = await fetch(url);
    return { res, body: Buffer.from(await res.arrayBuffer()) };
};

test('a 4K H.264 variant reaches the receiver as HEVC fMP4 on a continuous timeline', { skip: !hasX265 && 'ffmpeg with libx265 not installed' }, async () => {
    const cdnBase = `http://127.0.0.1:${cdn.address().port}/show`;

    const master = (await get(proxied(`${cdnBase}/master.m3u8`, '&transcode=hevc'))).body.toString();
    assert.ok(master.includes(`CODECS="${transcoder.HEVC_CODEC},mp4a.40.2"`), master);
    const variantUrl = master.split('\n').find(l => l.startsWith('http'));
    assert.ok(variantUrl.includes('transcode=hevc'));

    const media = (await get(variantUrl)).body.toString();
    const initUrl = media.match(/#EXT-X-MAP:URI="([^"]+)"/)[1];
    const segmentUrls = media.split('\n').filter(l => l.startsWith('http'));
    assert.strictEqual(segmentUrls.length, 2);
    assert.ok(segmentUrls.every(u => u.includes('transcode=hevc')));

    const init = await get(initUrl);
    assert.strictEqual(init.res.headers.get('content-type'), 'video/mp4');
    assert.strictEqual(init.body.toString('latin1', 4, 8), 'ftyp');
    assert.ok(init.body.includes('hvc1'), 'declares HEVC');
    // Without the AAC config in the init, Cast receivers fail the load.
    assert.ok(audioSpecificConfig(init.body)?.length >= 2, 'init carries the AAC decoder config');

    const [first, second] = await Promise.all(segmentUrls.map(get));
    for (const seg of [first, second]) assert.strictEqual(seg.body.toString('latin1', 4, 8), 'moof');

    // Source timestamps survive: video starts ~100s in (90kHz), and the
    // second segment picks up one second after the first.
    const [v0] = tfdts(first.body);
    const [v1] = tfdts(second.body);
    assert.ok(Math.abs(v0 / 90000 - 100) < 0.2, `first segment at ${v0 / 90000}s`);
    assert.ok(Math.abs((v1 - v0) / 90000 - 1) < 0.05, `segments ${(v1 - v0) / 90000}s apart`);
});

test('without the flag the same variant passes through untouched', { skip: !hasX265 && 'ffmpeg with libx265 not installed' }, async () => {
    const cdnBase = `http://127.0.0.1:${cdn.address().port}/show`;
    const master = (await get(proxied(`${cdnBase}/master.m3u8`))).body.toString();
    assert.ok(master.includes('avc1.640033'));
    assert.ok(!master.includes('transcode=hevc'));
});
