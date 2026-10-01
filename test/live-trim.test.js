// Long live playlists trimmed to their recent end (lib/proxy.js
// trimLivePlaylist): YouTube's hour of one-second segments.
const { test } = require('node:test');
const assert = require('assert');
const { trimLivePlaylist } = require('../lib/proxy');

// A live playlist of `count` one-second segments starting at sequence 9000,
// with a discontinuity after segment 100 and a key change at segment 50.
function livePlaylist(count, { endlist = false } = {}) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:9000', '#EXT-X-DISCONTINUITY-SEQUENCE:3',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key0"'];
    for (let i = 0; i < count; i++) {
        if (i === 50) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key50"');
        if (i === 100) lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:2026-10-01T14:00:${String(i % 60).padStart(2, '0')}.000Z`, '#EXTINF:1.0,', `https://cdn.example/seg/${9000 + i}.ts`);
    }
    if (endlist) lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

const segments = (m3u8) => m3u8.split('\n').filter(l => l.startsWith('https://cdn.example/seg/'));

test('an hour-long live playlist keeps its last 300 segments, numbered as before', () => {
    const out = trimLivePlaylist(livePlaylist(3600));
    const kept = segments(out);
    assert.strictEqual(kept.length, 300);
    assert.strictEqual(kept[0], 'https://cdn.example/seg/12300.ts');
    assert.strictEqual(kept.at(-1), 'https://cdn.example/seg/12599.ts');
    assert.match(out, /#EXT-X-MEDIA-SEQUENCE:12300\n/, 'the first kept segment keeps its sequence number');
    assert.match(out, /#EXT-X-DISCONTINUITY-SEQUENCE:4\n/, 'the dropped discontinuity is counted');
    assert.doesNotMatch(out, /^#EXT-X-DISCONTINUITY$/m);
});

test('the key in force at the cut comes along; the PDT of each kept segment stays with it', () => {
    const out = trimLivePlaylist(livePlaylist(3600)).split('\n');
    const first = out.indexOf('https://cdn.example/seg/12300.ts');
    assert.deepStrictEqual(out.filter(l => l.startsWith('#EXT-X-KEY')), ['#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key50"']);
    assert.ok(out.indexOf('#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key50"') < first);
    assert.match(out[first - 2], /^#EXT-X-PROGRAM-DATE-TIME:/);
});

test('short live playlists, recordings and masters pass unchanged', () => {
    const short = livePlaylist(600);
    assert.strictEqual(trimLivePlaylist(short), short);
    const recording = livePlaylist(3600, { endlist: true });
    assert.strictEqual(trimLivePlaylist(recording), recording);
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n';
    assert.strictEqual(trimLivePlaylist(master), master);
});
