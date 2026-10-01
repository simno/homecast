// YouTube's HLS through the proxy (routes/proxy.js): segment URLs that look
// like playlists, and packed audio renditions rewrapped as MPEG-TS for Cast
// receivers. The fixtures live on 127.0.0.1, so the SSRF guard is off.
process.env.DISABLE_SSRF_PROTECTION = 'true';

const { test, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const { server } = require('../server');

// Like YouTube's: the segment URLs carry /playlist/index.m3u8/ and
// playlist_type among their signed parameters.
const seg = (itag, n) => `/videoplayback/itag/${itag}/playlist_type/DVR/playlist/index.m3u8/sq/${n}`;

const MASTER = `#EXTM3U
#EXT-X-MEDIA:URI="/manifest/audio/234/index.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"
/manifest/video/270/index.m3u8
`;
const mediaPlaylist = (itag) => `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:5
#EXTINF:4.0,
${seg(itag, 0)}
#EXT-X-ENDLIST
`;

const TS_SEGMENT = Buffer.alloc(188 * 4, 0xff).fill(0x47, 0, 1);
for (let i = 0; i < 4; i++) TS_SEGMENT[i * 188] = 0x47;

// Packed audio: an ID3 tag with Apple's timestamp, then two ADTS frames.
function packedAudio() {
    const owner = Buffer.from('com.apple.streaming.transportStreamTimestamp\0', 'latin1');
    const body = Buffer.concat([owner, Buffer.from([0, 0, 0, 0, 0, 0x01, 0x5f, 0x90])]); // 90000 = 1s
    const tag = Buffer.concat([
        Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10 + body.length]),
        Buffer.from([0x50, 0x52, 0x49, 0x56, 0, 0, 0, body.length, 0, 0]), body
    ]);
    const frame = () => {
        const f = Buffer.alloc(200, 0x55);
        f.set([0xff, 0xf1, 0x50, 0x80, (200 >> 3) & 0xff, ((200 & 0x07) << 5) | 0x1f, 0xfc]);
        return f;
    };
    return Buffer.concat([tag, frame(), frame()]);
}
const PACKED = packedAudio();

let base;
let cdn;
const upstream = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/manifest/master') return res.end(MASTER);
    if (path === '/manifest/audio/234/index.m3u8') return res.end(mediaPlaylist(234));
    if (path === '/manifest/video/270/index.m3u8') return res.end(mediaPlaylist(270));
    if (path === seg(270, 0)) return res.end(TS_SEGMENT);
    if (path === seg(234, 0)) return res.end(PACKED);
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

const proxied = (url, extra = '') => `${base}/proxy?url=${encodeURIComponent(url)}&quality=highest&type=hls${extra}`;
const text = async (url) => (await fetch(url)).text();
const uris = (m3u8) => m3u8.split('\n').filter(l => l.startsWith('http'))
    .concat([...m3u8.matchAll(/URI="([^"]+)"/g)].map(m => m[1]));

test('the audio rendition is marked as audio; the video variant isn\'t', async () => {
    const master = await text(proxied(`${cdn}/manifest/master`));
    const [video, audio] = [uris(master).find(u => u.includes('270')), uris(master).find(u => u.includes('234'))];
    assert.match(audio, /&type=hls&audio=1$/);
    assert.doesNotMatch(video, /audio=1/);
});

test('segments listed in a media playlist are marked as segments, and piped through as they are', async () => {
    const playlist = await text(proxied(`${cdn}/manifest/video/270/index.m3u8`));
    const [segment] = uris(playlist);
    assert.match(segment, /&type=segment/);
    const body = Buffer.from(await (await fetch(segment)).arrayBuffer());
    assert.deepStrictEqual(body, TS_SEGMENT, 'a segment whose URL says playlist is not rewritten as one');
});

test('an audio rendition\'s packed audio comes back as MPEG-TS', async () => {
    const playlist = await text(proxied(`${cdn}/manifest/audio/234/index.m3u8`, '&audio=1'));
    const [segment] = uris(playlist);
    assert.match(segment, /&type=segment.*&audio=1/);
    const res = await fetch(segment);
    assert.strictEqual(res.headers.get('content-type'), 'video/mp2t');
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length % 188, 0);
    assert.strictEqual(body[0], 0x47);
});

test('an LG TV gets the packed audio as it is', async () => {
    const playlist = await text(proxied(`${cdn}/manifest/audio/234/index.m3u8`, '&audio=1&device=webos'));
    const body = Buffer.from(await (await fetch(uris(playlist)[0])).arrayBuffer());
    assert.deepStrictEqual(body, PACKED);
});
