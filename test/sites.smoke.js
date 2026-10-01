// The site resolvers against the real sites (npm run test:sites). Not part
// of npm test: it needs the internet, and the sites change on their own
// schedule. A weekly workflow (.github/workflows/sites.yml) runs it so an API
// change is noticed before a user reports it. site-resolvers.test.js covers
// the same code offline.
//
// When a check fails, first confirm the fixture below still exists (a replay
// can be deleted, a mission page renamed) before suspecting the resolver.
const { test } = require('node:test');
const assert = require('assert');
const axios = require('axios');
const { resolveTwitchStream } = require('../lib/twitch');
const { resolveXBroadcast } = require('../lib/x-broadcast');
const { fetchLaunchWebcasts } = require('../lib/spacex');
const { resolveKick } = require('../lib/kick');
const { resolveDailymotion } = require('../lib/dailymotion');
const { resolveRumble } = require('../lib/rumble');
const { resolveNasaLive } = require('../lib/nasa');
const { resolveYouTube } = require('../lib/youtube');
const { findStreams } = require('../lib/stream-finder');
const { USER_AGENT } = require('../lib/utils');

// A replay on X that has stayed up; any public broadcast ID will do.
const X_BROADCAST = '1AJEmmYdMDnJL';
// A past launch whose mission record lists its webcast.
const SPACEX_LAUNCH = 'https://www.spacex.com/launches/starship-flight-10';
// Channels to try; the first live one is played. All offline still proves
// the token handshake works (usher answers 404 rather than refusing it).
const TWITCH_CHANNELS = ['lofigirl', 'twitch'];
// Kick: channels to try for a live one; any existing channel proves the API.
const KICK_CHANNELS = ['xqc', 'adinross', 'kick'];
// A long-standing public Dailymotion video (a 1933 Popeye cartoon).
const DAILYMOTION_VIDEO = 'https://www.dailymotion.com/video/x8j6bwk';
// A Rumble video page; oEmbed maps it to its embed page.
const RUMBLE_VIDEO = 'https://rumble.com/v7g69dk-space-revolution-ep.-38.html';
// Blender's Big Buck Bunny, on its official channel.
const YOUTUBE_VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

async function fetchPlaylist(url, referer) {
    const { data } = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT, ...(referer ? { Referer: referer } : {}) },
        timeout: 15000,
        responseType: 'text'
    });
    return data;
}

test('Twitch: a playback token is issued and usher answers', async () => {
    const results = [];
    for (const channel of TWITCH_CHANNELS) {
        const result = await resolveTwitchStream(`https://www.twitch.tv/${channel}`);
        results.push({ channel, ...result });
        assert.notStrictEqual(result.status, 'error', `${channel}: ${result.message}`);
        if (result.status === 'ok') {
            const playlist = await fetchPlaylist(result.url, result.referer);
            assert.match(playlist, /#EXT-X-STREAM-INF/, `${channel}: the master playlist has no variants`);
            // H.264 only was asked for; Chromecasts can't play the others.
            assert.doesNotMatch(playlist, /CODECS="(?:av01|hvc1|hev1)/, `${channel}: non-H.264 variants came back`);
            return;
        }
    }
    console.log('[Sites] No test channel is live; checked the token handshake only:', JSON.stringify(results));
});

test('X: a broadcast resolves, as a guest, to a playlist that loads', async () => {
    const result = await resolveXBroadcast(X_BROADCAST);
    assert.strictEqual(result.status, 'ok', `${X_BROADCAST}: ${result.message}`);
    assert.match(await fetchPlaylist(result.url, result.referer), /#EXTM3U/);
});

test('SpaceX: a launch page\'s mission record lists its webcast', async () => {
    const result = await fetchLaunchWebcasts(SPACEX_LAUNCH);
    assert.ok(result, 'the mission record could not be read');
    assert.ok(result.title, 'the mission has no title');
    assert.ok(result.webcasts.length > 0, 'no webcast HomeCast can play was listed');
});

test('Kick: a channel resolves, and a live one\'s playlist loads', async () => {
    for (const channel of KICK_CHANNELS) {
        const result = await resolveKick(`https://kick.com/${channel}`);
        assert.notStrictEqual(result.status, 'error', `${channel}: ${result.message}`);
        if (result.status === 'ok') {
            assert.match(await fetchPlaylist(result.url, result.referer), /#EXTM3U/);
            return;
        }
    }
    console.log('[Sites] No Kick test channel is live; checked the channel lookup only');
});

test('Dailymotion: a video resolves to a manifest that loads', async () => {
    const result = await resolveDailymotion(DAILYMOTION_VIDEO);
    assert.strictEqual(result.status, 'ok', result.message);
    assert.match(await fetchPlaylist(result.url, result.referer), /#EXT-X-STREAM-INF/);
});

test('Rumble: a video page leads to an embed page with a playable stream', async () => {
    const result = await resolveRumble(RUMBLE_VIDEO);
    assert.strictEqual(result.status, 'page', result.message);
    const found = await findStreams(RUMBLE_VIDEO, { browser: false });
    assert.ok(found.videos.length > 0, 'the embed page named no stream');
});

test('NASA+: the live channel resolves to a playlist that loads', async () => {
    const result = await resolveNasaLive('https://plus.nasa.gov/');
    assert.strictEqual(result.status, 'ok', result.message);
    assert.match(await fetchPlaylist(result.url, result.referer), /#EXTM3U/);
});

test('YouTube: yt-dlp resolves a video to an HLS master that loads', async (t) => {
    const result = await resolveYouTube(YOUTUBE_VIDEO);
    if (result.status === 'unavailable') return t.skip('yt-dlp is not installed');
    // CI runners are data-centre addresses, which YouTube often won't serve.
    if (/possible bot/.test(result.message || '')) return t.skip(result.message);
    assert.strictEqual(result.status, 'ok', result.message);
    const master = result.streams.find(s => s.type === 'hls');
    assert.ok(master, 'no HLS master in yt-dlp\'s answer');
    assert.match(await fetchPlaylist(master.url), /CODECS="avc1/, 'no H.264 variant');
});
