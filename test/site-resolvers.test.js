// The site resolvers' conversations with their APIs (lib/twitch.js,
// lib/x-broadcast.js, lib/spacex.js), with axios standing in for the network:
// what each sends, and how each answer becomes a stream or a message.
// test/site-smoke.js runs the same resolvers against the real sites.
const { test } = require('node:test');
const assert = require('assert');
const axios = require('axios');
const { resolveTwitchStream } = require('../lib/twitch');
const { resolveXBroadcast } = require('../lib/x-broadcast');
const { fetchLaunchWebcasts } = require('../lib/spacex');

// Answers axios calls from a table of `METHOD url-prefix` -> response or Error.
function fakeApi(t, routes) {
    const calls = [];
    const answer = (method) => async (url, ...rest) => {
        const config = method === 'POST' ? rest[1] : rest[0];
        calls.push({ method, url, body: method === 'POST' ? rest[0] : undefined, headers: config?.headers || {} });
        const key = Object.keys(routes).find(k => `${method} ${url}`.startsWith(k));
        const reply = typeof routes[key] === 'function' ? routes[key]() : routes[key];
        if (!reply) throw new Error(`Unexpected ${method} ${url}`);
        if (reply instanceof Error) throw reply;
        const response = { status: 200, ...reply };
        if (response.status >= 400 && !config?.validateStatus) {
            throw Object.assign(new Error(`Request failed with status code ${response.status}`), { response });
        }
        return response;
    };
    t.mock.method(axios, 'get', answer('GET'));
    t.mock.method(axios, 'post', answer('POST'));
    return calls;
}

// ===== Twitch =====

const GQL = 'POST https://gql.twitch.tv/gql';
const USHER_LIVE = 'GET https://usher.ttvnw.net/api/channel/hls/pgl.m3u8';
const liveToken = { data: { data: { streamPlaybackAccessToken: { value: '{"channel":"pgl"}', signature: 'abc123' } } } };
const vodToken = { data: { data: { videoPlaybackAccessToken: { value: '{"vod_id":"42"}', signature: 'def456' } } } };

test('Twitch: a live channel resolves to its signed H.264 usher playlist', async (t) => {
    const calls = fakeApi(t, { [GQL]: liveToken, [USHER_LIVE]: { data: '#EXTM3U\n' } });
    const result = await resolveTwitchStream('https://www.twitch.tv/PGL');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.referer, 'https://www.twitch.tv/');

    const url = new URL(result.url);
    assert.strictEqual(url.pathname, '/api/channel/hls/pgl.m3u8');
    assert.strictEqual(url.searchParams.get('sig'), 'abc123');
    assert.strictEqual(url.searchParams.get('token'), '{"channel":"pgl"}');
    assert.strictEqual(url.searchParams.get('supported_codecs'), 'avc1');

    const gql = calls[0];
    assert.strictEqual(gql.headers['Client-ID'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
    assert.deepStrictEqual(gql.body.variables, { isLive: true, login: 'pgl', isVod: false, vodID: '', playerType: 'embed' });
});

test('Twitch: a VOD asks for a video token and the VOD playlist', async (t) => {
    const calls = fakeApi(t, { [GQL]: vodToken, 'GET https://usher.ttvnw.net/vod/42.m3u8': { data: '#EXTM3U\n' } });
    const result = await resolveTwitchStream('https://www.twitch.tv/videos/42');
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(calls[0].body.variables.vodID, '42');
    assert.strictEqual(new URL(result.url).searchParams.get('sig'), 'def456');
});

test('Twitch: usher 404 means the channel is offline or the video is gone', async (t) => {
    fakeApi(t, { [GQL]: liveToken, [USHER_LIVE]: { status: 404, data: '' } });
    assert.deepStrictEqual(await resolveTwitchStream('https://twitch.tv/pgl'),
        { status: 'offline', message: 'This Twitch channel is offline' });
});

test('Twitch: an unavailable VOD says so', async (t) => {
    fakeApi(t, { [GQL]: vodToken, 'GET https://usher.ttvnw.net/vod/42.m3u8': { status: 404, data: '' } });
    assert.deepStrictEqual(await resolveTwitchStream('https://player.twitch.tv/?video=v42'),
        { status: 'offline', message: 'This Twitch video is unavailable' });
});

test('Twitch: no token, or no reaching Twitch, is an error', async (t) => {
    fakeApi(t, { [GQL]: { data: { data: { streamPlaybackAccessToken: null } } } });
    assert.deepStrictEqual(await resolveTwitchStream('https://twitch.tv/pgl'),
        { status: 'error', message: 'Could not reach Twitch to authorise playback' });
});

test('Twitch: an unexpected usher answer is an error naming its status', async (t) => {
    fakeApi(t, { [GQL]: liveToken, [USHER_LIVE]: { status: 500, data: 'oops' } });
    const result = await resolveTwitchStream('https://twitch.tv/pgl');
    assert.deepStrictEqual(result, { status: 'error', message: 'Twitch returned an unexpected response (500)' });
});

test('Twitch: a failed playlist request is an error', async (t) => {
    fakeApi(t, { [GQL]: liveToken, [USHER_LIVE]: new Error('socket hang up') });
    assert.strictEqual((await resolveTwitchStream('https://twitch.tv/pgl')).message, 'Could not load the Twitch stream playlist');
});

test('Twitch: a URL that names no channel or video is refused without a request', async (t) => {
    const calls = fakeApi(t, {});
    assert.deepStrictEqual(await resolveTwitchStream('https://www.twitch.tv/directory'),
        { status: 'error', message: 'Unrecognised Twitch URL' });
    assert.strictEqual(calls.length, 0);
});

// ===== X broadcasts =====

const ACTIVATE = 'POST https://api.x.com/1.1/guest/activate.json';
const SHOW = 'GET https://api.x.com/1.1/broadcasts/show.json?ids=1AJEmmYdMDnJL';
const STATUS = 'GET https://api.x.com/1.1/live_video_stream/status/28_123';
const running = { data: { broadcasts: { '1AJEmmYdMDnJL': { media_key: '28_123', state: 'RUNNING', status: 'Launch', image_url: 'https://pbs.twimg.com/t.jpg' } } } };
const playlist = { data: { source: { location: 'https://prod-fastly.pscp.tv/live/master.m3u8' } } };

// Numbered across tests: the resolver caches its token between them.
let tokens = 0;
const guestToken = () => ({ data: { guest_token: `guest-${++tokens}` } });
const activations = (calls) => calls.filter(c => c.url.endsWith('/guest/activate.json')).length;

test('X: a running broadcast resolves to its playlist, as a guest', async (t) => {
    const calls = fakeApi(t, { [ACTIVATE]: guestToken, [SHOW]: running, [STATUS]: playlist });
    const result = await resolveXBroadcast('https://x.com/i/broadcasts/1AJEmmYdMDnJL');
    assert.deepStrictEqual(result, {
        status: 'ok',
        url: 'https://prod-fastly.pscp.tv/live/master.m3u8',
        referer: 'https://x.com/',
        title: 'Launch',
        thumbnail: 'https://pbs.twimg.com/t.jpg',
        live: true
    });
    assert.ok(calls.filter(c => c.method === 'GET').every(c => c.headers['x-guest-token'] === 'guest-1'));
});

test('X: the guest token is reused, and renewed once when X retires it', async (t) => {
    let shows = 0;
    // X no longer accepts the token cached by the test above.
    const show = () => (++shows === 1 ? { status: 403, data: {} } : running);
    const calls = fakeApi(t, { [ACTIVATE]: guestToken, [SHOW]: show, [STATUS]: playlist });
    const result = await resolveXBroadcast('1AJEmmYdMDnJL');
    assert.strictEqual(result.status, 'ok');
    const gets = calls.filter(c => c.method === 'GET').map(c => c.headers['x-guest-token']);
    assert.deepStrictEqual(gets, ['guest-1', 'guest-2', 'guest-2']);
    assert.strictEqual(activations(calls), 1);

    // And kept for the next lookup.
    const again = fakeApi(t, { [ACTIVATE]: guestToken, [SHOW]: running, [STATUS]: playlist });
    await resolveXBroadcast('1AJEmmYdMDnJL');
    assert.strictEqual(activations(again), 0);
});

test('X: a broadcast that has not started says so', async (t) => {
    const notStarted = { data: { broadcasts: { '1AJEmmYdMDnJL': { media_key: '28_123', state: 'NOT_STARTED' } } } };
    fakeApi(t, { [ACTIVATE]: guestToken, [SHOW]: notStarted, [STATUS]: { status: 404, data: {} } });
    assert.deepStrictEqual(await resolveXBroadcast('1AJEmmYdMDnJL'),
        { status: 'offline', message: 'This X broadcast has not started yet' });
});

test('X: an unknown or private broadcast is unavailable', async (t) => {
    fakeApi(t, { [ACTIVATE]: guestToken, [SHOW]: { data: { broadcasts: {} } } });
    assert.deepStrictEqual(await resolveXBroadcast('1AJEmmYdMDnJL'),
        { status: 'offline', message: 'This X broadcast is unavailable' });
});

test('X: not reaching X is an error, and a non-broadcast URL is refused', async (t) => {
    fakeApi(t, { [ACTIVATE]: new Error('ENOTFOUND'), [SHOW]: new Error('ENOTFOUND') });
    // Forget the cached token so the activation is tried.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * 60 * 1000 });
    assert.deepStrictEqual(await resolveXBroadcast('1AJEmmYdMDnJL'),
        { status: 'error', message: 'Could not reach X to look up the broadcast' });
    assert.deepStrictEqual(await resolveXBroadcast('https://x.com/SpaceX'),
        { status: 'error', message: 'Unrecognised X broadcast URL' });
});

// ===== SpaceX =====

test('SpaceX: the featured webcast comes first, unplayable ones are dropped', async (t) => {
    const calls = fakeApi(t, {
        'GET https://content.spacex.com/api/spacex-website/missions/crew-12': {
            data: {
                title: 'Crew-12',
                webcasts: [
                    { streamingVideoType: 'youtube', videoId: 'abc' },
                    { streamingVideoType: 'x-live-studio', videoId: '1AJEmmYdMDnJL', isFeatured: true },
                    { streamingVideoType: 'unknown', videoId: 'zzz' },
                    { streamingVideoType: 'youtube', videoId: 'abc' }
                ]
            }
        }
    });
    assert.deepStrictEqual(await fetchLaunchWebcasts('https://www.spacex.com/launches/crew-12'), {
        title: 'Crew-12',
        webcasts: ['https://studio.x.com/embed/broadcast/1AJEmmYdMDnJL', 'https://www.youtube.com/watch?v=abc']
    });
    assert.strictEqual(calls[0].headers.Accept, 'application/json');
});

test('SpaceX: a mission that cannot be read, or a page that is not a launch, gives null', async (t) => {
    fakeApi(t, { 'GET https://content.spacex.com/': { status: 404, data: {} } });
    assert.strictEqual(await fetchLaunchWebcasts('https://www.spacex.com/launches/nope'), null);
    assert.strictEqual(await fetchLaunchWebcasts('https://www.spacex.com/vehicles/falcon-9'), null);
});
