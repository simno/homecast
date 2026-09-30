const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.AIRPLAY_PAIRING_STORE ||
    path.join(__dirname, '..', 'data', 'airplay-pairings.json');

let store = { version: 1, pairs: {} };
let initialized = false;

async function initPairingStore() {
    const dir = path.dirname(STORE_PATH);

    try {
        await fs.promises.mkdir(dir, { recursive: true });
    } catch { /* directory exists */ }

    try {
        await fs.promises.access(STORE_PATH);
        const raw = await fs.promises.readFile(STORE_PATH, 'utf8');
        store = JSON.parse(raw);
        console.log('[AirPlay-Pairing] Loaded', Object.keys(store.pairs || {}).length, 'pairing(s) from', STORE_PATH);
    } catch {
        // No file yet — start fresh
        store = { version: 1, pairs: {} };
        console.log('[AirPlay-Pairing] No existing pairing data, starting fresh');
    }

    initialized = true;
}

async function save() {
    const tmp = STORE_PATH + '.tmp';
    const data = JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2);
    await fs.promises.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tmp, STORE_PATH);
}

function getPairing(ip) {
    return store.pairs[ip] || null;
}

function isPaired(ip) {
    return !!store.pairs[ip];
}

// Loading the file replaces the store, so it happens before a change, never
// between the change and its save.
async function ensureLoaded() {
    if (!initialized) await initPairingStore();
}

async function setPairing(ip, data) {
    await ensureLoaded();
    store.pairs[ip] = {
        ...data,
        pairedAt: Date.now()
    };
    await save();
}

async function removePairing(ip) {
    await ensureLoaded();
    delete store.pairs[ip];
    await save();
}

function getAllPairings() {
    return Object.entries(store.pairs).map(([ip, p]) => ({
        ip,
        deviceName: p.deviceName,
        deviceId: p.deviceId,
        pairedAt: p.pairedAt
    }));
}

module.exports = {
    initPairingStore,
    getPairing,
    isPaired,
    setPairing,
    removePairing,
    getAllPairings
};
