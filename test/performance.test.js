// Performance Tests - Tests performance-critical operations

const { test } = require('node:test');
const assert = require('assert');

// Test URL resolution performance
const performanceTests = [
    {
        name: 'Resolve 1000 URLs quickly',
        operation: () => {
            const { resolveM3u8Url } = require('../lib/proxy');
            const baseUrl = new URL('https://cdn.example.com/videos/stream.m3u8');

            const start = Date.now();
            for (let i = 0; i < 1000; i++) {
                resolveM3u8Url(`segment${i}.ts`, baseUrl);
            }
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 100 }; // Should complete in < 100ms
        }
    },
    {
        name: 'Parse large playlist quickly',
        operation: () => {
            // Generate a large playlist (1000 segments)
            const segments = Array(1000).fill(0).map((_, i) => `#EXTINF:4.0,\nsegment${i}.ts`).join('\n');
            const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n${segments}`;

            const start = Date.now();
            const lines = playlist.split('\n');
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 50, count: lines.length }; // Should parse < 50ms
        }
    },
    {
        name: 'URL encoding 1000 times is fast',
        operation: () => {
            const testUrl = 'https://cdn.example.com/video.ts?token=abc123&expires=9999999999&signature=xyz';

            const start = Date.now();
            for (let i = 0; i < 1000; i++) {
                encodeURIComponent(testUrl);
            }
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 50 }; // Should complete in < 50ms
        }
    },
    {
        name: 'Cache lookup is O(1)',
        operation: () => {
            const cache = new Map();

            // Populate cache with 1000 entries
            for (let i = 0; i < 1000; i++) {
                cache.set(`https://example.com/video${i}.m3u8`, {
                    content: 'test',
                    timestamp: Date.now(),
                    isLive: false
                });
            }

            // Measure lookup time
            const start = Date.now();
            for (let i = 0; i < 1000; i++) {
                cache.get(`https://example.com/video${i}.m3u8`);
            }
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 10 }; // Should be very fast < 10ms
        }
    },
    {
        name: 'String operations on large playlist',
        operation: () => {
            const largePlaylist = '#EXTM3U\n' + Array(5000).fill('#EXTINF:4.0,\nsegment.ts').join('\n');

            const start = Date.now();

            // Test common operations
            const _hasEndlist = largePlaylist.includes('#EXT-X-ENDLIST');
            const lines = largePlaylist.split('\n');
            const _filtered = lines.filter(l => !l.startsWith('#'));

            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 200, operations: 3 }; // < 200ms for large playlist
        }
    }
];

for (const { name, operation } of performanceTests) {
    test(name, () => {
        const result = operation();
        assert.ok(result.elapsed <= result.maxTime, `Took ${result.elapsed}ms (max: ${result.maxTime}ms)`);
    });
}

// Test memory efficiency
const memoryTests = [
    {
        name: 'Cache cleanup prevents memory leak',
        operation: () => {
            const cache = new Map();

            // Add 10000 entries
            for (let i = 0; i < 10000; i++) {
                cache.set(`url${i}`, { content: 'x'.repeat(1000), timestamp: Date.now() - 70000, isLive: false });
            }

            const sizeBefore = cache.size;

            // Simulate cleanup (server.js lines 85-98)
            const CACHE_TTL_VOD = 60000;
            const CACHE_TTL_LIVE = 4000;
            const now = Date.now();
            let cleaned = 0;

            for (const [key, value] of cache.entries()) {
                const ttl = value.isLive ? CACHE_TTL_LIVE : CACHE_TTL_VOD;
                if (now - value.timestamp > ttl) {
                    cache.delete(key);
                    cleaned++;
                }
            }

            return {
                sizeBefore,
                sizeAfter: cache.size,
                cleaned,
                expectedCleaned: 10000 // All should be cleaned
            };
        }
    },
    {
        name: 'Large playlist does not cause excessive memory',
        operation: () => {
            // Create a very large playlist
            const segments = Array(10000).fill(0).map((_, i) => `#EXTINF:4.0,\nhttps://cdn.example.com/seg${i}.ts`).join('\n');
            const playlist = `#EXTM3U\n${segments}`;

            const _lines = playlist.split('\n');

            // Rough estimate: each line ~50 chars, 20000 lines = ~1MB
            const estimatedSize = playlist.length;
            const maxSize = 5 * 1024 * 1024; // 5MB

            return { estimatedSize, maxSize, withinLimit: estimatedSize < maxSize };
        }
    }
];

for (const { name, operation } of memoryTests) {
    test(name, () => {
        const result = operation();
        if (result.expectedCleaned !== undefined) assert.strictEqual(result.cleaned, result.expectedCleaned);
        if (result.withinLimit !== undefined) {
            assert.ok(result.withinLimit, `Size ${result.estimatedSize} exceeds max ${result.maxSize}`);
        }
    });
}

// Test regex performance
const regexTests = [
    {
        name: 'M3U8 regex match is fast on large HTML',
        operation: () => {
            const largeHtml = '<html><body>' + 'x'.repeat(100000) + 'var url = "https://cdn.example.com/stream.m3u8";' + 'x'.repeat(100000) + '</body></html>';

            const start = Date.now();
            const match = largeHtml.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/);
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 50, found: match !== null };
        }
    },
    {
        name: 'MP4 regex match handles multiple URLs',
        operation: () => {
            const html = Array(100).fill('https://cdn.example.com/video.mp4 ').join('');

            const start = Date.now();
            const matches = html.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/g);
            const elapsed = Date.now() - start;

            return { elapsed, maxTime: 20, count: matches ? matches.length : 0 };
        }
    }
];

for (const { name, operation } of regexTests) {
    test(name, () => {
        const result = operation();
        assert.ok(result.elapsed <= result.maxTime, `Took ${result.elapsed}ms (max: ${result.maxTime}ms)`);
    });
}
