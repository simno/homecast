const express = require('express');
const { devices } = require('../lib/state');
const { pairWithDevice } = require('../lib/airplay-pairing');
const { getAllPairings, removePairing, isPaired, getPairing } = require('../lib/airplay-pairing-store');
const { broadcast } = require('../lib/websocket');

const router = express.Router();

// IPv4 validation (same pattern as cast.js)
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

function validatePin(pin) {
    if (!pin || typeof pin !== 'string') return false;
    return /^\d{4,8}$/.test(pin);
}

// === Pair a device using PIN code ===
router.post('/api/airplay/pair/:ip', async (req, res) => {
    const { ip } = req.params;
    const { pin } = req.body;

    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }
    if (!validatePin(pin)) {
        return res.status(400).json({ error: 'PIN must be a 4-8 digit number' });
    }

    try {
        const result = await pairWithDevice(ip, pin);

        broadcast({
            type: 'pairingStatus',
            deviceIp: ip,
            status: 'paired',
            deviceName: result.deviceName
        });

        res.json({ success: true, deviceName: result.deviceName, deviceIp: ip });
    } catch (err) {
        const statusCode = err.code === 'WRONG_PIN' ? 400 :
            err.code === 'PAIR_SETUP_FAILED' ? 502 :
                err.code === 'TIMEOUT' ? 504 : 500;

        console.error(`[AirPlay-Pairing] Pairing failed for ${ip}:`, err.message);
        res.status(statusCode).json({
            success: false,
            error: err.message,
            code: err.code || 'UNKNOWN'
        });
    }
});

// === Check pairing status for a device ===
router.get('/api/airplay/pairing-status/:ip', (req, res) => {
    const { ip } = req.params;
    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }

    const paired = isPaired(ip);
    const pairing = paired ? getPairing(ip) : null;
    res.json({
        paired,
        deviceName: devices[ip]?.name || ip,
        pairedAt: pairing?.pairedAt || null,
        deviceId: pairing?.deviceId || null
    });
});

// === Unpair a device ===
router.post('/api/airplay/unpair/:ip', async (req, res) => {
    const { ip } = req.params;
    if (!validateIp(ip)) {
        return res.status(400).json({ error: 'Invalid IP address' });
    }

    try {
        await removePairing(ip);
        // Also clear pair-verify session
        const pairingMod = require('../lib/airplay-pairing');
        pairingMod.clearPairVerifySession(ip);

        broadcast({
            type: 'pairingStatus',
            deviceIp: ip,
            status: 'unpaired'
        });

        res.json({ success: true });
    } catch (err) {
        console.error(`[AirPlay-Pairing] Unpair failed for ${ip}:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// === List all paired devices ===
router.get('/api/airplay/paired-devices', (req, res) => {
    const paired = getAllPairings().map(p => ({
        ...p,
        online: !!devices[p.ip],
        currentName: devices[p.ip]?.name || p.deviceName
    }));
    res.json({ devices: paired });
});

module.exports = router;
