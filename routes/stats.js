const express = require('express');
const { streamStats } = require('../lib/state');

const router = express.Router();

// --- API: Stream Stats ---
router.get('/api/stats', (req, res) => {
    const allStats = Array.from(streamStats.entries()).map(([clientIp, stats]) => {
        const duration = (Date.now() - stats.startTime) / 1000;
        const transferRate = duration > 0 ? Math.round((stats.totalBytes / duration) / 1024) : 0;
        return {
            clientIp,
            totalMB: (stats.totalBytes / (1024 * 1024)).toFixed(2),
            transferRate,
            duration: Math.round(duration),
            resolution: stats.resolution,
            bitrate: stats.bitrate,
            segmentCount: stats.segmentCount,
            cacheHits: stats.cacheHits,
            lastActivity: new Date(stats.lastActivity).toISOString()
        };
    });
    res.json(allStats);
});

module.exports = router;
