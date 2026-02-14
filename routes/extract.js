const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const rateLimit = require('express-rate-limit');
const { httpAgent, httpsAgent } = require('../lib/utils');
const { searchIframesRecursively, detectResolution } = require('../lib/extraction');

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
    let videoReferer = url;

    try {
        if (url.match(/\.(mp4|m3u8|webm|mkv)$/i)) return res.json({ videos: [{ url, referer: url }] });

        const { data } = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
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
            const result = await searchIframesRecursively(url, data, url, 0);
            if (result) {
                foundVideos.add(result.videoUrl);
                videoReferer = result.referer;
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

            const resolution = await detectResolution(resolvedUrl, type);

            videos.push({
                url: resolvedUrl,
                referer: videoReferer,
                type: type,
                resolution: resolution,
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
