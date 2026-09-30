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
const { USER_AGENT } = require('../lib/utils');

// A replay on X that has stayed up; any public broadcast ID will do.
const X_BROADCAST = '1AJEmmYdMDnJL';
// A past launch whose mission record lists its webcast.
const SPACEX_LAUNCH = 'https://www.spacex.com/launches/starship-flight-10';
// Channels to try; the first live one is played. All offline still proves
// the token handshake works (usher answers 404 rather than refusing it).
const TWITCH_CHANNELS = ['lofigirl', 'twitch'];

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
