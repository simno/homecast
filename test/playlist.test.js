// Playlist Rewriting Tests - Tests M3U8 playlist rewriting logic

console.log('Running Playlist Rewriting Tests...\n');

let passed = 0;
let failed = 0;

// Simulate the playlist rewriting logic from server.js lines 334-344
function rewritePlaylist(originalM3u8, baseUrl, proxyHost) {
    const { resolveM3u8Url } = require('../lib/proxy');
    const parsedBaseUrl = new URL(baseUrl);

    return originalM3u8.split('\n').map(line => {
        const result = resolveM3u8Url(line, parsedBaseUrl);

        if (!result.isUrl) {
            return line; // Keep original line (comments, etc.)
        }

        // Rewrite to point to proxy
        const proxyUrl = `http://${proxyHost}/proxy?url=${encodeURIComponent(result.url)}&referer=${encodeURIComponent('')}`;
        return proxyUrl;
    }).join('\n');
}

const playlistRewriteTests = [
    {
        name: 'Rewrite simple VOD playlist with relative URLs',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
segment001.ts
#EXTINF:10.0,
segment002.ts
#EXT-X-ENDLIST`,
        baseUrl: 'https://cdn.example.com/videos/stream.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 2,
        shouldContainProxy: true
    },
    {
        name: 'Rewrite live playlist with absolute URLs',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:1001
#EXTINF:4.0,
https://cdn1.example.com/live/seg1001.ts
#EXTINF:4.0,
https://cdn1.example.com/live/seg1002.ts`,
        baseUrl: 'https://origin.example.com/live.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 2,
        shouldContainProxy: true
    },
    {
        name: 'Preserve comments and tags in playlist',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10.0,
segment.ts
#EXT-X-ENDLIST`,
        baseUrl: 'https://cdn.example.com/stream.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 1,
        shouldContainProxy: true
    },
    {
        name: 'Handle master playlist with variant URLs',
        playlist: `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
hd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
sd.m3u8`,
        baseUrl: 'https://cdn.example.com/master.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 2,
        shouldContainProxy: true
    },
    {
        name: 'Handle mixed absolute and relative URLs',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10.0,
segment001.ts
#EXTINF:10.0,
https://cdn2.example.com/segment002.ts
#EXTINF:10.0,
//cdn3.example.com/segment003.ts`,
        baseUrl: 'https://cdn1.example.com/stream.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 3,
        shouldContainProxy: true
    },
    {
        name: 'Handle playlist with query parameters',
        playlist: `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10.0,
segment.ts?token=abc123&expires=9999999999`,
        baseUrl: 'https://cdn.example.com/stream.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 1,
        shouldContainProxy: true
    },
    {
        name: 'Handle empty lines and whitespace',
        playlist: `#EXTM3U
#EXT-X-VERSION:3

#EXTINF:10.0,
segment.ts

#EXT-X-ENDLIST`,
        baseUrl: 'https://cdn.example.com/stream.m3u8',
        proxyHost: 'localhost:3000',
        expectedSegments: 1,
        shouldContainProxy: true
    }
];

playlistRewriteTests.forEach(({ name, playlist, baseUrl, proxyHost, expectedSegments, shouldContainProxy }, index) => {
    try {
        const rewritten = rewritePlaylist(playlist, baseUrl, proxyHost);

        // Check that proxy URLs are present
        const proxyCount = (rewritten.match(/http:\/\/localhost:3000\/proxy\?url=/g) || []).length;

        if (proxyCount !== expectedSegments) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log(`   Expected ${expectedSegments} proxy URLs, found ${proxyCount}`);
            console.log(`   Rewritten:\n${rewritten}`);
            failed++;
            return;
        }

        // Check that all original tags/comments are preserved
        const originalLines = playlist.split('\n').filter(l => l.trim().startsWith('#'));
        const rewrittenLines = rewritten.split('\n').filter(l => l.trim().startsWith('#'));

        if (originalLines.length !== rewrittenLines.length) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log('   Tags/comments not preserved correctly');
            console.log(`   Expected ${originalLines.length} comment lines, found ${rewrittenLines.length}`);
            failed++;
            return;
        }

        // Check that URLs are properly encoded
        if (shouldContainProxy && !rewritten.includes('url=https%3A%2F%2F')) {
            // At least one absolute URL should be encoded
            const hasEncodedUrl = rewritten.includes('url=https%3A') || rewritten.includes('url=http%3A');
            if (!hasEncodedUrl && playlist.includes('http')) {
                console.log(`❌ Test ${index + 1} FAILED: ${name}`);
                console.log('   URLs not properly URL-encoded');
                failed++;
                return;
            }
        }

        console.log(`✓ Test ${index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test URL encoding specifically
const encodingTests = [
    {
        name: 'Encode special characters in URL',
        url: 'https://cdn.example.com/video.ts?token=abc&key=123',
        expectedEncoded: 'https%3A%2F%2Fcdn.example.com%2Fvideo.ts%3Ftoken%3Dabc%26key%3D123'
    },
    {
        name: 'Encode spaces in URL (should be %20)',
        url: 'https://cdn.example.com/my video.ts',
        expectedEncoded: 'https%3A%2F%2Fcdn.example.com%2Fmy%20video.ts'
    },
    {
        name: 'Encode URL with already encoded params',
        url: 'https://cdn.example.com/video.ts?redirect=https%3A%2F%2Fother.com',
        expectedEncoded: 'https%3A%2F%2Fcdn.example.com%2Fvideo.ts%3Fredirect%3Dhttps%253A%252F%252Fother.com'
    }
];

encodingTests.forEach(({ name, url, expectedEncoded }, index) => {
    try {
        const encoded = encodeURIComponent(url);

        if (encoded !== expectedEncoded) {
            console.log(`❌ Test ${playlistRewriteTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expectedEncoded}`);
            console.log(`   Got: ${encoded}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${playlistRewriteTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${playlistRewriteTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
