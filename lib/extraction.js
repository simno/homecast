const axios = require('axios');
const cheerio = require('cheerio');
const { httpAgent, httpsAgent } = require('./utils');

// --- Helper: Extract Video URL from HTML ---
function extractVideoFromHtml(html) {
    // 1. Common Player variables (source: "http...", file: "http...") - check first for accuracy
    let match = html.match(/(?:source|file)\s*:\s*['"](https?:\/\/[^"']+)['"]/);
    if (match) {
        return match[1];
    }

    // 2. Standard m3u8/mp4 URLs
    match = html.match(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/) ||
                html.match(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/);

    if (match) {
        return match[0];
    }

    // 3. Obfuscated window.atob('...')
    const atobMatch = html.match(/window\.atob\s*\(\s*['"]([a-zA-Z0-9+/=]+)['"]\s*\)/);
    if (atobMatch) {
        try {
            const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
            if (decoded.startsWith('http')) {
                console.log(`[Extract] Decoded atob URL: ${decoded}`);
                return decoded;
            }
        } catch {
            console.log('[Extract] Failed to decode atob string');
        }
    }

    return null;
}

// --- Helper: Extract iframes from JavaScript ---
async function extractIframesFromScripts(html, pageUrl) {
    const iframes = [];

    const docWriteMatches = html.matchAll(/document\.write\([^)]*src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    for (const match of docWriteMatches) {
        iframes.push(match[1]);
    }

    const srcMatches = html.matchAll(/<iframe[^>]+src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    for (const match of srcMatches) {
        iframes.push(match[1]);
    }

    const scriptSrcMatches = html.matchAll(/<script[^>]+src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
    const scriptUrls = [];
    for (const match of scriptSrcMatches) {
        scriptUrls.push(match[1]);
    }

    for (const scriptUrl of scriptUrls.slice(0, 3)) {
        try {
            console.log(`[Extract] Fetching external script: ${scriptUrl}`);
            const { data: scriptData } = await axios.get(scriptUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': pageUrl
                },
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                timeout: 3000
            });

            const scriptIframeMatches = scriptData.matchAll(/src\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi);
            for (const match of scriptIframeMatches) {
                iframes.push(match[1]);
            }
        } catch (err) {
            console.log(`[Extract] Failed to fetch script ${scriptUrl}: ${err.message}`);
        }
    }

    return iframes;
}

// --- Helper: Recursive Iframe Search ---
async function searchIframesRecursively(pageUrl, htmlData, referer, depth) {
    const MAX_DEPTH = 3;
    const MAX_IFRAMES_PER_LEVEL = 5;

    if (depth >= MAX_DEPTH) {
        console.log(`[Extract] Max recursion depth ${MAX_DEPTH} reached`);
        return null;
    }

    const $ = cheerio.load(htmlData);

    const videoUrl = extractVideoFromHtml(htmlData);
    if (videoUrl) {
        console.log(`[Extract] Found video at depth ${depth}: ${videoUrl}`);
        return { videoUrl, referer: pageUrl };
    }

    const iframes = $('iframe').map((i, el) => $(el).attr('src')).get().slice(0, MAX_IFRAMES_PER_LEVEL);
    const scriptIframes = await extractIframesFromScripts(htmlData, pageUrl);
    const allIframes = [...new Set([...iframes, ...scriptIframes])];

    for (let iframeSrc of allIframes) {
        if (!iframeSrc) continue;

        try {
            if (!iframeSrc.startsWith('http')) {
                iframeSrc = new URL(iframeSrc, new URL(pageUrl).origin).href;
            }

            console.log(`[Extract] Checking iframe at depth ${depth}: ${iframeSrc}`);

            const { data: iframeData } = await axios.get(iframeSrc, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': pageUrl
                },
                httpAgent: httpAgent,
                httpsAgent: httpsAgent,
                timeout: 5000
            });

            const result = await searchIframesRecursively(iframeSrc, iframeData, iframeSrc, depth + 1);
            if (result) {
                return result;
            }
        } catch (iframeErr) {
            console.log(`[Extract] Failed to check iframe at depth ${depth} (${iframeSrc}): ${iframeErr.message}`);
        }
    }

    return null;
}

// --- Helper: Detect Frame Rate ---
async function detectFrameRate(videoUrl, type) {
    try {
        if (type === 'mp4') {
            try {
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    timeout: 3000,
                    responseType: 'arraybuffer',
                    headers: {
                        'Range': 'bytes=0-65535'
                    },
                    validateStatus: (status) => status === 200 || status === 206
                });

                const buffer = Buffer.from(response.data);
                const timescale = findMvhdTimescale(buffer);
                if (timescale) {
                    if (timescale === 600) return 24;
                    if (timescale === 24000) return 24;
                    if (timescale === 23976) return 24;
                    if (timescale === 25000) return 25;
                    if (timescale === 1000) return 30;
                    if (timescale === 30000) return 30;
                    if (timescale === 29970) return 30;
                    if (timescale === 48000) return 48;
                    if (timescale === 50000) return 50;
                    if (timescale === 60000) return 60;
                    if (timescale === 59940) return 60;

                    const estimatedFps = Math.round(timescale / 1000);
                    if (estimatedFps >= 15 && estimatedFps <= 120) return estimatedFps;
                }
            } catch {
                // Silently fail - frame rate detection is optional
            }
        }

        return null;
    } catch {
        return null;
    }
}

function findMvhdTimescale(buffer) {
    try {
        const mvhdIndex = buffer.indexOf('mvhd');
        if (mvhdIndex === -1) return null;

        const versionOffset = mvhdIndex + 4;
        if (versionOffset >= buffer.length) return null;

        const version = buffer[versionOffset];
        let timescaleOffset;

        if (version === 1) {
            timescaleOffset = mvhdIndex + 4 + 20;
        } else {
            timescaleOffset = mvhdIndex + 4 + 12;
        }

        if (timescaleOffset + 4 > buffer.length) return null;

        const timescale = buffer.readUInt32BE(timescaleOffset);
        if (timescale < 1 || timescale > 600000) return null;

        return timescale;
    } catch {
        return null;
    }
}

// --- Helper: Detect Resolution ---
async function detectResolution(videoUrl, type) {
    try {
        const urlPatterns = [
            { regex: /(\d{3,4})p/i, format: (m) => `${m[1]}p` },
            { regex: /(\d{3,4})x(\d{3,4})/i, format: (m) => `${m[2]}p` },
            { regex: /_hd\b|\/hd\b/i, format: () => 'HD' },
            { regex: /_sd\b|\/sd\b/i, format: () => 'SD' },
            { regex: /_fhd\b|\/fhd\b/i, format: () => '1080p' },
            { regex: /4k|uhd|2160/i, format: () => '4K' },
            { regex: /quality[=_](\d+)/i, format: (m) => `${m[1]}p` }
        ];

        for (const pattern of urlPatterns) {
            const match = videoUrl.match(pattern.regex);
            if (match) {
                return pattern.format(match);
            }
        }

        if (type === 'hls' && videoUrl.includes('.m3u8')) {
            try {
                const response = await axios({
                    method: 'get',
                    url: videoUrl,
                    timeout: 3000,
                    maxContentLength: 50000,
                    validateStatus: (status) => status === 200
                });

                const playlist = response.data;
                const resMatch = playlist.match(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)/);
                if (resMatch) {
                    return `${parseInt(resMatch[2])}p`;
                }

                const bandwidthMatch = playlist.match(/#EXT-X-STREAM-INF:[^\n]*BANDWIDTH=(\d+)/);
                if (bandwidthMatch) {
                    const bandwidth = parseInt(bandwidthMatch[1]);
                    if (bandwidth > 5000000) return '1080p+';
                    if (bandwidth > 2500000) return '720p';
                    if (bandwidth > 1000000) return '480p';
                    return 'SD';
                }
            } catch {
                // Silently fail
            }
        }

        if (type === 'mp4') {
            try {
                const response = await axios({
                    method: 'head',
                    url: videoUrl,
                    timeout: 2000,
                    validateStatus: (status) => status === 200
                });

                const contentLength = parseInt(response.headers['content-length'] || '0');
                if (contentLength > 0) {
                    const sizeMB = contentLength / (1024 * 1024);
                    if (sizeMB > 2000) return '1080p+';
                    if (sizeMB > 800) return '720p';
                    if (sizeMB > 300) return '480p';
                    return 'SD';
                }
            } catch {
                // Silently fail
            }
        }

        return null;
    } catch {
        return null;
    }
}

module.exports = {
    extractVideoFromHtml,
    extractIframesFromScripts,
    searchIframesRecursively,
    detectFrameRate,
    detectResolution
};
