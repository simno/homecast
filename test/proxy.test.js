const { test } = require('node:test');
const assert = require('assert');
const { resolveM3u8Url } = require('../lib/proxy');

const testCases = [
    // Comments and tags
    {
        name: 'Skip #EXTM3U comment',
        input: '#EXTM3U',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: false, url: null }
    },
    {
        name: 'Skip #EXT-X-VERSION tag',
        input: '#EXT-X-VERSION:3',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: false, url: null }
    },
    {
        name: 'Skip #EXT-X-STREAM-INF tag',
        input: '#EXT-X-STREAM-INF:BANDWIDTH=4000000',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: false, url: null }
    },
    {
        name: 'Skip empty lines',
        input: '',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: false, url: null }
    },
    {
        name: 'Skip whitespace-only lines',
        input: '   ',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: false, url: null }
    },

    // Absolute URLs
    {
        name: 'Handle HTTPS absolute URLs',
        input: 'https://cdn.example.com/segment.ts',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: true, url: 'https://cdn.example.com/segment.ts' }
    },
    {
        name: 'Handle HTTP absolute URLs',
        input: 'http://cdn.example.com/segment.ts',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: true, url: 'http://cdn.example.com/segment.ts' }
    },
    {
        name: 'Handle absolute URLs with query parameters',
        input: 'https://cdn.example.com/segment.ts?token=abc123',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: true, url: 'https://cdn.example.com/segment.ts?token=abc123' }
    },
    {
        name: 'Real-world: Master playlist with absolute variant URL',
        input: 'https://pfl5.galaxaignite.space/playlist/42821/a.vortexstellar.space/caxi',
        base: 'https://red6.lumenglide.shop/playlist/42821/load-playlist',
        expected: { isUrl: true, url: 'https://pfl5.galaxaignite.space/playlist/42821/a.vortexstellar.space/caxi' }
    },

    // Protocol-relative URLs
    {
        name: 'Handle protocol-relative URLs',
        input: '//cdn.example.com/segment.ts',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: true, url: 'https://cdn.example.com/segment.ts' }
    },

    // Relative URLs
    {
        name: 'Resolve relative file paths',
        input: 'segment001.ts',
        base: 'https://example.com/path/to/playlist.m3u8',
        expected: { isUrl: true, url: 'https://example.com/path/to/segment001.ts' }
    },
    {
        name: 'Resolve relative directory paths',
        input: 'segments/segment001.ts',
        base: 'https://example.com/path/to/playlist.m3u8',
        expected: { isUrl: true, url: 'https://example.com/path/to/segments/segment001.ts' }
    },
    {
        name: 'Resolve parent directory paths',
        input: '../other/segment001.ts',
        base: 'https://example.com/path/to/playlist.m3u8',
        expected: { isUrl: true, url: 'https://example.com/path/other/segment001.ts' }
    },
    {
        name: 'Resolve root-relative paths',
        input: '/segments/segment001.ts',
        base: 'https://example.com/path/to/playlist.m3u8',
        expected: { isUrl: true, url: 'https://example.com/segments/segment001.ts' }
    },
    {
        name: 'Handle relative paths with query parameters',
        input: 'segment001.ts?token=xyz',
        base: 'https://example.com/path/to/playlist.m3u8',
        expected: { isUrl: true, url: 'https://example.com/path/to/segment001.ts?token=xyz' }
    },

    // Edge cases
    {
        name: 'Handle URLs with leading/trailing whitespace',
        input: '  https://cdn.example.com/segment.ts  ',
        base: 'https://example.com/playlist.m3u8',
        expected: { isUrl: true, url: 'https://cdn.example.com/segment.ts' }
    }
];

for (const { name, input, base, expected } of testCases) {
    test(name, () => {
        const result = resolveM3u8Url(input, new URL(base));
        assert.strictEqual(result.isUrl, expected.isUrl);
        if (expected.url !== undefined) assert.strictEqual(result.url, expected.url);
    });
}
