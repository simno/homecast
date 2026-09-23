const assert = require('assert');
const { rewritePlaylist, buildProxyUrl } = require('../lib/proxy');

console.log('Running Playlist Rewrite Tests...\n');

let passed = 0;
let failed = 0;

function test(description, fn) {
    try {
        fn();
        console.log(`✓ ${description}`);
        passed++;
    } catch (err) {
        console.error(`✗ ${description}`);
        console.error(`  ${err.message}`);
        failed++;
    }
}

const BASE = new URL('https://cdn.example/show/ep1/master.m3u8');
// Mark each rewritten reference so the tests can see what went through.
const mark = (url, isPlaylist) => `P(${isPlaylist ? 'hls' : 'bin'}):${url}`;

test('bare segment lines in a media playlist are rewritten as binaries', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXTINF:4,\nseg1.ts\n', BASE, mark);
    assert.ok(out.includes('P(bin):https://cdn.example/show/ep1/seg1.ts'), out);
});

test('variant lines in a master are rewritten as playlists', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720/index\n', BASE, mark);
    assert.ok(out.includes('P(hls):https://cdn.example/show/ep1/720/index'), out);
});

test('fMP4 init segments (#EXT-X-MAP) are rewritten', () => {
    const out = rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"\n', BASE, mark);
    assert.strictEqual(out, '#EXTM3U\n#EXT-X-MAP:URI="P(bin):https://cdn.example/show/ep1/init.mp4",BYTERANGE="800@0"\n');
});

test('encryption keys (#EXT-X-KEY) are rewritten, attributes intact', () => {
    const out = rewritePlaylist('#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1",IV=0x1\n', BASE, mark);
    assert.strictEqual(out, '#EXT-X-KEY:METHOD=AES-128,URI="P(bin):https://cdn.example/show/keys/k1",IV=0x1\n');
});

test('alternate renditions (#EXT-X-MEDIA) are rewritten as playlists', () => {
    const out = rewritePlaylist('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/en.m3u8"\n', BASE, mark);
    assert.ok(out.includes('URI="P(hls):https://cdn.example/show/ep1/audio/en.m3u8"'), out);
});

test('DRM key identifiers and inline data URIs are left alone', () => {
    const skd = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-id"';
    const data = '#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"';
    assert.strictEqual(rewritePlaylist(skd, BASE, mark), skd);
    assert.strictEqual(rewritePlaylist(data, BASE, mark), data);
});

test('tags without URIs and comments pass through untouched', () => {
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-ENDLIST';
    assert.strictEqual(rewritePlaylist(text, BASE, mark), text);
});

test('buildProxyUrl encodes every part and adds the playlist hint only for HLS', () => {
    const plain = buildProxyUrl('10.0.0.2:3000', { url: 'https://a.example/x?y=1&z=2', referer: 'https://r.example/', quality: '720' });
    assert.strictEqual(plain, 'http://10.0.0.2:3000/proxy?url=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2&referer=https%3A%2F%2Fr.example%2F&quality=720');
    const hls = buildProxyUrl('h:1', { url: 'https://a.example/api/7', type: 'hls' });
    assert.ok(hls.endsWith('&referer=&quality=highest&type=hls'), hls);
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50) + '\n');

if (failed > 0) process.exit(1);
