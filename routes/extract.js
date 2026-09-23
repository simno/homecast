const express = require('express');
const rateLimit = require('express-rate-limit');
const { findStreams, FinderError } = require('../lib/stream-finder');
const { validateProxyUrl } = require('../lib/security');

const router = express.Router();

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests, please try again later',
    standardHeaders: true,
    legacyHeaders: false
});

// Re-analysing the same URL within a minute (a second device, a retry after a
// failed cast) returns instantly. Short, because stream URLs carry expiring
// tokens.
const RESULT_TTL_MS = 60 * 1000;
const MAX_CACHED_RESULTS = 50;
const resultCache = new Map();

function cachedResult(url) {
    const hit = resultCache.get(url);
    if (!hit) return null;
    if (Date.now() - hit.at > RESULT_TTL_MS) {
        resultCache.delete(url);
        return null;
    }
    return hit.result;
}

function cacheResult(url, result) {
    resultCache.set(url, { at: Date.now(), result });
    while (resultCache.size > MAX_CACHED_RESULTS) {
        resultCache.delete(resultCache.keys().next().value);
    }
}

// --- API: Extract Video URL ---
// Responds with JSON { videos, title } by default. A client that sends
// `Accept: application/x-ndjson` gets progress lines ({ progress }) while the
// search runs, then one final line holding the result or { error, status }.
router.post('/api/extract', apiLimiter, async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    if (!url) {
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

    // Security: Validate URL for SSRF protection (same check used by /proxy)
    const validation = await validateProxyUrl(url);
    if (!validation.valid) {
        console.warn(`[Security] Blocked extract request: ${validation.reason}`);
        return res.status(403).json({
            error: 'URL blocked by security policy',
            reason: validation.reason,
            note: 'Set DISABLE_SSRF_PROTECTION=true to disable (not recommended for public deployments)'
        });
    }

    const streaming = (req.get('accept') || '').includes('application/x-ndjson');
    const send = (payload) => res.write(JSON.stringify(payload) + '\n');
    if (streaming) {
        res.status(200).set({
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();
    }

    // The user navigated away or hit Cancel: stop fetching and close the browser.
    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableFinished) controller.abort();
    });

    const started = Date.now();
    try {
        let result = cachedResult(url);
        if (!result) {
            result = await findStreams(url, {
                signal: controller.signal,
                onProgress: streaming ? (progress) => send({ progress }) : undefined
            });
            cacheResult(url, result);
        }

        console.log(`[Extract] Found ${result.videos.length} stream(s) at ${url} in ${Date.now() - started}ms`);
        result.videos.forEach((v, i) => {
            const resInfo = v.resolution ? ` (${v.resolution})` : '';
            console.log(`[Extract]   ${i + 1}. ${v.type.toUpperCase()}${resInfo} via ${v.source}: ${v.url.substring(0, 80)}`);
        });

        if (streaming) {
            send(result);
            return res.end();
        }
        res.json(result);
    } catch (err) {
        if (controller.signal.aborted) {
            console.log(`[Extract] Cancelled after ${Date.now() - started}ms: ${url}`);
            return res.end();
        }
        const status = err instanceof FinderError ? err.status : 500;
        const message = err instanceof FinderError ? err.message : 'Analysis failed unexpectedly';
        if (!(err instanceof FinderError)) console.error('[Extract] Unexpected error:', err);
        else console.log(`[Extract] ${message} (${url})`);

        if (streaming) {
            send({ error: message, status });
            return res.end();
        }
        res.status(status).json({ error: message });
    }
});

// Test seam
function clearExtractCache() {
    resultCache.clear();
}

module.exports = router;
module.exports.clearExtractCache = clearExtractCache;
