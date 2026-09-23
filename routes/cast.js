const express = require('express');
const { activeSessions, activeAirPlaySessions, streamStats, playbackTracking, devices } = require('../lib/state');
const { castToDevice, stopCasting, controlPlayback } = require('../lib/cast');
const { castToAirPlayDevice, stopAirPlayCasting, controlAirPlayPlayback } = require('../lib/airplay');
const { subtitleState, selectSubtitle } = require('../lib/subtitles');

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

const shortText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);

// The subtitle choice sent with a cast: null (off), a file to sideload
// ({ url, language?, label? }) or a manifest rendition ({ language?, label? }).
// Returns undefined when the value is present but malformed.
function normalizeSubtitle(subtitle) {
    if (subtitle === undefined || subtitle === null) return null;
    if (typeof subtitle !== 'object' || Array.isArray(subtitle)) return undefined;
    const language = shortText(subtitle.language);
    const label = shortText(subtitle.label);
    if (subtitle.url !== undefined) {
        if (!validateUrl(subtitle.url) || subtitle.url.length > 4096) return undefined;
        return { url: subtitle.url, language, label };
    }
    if (!language && !label) return undefined;
    return { language, label };
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
    const subtitle = normalizeSubtitle(req.body.subtitle);
    if (subtitle === undefined) {
        return res.status(400).json({ error: 'Invalid subtitle choice' });
    }

    // Route to AirPlay or Chromecast based on device type
    if (deviceType === 'airplay' || (devices.get(ip)?.type === 'airplay')) {
        if (type === 'dash' || (!type && /\.mpd(?:$|[?;])/i.test(url))) {
            return res.status(400).json({ error: 'Apple TV cannot play DASH streams. Cast this one to a Chromecast, or pick an HLS or MP4 stream.' });
        }
        // AirPlay 1 can't sideload text tracks; HLS subtitles are picked on the Apple TV itself.
        return castToAirPlayDevice(ip, url, !!proxy, referer || '', quality, res, type);
    }

    castToDevice(ip, url, !!proxy, referer || '', quality, res, type, subtitle);
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
            hasPlayer: !!session.player,
            subtitles: subtitleState(ip),
            volume: session.volume || null
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

// --- API: Playback Control ---
// action: 'pause' | 'play' | 'seek' (value: seconds to skip, -3600..3600)
// | 'volume' (value: 0-1, Chromecast only) | 'mute' (value: boolean, Chromecast only)
function validPlaybackValue(action, value) {
    if (action === 'pause' || action === 'play') return true;
    if (action === 'seek') return Number.isFinite(value) && Math.abs(value) <= 3600;
    if (action === 'volume') return Number.isFinite(value) && value >= 0 && value <= 1;
    if (action === 'mute') return typeof value === 'boolean';
    return false;
}

router.post('/api/playback', async (req, res) => {
    const { ip, action, value } = req.body;
    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid or missing IP address' });
    }
    if (!validPlaybackValue(action, value)) {
        return res.status(400).json({ error: 'Invalid playback action' });
    }

    const airplay = activeAirPlaySessions.has(ip);
    if (!airplay && !activeSessions.has(ip)) {
        return res.status(404).json({ error: 'No active session found for this device' });
    }
    if (airplay && (action === 'volume' || action === 'mute')) {
        return res.status(400).json({ error: 'Set the volume with the Apple TV remote' });
    }

    try {
        const result = airplay
            ? await controlAirPlayPlayback(ip, action, value)
            : await controlPlayback(ip, action, value);
        res.json(result);
    } catch (err) {
        console.error(`[Playback] ${action} failed on ${ip}:`, err.message);
        res.status(502).json({ error: `Could not ${action === 'play' ? 'resume' : action}: ${err.message}` });
    }
});

// --- API: Switch Subtitles (Chromecast) ---
// trackId: one of the session's text tracks, or null for off.
router.post('/api/subtitles', async (req, res) => {
    const { ip, trackId } = req.body;
    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid or missing IP address' });
    }
    if (activeAirPlaySessions.has(ip)) {
        return res.status(400).json({ error: 'Choose subtitles on the Apple TV itself' });
    }
    if (!activeSessions.has(ip)) {
        return res.status(404).json({ error: 'No active session found for this device' });
    }
    const { tracks } = subtitleState(ip);
    if (trackId !== null && !tracks.some(t => t.trackId === trackId)) {
        return res.status(400).json({ error: 'Unknown subtitle track' });
    }

    try {
        await selectSubtitle(ip, trackId);
        res.json(subtitleState(ip));
    } catch (err) {
        console.error('[Subtitles] Switch failed:', err.message);
        res.status(502).json({ error: 'Could not switch subtitles: ' + err.message });
    }
});

module.exports = router;
