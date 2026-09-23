const express = require('express');
const { activeSessions, activeAirPlaySessions, streamStats, playbackTracking, devices } = require('../lib/state');
const { castToDevice, stopCasting } = require('../lib/cast');
const { castToAirPlayDevice, stopAirPlayCasting } = require('../lib/airplay');

const router = express.Router();

// IPv4 address or hostname validation
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function validateIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    if (ip === 'localhost') return true;
    if (IP_RE.test(ip)) {
        const parts = ip.split('.').map(Number);
        return parts.every(p => p >= 0 && p <= 255);
    }
    return false;
}

// Normalize the requested quality to one the proxy understands:
// 'highest' (default), 'auto', or a numeric height string like '1080'.
function normalizeQuality(quality) {
    if (quality === 'auto' || quality === 'highest') return quality;
    const height = parseInt(quality, 10);
    if (Number.isFinite(height) && height > 0 && height <= 4320) return String(height);
    return 'highest';
}

const STREAM_TYPES = new Set(['hls', 'dash', 'mp4', 'webm', 'mkv']);

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const u = new URL(url);
        return ['http:', 'https:'].includes(u.protocol);
    } catch {
        return false;
    }
}

// --- API: Cast ---
router.post('/api/cast', (req, res) => {
    const { ip, url, proxy, referer, deviceType } = req.body;
    const quality = normalizeQuality(req.body.quality);
    // The extractor's verdict on the format, for URLs that don't carry an extension.
    const type = STREAM_TYPES.has(req.body.type) ? req.body.type : undefined;

    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid or missing IP address' });
    }
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid or missing URL. Only http and https protocols are allowed.' });
    }

    // Route to AirPlay or Chromecast based on device type
    if (deviceType === 'airplay' || (devices.get(ip)?.type === 'airplay')) {
        if (type === 'dash' || (!type && /\.mpd(?:$|[?;])/i.test(url))) {
            return res.status(400).json({ error: 'Apple TV cannot play DASH streams. Cast this one to a Chromecast, or pick an HLS or MP4 stream.' });
        }
        return castToAirPlayDevice(ip, url, !!proxy, referer || '', quality, res, type);
    }

    castToDevice(ip, url, !!proxy, referer || '', quality, res, type);
});

// --- API: Get Session State ---
router.get('/api/session/:ip', (req, res) => {
    const { ip } = req.params;

    // Check Chromecast sessions
    const session = activeSessions.get(ip);
    if (session) {
        const stats = streamStats.get(ip);
        const tracking = playbackTracking.get(ip);
        return res.json({
            active: true,
            type: 'chromecast',
            stats: stats || null,
            tracking: tracking || null,
            hasPlayer: !!session.player
        });
    }

    // Check AirPlay sessions
    const airPlaySession = activeAirPlaySessions.get(ip);
    if (airPlaySession) {
        const stats = streamStats.get(ip);
        return res.json({
            active: true,
            type: 'airplay',
            stats: stats || null,
            startTime: airPlaySession.startTime
        });
    }

    res.json({ active: false });
});

// --- API: Stop Casting ---
router.post('/api/stop', async (req, res) => {
    const { ip } = req.body;
    console.log(`[Stop] Request received for IP: ${ip}`);

    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid or missing IP address' });
    }

    // Check AirPlay sessions first
    if (activeAirPlaySessions.has(ip)) {
        try {
            await stopAirPlayCasting(ip);
            return res.json({ status: 'stopped' });
        } catch (err) {
            console.error('[Stop] AirPlay stop error:', err);
            return res.status(500).json({ error: 'Failed to stop AirPlay: ' + err.message });
        }
    }

    // Check Chromecast sessions
    const session = activeSessions.get(ip);
    if (!session) {
        return res.status(404).json({ error: 'No active session found for this device' });
    }

    try {
        await stopCasting(ip);
        res.json({ status: 'stopped' });
    } catch (err) {
        console.error('[Stop] Error stopping playback:', err);
        res.status(500).json({ error: 'Failed to stop playback: ' + err.message });
    }
});

module.exports = router;
