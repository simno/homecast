// Time budgets for the hot paths on large inputs: playlist rewriting and
// quality capping (every live refresh), page and script scanning (a
// catastrophic regex backtrack would hang Analyze), and subtitle conversion.
// Budgets are generous so a slow CI runner doesn't fail them; they exist to
// catch an accidental O(n²) or a backtracking regex, which blow past them by
// orders of magnitude.
const { test } = require('node:test');
const assert = require('assert');
const { rewritePlaylist, filterMasterPlaylist } = require('../lib/proxy');
const scan = require('../lib/media-scan');
const { toWebVtt, parseHlsSubtitles } = require('../lib/subtitles');

function timed(fn) {
    const start = process.hrtime.bigint();
    const result = fn();
    return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
}

const BASE = new URL('https://cdn.example/live/index.m3u8');

test('a 10,000-segment playlist is rewritten in under 250ms', () => {
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n' +
        Array.from({ length: 10000 }, (_, i) => `#EXTINF:4.0,\nseg${i}.ts?token=abc`).join('\n');
    const { result, ms } = timed(() => rewritePlaylist(playlist, BASE, (u) => `http://h/proxy?url=${encodeURIComponent(u)}`));
    assert.strictEqual((result.match(/\/proxy\?url=/g) || []).length, 10000);
    assert.ok(ms < 250, `took ${ms.toFixed(1)}ms`);
});

test('a 500-variant master is capped in under 100ms', () => {
    const master = '#EXTM3U\n' + Array.from({ length: 500 }, (_, i) =>
        `#EXT-X-STREAM-INF:BANDWIDTH=${(i + 1) * 1000},RESOLUTION=${i + 100}x${i + 100}\nv${i}.m3u8`).join('\n');
    const { result, ms } = timed(() => filterMasterPlaylist(master, 'highest'));
    assert.strictEqual((result.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
    assert.ok(ms < 100, `took ${ms.toFixed(1)}ms`);
});

test('a 2MB page of noise is scanned in under 1s and its stream still found', () => {
    // Long runs of quotes, slashes and dots are what backtracking URL regexes choke on.
    const noise = 'x"/.:'.repeat(200000);
    const html = `<html><body><script>${noise} var src = "https://cdn.example/live/master.m3u8"; ${noise}</script></body></html>`;
    const { result, ms } = timed(() => scan.scanDocument(html, 'https://site.example/watch'));
    assert.ok(result.candidates.some(c => c.url === 'https://cdn.example/live/master.m3u8'));
    assert.ok(ms < 1000, `took ${ms.toFixed(1)}ms`);
});

test('a 1.5MB player script is searched in under 1s', () => {
    const script = 'function f(){return "a/b.c"}'.repeat(50000) + ';cfg={file:"https://cdn.example/v/clip.mp4"}';
    const { result, ms } = timed(() => scan.scanText(script, 'https://site.example/'));
    assert.ok(result.some(c => c.url === 'https://cdn.example/v/clip.mp4'));
    assert.ok(ms < 1000, `took ${ms.toFixed(1)}ms`);
});

test('a 20,000-cue SRT file is converted in under 250ms', () => {
    const srt = Array.from({ length: 20000 }, (_, i) => {
        const s = String(i % 60).padStart(2, '0');
        return `${i + 1}\r\n00:00:${s},000 --> 00:00:${s},500\r\nLine ${i}\r\n`;
    }).join('\r\n');
    const { result, ms } = timed(() => toWebVtt(Buffer.from(srt)));
    assert.ok(result.startsWith('WEBVTT'));
    assert.ok(ms < 250, `took ${ms.toFixed(1)}ms`);
});

test('a master with 1,000 subtitle renditions is parsed in under 100ms', () => {
    const master = '#EXTM3U\n' + Array.from({ length: 1000 }, (_, i) =>
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Track ${i}",LANGUAGE="l${i}",URI="s${i}.m3u8"`).join('\n');
    const { result, ms } = timed(() => parseHlsSubtitles(master));
    assert.strictEqual(result.length, 1000);
    assert.ok(ms < 100, `took ${ms.toFixed(1)}ms`);
});
