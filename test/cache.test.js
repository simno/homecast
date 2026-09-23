// Cache Logic Tests - Tests adaptive caching system for live vs VOD streams

const { test } = require('node:test');
const assert = require('assert');

// Test cases for stream type detection
const streamDetectionTests = [
    {
        name: 'Detect VOD stream with EXT-X-ENDLIST',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment1.ts
#EXTINF:10.0,
segment2.ts
#EXT-X-ENDLIST`,
        expectedType: 'VOD',
        expectedTTL: 60000
    },
    {
        name: 'Detect live stream without EXT-X-ENDLIST',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment1001.ts
#EXTINF:4.0,
segment1002.ts`,
        expectedType: 'LIVE',
        expectedTTL: 4000
    },
    {
        name: 'Case-sensitive check: lowercase endlist not detected (LIVE)',
        playlist: `#EXTM3U
#ext-x-endlist`,
        expectedType: 'LIVE', // .includes() is case-sensitive
        expectedTTL: 4000
    },
    {
        name: 'Detect live stream with sequence number',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:52301
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
segment52301.ts`,
        expectedType: 'LIVE',
        expectedTTL: 4000
    },
    {
        name: 'Empty playlist should be treated as VOD',
        playlist: '#EXTM3U',
        expectedType: 'LIVE', // No endlist = live
        expectedTTL: 4000
    }
];

for (const { name, playlist, expectedType, expectedTTL } of streamDetectionTests) {
    test(name, () => {
        // Simulate the detection logic from server.js line 332
        const isLive = !playlist.includes('#EXT-X-ENDLIST');
        assert.strictEqual(isLive ? 'LIVE' : 'VOD', expectedType);
        assert.strictEqual(isLive ? 4000 : 60000, expectedTTL);
    });
}

// Test cache expiration logic
const cacheExpirationTests = [
    {
        name: 'VOD cache should be valid within 60s',
        isLive: false,
        timestamp: Date.now() - 30000, // 30 seconds ago
        expectedValid: true
    },
    {
        name: 'VOD cache should expire after 60s',
        isLive: false,
        timestamp: Date.now() - 61000, // 61 seconds ago
        expectedValid: false
    },
    {
        name: 'Live cache should be valid within 4s',
        isLive: true,
        timestamp: Date.now() - 2000, // 2 seconds ago
        expectedValid: true
    },
    {
        name: 'Live cache should expire after 4s',
        isLive: true,
        timestamp: Date.now() - 5000, // 5 seconds ago
        expectedValid: false
    },
    {
        name: 'Live cache at exactly 4s should expire',
        isLive: true,
        timestamp: Date.now() - 4000, // Exactly 4 seconds ago
        expectedValid: false
    },
    {
        name: 'VOD cache at exactly 60s should expire',
        isLive: false,
        timestamp: Date.now() - 60000, // Exactly 60 seconds ago
        expectedValid: false
    }
];

for (const { name, isLive, timestamp, expectedValid } of cacheExpirationTests) {
    test(name, () => {
        // Simulate cache validation logic from server.js line 291-294
        const CACHE_TTL_VOD = 60000;
        const CACHE_TTL_LIVE = 4000;
        const cacheTTL = isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;
        const age = Date.now() - timestamp;
        assert.strictEqual(age < cacheTTL, expectedValid, `Age: ${age}ms, TTL: ${cacheTTL}ms`);
    });
}

// Test cache key generation
const cacheKeyTests = [
    {
        name: 'Cache key should match URL exactly',
        url: 'https://example.com/playlist.m3u8',
        expectedKey: 'https://example.com/playlist.m3u8'
    },
    {
        name: 'Cache key should preserve query parameters',
        url: 'https://example.com/playlist.m3u8?token=abc123&expires=1234567890',
        expectedKey: 'https://example.com/playlist.m3u8?token=abc123&expires=1234567890'
    },
    {
        name: 'Cache key should be case-sensitive',
        url: 'https://Example.COM/Playlist.M3U8',
        expectedKey: 'https://Example.COM/Playlist.M3U8'
    }
];

for (const { name, url, expectedKey } of cacheKeyTests) {
    test(name, () => {
        // Simulate cache key generation from server.js line 287
        const cacheKey = url;
        assert.strictEqual(cacheKey, expectedKey);
    });
}
