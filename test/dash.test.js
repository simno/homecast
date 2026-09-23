// MPEG-DASH: manifest reading/rewriting, the path-shaped segment proxy, and
// discovery. Fixtures live on 127.0.0.1, so the SSRF guard is off for this run.
process.env.DISABLE_SSRF_PROTECTION = 'true';

const assert = require('assert');
const http = require('http');
const express = require('express');
const dash = require('../lib/dash');
const { findStreams } = require('../lib/stream-finder');

console.log('Running DASH Tests...\n');

let passed = 0;
let failed = 0;
const tests = [];
function test(description, fn) {
    tests.push({ description, fn });
}

const MPD_URL = 'https://cdn.example/show/ep1/manifest.mpd?tok=abc';

function mpd({ type = 'static', drm = false, rootBase = '', location = '' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="${type}" mediaPresentationDuration="PT10M">
  ${location ? `<Location>${location}</Location>` : ''}
  ${rootBase ? `<BaseURL>${rootBase}</BaseURL>` : ''}
  <Period id="1">
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.640028" segmentAlignment="true">
      ${drm ? '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>' : ''}
      <SegmentTemplate media="$RepresentationID$/seg-$Number%05d$.m4s" initialization="$RepresentationID$/init.mp4" startNumber="1" duration="4" timescale="1"/>
      <Representation id="v2160" bandwidth="16000000" width="3840" height="2160"/>
      <Representation id="v1080" bandwidth="6000000" width="1920" height="1080" frameRate="60000/1001"/>
      <Representation id="v360" bandwidth="700000" width="640" height="360"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">
      <Representation id="a1" bandwidth="128000">
        <BaseURL>https://audio.example/en/track.mp4?sig=1&amp;k=2</BaseURL>
        <SegmentBase indexRange="0-999"><Initialization range="0-599"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
}

const toSegmentUrl = (u) => dash.dashSegmentUrl('10.0.0.2:3000', u, 'https://site.example/');
const toManifestUrl = (u) => `MANIFEST(${u})`;
const rewrite = (xml, quality = 'highest') => dash.rewriteMpd(xml, MPD_URL, { quality, toSegmentUrl, toManifestUrl });

// Every proxied URL in the output, decoded back to the upstream it stands for.
function upstreamsIn(xml) {
    return [...xml.matchAll(/http:\/\/10\.0\.0\.2:3000(\/proxy\/dash\/[^<"]+)/g)]
        .map(m => dash.upstreamFromDashPath(m[1].replace(/&amp;/g, '&')).url);
}

// --- describeMpd ---

test('describes qualities highest first with high frame rates labelled', () => {
    const info = dash.describeMpd(mpd());
    assert.deepStrictEqual(info.qualities.map(q => q.label), ['2160p', '1080p60', '360p']);
    assert.strictEqual(info.live, false);
    assert.strictEqual(info.drm, false);
});

test('type="dynamic" is live; ContentProtection is DRM', () => {
    assert.strictEqual(dash.describeMpd(mpd({ type: 'dynamic' })).live, true);
    assert.strictEqual(dash.describeMpd(mpd({ drm: true })).drm, true);
});

test('anything that is not an MPD is rejected', () => {
    assert.strictEqual(dash.describeMpd('#EXTM3U\n'), null);
    assert.strictEqual(dash.describeMpd('<html><body>MPD</body></html>'), null);
    assert.strictEqual(dash.describeMpd(null), null);
});

// --- rewriteMpd ---

test('adds a proxied BaseURL for the MPD directory when there is none', () => {
    const out = rewrite(mpd());
    const base = out.match(/<MPD[^>]*>\s*<BaseURL>([^<]+)<\/BaseURL>/);
    assert.ok(base, out.slice(0, 400));
    assert.strictEqual(dash.upstreamFromDashPath(base[1].replace('http://10.0.0.2:3000', '')).url, 'https://cdn.example/show/ep1/');
});

test('relative templates are left for the receiver to fill in, $ intact', () => {
    const out = rewrite(mpd());
    assert.ok(out.includes('media="$RepresentationID$/seg-$Number%05d$.m4s"'), out);
    assert.ok(!out.includes('&#x24;'));
});

test('absolute BaseURLs on other hosts are proxied with their own origin, query intact', () => {
    const out = rewrite(mpd());
    assert.ok(upstreamsIn(out).includes('https://audio.example/en/track.mp4?sig=1&k=2'), upstreamsIn(out).join('\n'));
});

test('a relative root BaseURL is resolved against the MPD, then proxied', () => {
    const out = rewrite(mpd({ rootBase: '../media/' }));
    assert.ok(upstreamsIn(out).includes('https://cdn.example/show/media/'));
    assert.strictEqual((out.match(/<BaseURL>/g) || []).length, 2, 'no extra BaseURL inserted');
});

test('root-relative and absolute segment attributes are proxied, keeping templates', () => {
    const xml = mpd().replace('initialization="$RepresentationID$/init.mp4"', 'initialization="/inits/$RepresentationID$.mp4"');
    const out = rewrite(xml);
    assert.ok(upstreamsIn(out).includes('https://cdn.example/inits/$RepresentationID$.mp4'), upstreamsIn(out).join('\n'));
});

test('<Location> is sent back through the manifest proxy', () => {
    const out = rewrite(mpd({ location: 'https://cdn.example/live/next.mpd?t=1&amp;u=2' }));
    assert.ok(out.includes('<Location>MANIFEST(https://cdn.example/live/next.mpd?t=1&amp;u=2)</Location>'), out);
});

test('"highest" keeps one decodable video rendition and all audio', () => {
    const out = rewrite(mpd());
    assert.ok(out.includes('id="v1080"'));
    assert.ok(!out.includes('id="v2160"'), '4K H.264 is past the receiver');
    assert.ok(!out.includes('id="v360"'));
    assert.ok(out.includes('id="a1"'));
});

test('an explicit height and "auto" are honoured', () => {
    const out360 = rewrite(mpd(), '360');
    assert.ok(out360.includes('id="v360"') && !out360.includes('id="v1080"'));
    const outAuto = rewrite(mpd(), 'auto');
    assert.ok(['v2160', 'v1080', 'v360'].every(id => outAuto.includes(`id="${id}"`)));
});

test('rewriting something that is not an MPD returns null', () => {
    assert.strictEqual(rewrite('<html></html>'), null);
});

// --- tokens ---

test('segment URLs round-trip to their upstream and referer', () => {
    const url = 'https://cdn.example:8443/a b/seg-$Number$.m4s?x=1&y=$Time$';
    const proxied = dash.dashSegmentUrl('h:1', url, 'https://ref.example/page');
    const back = dash.upstreamFromDashPath(proxied.replace('http://h:1', ''));
    assert.strictEqual(back.url, new URL(url).href);
    assert.strictEqual(back.referer, 'https://ref.example/page');
});

test('malformed or non-http tokens are refused', () => {
    assert.strictEqual(dash.upstreamFromDashPath('/proxy/dash/!!!/x'), null);
    assert.strictEqual(dash.upstreamFromDashPath('/proxy/dash/abc/x'), null);
    const fileToken = dash.encodeDashToken({ origin: 'file:///etc' });
    assert.strictEqual(dash.upstreamFromDashPath(`/proxy/dash/${fileToken}/passwd`), null);
});

// --- End to end through the proxy router ---

let base;
const seen = [];
const SEGMENT = Buffer.from('0123456789abcdefghij');
const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, referer: req.headers.referer, range: req.headers.range });
    const path = req.url.split('?')[0];
    if (path === '/show/manifest.mpd') {
        res.setHeader('Content-Type', 'application/dash+xml');
        return res.end(mpd({ type: req.url.includes('live') ? 'dynamic' : 'static' }));
    }
    if (path === '/show/drm.mpd') {
        res.setHeader('Content-Type', 'application/dash+xml');
        return res.end(mpd({ drm: true }));
    }
    if (path === '/page.html') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<html><video data-src="/show/manifest.mpd?live=1"></video><script>var d = "${base}/show/drm.mpd";</script></html>`);
    }
    if (path.startsWith('/show/v1080/')) {
        const m = (req.headers.range || '').match(/bytes=(\d+)-(\d+)/);
        if (m) {
            const [start, end] = [Number(m[1]), Number(m[2])];
            res.writeHead(206, {
                'Content-Type': 'video/iso.segment',
                'Content-Range': `bytes ${start}-${end}/${SEGMENT.length}`,
                'Access-Control-Allow-Origin': 'https://site.example'
            });
            return res.end(SEGMENT.subarray(start, end + 1));
        }
        res.setHeader('Content-Type', 'video/iso.segment');
        return res.end(SEGMENT);
    }
    res.statusCode = 404;
    res.end();
});

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
}

test('the proxy serves a rewritten MPD whose segments stream back through it, with ranges', async () => {
    const app = express();
    app.use(require('../routes/proxy'));
    const api = app.listen(0, '127.0.0.1');
    await new Promise(r => api.once('listening', r));
    const port = api.address().port;
    try {
        const manifestUrl = `${base}/show/manifest.mpd`;
        const res = await get(port, `/proxy?url=${encodeURIComponent(manifestUrl)}&referer=${encodeURIComponent('https://site.example/')}&quality=highest&type=dash`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers['content-type'], /dash\+xml/);
        const xml = res.body.toString();
        const baseUrl = xml.match(/<BaseURL>(http:\/\/127\.0\.0\.1:\d+\/proxy\/dash\/[^<]+)<\/BaseURL>/)[1];

        // What a receiver does: resolve the template against the BaseURL.
        const segmentUrl = new URL('v1080/seg-00001.m4s', baseUrl);
        seen.length = 0;
        const seg = await get(port, segmentUrl.pathname, { Range: 'bytes=5-9' });
        assert.strictEqual(seg.status, 206);
        assert.strictEqual(seg.body.toString(), '56789');
        assert.strictEqual(seg.headers['content-range'], 'bytes 5-9/20');
        assert.strictEqual(seg.headers['access-control-allow-origin'], '*', 'upstream CORS pin replaced');
        assert.deepStrictEqual(seen[0], { url: '/show/v1080/seg-00001.m4s', referer: 'https://site.example/', range: 'bytes=5-9' });

        const preflight = await new Promise((resolve) => {
            http.request({ host: '127.0.0.1', port, path: segmentUrl.pathname, method: 'OPTIONS' }, resolve).end();
        });
        assert.strictEqual(preflight.statusCode, 204);
        assert.match(preflight.headers['access-control-allow-headers'], /Range/);

        const bad = await get(port, '/proxy/dash/not-a-token/x.m4s');
        assert.strictEqual(bad.status, 400);

        // Same fix for progressive files on the classic /proxy route: seeking an
        // MP4 sends a Range, and has to get a 206 of those bytes back.
        const mp4 = await get(port, `/proxy?url=${encodeURIComponent(`${base}/show/v1080/clip.mp4`)}`, { Range: 'bytes=0-3' });
        assert.strictEqual(mp4.status, 206);
        assert.strictEqual(mp4.body.toString(), '0123');
    } finally {
        api.close();
    }
});

// --- Discovery ---

test('the finder lists a DASH stream with qualities and liveness, and flags DRM', async () => {
    const { videos } = await findStreams(`${base}/page.html`, { browser: false });
    const live = videos.find(v => v.url.endsWith('manifest.mpd?live=1'));
    assert.ok(live, JSON.stringify(videos));
    assert.strictEqual(live.type, 'dash');
    assert.strictEqual(live.live, true);
    assert.strictEqual(live.unsupported, false);
    assert.deepStrictEqual(live.qualities.map(q => q.label), ['2160p', '1080p60', '360p']);

    const drm = videos.find(v => v.url.endsWith('drm.mpd'));
    assert.strictEqual(drm.unsupported, true);
    assert.match(drm.reason, /DRM/);
    assert.strictEqual(videos[0], live, 'castable first');
});

test('Apple TV casts of DASH are refused with an explanation', async () => {
    const app = express();
    app.use(express.json());
    app.use(require('../routes/cast'));
    const api = app.listen(0, '127.0.0.1');
    await new Promise(r => api.once('listening', r));
    try {
        const body = JSON.stringify({ ip: '192.0.2.10', url: 'https://cdn.example/a/manifest.mpd', deviceType: 'airplay', type: 'dash' });
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port: api.address().port, path: '/api/cast', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (r) => {
                let data = '';
                r.on('data', c => (data += c));
                r.on('end', () => resolve({ status: r.statusCode, data }));
            });
            req.on('error', reject);
            req.end(body);
        });
        assert.strictEqual(res.status, 400);
        assert.match(JSON.parse(res.data).error, /Apple TV cannot play DASH/);
    } finally {
        api.close();
    }
});

async function run() {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${upstream.address().port}`;

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

    upstream.closeAllConnections();
    upstream.close();

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50) + '\n');

    // The proxy router keeps a cache-sweeping interval alive.
    process.exit(failed > 0 ? 1 : 0);
}

run();
