const axios = require('axios');

// --- Helper: Try Next Segment ---
async function tryNextSegment(currentUrl) {
    try {
        const match = currentUrl.match(/(\d+)\.(?:ts|m4s|mp4)(\?.*)?$/);
        if (!match) return null;

        const segmentNumber = parseInt(match[1]);
        const nextSegmentNumber = segmentNumber + 1;
        const nextUrl = currentUrl.replace(`${segmentNumber}.`, `${nextSegmentNumber}.`);

        const response = await axios({
            method: 'head',
            url: nextUrl,
            timeout: 1000,
            validateStatus: (status) => status < 500
        });

        if (response.status === 200) {
            console.log(`[Proxy] Next segment exists (${nextSegmentNumber}), skipping missing segment ${segmentNumber}`);
            return nextUrl;
        }
    } catch {
        // Next segment doesn't exist or error checking
    }
    return null;
}

// --- Helper: Resolve M3U8 URLs ---
function resolveM3u8Url(line, baseUrl) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
        return { isUrl: false, url: null };
    }

    try {
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            new URL(trimmed);
            return { isUrl: true, url: trimmed };
        }

        if (trimmed.startsWith('//')) {
            const absoluteUrl = baseUrl.protocol + trimmed;
            new URL(absoluteUrl);
            return { isUrl: true, url: absoluteUrl };
        }

        const absoluteUrl = new URL(trimmed, baseUrl).href;
        return { isUrl: true, url: absoluteUrl };
    } catch {
        console.log(`[Proxy] Failed to parse URL: ${trimmed.substring(0, 100)}`);
        return { isUrl: false, url: null };
    }
}

module.exports = { tryNextSegment, resolveM3u8Url };
