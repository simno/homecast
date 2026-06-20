const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const { httpAgent, httpsAgent, USER_AGENT } = require('../lib/utils');
const { searchIframesRecursively, detectResolution, getHlsQualities } = require('../lib/extraction');
const { isTwitchUrl, resolveTwitchStream } = require('../lib/twitch');

let extractWithBrowser = null;
function getBrowserExtractor() {
    if (extractWithBrowser !== null) return extractWithBrowser;
    try {
        extractWithBrowser = require('../lib/browser').extractWithBrowser;
    } catch {
        console.log('[Extract] Playwright not available, browser fallback disabled');
        extractWithBrowser = undefined;
    }
    return extractWithBrowser;
}

const router = express.Router();

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

// --- API: Extract Video URL ---
router.post('/api/extract', apiLimiter, async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Invalid or missing URL parameter' });
    }

    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: 'Only http and https URLs are allowed' });
        }
    } catch {
        return res.status(400).json({ error: 'Invalid URL format' });
    }

    let videoReferer = url;

    try {
        if (url.match(/\.(mp4|m3u8|webm|mkv)$/i)) {
            const directType = /\.m3u8$/i.test(url) ? 'hls' : 'mp4';
            const qualities = directType === 'hls' ? await getHlsQualities(url) : [];
            return res.json({ videos: [{ url, referer: url, type: directType, qualities }] });
        }

        // Twitch exposes an og:video pointing at its HTML embed player, which the
        // generic scraper below would mis-classify as a playable MP4. Resolve the
        // real HLS stream via Twitch's playback-token API instead.
        if (isTwitchUrl(url)) {
            const twitch = await resolveTwitchStream(url);
            if (twitch.status === 'ok') {
                const qualities = await getHlsQualities(twitch.url);
                const resolution = qualities.length > 0
                    ? qualities[0].label
                    : await detectResolution(twitch.url, 'hls');
                console.log(`[Extract] Resolved Twitch HLS stream: ${twitch.url.substring(0, 80)}...`);
                return res.json({
                    videos: [{
                        url: twitch.url,
                        referer: twitch.referer,
                        type: 'hls',
                        resolution,
                        qualities,
                        unsupported: false
                    }]
                });
            }
            // The generic scraper only ever finds Twitch's embed player page (an
            // unplayable HTML doc), so don't fall through — report the real reason.
            const statusCode = twitch.status === 'offline' ? 404 : 502;
            console.log(`[Extract] Twitch unavailable (${twitch.status}): ${twitch.message}`);
            return res.status(statusCode).json({ error: twitch.message });
        }

        const { data } = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            httpAgent: httpAgent,
            httpsAgent: httpsAgent,
            timeout: 10000
        });
        const $ = cheerio.load(data);

        const foundVideos = new Set();

        $('video source').each((i, el) => {
            const src = $(el).attr('src');
            if (src) foundVideos.add(src);
        });

        const videoSrc = $('video').attr('src');
        if (videoSrc) foundVideos.add(videoSrc);

        const ogVideo = $('meta[property="og:video"]').attr('content');
        if (ogVideo) foundVideos.add(ogVideo);

        const ogVideoUrl = $('meta[property="og:video:url"]').attr('content');
        if (ogVideoUrl) foundVideos.add(ogVideoUrl);

        const m3u8Matches = data.matchAll(/https?:\/\/[^"'\s]+\.m3u8(\?[^"'\s]*)?/g);
        for (const match of m3u8Matches) {
            foundVideos.add(match[0]);
        }

        const mp4Matches = data.matchAll(/https?:\/\/[^"'\s]+\.mp4(\?[^"'\s]*)?/g);
        for (const match of mp4Matches) {
            foundVideos.add(match[0]);
        }

        const mjpegMatches = data.matchAll(/https?:\/\/[^"'\s]+(?:mjpg|mjpeg|jpg\/video)[^"'\s]*/g);
        for (const match of mjpegMatches) {
            foundVideos.add(match[0]);
        }

        if (foundVideos.size === 0) {
            // Detect SPAs: modern frameworks that render video players client-side.
            // Drop the tight size limit — many SPAs serve large initial HTML via SSR.
            const isSpa = (
                data.includes('id="root"') ||
                data.includes('id="app"') ||
                data.includes('id="__next"') ||
                data.includes('id="__nuxt"') ||
                data.includes('data-reactroot') ||
                data.includes('data-react-root') ||
                data.includes('ng-app') ||
                data.includes('ng-version') ||
                data.includes('data-v-') ||
                data.includes('__NEXT_DATA__') ||
                data.includes('window.__NUXT__') ||
                data.includes('window.__INITIAL_STATE__') ||
                data.includes('_next/static') ||
                // Streaming sites that render players client-side
                data.includes('player.twitch.tv') ||
                data.includes('/js/twitch') ||
                data.includes('kraken')  // Twitch API bootstrap
            );

            if (isSpa) {
                console.log('[Extract] SPA detected, trying headless browser...');
                const browserExtract = getBrowserExtractor();
                if (browserExtract) {
                    const browserVideos = await browserExtract(url);
                    if (browserVideos) {
                        for (const v of browserVideos) {
                            foundVideos.add(v.url);
                        }
                        videoReferer = browserVideos[0].referer;
                    }
                }
            }

            if (foundVideos.size === 0 && !isSpa) {
                const result = await searchIframesRecursively(url, data, url, 0);
                if (result) {
                    foundVideos.add(result.videoUrl);
                    videoReferer = result.referer;
                }
            }
        }

        if (foundVideos.size === 0) return res.status(404).json({ error: 'No video found' });

        const videos = [];
        for (const videoUrl of foundVideos) {
            let resolvedUrl = videoUrl;

            if (videoUrl && !videoUrl.startsWith('http')) {
                try {
                    const u = new URL(url);
                    resolvedUrl = new URL(videoUrl, u.origin).href;
                } catch {
                    continue;
                }
            }

            const isMjpeg = resolvedUrl.match(/mjpe?g|jpg.*video/i);
            const type = isMjpeg ? 'mjpeg' : (resolvedUrl.includes('.m3u8') ? 'hls' : 'mp4');

            const qualities = type === 'hls' ? await getHlsQualities(resolvedUrl) : [];
            const resolution = (type === 'hls' && qualities.length > 0)
                ? qualities[0].label
                : await detectResolution(resolvedUrl, type);

            videos.push({
                url: resolvedUrl,
                referer: videoReferer,
                type: type,
                resolution: resolution,
                qualities,
                unsupported: isMjpeg
            });
        }

        videos.sort((a, b) => {
            const priority = { hls: 0, mp4: 1, mjpeg: 2 };
            return priority[a.type] - priority[b.type];
        });

        console.log(`[Extract] Found ${videos.length} video stream(s) at ${url}`);
        videos.forEach((v, i) => {
            const resInfo = v.resolution ? ` (${v.resolution})` : '';
            console.log(`[Extract]   ${i + 1}. ${v.type.toUpperCase()}${resInfo}: ${v.url.substring(0, 80)}...`);
        });

        res.json({ videos });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
