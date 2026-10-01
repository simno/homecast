// SponsorBlock (lib/sponsorblock.js): which categories, which videos, the
// lookup by hash prefix, and skipping on a (fake) Cast session.
const { test } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const axios = require('axios');
const { activeSessions } = require('../lib/state');
const { categories, youTubeVideoId, fetchSegments, segmentAt, startSkipping, stopSkipping } = require('../lib/sponsorblock');

const VIDEO = 'Y19LzouHe7I';
const answer = [
    { videoID: 'otherVideo1', segments: [{ category: 'sponsor', segment: [1, 50] }] },
    {
        videoID: VIDEO,
        segments: [
            { category: 'selfpromo', segment: [300, 330] },
            { category: 'sponsor', segment: [27.2, 64.6] },
            { category: 'sponsor', segment: [100, 100.5] }
        ]
    }
];

test('categories default to the ad-like ones; a list or none overrides them', () => {
    assert.deepStrictEqual(categories(undefined), ['sponsor', 'selfpromo', 'interaction']);
    assert.deepStrictEqual(categories(' Sponsor, intro ,bogus'), ['sponsor', 'intro']);
    assert.deepStrictEqual(categories('none'), []);
});

test('the video ID is read from YouTube video URLs only', () => {
    assert.strictEqual(youTubeVideoId(`https://www.youtube.com/watch?v=${VIDEO}&t=30`), VIDEO);
    assert.strictEqual(youTubeVideoId(`https://youtu.be/${VIDEO}`), VIDEO);
    assert.strictEqual(youTubeVideoId(`https://m.youtube.com/shorts/${VIDEO}`), VIDEO);
    assert.strictEqual(youTubeVideoId('https://www.youtube.com/@NASA/live'), null);
    assert.strictEqual(youTubeVideoId(`https://vimeo.com/watch?v=${VIDEO}`), null);
});

test('segments are looked up by hash prefix, then picked out for this video, in order', async (t) => {
    const calls = [];
    t.mock.method(axios, 'get', async (url, config) => {
        calls.push({ url, params: config.params });
        return { status: 200, data: answer };
    });
    const segments = await fetchSegments(VIDEO, ['sponsor', 'selfpromo']);
    const prefix = crypto.createHash('sha256').update(VIDEO).digest('hex').slice(0, 4);
    assert.strictEqual(calls[0].url, `https://sponsor.ajay.app/api/skipSegments/${prefix}`);
    assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(VIDEO), 'the video ID itself isn\'t sent');
    assert.deepStrictEqual(JSON.parse(calls[0].params.categories), ['sponsor', 'selfpromo']);
    assert.deepStrictEqual(segments, [
        { start: 27.2, end: 64.6, category: 'sponsor' },
        { start: 300, end: 330, category: 'selfpromo' }
    ], 'a half-second segment isn\'t worth a seek');
});

test('a video nobody has marked has no segments', async (t) => {
    t.mock.method(axios, 'get', async () => ({ status: 404, data: 'Not Found' }));
    assert.deepStrictEqual(await fetchSegments(VIDEO, ['sponsor']), []);
});

test('a segment is skipped once, and not with too little of it left', () => {
    const segments = [{ start: 27.2, end: 64.6 }];
    const skipped = new Set();
    assert.strictEqual(segmentAt(segments, 20, skipped), null);
    assert.strictEqual(segmentAt(segments, 30, skipped), segments[0]);
    assert.strictEqual(segmentAt(segments, 64, skipped), null);
    skipped.add(segments[0]);
    assert.strictEqual(segmentAt(segments, 30, skipped), null);
});

// A Cast session whose player reports `status` and records seeks.
function fakeCastSession(ip, status) {
    const seeks = [];
    const session = {
        lastStatus: status,
        lastStatusAt: Date.now(),
        player: {
            getStatus: (cb) => cb(null, session.lastStatus),
            seek: (to, cb) => {
                seeks.push(to);
                session.lastStatus = { ...session.lastStatus, currentTime: to };
                session.lastStatusAt = Date.now();
                cb(null, session.lastStatus);
            }
        }
    };
    activeSessions.set(ip, session);
    return { session, seeks };
}

const waitFor = async (check, ms = 3000) => {
    const until = Date.now() + ms;
    while (!check()) {
        if (Date.now() > until) return false;
        await new Promise(r => setTimeout(r, 50));
    }
    return true;
};

test('playing into a segment on a Cast session seeks past it, once', async (t) => {
    const ip = '10.0.0.77';
    t.mock.method(axios, 'get', async () => ({ status: 200, data: answer }));
    const { session, seeks } = fakeCastSession(ip, { playerState: 'PLAYING', currentTime: 30, playbackRate: 1, media: { duration: 600 } });
    t.after(() => {
        stopSkipping(ip);
        activeSessions.delete(ip);
    });

    startSkipping(ip, `https://www.youtube.com/watch?v=${VIDEO}`, { wanted: ['sponsor'] });
    assert.ok(await waitFor(() => seeks.length === 1), 'no seek past the sponsor');
    assert.deepStrictEqual(seeks, [64.6]);

    // Seeking back into it plays it this time.
    session.lastStatus = { ...session.lastStatus, currentTime: 30 };
    session.lastStatusAt = Date.now();
    await new Promise(r => setTimeout(r, 1200));
    assert.deepStrictEqual(seeks, [64.6]);
});

test('a paused player isn\'t moved, and other casts skip nothing', async (t) => {
    const ip = '10.0.0.78';
    t.mock.method(axios, 'get', async () => ({ status: 200, data: answer }));
    const { seeks } = fakeCastSession(ip, { playerState: 'PAUSED', currentTime: 30, playbackRate: 1 });
    t.after(() => {
        stopSkipping(ip);
        activeSessions.delete(ip);
    });
    startSkipping(ip, `https://youtu.be/${VIDEO}`, { wanted: ['sponsor'] });
    await new Promise(r => setTimeout(r, 1200));
    assert.deepStrictEqual(seeks, []);

    assert.strictEqual(startSkipping(ip, 'https://vimeo.com/76979871'), null);
    assert.strictEqual(startSkipping(ip, `https://youtu.be/${VIDEO}`, { wanted: [] }), null);
});
