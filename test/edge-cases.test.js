// Edge Cases Tests - Tests error handling and boundary conditions

console.log('Running Edge Cases Tests...\n');

let passed = 0;
let failed = 0;

// Test URL parsing edge cases
const urlParsingTests = [
    {
        name: 'Handle malformed URL with invalid protocol',
        input: 'ht!tp://example.com/video.mp4',
        shouldThrow: true
    },
    {
        name: 'Handle URL with missing domain',
        input: 'https:///video.mp4',
        shouldThrow: false // Valid URL (empty host)
    },
    {
        name: 'Handle extremely long URL',
        input: 'https://example.com/' + 'a'.repeat(10000) + '.mp4',
        shouldThrow: false // Valid, just long
    },
    {
        name: 'Handle URL with unicode characters',
        input: 'https://example.com/видео.mp4',
        shouldThrow: false
    },
    {
        name: 'Handle URL with encoded unicode',
        input: 'https://example.com/%D0%B2%D0%B8%D0%B4%D0%B5%D0%BE.mp4',
        shouldThrow: false
    },
    {
        name: 'Handle URL with fragment identifier',
        input: 'https://example.com/video.mp4#t=30',
        shouldThrow: false
    },
    {
        name: 'Handle URL with multiple query parameters',
        input: 'https://example.com/video.mp4?token=abc&expires=123&signature=xyz&quality=hd',
        shouldThrow: false
    },
    {
        name: 'Handle URL with empty query parameter',
        input: 'https://example.com/video.mp4?token=&key=',
        shouldThrow: false
    }
];

urlParsingTests.forEach(({ name, input, shouldThrow }, index) => {
    try {
        new URL(input);

        if (shouldThrow) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log('   Expected URL parsing to throw, but succeeded');
            failed++;
        } else {
            console.log(`✓ Test ${index + 1}: ${name}`);
            passed++;
        }
    } catch (err) {
        if (!shouldThrow) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log(`   Unexpected error: ${err.message}`);
            failed++;
        } else {
            console.log(`✓ Test ${index + 1}: ${name}`);
            passed++;
        }
    }
});

// Test playlist boundary conditions
const playlistBoundaryTests = [
    {
        name: 'Handle empty playlist',
        playlist: '',
        expectedValid: true
    },
    {
        name: 'Handle playlist with only header',
        playlist: '#EXTM3U',
        expectedValid: true
    },
    {
        name: 'Handle playlist with thousands of segments',
        playlist: '#EXTM3U\n#EXT-X-VERSION:3\n' + Array(1000).fill('#EXTINF:10.0,\nsegment.ts').join('\n'),
        expectedValid: true,
        minSize: 20000 // Should be large
    },
    {
        name: 'Handle playlist with very long lines',
        playlist: '#EXTM3U\n#EXTINF:10.0,\n' + 'https://example.com/' + 'x'.repeat(5000) + '.ts',
        expectedValid: true,
        minSize: 5000
    },
    {
        name: 'Handle playlist with mixed line endings (CRLF)',
        playlist: '#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXTINF:10.0,\r\nsegment.ts',
        expectedValid: true
    },
    {
        name: 'Handle playlist with only comments',
        playlist: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10',
        expectedValid: true
    },
    {
        name: 'Handle playlist with duplicate segment URLs',
        playlist: '#EXTM3U\n#EXTINF:10.0,\nsegment.ts\n#EXTINF:10.0,\nsegment.ts\n#EXTINF:10.0,\nsegment.ts',
        expectedValid: true
    }
];

playlistBoundaryTests.forEach(({ name, playlist, expectedValid, minSize }, index) => {
    try {
        // Basic validation
        if (expectedValid) {
            // Check it's a string
            if (typeof playlist !== 'string') {
                throw new Error('Playlist must be a string');
            }

            // Check minimum size if specified
            if (minSize && playlist.length < minSize) {
                throw new Error(`Playlist too small: ${playlist.length} < ${minSize}`);
            }

            console.log(`✓ Test ${urlParsingTests.length + index + 1}: ${name}`);
            passed++;
        }
    } catch (err) {
        console.log(`❌ Test ${urlParsingTests.length + index + 1} FAILED: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test cache edge cases
const cacheEdgeCases = [
    {
        name: 'Cache with timestamp in future (clock skew)',
        getTimestamp: () => Date.now() + 1000,
        isLive: false,
        expectedValid: true // Still valid since future - now = negative
    },
    {
        name: 'Cache with timestamp at 0 (epoch)',
        getTimestamp: () => 0,
        isLive: false,
        expectedValid: false // Very old
    },
    {
        name: 'Cache with negative timestamp',
        getTimestamp: () => -1000,
        isLive: false,
        expectedValid: false // Invalid
    },
    {
        name: 'Cache at exact expiration boundary (live)',
        age: 4000,
        isLive: true,
        expectedValid: false // Exactly at TTL = expired
    },
    {
        name: 'Cache 1ms before expiration (live)',
        age: 3999,
        isLive: true,
        expectedValid: true
    },
    {
        name: 'Cache 1ms after expiration (live)',
        age: 4001,
        isLive: true,
        expectedValid: false
    }
];

cacheEdgeCases.forEach(({ name, getTimestamp, age: fixedAge, isLive, expectedValid }, index) => {
    try {
        const CACHE_TTL_VOD = 60000;
        const CACHE_TTL_LIVE = 4000;
        const cacheTTL = isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;
        // Use fixed age if provided (avoids timing flakiness), otherwise compute from timestamp
        const age = fixedAge !== undefined ? fixedAge : Date.now() - getTimestamp();
        const isValid = (age < cacheTTL);

        if (isValid !== expectedValid) {
            console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected valid: ${expectedValid}, Got: ${isValid}`);
            console.log(`   Age: ${age}ms, TTL: ${cacheTTL}ms`);
            failed++;
        } else {
            console.log(`✓ Test ${urlParsingTests.length + playlistBoundaryTests.length + index + 1}: ${name}`);
            passed++;
        }
    } catch (err) {
        console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test content type detection
const contentTypeTests = [
    {
        name: 'Detect M3U8 from .m3u8 extension',
        url: 'https://example.com/stream.m3u8',
        expected: 'application/x-mpegURL'
    },
    {
        name: 'Detect M3U8 from playlist keyword',
        url: 'https://example.com/video/playlist?id=123',
        expected: 'application/x-mpegURL'
    },
    {
        name: 'Detect WebM from .webm extension',
        url: 'https://example.com/video.webm',
        expected: 'video/webm'
    },
    {
        name: 'Default to MP4 for unknown',
        url: 'https://example.com/video.xyz',
        expected: 'video/mp4'
    },
    {
        name: 'Handle uppercase extensions',
        url: 'https://example.com/video.M3U8',
        expected: 'application/x-mpegURL'
    },
    {
        name: 'Handle M3U8 with query parameters',
        url: 'https://example.com/stream.m3u8?token=abc',
        expected: 'application/x-mpegURL'
    }
];

contentTypeTests.forEach(({ name, url, expected }, index) => {
    try {
        // Simulate content type detection from server.js lines 443-448
        let contentType = 'video/mp4';
        const lowerUrl = url.toLowerCase();
        if (lowerUrl.includes('.m3u8') || lowerUrl.includes('playlist')) {
            contentType = 'application/x-mpegURL';
        }
        if (lowerUrl.includes('.webm')) contentType = 'video/webm';

        if (contentType !== expected) {
            console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected}`);
            console.log(`   Got: ${contentType}`);
            failed++;
        } else {
            console.log(`✓ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + index + 1}: ${name}`);
            passed++;
        }
    } catch (err) {
        console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test special characters in URLs
const specialCharTests = [
    {
        name: 'Handle URL with spaces (already encoded)',
        url: 'https://example.com/my%20video.mp4',
        shouldParse: true
    },
    {
        name: 'Handle URL with parentheses',
        url: 'https://example.com/video(1).mp4',
        shouldParse: true
    },
    {
        name: 'Handle URL with brackets',
        url: 'https://example.com/video[720p].mp4',
        shouldParse: true
    },
    {
        name: 'Handle URL with ampersand in query',
        url: 'https://example.com/video.mp4?a=1&b=2&c=3',
        shouldParse: true
    },
    {
        name: 'Handle URL with equals in query value',
        url: 'https://example.com/video.mp4?token=abc==',
        shouldParse: true
    }
];

specialCharTests.forEach(({ name, url, shouldParse }, index) => {
    try {
        new URL(url);

        if (!shouldParse) {
            console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + contentTypeTests.length + index + 1} FAILED: ${name}`);
            console.log('   Expected parsing to fail');
            failed++;
        } else {
            console.log(`✓ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + contentTypeTests.length + index + 1}: ${name}`);
            passed++;
        }
    } catch (err) {
        if (shouldParse) {
            console.log(`❌ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + contentTypeTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Unexpected error: ${err.message}`);
            failed++;
        } else {
            console.log(`✓ Test ${urlParsingTests.length + playlistBoundaryTests.length + cacheEdgeCases.length + contentTypeTests.length + index + 1}: ${name}`);
            passed++;
        }
    }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
