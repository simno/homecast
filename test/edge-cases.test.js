// Awkward inputs to the code that turns URLs and playlists into casts:
// line endings, blank and padded lines, malformed URIs, non-ASCII URLs, and
// the content type sent to the receiver.
const { test } = require('node:test');
const assert = require('assert');
const { rewritePlaylist, filterMasterPlaylist, resolveM3u8Url, buildProxyUrl } = require('../lib/proxy');
const { getContentType } = require('../lib/cast');

const BASE = new URL('https://cdn.example/show/master.m3u8');
const mark = (url, isPlaylist) => `P(${isPlaylist ? 'hls' : 'bin'}):${url}`;

// --- Playlist text ---

test('CRLF playlists are rewritten without a carriage return in any URL', () => {
    const out = rewritePlaylist('#EXTM3U\r\n#EXTINF:4,\r\nseg1.ts\r\n', BASE, mark);
    assert.ok(out.includes('P(bin):https://cdn.example/show/seg1.ts\n'), JSON.stringify(out));
    assert.ok(!/P\([a-z]+\):\S*\r/.test(out));
});

test('an empty playlist stays empty', () => {
    assert.strictEqual(rewritePlaylist('', BASE, mark), '');
    assert.strictEqual(filterMasterPlaylist('', 'highest'), '');
});

test('blank lines are kept and padded URIs are trimmed', () => {
    assert.strictEqual(rewritePlaylist('#EXTM3U\n\n#EXTINF:4,\n  seg1.ts  \n', BASE, mark),
        '#EXTM3U\n\n#EXTINF:4,\nP(bin):https://cdn.example/show/seg1.ts\n');
});

test('quality capping works on CRLF masters too', () => {
    const master = '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=900\r\nlo.m3u8\r\n#EXT-X-STREAM-INF:BANDWIDTH=5000\r\nhi.m3u8\r\n';
    assert.strictEqual(filterMasterPlaylist(master, 'highest'), '#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=5000\r\nhi.m3u8\r\n');
});

test('a malformed URI is left alone rather than breaking the playlist', () => {
    assert.deepStrictEqual(resolveM3u8Url('http://[bad', BASE), { isUrl: false, url: null });
});

test('a 5,000-character segment URI survives rewriting intact', () => {
    const long = `https://cdn.example/${'x'.repeat(5000)}.ts`;
    assert.ok(rewritePlaylist(`#EXTM3U\n#EXTINF:4,\n${long}\n`, BASE, mark).includes(`P(bin):${long}`));
});

// --- Proxy URLs ---

test('non-ASCII and pre-encoded URLs round-trip through the proxy URL unchanged', () => {
    const url = 'https://cdn.example/видео/a b.m3u8?x=1&y=%2F';
    const referer = 'https://site.example/?q=1&z';
    const params = new URL(buildProxyUrl('10.0.0.2:3000', { url, referer, type: 'hls' })).searchParams;
    assert.strictEqual(params.get('url'), url);
    assert.strictEqual(params.get('referer'), referer);
    assert.strictEqual(params.get('type'), 'hls');
    assert.strictEqual(params.get('quality'), 'highest');
});

// --- Content type sent to the receiver ---

for (const [name, url, hint, expected] of [
    ['the extractor\'s verdict beats the URL', 'https://cdn.example/stream', 'hls', 'application/x-mpegURL'],
    ['DASH by extension', 'https://cdn.example/manifest.mpd?t=1', undefined, 'application/dash+xml'],
    ['HLS by extension, in any case', 'https://cdn.example/STREAM.M3U8', undefined, 'application/x-mpegURL'],
    ['HLS by a "playlist" path', 'https://cdn.example/video/playlist?id=123', undefined, 'application/x-mpegURL'],
    ['WebM by extension', 'https://cdn.example/clip.webm', undefined, 'video/webm'],
    ['MP4 when nothing says otherwise', 'https://cdn.example/clip.xyz', undefined, 'video/mp4'],
    ['an MP4 hint for an extensionless URL', 'https://cdn.example/api/v/9', 'mp4', 'video/mp4']
]) {
    test(`content type: ${name}`, () => {
        assert.strictEqual(getContentType(url, hint).contentType, expected);
    });
}
