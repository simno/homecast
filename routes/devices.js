const express = require('express');
const os = require('os');
const { devices } = require('../lib/state');
const { getLocalIp, PORT } = require('../lib/utils');

const router = express.Router();

// --- API: List Devices ---
router.get('/api/devices', (req, res) => {
    const deviceList = Object.values(devices);
    console.log(`[API] Device list requested - returning ${deviceList.length} device(s)`);
    res.json(deviceList);
});

// --- API: Discovery Status (for debugging) ---
router.get('/api/discovery/status', (req, res) => {
    const interfaces = os.networkInterfaces();

    res.json({
        devicesFound: Object.keys(devices).length,
        devices: devices,
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
