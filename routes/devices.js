const express = require('express');
const os = require('os');
const { devices } = require('../lib/state');
const { rescanDevices } = require('../lib/discovery');
const { getLocalIp, PORT } = require('../lib/utils');

const router = express.Router();

// --- API: List Devices ---
router.get('/api/devices', (req, res) => {
    const deviceList = [...devices.values()];
    console.log(`[API] Device list requested - returning ${deviceList.length} device(s)`);
    res.json(deviceList);
});

// --- API: Rescan ---
// Sends the discovery searches again now instead of at the next 30s round.
// Devices that answer arrive over the WebSocket as usual.
router.post('/api/devices/rescan', (req, res) => {
    rescanDevices();
    res.json({ status: 'scanning' });
});

// --- API: Discovery Status (for debugging) ---
router.get('/api/discovery/status', (req, res) => {
    const interfaces = os.networkInterfaces();

    res.json({
        devicesFound: devices.size,
        devices: [...devices.values()],
        networkInterfaces: Object.keys(interfaces).reduce((acc, name) => {
            acc[name] = interfaces[name].filter(i => i.family === 'IPv4');
            return acc;
        }, {}),
        serverIP: getLocalIp(),
        port: PORT,
        mdnsNote: 'mDNS requires network_mode: host in Docker and UDP port 5353 open'
    });
});

module.exports = router;
