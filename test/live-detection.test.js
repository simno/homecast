const assert = require('assert');
const http = require('http');
const { isLiveHlsStream } = require('../lib/extraction');

console.log('Running Live Detection Tests...\n');

let passed = 0;
let failed = 0;

const tests = [];
function test(description, fn) {
    tests.push({ description, fn });
}

// A media playlist that is still growing: no #EXT-X-ENDLIST.
const LIVE_MEDIA = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:998',
    '#EXTINF:4.0,',
    'seg998.ts',
    '#EXTINF:4.0,',
    'seg999.ts',
    ''
].join('\n');

const VOD_MEDIA = LIVE_MEDIA + '#EXT-X-ENDLIST\n';

// Periscope/X mark a finished replay this way while still serving it through a
// live-shaped `master_dynamic_*` URL — the case that made playback end instantly.
const VOD_TYPE_MEDIA = [
    '#EXTM3U',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:3',
    '#EXTINF:2.0,',
    'chunk_0.ts',
    ''
].join('\n');

// Serves whichever media playlist `mode` currently points at, so a single
// server can stand in for both a live stream and a finished recording.
let mode = 'live';
const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    const port = server.address().port;

    if (req.url.startsWith('/absolute-master')) {
        res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nhttp://127.0.0.1:${port}/variant.m3u8\n`);
        return;
    }
    if (req.url.startsWith('/relative-master')) {
        res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nnested/variant.m3u8\n');
        return;
    }
    if (req.url.includes('variant')) {
        if (mode === 'live') res.end(LIVE_MEDIA);
        else if (mode === 'vod') res.end(VOD_MEDIA);
        else res.end(VOD_TYPE_MEDIA);
        return;
    }
    res.statusCode = 404;
    res.end();
});

let base;

test('live media playlist behind a master is live', async () => {
    mode = 'live';
    assert.strictEqual(await isLiveHlsStream(`${base}/absolute-master.m3u8`), true);
});

test('#EXT-X-ENDLIST behind a master is not live', async () => {
    mode = 'vod';
    assert.strictEqual(await isLiveHlsStream(`${base}/absolute-master.m3u8`), false);
});

test('#EXT-X-PLAYLIST-TYPE:VOD is not live', async () => {
    mode = 'vod-type';
    assert.strictEqual(await isLiveHlsStream(`${base}/absolute-master.m3u8`), false);
});

test('relative variant URI is resolved against the master URL', async () => {
    mode = 'live';
    assert.strictEqual(await isLiveHlsStream(`${base}/relative-master.m3u8`), true);
});

test('media playlist fetched directly is classified without a master', async () => {
    mode = 'vod';
    assert.strictEqual(await isLiveHlsStream(`${base}/variant.m3u8`), false);
});

test('non-HLS URL is undetermined', async () => {
    assert.strictEqual(await isLiveHlsStream('https://example.com/video.mp4'), null);
});

test('missing URL is undetermined', async () => {
    assert.strictEqual(await isLiveHlsStream(null), null);
});

test('unreachable playlist is undetermined so callers can fall back', async () => {
    assert.strictEqual(await isLiveHlsStream('https://nonexistent.invalid/master.m3u8'), null);
});

test('404 playlist is undetermined', async () => {
    assert.strictEqual(await isLiveHlsStream(`${base}/missing.m3u8`), null);
});

async function run() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    for (const { description, fn } of tests) {
        try {
            await fn();
            console.log(`✓ ${description}`);
            passed++;
        } catch (err) {
            console.error(`✗ ${description}`);
            console.error(`  ${err.message}`);
            failed++;
        }
    }

    server.close();

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50) + '\n');

    if (failed > 0) process.exit(1);
}

run();
