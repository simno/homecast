const { test } = require('node:test');
const assert = require('assert');
const scan = require('../lib/media-scan');

const PAGE = 'https://site.example/shows/episode.html';
const urls = (list) => list.map(c => c.url).sort();

// --- typeFromUrl ---

test('classifies by path extension, ignoring query strings', () => {
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/live/index.m3u8?token=abc&exp=1'), 'hls');
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/v/clip.MP4?x=1'), 'mp4');
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/v/clip.webm'), 'webm');
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/v/clip.mkv'), 'mkv');
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/d/manifest.mpd'), 'dash');
});

test('a media name in the query does not make a page a stream', () => {
    assert.strictEqual(scan.typeFromUrl('https://site.example/player.html?file=clip.mp4'), null);
    assert.strictEqual(scan.typeFromUrl('https://player.twitch.tv/?channel=pgl'), null);
});

test('extensions followed by path params still classify', () => {
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/a/video.m3u8;jsessionid=42'), 'hls');
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/a/clip.mp4/download'), 'mp4');
});

test('look-alikes are not media', () => {
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/thumbs/clip.mp4.jpg'), null);
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/audio.mp4a'), null);
    assert.strictEqual(scan.typeFromUrl('https://cdn.example/streamers/list'), null);
});

test('format in the query identifies extensionless streams', () => {
    assert.strictEqual(scan.typeFromUrl('https://api.example/stream?id=4&format=m3u8'), 'hls');
});

test('MJPEG camera endpoints classify as mjpeg', () => {
    assert.strictEqual(scan.typeFromUrl('http://cam.example/mjpg/video.mjpg'), 'mjpeg');
    assert.strictEqual(scan.typeFromUrl('http://cam.example/axis-cgi/mjpg/video.cgi'), 'mjpeg');
});

// --- sniffing ---

test('sniffs HLS from the body when the Content-Type is vague', () => {
    assert.strictEqual(scan.sniffType('text/plain', Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n')), 'hls');
    assert.strictEqual(scan.sniffType('', Buffer.from('﻿  #EXTM3U\n')), 'hls');
});

test('sniffs MP4, WebM and Matroska by magic bytes', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    assert.strictEqual(scan.sniffType('application/octet-stream', mp4), 'mp4');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....webm')]);
    assert.strictEqual(scan.sniffType('', webm), 'webm');
    const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska')]);
    assert.strictEqual(scan.sniffType('', mkv), 'mkv');
});

test('Content-Type wins when it is specific', () => {
    assert.strictEqual(scan.sniffType('application/vnd.apple.mpegurl', Buffer.alloc(0)), 'hls');
    assert.strictEqual(scan.sniffType('application/dash+xml', null), 'dash');
    assert.strictEqual(scan.sniffType('multipart/x-mixed-replace; boundary=x', null), 'mjpeg');
});

test('HTML is not media', () => {
    assert.strictEqual(scan.sniffType('text/html', Buffer.from('<!doctype html><html>')), null);
    assert.ok(scan.isHtmlResponse('', Buffer.from('<!DOCTYPE html><html>')));
});

// --- scanText ---

test('finds JSON-escaped URLs in inline scripts', () => {
    const html = '<script>window.__DATA__={"hls":"https:\\/\\/cdn.example\\/v\\/master.m3u8?t=1\\u0026s=2"}</script>';
    assert.deepStrictEqual(urls(scan.scanText(html, PAGE)), ['https://cdn.example/v/master.m3u8?t=1&s=2']);
});

test('decodes &amp; in attribute-embedded URLs', () => {
    const html = '<div data-config="{&quot;src&quot;:&quot;https://cdn.example/a.mp4?x=1&amp;y=2&quot;}"></div>';
    assert.deepStrictEqual(urls(scan.scanText(html, PAGE)), ['https://cdn.example/a.mp4?x=1&y=2']);
});

test('resolves quoted relative paths against the page, not the site root', () => {
    const found = scan.scanText('player.setup({ file: "media/ep1.m3u8" })', PAGE);
    assert.deepStrictEqual(urls(found), ['https://site.example/shows/media/ep1.m3u8']);
});

test('resolves protocol-relative URLs', () => {
    const found = scan.scanText('src="//cdn.example/live/stream.m3u8"', PAGE);
    assert.deepStrictEqual(urls(found), ['https://cdn.example/live/stream.m3u8']);
});

test('finds a stream URL-encoded inside another URL', () => {
    const html = '<a href="https://player.example/embed?file=https%3A%2F%2Fcdn.example%2Fx%2Fplay.m3u8">';
    assert.deepStrictEqual(urls(scan.scanText(html, PAGE)), ['https://cdn.example/x/play.m3u8']);
});

test('decodes base64-hidden URLs (atob and bare)', () => {
    const b64 = Buffer.from('https://cdn.example/secret/master.m3u8').toString('base64');
    assert.deepStrictEqual(urls(scan.scanText(`var s = window.atob('${b64}');`, PAGE)), ['https://cdn.example/secret/master.m3u8']);
    assert.deepStrictEqual(urls(scan.scanText(`{"src":"${b64}"}`, PAGE)), ['https://cdn.example/secret/master.m3u8']);
});

test('stops URLs at CSS/JS punctuation', () => {
    const found = scan.scanText('background:url(https://cdn.example/bg/loop.mp4);', PAGE);
    assert.deepStrictEqual(urls(found), ['https://cdn.example/bg/loop.mp4']);
});

test('ignores non-media URLs', () => {
    assert.deepStrictEqual(scan.scanText('<a href="https://site.example/about">', PAGE), []);
});

// --- scanDocument ---

test('reads <video> and <source>, using the type attribute for extensionless sources', () => {
    const html = `<video src="intro.mp4"></video>
        <video><source src="/api/stream/42" type="application/x-mpegURL"></video>`;
    const doc = scan.scanDocument(html, PAGE);
    const byUrl = Object.fromEntries(doc.candidates.map(c => [c.url, c]));
    assert.strictEqual(byUrl['https://site.example/shows/intro.mp4'].source, 'video-tag');
    assert.strictEqual(byUrl['https://site.example/api/stream/42'].type, 'hls');
});

test('honours <base href> when resolving', () => {
    const doc = scan.scanDocument('<base href="https://static.example/v/"><video src="a.mp4"></video>', PAGE);
    assert.deepStrictEqual(urls(doc.candidates), ['https://static.example/v/a.mp4']);
});

test('treats an HTML og:video as an embed to follow, not a stream', () => {
    const html = '<meta property="og:video" content="https://player.example/embed/9">' +
        '<meta property="og:video:type" content="text/html">';
    const doc = scan.scanDocument(html, PAGE);
    assert.deepStrictEqual(doc.candidates, []);
    assert.deepStrictEqual(doc.embeds, ['https://player.example/embed/9']);
});

test('keeps a typed og:video even without an extension', () => {
    const html = '<meta property="og:video" content="https://cdn.example/v/9">' +
        '<meta property="og:video:type" content="video/mp4">';
    const [c] = scan.scanDocument(html, PAGE).candidates;
    assert.strictEqual(c.type, 'mp4');
    assert.strictEqual(c.source, 'meta');
});

test('reads schema.org VideoObject contentUrl and embedUrl', () => {
    const html = `<script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"VideoObject",
         "contentUrl":"https://cdn.example/full.mp4","embedUrl":"https://player.example/e/1"}]}
    </script>`;
    const doc = scan.scanDocument(html, PAGE);
    assert.deepStrictEqual(urls(doc.candidates), ['https://cdn.example/full.mp4']);
    assert.strictEqual(doc.candidates[0].source, 'json-ld');
    assert.deepStrictEqual(doc.embeds, ['https://player.example/e/1']);
});

test('collects lazy iframes and skips social/ad frames', () => {
    const html = `<iframe data-src="/embed/player?id=3"></iframe>
        <iframe src="https://www.facebook.com/plugins/like.php"></iframe>
        <iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>`;
    assert.deepStrictEqual(scan.scanDocument(html, PAGE).embeds, ['https://site.example/embed/player?id=3']);
});

test('reports title and external scripts', () => {
    const doc = scan.scanDocument('<title> Episode  1 </title><script src="/js/player.js"></script>', PAGE);
    assert.strictEqual(doc.title, 'Episode 1');
    assert.deepStrictEqual(doc.scripts, ['https://site.example/js/player.js']);
});

test('finds iframes written by scripts', () => {
    const js = 'document.write(\'<iframe width="640" src="https://player.example/e/77"></iframe>\')';
    assert.deepStrictEqual(scan.scanScriptEmbeds(js, PAGE), ['https://player.example/e/77']);
});

// --- ranking ---

test('ranks the main stream above ads, previews and segments', () => {
    const ranked = scan.rankCandidates([
        { url: 'https://ads.doubleclick.net/vast/preroll.mp4', type: 'mp4', source: 'page-text' },
        { url: 'https://cdn.example/previews/thumb-loop.mp4', type: 'mp4', source: 'video-tag' },
        { url: 'https://cdn.example/v/seg-00012.mp4', type: 'mp4', source: 'network' },
        { url: 'https://cdn.example/v/master.m3u8', type: 'hls', source: 'page-text' }
    ]);
    assert.strictEqual(ranked[0].url, 'https://cdn.example/v/master.m3u8');
    assert.strictEqual(ranked[ranked.length - 1].url, 'https://ads.doubleclick.net/vast/preroll.mp4');
});

test('ranks castable formats above unsupported ones regardless of score', () => {
    const ranked = scan.rankCandidates([
        { url: 'http://cam.example/mjpg/video.mjpg', type: 'mjpeg', source: 'direct' },
        { url: 'https://cdn.example/drm.mpd', type: 'dash', source: 'direct', unsupportedReason: 'DRM' },
        { url: 'https://cdn.example/v.mkv', type: 'mkv', source: 'page-text' }
    ]);
    assert.strictEqual(ranked[0].type, 'mkv');
});

test('DASH is castable, ranked just below HLS', () => {
    assert.ok(scan.isCastable({ type: 'dash' }));
    const ranked = scan.rankCandidates([
        { url: 'https://cdn.example/a/manifest.mpd', type: 'dash', source: 'page-text' },
        { url: 'https://cdn.example/a/clip.mp4', type: 'mp4', source: 'page-text' },
        { url: 'https://cdn.example/a/master.m3u8', type: 'hls', source: 'page-text' }
    ]);
    assert.deepStrictEqual(ranked.map(c => c.type), ['hls', 'dash', 'mp4']);
});

test('segments are pruned beside a DASH manifest', () => {
    const pruned = scan.pruneCandidates([
        { url: 'https://cdn.example/manifest.mpd', type: 'dash' },
        { url: 'https://cdn.example/v/init.mp4', type: 'mp4' }
    ]);
    assert.deepStrictEqual(urls(pruned), ['https://cdn.example/manifest.mpd']);
});

test('higher resolution wins between otherwise equal candidates', () => {
    const ranked = scan.rankCandidates([
        { url: 'https://cdn.example/a.mp4', type: 'mp4', source: 'video-tag', height: 480 },
        { url: 'https://cdn.example/b.mp4', type: 'mp4', source: 'video-tag', height: 1080 }
    ]);
    assert.strictEqual(ranked[0].url, 'https://cdn.example/b.mp4');
});

test('prunes variants covered by a listed master, and segments beside a playlist', () => {
    const pruned = scan.pruneCandidates([
        { url: 'https://cdn.example/master.m3u8', type: 'hls', variantUrls: ['https://cdn.example/720/index.m3u8'] },
        { url: 'https://cdn.example/720/index.m3u8', type: 'hls' },
        { url: 'https://cdn.example/720/init.mp4', type: 'mp4' },
        { url: 'https://cdn.example/extra.mp4', type: 'mp4' }
    ]);
    assert.deepStrictEqual(urls(pruned), ['https://cdn.example/extra.mp4', 'https://cdn.example/master.m3u8']);
});

// --- HLS / MP4 metadata ---

const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio/en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=2000000,BANDWIDTH=2800000,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
    'audio-only.m3u8'
].join('\n');

test('parses master variants highest first, labelling high frame rates', () => {
    const variants = scan.parseHlsVariants(MASTER, 'https://cdn.example/v/master.m3u8');
    assert.deepStrictEqual(variants.map(v => v.label), ['1080p60', '720p', '360p']);
    assert.strictEqual(variants[0].url, 'https://cdn.example/v/1080/index.m3u8');
    assert.strictEqual(variants[1].bandwidth, 2800000, 'BANDWIDTH, not AVERAGE-BANDWIDTH');
});

test('media playlists have no variants', () => {
    assert.deepStrictEqual(scan.parseHlsVariants('#EXTM3U\n#EXTINF:4,\na.ts\n', 'https://x.example/'), []);
});

test('lists every child URI of a master, including renditions', () => {
    const children = scan.playlistChildUrls(MASTER, 'https://cdn.example/v/master.m3u8');
    assert.ok(children.includes('https://cdn.example/v/audio/en.m3u8'));
    assert.ok(children.includes('https://cdn.example/v/720/index.m3u8'));
});

// Minimal moov/trak/tkhd, laid out per ISO/IEC 14496-12.
function tkhdBox(version, width, height) {
    const payload = Buffer.alloc(version === 1 ? 96 : 84);
    payload[0] = version;
    const dimsAt = version === 1 ? 4 + 84 : 4 + 72;
    payload.writeUInt32BE(width << 16, dimsAt);
    payload.writeUInt32BE(height << 16, dimsAt + 4);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8, 0);
    header.write('tkhd', 4, 'latin1');
    return Buffer.concat([header, payload]);
}

test('reads video dimensions from tkhd (v0 and v1), ignoring audio tracks', () => {
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    const buf = Buffer.concat([ftyp, tkhdBox(0, 0, 0), tkhdBox(1, 1920, 1080)]);
    assert.deepStrictEqual(scan.parseMp4Dimensions(buf), { width: 1920, height: 1080 });
    assert.deepStrictEqual(scan.parseMp4Dimensions(Buffer.concat([ftyp, tkhdBox(0, 1280, 720)])), { width: 1280, height: 720 });
});

test('no moov in range means no dimensions', () => {
    assert.strictEqual(scan.parseMp4Dimensions(Buffer.alloc(4096)), null);
});

test('labels resolution by the short side', () => {
    assert.strictEqual(scan.resolutionLabel(1920, 1080), '1080p');
    assert.strictEqual(scan.resolutionLabel(1080, 1920), '1080p');
    assert.strictEqual(scan.resolutionLabel(3840, 2160), '4K');
});

// --- Thumbnail ---

test('the share-card image is the thumbnail, resolved against the page', () => {
    const doc = scan.scanDocument('<meta property="og:image" content="/img/cover.jpg"><video src="a.mp4" poster="p.jpg"></video>', PAGE);
    assert.strictEqual(doc.thumbnail, 'https://site.example/img/cover.jpg');
});

test('without a share card the poster frame is the thumbnail', () => {
    const doc = scan.scanDocument('<video src="a.mp4" poster="p.jpg"></video>', PAGE);
    assert.strictEqual(doc.thumbnail, 'https://site.example/shows/p.jpg');
});

test('a page without either has no thumbnail', () => {
    assert.strictEqual(scan.scanDocument('<video src="a.mp4"></video>', PAGE).thumbnail, null);
});
