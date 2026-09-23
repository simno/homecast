// Twitch Resolver Tests - URL parsing and usher playlist construction (no network)

const { test } = require('node:test');
const assert = require('assert');
const { isTwitchUrl, parseTwitchUrl } = require('../lib/twitch');

// --- isTwitchUrl ---
test('recognises twitch.tv hosts', () => {
    assert.strictEqual(isTwitchUrl('https://www.twitch.tv/pgl'), true);
    assert.strictEqual(isTwitchUrl('https://twitch.tv/pgl'), true);
    assert.strictEqual(isTwitchUrl('https://m.twitch.tv/pgl'), true);
    assert.strictEqual(isTwitchUrl('https://player.twitch.tv/?channel=pgl'), true);
});

test('rejects non-twitch and malformed hosts', () => {
    assert.strictEqual(isTwitchUrl('https://example.com/twitch.tv'), false);
    assert.strictEqual(isTwitchUrl('https://nottwitch.tv/pgl'), false);
    assert.strictEqual(isTwitchUrl('not a url'), false);
});

// --- parseTwitchUrl ---
test('parses live channel from a channel page', () => {
    assert.deepStrictEqual(parseTwitchUrl('https://www.twitch.tv/PGL'),
        { kind: 'live', channel: 'pgl' });
});

test('parses live channel from the embed player URL (the og:video case)', () => {
    const url = 'https://player.twitch.tv/?channel=pgl&player=facebook&autoplay=true&parent=meta.tag';
    assert.deepStrictEqual(parseTwitchUrl(url), { kind: 'live', channel: 'pgl' });
});

test('parses VOD from /videos/ path', () => {
    assert.deepStrictEqual(parseTwitchUrl('https://www.twitch.tv/videos/123456789'),
        { kind: 'vod', vodId: '123456789' });
});

test('parses VOD from player ?video= (strips leading v)', () => {
    assert.deepStrictEqual(parseTwitchUrl('https://player.twitch.tv/?video=v123'),
        { kind: 'vod', vodId: '123' });
});

test('does not treat reserved feature paths as channels', () => {
    assert.strictEqual(parseTwitchUrl('https://www.twitch.tv/directory/game/Chess'), null);
    assert.strictEqual(parseTwitchUrl('https://www.twitch.tv/settings'), null);
});

