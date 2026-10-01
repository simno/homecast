// The site resolvers' conversations with their APIs (lib/twitch.js,
// lib/x-broadcast.js, lib/spacex.js, lib/kick.js, lib/dailymotion.js,
// lib/rumble.js, lib/nasa.js), with axios standing in for the network:
// what each sends, and how each answer becomes a stream or a message.
// test/site-smoke.js runs the same resolvers against the real sites.
const { test } = require('node:test');
const assert = require('assert');
const axios = require('axios');
const { resolveTwitchStream } = require('../lib/twitch');
const { resolveXBroadcast, postIdFromUrl, broadcastsInPost, syndicationToken } = require('../lib/x-broadcast');
const { fetchLaunchWebcasts } = require('../lib/spacex');
const { parseKickUrl, resolveKick } = require('../lib/kick');
const { videoIdFromUrl, resolveDailymotion } = require('../lib/dailymotion');
const { isRumbleVideoUrl, resolveRumble } = require('../lib/rumble');
const { isNasaLiveUrl, resolveNasaLive, decodeEntities } = require('../lib/nasa');

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

test('X: a post\'s ID is read from its URL, other pages give none', () => {
    assert.strictEqual(postIdFromUrl('https://x.com/i/status/1960178606212063307'), '1960178606212063307');
    assert.strictEqual(postIdFromUrl('https://twitter.com/SpaceX/status/1960178606212063307/video/1'), '1960178606212063307');
    assert.strictEqual(postIdFromUrl('https://x.com/SpaceX'), null);
    assert.strictEqual(postIdFromUrl('https://x.com/i/broadcasts/1lPKqvNwLREGb'), null);
    assert.strictEqual(postIdFromUrl('https://example.com/i/status/1'), null);
});

test('X: a post\'s linked broadcasts come from the embed service, with the token X\'s embeds send', async (t) => {
    const calls = fakeApi(t, {
        'GET https://cdn.syndication.twimg.com/tweet-result': {
            data: {
                entities: {
                    urls: [
                        { expanded_url: 'http://spacex.com/launches/starship-flight-10' },
                        { expanded_url: 'https://x.com/i/broadcasts/1lPKqvNwLREGb' },
                        { expanded_url: 'https://x.com/i/broadcasts/1lPKqvNwLREGb' }
                    ]
                }
            }
        }
    });
    assert.deepStrictEqual(await broadcastsInPost('1960178606212063307'), ['https://x.com/i/broadcasts/1lPKqvNwLREGb']);
    assert.strictEqual(syndicationToken('1960178606212063307'), '4r22z6vcxki');
    assert.ok(calls[0].url.startsWith('https://cdn.syndication.twimg.com/tweet-result'));
});

test('X: a post that can\'t be read links nothing', async (t) => {
    fakeApi(t, { 'GET https://cdn.syndication.twimg.com/': new Error('Request failed with status code 404') });
    assert.deepStrictEqual(await broadcastsInPost('1'), []);
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

// ===== Kick =====

const KICK_CHANNEL = 'GET https://kick.com/api/v2/channels/xqc';

test('Kick: URLs name a channel, a past broadcast or a clip', () => {
    const uuid = 'bd5dcbda-957d-4c3a-88b7-e689c607b9a3';
    assert.deepStrictEqual(parseKickUrl('https://kick.com/xQc'), { kind: 'live', channel: 'xqc' });
    assert.deepStrictEqual(parseKickUrl('https://player.kick.com/xqc'), { kind: 'live', channel: 'xqc' });
    assert.deepStrictEqual(parseKickUrl(`https://kick.com/xqc/videos/${uuid}`), { kind: 'vod', uuid });
    assert.deepStrictEqual(parseKickUrl(`https://kick.com/video/${uuid}`), { kind: 'vod', uuid });
    assert.deepStrictEqual(parseKickUrl('https://kick.com/xqc/clips/clip_01ABC'), { kind: 'clip', clipId: 'clip_01ABC' });
    assert.deepStrictEqual(parseKickUrl('https://kick.com/xqc?clip=clip_01ABC'), { kind: 'clip', clipId: 'clip_01ABC' });
    assert.strictEqual(parseKickUrl('https://kick.com/browse'), null);
    assert.strictEqual(parseKickUrl('https://kick.com/categories/gta'), null);
    assert.strictEqual(parseKickUrl('https://notkick.com/xqc'), null);
});

test('Kick: a live channel resolves to its playback URL', async (t) => {
    fakeApi(t, {
        [KICK_CHANNEL]: {
            data: {
                playback_url: 'https://ivs.example/channel.m3u8?token=t',
                user: { username: 'xQc' },
                livestream: { is_live: true, session_title: 'GTA', thumbnail: { url: 'https://thumb.example/0.jpg' } }
            }
        }
    });
    assert.deepStrictEqual(await resolveKick('https://kick.com/xqc'), {
        status: 'ok', type: 'hls', referer: 'https://kick.com/', live: true,
        url: 'https://ivs.example/channel.m3u8?token=t', title: 'GTA', thumbnail: 'https://thumb.example/0.jpg'
    });
});

test('Kick: a channel with a playback URL but no live stream is offline', async (t) => {
    fakeApi(t, { [KICK_CHANNEL]: { data: { playback_url: 'https://ivs.example/channel.m3u8', livestream: null } } });
    assert.deepStrictEqual(await resolveKick('https://kick.com/xqc'), { status: 'offline', message: 'This Kick channel is offline' });
});

test('Kick: past broadcasts and clips resolve to their recordings', async (t) => {
    const uuid = 'bd5dcbda-957d-4c3a-88b7-e689c607b9a3';
    fakeApi(t, {
        [`GET https://kick.com/api/v1/video/${uuid}`]: {
            data: { source: 'https://stream.kick.com/vod/master.m3u8', livestream: { session_title: 'Yesterday', thumbnail: 'https://thumb.example/v.jpg' } }
        },
        'GET https://kick.com/api/v2/clips/clip_01ABC': {
            data: { clip: { title: 'Nice', video_url: 'https://clips.kick.com/c/playlist.m3u8', thumbnail_url: 'https://clips.kick.com/c/t.webp' } }
        }
    });
    const vod = await resolveKick(`https://kick.com/xqc/videos/${uuid}`);
    assert.deepStrictEqual([vod.url, vod.live, vod.title, vod.thumbnail],
        ['https://stream.kick.com/vod/master.m3u8', false, 'Yesterday', 'https://thumb.example/v.jpg']);
    const clip = await resolveKick('https://kick.com/xqc/clips/clip_01ABC');
    assert.deepStrictEqual([clip.url, clip.live, clip.title], ['https://clips.kick.com/c/playlist.m3u8', false, 'Nice']);
});

test('Kick: unknown channels are offline, other failures errors', async (t) => {
    fakeApi(t, {
        [KICK_CHANNEL]: { status: 404, data: {} },
        'GET https://kick.com/api/v2/channels/blocked': { status: 403, data: '<html>Just a moment…</html>' },
        'GET https://kick.com/api/v2/channels/down': new Error('ECONNRESET')
    });
    assert.deepStrictEqual(await resolveKick('https://kick.com/xqc'),
        { status: 'offline', message: 'This Kick channel doesn\'t exist or has been removed' });
    assert.deepStrictEqual(await resolveKick('https://kick.com/blocked'),
        { status: 'error', message: 'Kick returned an unexpected response (403)' });
    assert.deepStrictEqual(await resolveKick('https://kick.com/down'), { status: 'error', message: 'Could not reach Kick' });
    assert.deepStrictEqual(await resolveKick('https://kick.com/browse'), { status: 'error', message: 'Unrecognised Kick URL' });
});

// ===== Dailymotion =====

const DM_VIDEO = 'GET https://geo.dailymotion.com/videos/x8j6bwk';

test('Dailymotion: the video ID is read from every URL form', () => {
    for (const url of [
        'https://www.dailymotion.com/video/x8j6bwk',
        'https://www.dailymotion.com/video/x8j6bwk_popeye-many-tanks',
        'https://www.dailymotion.com/embed/video/x8j6bwk?autoplay=1',
        'https://dai.ly/x8j6bwk',
        'https://geo.dailymotion.com/player/xtv3w.html?video=x8j6bwk'
    ]) assert.strictEqual(videoIdFromUrl(url), 'x8j6bwk', url);
    assert.strictEqual(videoIdFromUrl('https://www.dailymotion.com/tv'), null);
    assert.strictEqual(videoIdFromUrl('https://example.com/video/x8j6bwk'), null);
});

test('Dailymotion: a video resolves to its manifest, with its title and largest poster', async (t) => {
    fakeApi(t, {
        [`${DM_VIDEO}/details`]: { data: { info: { title: 'Popeye' } } },
        [DM_VIDEO]: {
            data: {
                stream: { stream_type: 'recorded', url: 'https://www.dailymotion.com/cdn/manifest/video/x8j6bwk.m3u8?sec=s' },
                media: { posters_url: { 60: 'https://s.example/x60', 1080: 'https://s.example/x1080', 480: 'https://s.example/x480' } }
            }
        }
    });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'), {
        status: 'ok', type: 'hls', referer: 'https://www.dailymotion.com/', live: false,
        url: 'https://www.dailymotion.com/cdn/manifest/video/x8j6bwk.m3u8?sec=s',
        title: 'Popeye', thumbnail: 'https://s.example/x1080'
    });
});

test('Dailymotion: a live stream is live, and a missing title costs nothing', async (t) => {
    fakeApi(t, {
        [`${DM_VIDEO}/details`]: new Error('ETIMEDOUT'),
        [DM_VIDEO]: { data: { stream: { stream_type: 'live', url: 'https://www.dailymotion.com/cdn/live/video/x8j6bwk.m3u8' } } }
    });
    const result = await resolveDailymotion('https://www.dailymotion.com/video/x8j6bwk');
    assert.deepStrictEqual([result.status, result.live, result.title, result.thumbnail], ['ok', true, null, null]);
});

test('Dailymotion: refusals are explained', async (t) => {
    fakeApi(t, {
        [`${DM_VIDEO}/details`]: { status: 404, data: {} },
        [DM_VIDEO]: { status: 404, data: { error: { code: '404', reason: 'content_not_found' } } },
        'GET https://geo.dailymotion.com/videos/x9zenyk': { data: { error: { code: 'DM016', reason: 'embed_rules' } } },
        'GET https://geo.dailymotion.com/videos/x1new': { data: { error: { reason: 'something_new' } } }
    });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'),
        { status: 'offline', message: 'This Dailymotion video doesn\'t exist or has been removed' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x9zenyk'),
        { status: 'offline', message: 'This Dailymotion video can only be played on dailymotion.com' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x1new'),
        { status: 'offline', message: 'Dailymotion won\'t play this video (something_new)' });
});

test('Dailymotion: no stream, or no reaching Dailymotion, is an error', async (t) => {
    fakeApi(t, {
        [`${DM_VIDEO}/details`]: { data: {} },
        [DM_VIDEO]: { status: 500, data: 'oops' },
        'GET https://geo.dailymotion.com/videos/x2down': new Error('ENOTFOUND')
    });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'),
        { status: 'error', message: 'Dailymotion returned an unexpected response (500)' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x2down'),
        { status: 'error', message: 'Could not reach Dailymotion' });
});

// ===== Rumble =====

const RUMBLE_OEMBED = 'GET https://rumble.com/api/Media/oembed.json';

test('Rumble: only video pages are resolved', () => {
    assert.strictEqual(isRumbleVideoUrl('https://rumble.com/v7g69dk-space-revolution-ep.-38.html?e9s=src'), true);
    assert.strictEqual(isRumbleVideoUrl('https://www.rumble.com/v7g69dk.html'), true);
    assert.strictEqual(isRumbleVideoUrl('https://rumble.com/embed/v7dzwg2/'), false, 'embeds are scanned as they are');
    assert.strictEqual(isRumbleVideoUrl('https://rumble.com/c/BadlandsMedia'), false);
    assert.strictEqual(isRumbleVideoUrl('https://example.com/v7g69dk-x.html'), false);
});

test('Rumble: oEmbed names the embed page to scan instead', async (t) => {
    const calls = fakeApi(t, {
        [RUMBLE_OEMBED]: {
            data: {
                title: 'Space Revolution Ep. 38',
                thumbnail_url: 'https://1a-1791.com/t.jpg',
                html: '<iframe src="https://rumble.com/embed/v7dzwg2/" width="1920" height="1080"></iframe>'
            }
        }
    });
    assert.deepStrictEqual(await resolveRumble('https://rumble.com/v7g69dk-space-revolution-ep.-38.html?e9s=src_v1'), {
        status: 'page', url: 'https://rumble.com/embed/v7dzwg2/',
        title: 'Space Revolution Ep. 38', thumbnail: 'https://1a-1791.com/t.jpg'
    });
    assert.strictEqual(calls.length, 1);
});

test('Rumble: an unknown video is offline, an answer without an embed an error', async (t) => {
    let reply = { status: 404, data: 'Media not found with that url' };
    fakeApi(t, { [RUMBLE_OEMBED]: () => reply });
    assert.deepStrictEqual(await resolveRumble('https://rumble.com/v1-gone.html'),
        { status: 'offline', message: 'This Rumble video doesn\'t exist or has been removed' });
    reply = { status: 200, data: { html: '<p>no player</p>' } };
    assert.deepStrictEqual(await resolveRumble('https://rumble.com/v1-odd.html'),
        { status: 'error', message: 'Rumble returned an unexpected response (200)' });
});

// ===== NASA+ =====

const NASA_SCHEDULE = 'GET https://plus.nasa.gov/wp-json/wp/v2/scheduled_video';
const NASA_CHANNEL = 'GET https://plus.nasa.gov/wp-json/nasaplus/v1/live-streams';
const CHANNEL_URL = 'https://mediatailor.example/v1/channel/NASAPrime/NASAPlus.m3u8';
const launchEvent = {
    title: { rendered: 'NASA&#8217;s SpaceX Crew-13 Launch' },
    meta: { 'video-url': 'https://ntv1.akamaized.net/hls/live/launch/master.m3u8', first_aired_date: '1000', end_aired_date: '2000' }
};

test('NASA+: the home page and NASA\'s live pages are resolved, other pages scanned', () => {
    assert.strictEqual(isNasaLiveUrl('https://plus.nasa.gov/'), true);
    assert.strictEqual(isNasaLiveUrl('https://plus.nasa.gov'), true);
    assert.strictEqual(isNasaLiveUrl('https://www.nasa.gov/live/'), true);
    assert.strictEqual(isNasaLiveUrl('https://plus.nasa.gov/video/planetary-defenders/'), false);
    assert.strictEqual(isNasaLiveUrl('https://plus.nasa.gov/scheduled-video/crew-13-launch/'), false);
    assert.strictEqual(isNasaLiveUrl('https://www.nasa.gov/news/'), false);
});

test('NASA+: an event on air comes before the channel', async (t) => {
    fakeApi(t, { [NASA_SCHEDULE]: { data: [launchEvent] }, [NASA_CHANNEL]: { data: [{ 'live-stream-link': CHANNEL_URL }] } });
    const result = await resolveNasaLive('https://plus.nasa.gov/', { now: 1500 * 1000 });
    assert.deepStrictEqual([result.status, result.url, result.live, result.title],
        ['ok', launchEvent.meta['video-url'], true, 'NASA’s SpaceX Crew-13 Launch']);
});

test('NASA+: with no event on air, or no schedule, the channel plays', async (t) => {
    let schedule = { data: [launchEvent] };
    fakeApi(t, { [NASA_SCHEDULE]: () => schedule, [NASA_CHANNEL]: { data: [{ title: 'MediaTailor', 'live-stream-link': CHANNEL_URL }] } });
    const later = await resolveNasaLive('https://plus.nasa.gov/', { now: 2000 * 1000 });
    assert.deepStrictEqual([later.url, later.title], [CHANNEL_URL, 'NASA+ Live']);
    schedule = new Error('ETIMEDOUT');
    assert.strictEqual((await resolveNasaLive('https://plus.nasa.gov/')).url, CHANNEL_URL);
});

test('NASA+: no channel is offline, no reaching NASA+ an error', async (t) => {
    let channels = { data: [] };
    fakeApi(t, { [NASA_SCHEDULE]: { data: [] }, [NASA_CHANNEL]: () => channels });
    assert.deepStrictEqual(await resolveNasaLive('https://plus.nasa.gov/'),
        { status: 'offline', message: 'NASA+ isn\'t streaming live right now' });
    channels = new Error('ECONNREFUSED');
    assert.deepStrictEqual(await resolveNasaLive('https://plus.nasa.gov/'), { status: 'error', message: 'Could not reach NASA+' });
});

test('NASA+: WordPress title entities are decoded', () => {
    assert.strictEqual(decodeEntities('A &amp; B &#8211; C&#x27;s'), 'A & B – C\'s');
    assert.strictEqual(decodeEntities(undefined), null);
});
