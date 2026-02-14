const express = require('express');
const { activeSessions, streamStats, playbackTracking } = require('../lib/state');
const { castToDevice, stopCasting } = require('../lib/cast');

const router = express.Router();

// --- API: Cast ---
router.post('/api/cast', (req, res) => {
    const { ip, url, proxy, referer } = req.body;
    castToDevice(ip, url, proxy, referer, res);
});

// --- API: Get Session State ---
router.get('/api/session/:ip', (req, res) => {
    const { ip } = req.params;

    const session = activeSessions.get(ip);
    if (!session) {
        return res.json({ active: false });
    }

    const stats = streamStats.get(ip);
    const tracking = playbackTracking.get(ip);

    res.json({
        active: true,
        stats: stats || null,
        tracking: tracking || null,
        hasPlayer: !!session.player
    });
});

// --- API: Stop Casting ---
router.post('/api/stop', async (req, res) => {
    const { ip } = req.body;
    console.log(`[Stop] Request received for IP: ${ip}`);

    if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
    }

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
