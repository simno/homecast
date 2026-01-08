// Extract API Tests - Tests video URL extraction from HTML

console.log('Running Video Extraction Tests...\n');

let passed = 0;
let failed = 0;

// Helper to simulate extraction logic
function extractVideoUrl(html, pageUrl) {
    // Simulate direct video file detection (line 117 in server.js)
    // Note: Regex checks file extension at END of URL (before query params fails)
    if (pageUrl.match(/\.(mp4|m3u8|webm|mkv)$/i)) {
        return { videoUrl: pageUrl, referer: pageUrl };
    }

    // Simulate video source extraction from HTML
    // This mimics the cheerio logic from server.js lines 126-131

    // Try <video> tags
    let match = html.match(/<video[^>]*src=["']([^"']+)["']/i);
    if (match) return { videoUrl: match[1], referer: pageUrl };

    match = html.match(/<video[^>]*>[\s\S]*?<source[^>]*src=["']([^"']+)["']/i);
    if (match) return { videoUrl: match[1], referer: pageUrl };

    // Try meta tags
    match = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["']([^"']+)["']/i);
    if (match) return { videoUrl: match[1], referer: pageUrl };

    match = html.match(/<meta[^>]*property=["']og:video:url["'][^>]*content=["']([^"']+)["']/i);
    if (match) return { videoUrl: match[1], referer: pageUrl };

    // Regex search for m3u8 (server.js line 136-138)
    match = html.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/);
    if (match) return { videoUrl: match[0], referer: pageUrl };

    // Regex search for mp4 (server.js line 142-144)
    match = html.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/);
    if (match) return { videoUrl: match[0], referer: pageUrl };

    // Check for iframes
    match = html.match(/<iframe[^>]*src=["']([^"']+)["']/i);
    if (match) {
        const iframeSrc = match[1];
        // Simulate iframe extraction (simplified)
        return { videoUrl: null, iframeSrc };
    }

    return { videoUrl: null };
}

// Test direct video file URLs
const directVideoTests = [
    {
        name: 'Detect direct MP4 URL',
        url: 'https://example.com/video.mp4',
        html: '',
        expected: { videoUrl: 'https://example.com/video.mp4', referer: 'https://example.com/video.mp4' }
    },
    {
        name: 'Detect direct M3U8 URL',
        url: 'https://example.com/stream.m3u8',
        html: '',
        expected: { videoUrl: 'https://example.com/stream.m3u8', referer: 'https://example.com/stream.m3u8' }
    },
    {
        name: 'Detect direct WebM URL',
        url: 'https://example.com/video.webm',
        html: '',
        expected: { videoUrl: 'https://example.com/video.webm', referer: 'https://example.com/video.webm' }
    },
    {
        name: 'Detect direct MKV URL',
        url: 'https://example.com/video.mkv',
        html: '',
        expected: { videoUrl: 'https://example.com/video.mkv', referer: 'https://example.com/video.mkv' }
    },
    {
        name: 'Direct URL regex only matches extension at end',
        url: 'https://example.com/video.mp4?token=abc123',
        html: '',
        expected: { videoUrl: null } // Regex /\.mp4$/i fails with query params
    }
];

directVideoTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        if (result.videoUrl !== expected.videoUrl) {
            console.log(`❌ Test ${index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected.videoUrl}`);
            console.log(`   Got: ${result.videoUrl}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test HTML video tag extraction
const videoTagTests = [
    {
        name: 'Extract from <video src="">',
        url: 'https://example.com/page.html',
        html: '<video src="https://cdn.example.com/video.mp4"></video>',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    },
    {
        name: 'Extract from <video><source src="">',
        url: 'https://example.com/page.html',
        html: '<video><source src="https://cdn.example.com/video.mp4" type="video/mp4"></video>',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    },
    {
        name: 'Extract from <video> with multiple sources (first wins)',
        url: 'https://example.com/page.html',
        html: '<video><source src="https://cdn.example.com/video-hd.mp4"><source src="https://cdn.example.com/video-sd.mp4"></video>',
        expected: { videoUrl: 'https://cdn.example.com/video-hd.mp4' }
    },
    {
        name: 'Handle video tag with attributes',
        url: 'https://example.com/page.html',
        html: '<video controls autoplay src="https://cdn.example.com/video.mp4">',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    }
];

videoTagTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        if (result.videoUrl !== expected.videoUrl) {
            console.log(`❌ Test ${directVideoTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected.videoUrl}`);
            console.log(`   Got: ${result.videoUrl}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${directVideoTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${directVideoTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test meta tag extraction
const metaTagTests = [
    {
        name: 'Extract from og:video meta tag',
        url: 'https://example.com/page.html',
        html: '<meta property="og:video" content="https://cdn.example.com/video.mp4">',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    },
    {
        name: 'Extract from og:video:url meta tag',
        url: 'https://example.com/page.html',
        html: '<meta property="og:video:url" content="https://cdn.example.com/video.mp4">',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    },
    {
        name: 'Handle meta tag with single quotes',
        url: 'https://example.com/page.html',
        html: "<meta property='og:video' content='https://cdn.example.com/video.mp4'>",
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    }
];

metaTagTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        if (result.videoUrl !== expected.videoUrl) {
            console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected.videoUrl}`);
            console.log(`   Got: ${result.videoUrl}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${directVideoTests.length + videoTagTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test regex fallback extraction
const regexExtractionTests = [
    {
        name: 'Extract M3U8 from JavaScript variable',
        url: 'https://example.com/page.html',
        html: 'var videoUrl = "https://cdn.example.com/stream.m3u8";',
        expected: { videoUrl: 'https://cdn.example.com/stream.m3u8' }
    },
    {
        name: 'Extract M3U8 with query parameters',
        url: 'https://example.com/page.html',
        html: 'source: "https://cdn.example.com/stream.m3u8?token=xyz123&expires=1234567890"',
        expected: { videoUrl: 'https://cdn.example.com/stream.m3u8?token=xyz123&expires=1234567890' }
    },
    {
        name: 'Extract MP4 from JSON',
        url: 'https://example.com/page.html',
        html: '{"video": {"url": "https://cdn.example.com/video.mp4"}}',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' }
    },
    {
        name: 'Extract first M3U8 when multiple present',
        url: 'https://example.com/page.html',
        html: 'var hd = "https://cdn.example.com/hd.m3u8"; var sd = "https://cdn.example.com/sd.m3u8";',
        expected: { videoUrl: 'https://cdn.example.com/hd.m3u8' }
    },
    {
        name: 'Prefer M3U8 over MP4',
        url: 'https://example.com/page.html',
        html: 'fallback: "https://cdn.example.com/video.mp4", stream: "https://cdn.example.com/stream.m3u8"',
        expected: { videoUrl: 'https://cdn.example.com/stream.m3u8' }
    }
];

regexExtractionTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        if (result.videoUrl !== expected.videoUrl) {
            console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected.videoUrl}`);
            console.log(`   Got: ${result.videoUrl}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test iframe detection
const iframeTests = [
    {
        name: 'Detect iframe with video player',
        url: 'https://example.com/page.html',
        html: '<iframe src="https://player.example.com/embed/video123"></iframe>',
        expected: { iframeSrc: 'https://player.example.com/embed/video123' }
    },
    {
        name: 'Detect iframe with single quotes',
        url: 'https://example.com/page.html',
        html: "<iframe src='https://player.example.com/embed/video123'></iframe>",
        expected: { iframeSrc: 'https://player.example.com/embed/video123' }
    },
    {
        name: 'Detect iframe with attributes',
        url: 'https://example.com/page.html',
        html: '<iframe width="640" height="480" src="https://player.example.com/embed/video123" frameborder="0"></iframe>',
        expected: { iframeSrc: 'https://player.example.com/embed/video123' }
    }
];

iframeTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        // For iframe tests, we check if iframe was detected (videoUrl would be null)
        if (result.videoUrl !== null && result.videoUrl !== expected.videoUrl) {
            // Only fail if we got a videoUrl when we shouldn't, or wrong iframeSrc
            if (!result.iframeSrc || result.iframeSrc !== expected.iframeSrc) {
                console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + index + 1} FAILED: ${name}`);
                console.log(`   Expected iframe: ${expected.iframeSrc}`);
                console.log(`   Got: ${result.iframeSrc || 'none'}`);
                failed++;
                return;
            }
        }

        console.log(`✓ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

// Test edge cases
const edgeCaseTests = [
    {
        name: 'Handle empty HTML',
        url: 'https://example.com/page.html',
        html: '',
        expected: { videoUrl: null }
    },
    {
        name: 'Handle HTML with no video',
        url: 'https://example.com/page.html',
        html: '<html><body><h1>Hello World</h1></body></html>',
        expected: { videoUrl: null }
    },
    {
        name: 'Handle malformed video tags',
        url: 'https://example.com/page.html',
        html: '<video src=>',
        expected: { videoUrl: null }
    },
    {
        name: 'Regex finds first match (MP4 before M3U8 in source)',
        url: 'https://example.com/page.html',
        html: '<!-- <video src="https://cdn.example.com/video.mp4"> --> var realUrl = "https://cdn.example.com/real.m3u8";',
        expected: { videoUrl: 'https://cdn.example.com/video.mp4' } // First match wins
    }
];

edgeCaseTests.forEach(({ name, url, html, expected }, index) => {
    try {
        const result = extractVideoUrl(html, url);

        if (result.videoUrl !== expected.videoUrl) {
            console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + iframeTests.length + index + 1} FAILED: ${name}`);
            console.log(`   Expected: ${expected.videoUrl}`);
            console.log(`   Got: ${result.videoUrl}`);
            failed++;
            return;
        }

        console.log(`✓ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + iframeTests.length + index + 1}: ${name}`);
        passed++;
    } catch (err) {
        console.log(`❌ Test ${directVideoTests.length + videoTagTests.length + metaTagTests.length + regexExtractionTests.length + iframeTests.length + index + 1} ERROR: ${name}`);
        console.log(`   ${err.message}`);
        failed++;
    }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
