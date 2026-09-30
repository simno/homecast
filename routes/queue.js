const express = require('express');
const { activeSessions, activeAirPlaySessions, activeWebOsSessions } = require('../lib/state');
const { validateIp, parseCastRequest, startCast } = require('../lib/dispatch');
const { items, enqueue, removeItem, playNext } = require('../lib/queue');

const router = express.Router();

const isPlaying = (ip) => activeSessions.has(ip) || activeAirPlaySessions.has(ip) || activeWebOsSessions.has(ip);

// --- API: What's queued on a device ---
router.get('/api/queue/:ip', (req, res) => {
    if (!validateIp(req.params.ip)) return res.status(400).json({ error: 'Invalid IP address' });
    res.json({ items: items(req.params.ip) });
});

// --- API: Play next ---
// The body is a cast request, as for /api/cast, plus the `title` and `page`
// it came from. Queued behind whatever the device is playing; with nothing
// playing it starts at once, answered as /api/cast answers.
router.post('/api/queue', (req, res) => {
    const { cast, error } = parseCastRequest(req.body);
    if (error) return res.status(400).json({ error });
    if (!isPlaying(cast.ip)) return startCast(cast, res);
    try {
        enqueue(cast, { title: req.body.title, url: cast.page });
    } catch (err) {
        return res.status(409).json({ error: err.message });
    }
    res.json({ queued: true, items: items(cast.ip) });
});

// --- API: Take an item out of the queue ---
router.post('/api/queue/:ip/remove', (req, res) => {
    const { ip } = req.params;
    if (!validateIp(ip)) return res.status(400).json({ error: 'Invalid IP address' });
    if (!removeItem(ip, req.body.id)) return res.status(404).json({ error: 'Not in the queue' });
    res.json({ items: items(ip) });
});

// --- API: Skip to the next item now ---
router.post('/api/queue/:ip/next', async (req, res) => {
    const { ip } = req.params;
    if (!validateIp(ip)) return res.status(400).json({ error: 'Invalid IP address' });
    const result = await playNext(ip);
    if (!result) return res.status(404).json({ error: 'Nothing is queued' });
    if (result.status >= 400) return res.status(502).json({ error: result.body?.error || 'Could not play the next video', item: result.item });
    res.json({ item: result.item, items: items(ip) });
});

module.exports = router;
