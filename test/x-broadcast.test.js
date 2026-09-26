// X broadcast and SpaceX launch resolvers - URL parsing (no network)

const { test } = require('node:test');
const assert = require('assert');
const { isXBroadcastUrl, broadcastIdFromUrl } = require('../lib/x-broadcast');
const { launchSlugFromUrl, webcastUrl } = require('../lib/spacex');

// --- broadcastIdFromUrl ---
test('reads the broadcast ID from x.com and twitter.com broadcast pages', () => {
    assert.strictEqual(broadcastIdFromUrl('https://x.com/i/broadcasts/1AJEmmYdMDnJL'), '1AJEmmYdMDnJL');
    assert.strictEqual(broadcastIdFromUrl('https://twitter.com/i/broadcasts/1AJEmmYdMDnJL?s=20'), '1AJEmmYdMDnJL');
    assert.strictEqual(broadcastIdFromUrl('https://mobile.x.com/i/broadcasts/1AJEmmYdMDnJL'), '1AJEmmYdMDnJL');
});

test('reads the broadcast ID from the studio embed and Periscope links', () => {
    assert.strictEqual(broadcastIdFromUrl('https://studio.x.com/embed/broadcast/1AJEmmYdMDnJL'), '1AJEmmYdMDnJL');
    assert.strictEqual(broadcastIdFromUrl('https://www.periscope.tv/w/1AJEmmYdMDnJL'), '1AJEmmYdMDnJL');
    assert.strictEqual(broadcastIdFromUrl('https://pscp.tv/w/1AJEmmYdMDnJL'), '1AJEmmYdMDnJL');
});

test('rejects other X pages and look-alike hosts', () => {
    assert.strictEqual(isXBroadcastUrl('https://x.com/SpaceX'), false);
    assert.strictEqual(isXBroadcastUrl('https://x.com/SpaceX/status/123'), false);
    assert.strictEqual(isXBroadcastUrl('https://notx.com/i/broadcasts/1AJEmmYdMDnJL'), false);
    assert.strictEqual(isXBroadcastUrl('https://example.com/i/broadcasts/1AJEmmYdMDnJL'), false);
    assert.strictEqual(isXBroadcastUrl('not a url'), false);
});

// --- SpaceX launch pages ---
test('reads the mission slug from a launch page', () => {
    assert.strictEqual(launchSlugFromUrl('https://www.spacex.com/launches/starship-flight-13'), 'starship-flight-13');
    assert.strictEqual(launchSlugFromUrl('https://spacex.com/launches/crew-12/'), 'crew-12');
});

test('ignores the launches index and other hosts', () => {
    assert.strictEqual(launchSlugFromUrl('https://www.spacex.com/launches'), null);
    assert.strictEqual(launchSlugFromUrl('https://www.spacex.com/vehicles/starship'), null);
    assert.strictEqual(launchSlugFromUrl('https://notspacex.com/launches/starship-flight-13'), null);
});

test('builds the player URL for each webcast type, as the site does', () => {
    assert.strictEqual(webcastUrl({ streamingVideoType: 'x-live-studio', videoId: '1AJEmmYdMDnJL' }),
        'https://studio.x.com/embed/broadcast/1AJEmmYdMDnJL');
    assert.strictEqual(webcastUrl({ streamingVideoType: 'youtube', videoId: 'abc' }), 'https://www.youtube.com/watch?v=abc');
    assert.strictEqual(webcastUrl({ streamingVideoType: 'x.com', videoId: '123' }), 'https://x.com/i/status/123');
    assert.strictEqual(webcastUrl({ streamingVideoType: 'vimeo', videoId: '1' }), null);
    assert.strictEqual(webcastUrl({ streamingVideoType: 'x-live-studio', videoId: null }), null);
});

test('the studio embed a launch page builds resolves to its broadcast', () => {
    const url = webcastUrl({ streamingVideoType: 'x-live-studio', videoId: '1AJEmmYdMDnJL' });
    assert.strictEqual(broadcastIdFromUrl(url), '1AJEmmYdMDnJL');
});
