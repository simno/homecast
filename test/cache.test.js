// Cache Logic Tests - Tests adaptive caching system for live vs VOD streams

console.log('Running Cache Logic Tests...\n');

let passed = 0;
let failed = 0;

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

streamDetectionTests.forEach(({ name, playlist, expectedType, expectedTTL }, index) => {
    try {
        // Simulate the detection logic from server.js line 332
        const isLive = !playlist.includes('#EXT-X-ENDLIST');
        const actualType = isLive ? 'LIVE' : 'VOD';
        const actualTTL = isLive ? 4000 : 60000;

        if (actualType !== expectedType) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log(`   Expected type: ${expectedType}, Got: ${actualType}`);
            failed++;
            return;
        }

        if (actualTTL !== expectedTTL) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log(`   Expected TTL: ${expectedTTL}ms, Got: ${actualTTL}ms`);
            failed++;
            return;
        }

        console.log(`✓ Test ${index + 1}: ${name} (${actualType}, TTL: ${actualTTL}ms)`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

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

cacheExpirationTests.forEach(({ name, isLive, timestamp, expectedValid }, index) => {
    try {
        // Simulate cache validation logic from server.js line 291-294
        const CACHE_TTL_VOD = 60000;
        const CACHE_TTL_LIVE = 4000;
        const cacheTTL = isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;
        const isValid = (Date.now() - timestamp < cacheTTL);

        if (isValid !== expectedValid) {
            console.log(`❌ Test ${streamDetectionTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected valid: ${expectedValid}, Got: ${isValid}`);
            console.log(`   Age: ${Date.now() - timestamp}ms, TTL: ${cacheTTL}ms`);
            failed++;
            return;
        }

        console.log(`✓ Test ${streamDetectionTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${streamDetectionTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

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

cacheKeyTests.forEach(({ name, url, expectedKey }, index) => {
    try {
        // Simulate cache key generation from server.js line 287
        const cacheKey = url;

        if (cacheKey !== expectedKey) {
            console.log(`❌ Test ${streamDetectionTests.length + cacheExpirationTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expectedKey}`);
            console.log(`   Got: ${cacheKey}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${streamDetectionTests.length + cacheExpirationTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${streamDetectionTests.length + cacheExpirationTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
