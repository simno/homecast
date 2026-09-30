const express = require('express');
const { activeSessions, activeAirPlaySessions, activeWebOsSessions, streamStats, playbackTracking, devices } = require('../lib/state');
const { stopCasting, controlPlayback, sessionPlayback, sessionNotice } = require('../lib/cast');
const { stopAirPlayCasting, controlAirPlayPlayback } = require('../lib/airplay');
const { stopWebOsCasting, controlWebOsPlayback, webOsVolume } = require('../lib/webos');
const { subtitleState, selectSubtitle } = require('../lib/subtitles');
const { getBufferHealthStats } = require('../lib/stats');
const { validateIp, parseCastRequest, startCast, castPage } = require('../lib/dispatch');
const { clearQueue } = require('../lib/queue');

const router = express.Router();

// --- API: Cast ---
router.post('/api/cast', (req, res) => {
    const { cast, error } = parseCastRequest(req.body);
    if (error) return res.status(400).json({ error });
    // Casting something new replaces what was queued behind the old stream.
    clearQueue(cast.ip);
    startCast(cast, res);
});

// --- API: Running Sessions ---
// Every stream playing now, so a page opened anywhere (another browser, a
// phone) can show them — not just the one that started them.
router.get('/api/sessions', (req, res) => {
    const sessions = [
        ...[...activeSessions.keys()].map(ip => ({ ip, type: 'chromecast' })),
        ...[...activeAirPlaySessions.keys()].map(ip => ({ ip, type: 'airplay' })),
        ...[...activeWebOsSessions.keys()].map(ip => ({ ip, type: 'webos' }))
    ].map(s => ({ ...s, deviceName: devices.get(s.ip)?.name || s.ip }));
    res.json({ sessions });
});

// --- API: Get Session State ---
router.get('/api/session/:ip', async (req, res) => {
    const { ip } = req.params;

    // Check Chromecast sessions
    const session = activeSessions.get(ip);
    if (session) {
        const stats = streamStats.get(ip);
        const tracking = playbackTracking.get(ip);
        // Where playback is, for a dashboard opened mid-stream: receivers
        // only report it when something changes.
        const playback = await sessionPlayback(ip);
        return res.json({
            active: true,
            type: 'chromecast',
            stats: stats || null,
            tracking: tracking || null,
            hasPlayer: !!session.player,
            subtitles: subtitleState(ip),
            volume: session.volume || null,
            playback,
            bufferHealth: getBufferHealthStats(ip),
            notice: sessionNotice(ip),
            page: castPage(ip)
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
            startTime: airPlaySession.startTime,
            page: castPage(ip),
            playback: { status: { playerState: airPlaySession.playerState }, statusAgeMs: 0, ended: false }
        });
    }

    const webOsSession = activeWebOsSessions.get(ip);
    if (webOsSession) {
        return res.json({
            active: true,
            type: 'webos',
            stats: streamStats.get(ip) || null,
            startTime: webOsSession.startTime,
            page: castPage(ip),
            volume: webOsSession.volume || await webOsVolume(ip),
            playback: webOsSession.lastStatus
                ? { status: webOsSession.lastStatus.status, statusAgeMs: Date.now() - webOsSession.lastStatus.at, ended: false }
                : null
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
    // Stop means stop: nothing queued starts afterwards.
    clearQueue(ip);

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

    if (activeWebOsSessions.has(ip)) {
        await stopWebOsCasting(ip);
        return res.json({ status: 'stopped' });
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
// | 'seekTo' (value: position in seconds) | 'live' (jump to the live edge)
// | 'volume' (value: 0-1; not Apple TV) | 'mute' (value: boolean; not Apple TV)
function validPlaybackValue(action, value) {
    if (action === 'pause' || action === 'play' || action === 'live') return true;
    if (action === 'seek') return Number.isFinite(value) && Math.abs(value) <= 3600;
    if (action === 'seekTo') return Number.isFinite(value) && value >= 0;
    if (action === 'volume') return Number.isFinite(value) && value >= 0 && value <= 1;
    if (action === 'mute') return typeof value === 'boolean';
    return false;
}

const PLAYBACK_VERBS = { play: 'resume', live: 'jump to live' };

router.post('/api/playback', async (req, res) => {
    const { ip, action, value } = req.body;
    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid or missing IP address' });
    }
    if (!validPlaybackValue(action, value)) {
        return res.status(400).json({ error: 'Invalid playback action' });
    }

    const airplay = activeAirPlaySessions.has(ip);
    const webos = activeWebOsSessions.has(ip);
    if (!airplay && !webos && !activeSessions.has(ip)) {
        return res.status(404).json({ error: 'No active session found for this device' });
    }
    if (airplay && (action === 'volume' || action === 'mute')) {
        return res.status(400).json({ error: 'Set the volume with the Apple TV remote' });
    }

    try {
        const result = airplay ? await controlAirPlayPlayback(ip, action, value)
            : webos ? await controlWebOsPlayback(ip, action, value)
                : await controlPlayback(ip, action, value);
        res.json(result);
    } catch (err) {
        console.error(`[Playback] ${action} failed on ${ip}:`, err.message);
        res.status(502).json({ error: `Could not ${PLAYBACK_VERBS[action] || action}: ${err.message}` });
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
    if (activeWebOsSessions.has(ip)) {
        return res.status(400).json({ error: 'Subtitles on an LG TV are chosen when casting' });
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
