// AirPlay Pairing unit tests
const crypto = require('crypto');
const { encodeBPlist, decodeBPlist } = require('../lib/bplist');
const { computeSRP, verifyServerProof } = require('../lib/airplay-pairing');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-test-'));

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`✗ ${name}: ${e.message}`);
    }
}

console.log('Running AirPlay Pairing tests...\n');

// ===== Binary Plist Tests =====

test('Encode and decode simple dictionary', () => {
    const obj = { method: 'pin', user: 'test-uuid' };
    const encoded = encodeBPlist(obj);
    if (!Buffer.isBuffer(encoded)) throw new Error('Expected Buffer');
    if (!encoded.subarray(0, 8).equals(Buffer.from('bplist00'))) throw new Error('Missing bplist header');
    const decoded = decodeBPlist(encoded);
    if (decoded.method !== 'pin') throw new Error(`Expected method=pin, got ${decoded.method}`);
    if (decoded.user !== 'test-uuid') throw new Error(`Expected user=test-uuid, got ${decoded.user}`);
});

test('Encode and decode dictionary with data values', () => {
    const key = Buffer.alloc(32, 0xAB);
    const proof = Buffer.alloc(40, 0xCD);
    const obj = { pk: key, proof: proof };
    const encoded = encodeBPlist(obj);
    const decoded = decodeBPlist(encoded);
    if (!decoded.pk.equals(key)) throw new Error('pk mismatch');
    if (!decoded.proof.equals(proof)) throw new Error('proof mismatch');
});

test('Encode and decode empty dictionary', () => {
    const encoded = encodeBPlist({});
    const decoded = decodeBPlist(encoded);
    if (Object.keys(decoded).length !== 0) throw new Error('Expected empty object');
});

test('Encode and decode with integer values', () => {
    const obj = { version: 1, method: 'pin' };
    const encoded = encodeBPlist(obj);
    const decoded = decodeBPlist(encoded);
    if (decoded.version !== 1) throw new Error(`Expected version=1, got ${decoded.version}`);
});

test('Decode rejects non-bplist data', () => {
    try {
        decodeBPlist(Buffer.from('not a plist'));
        throw new Error('Should have thrown');
    } catch (e) {
        if (!e.message.includes('too short') && !e.message.includes('binary plist')) throw e;
    }
});

test('Decode rejects empty buffer', () => {
    try {
        decodeBPlist(Buffer.from([]));
        throw new Error('Should have thrown');
    } catch (e) {
        if (!e.message.includes('too short')) throw e;
    }
});

test('Round-trip with ASCII strings', () => {
    const obj = { greeting: 'hello world', empty: '' };
    const encoded = encodeBPlist(obj);
    const decoded = decodeBPlist(encoded);
    if (decoded.greeting !== 'hello world') throw new Error(`Got ${decoded.greeting}`);
    if (decoded.empty !== '') throw new Error(`Got ${decoded.empty}`);
});

function padTo256(buf) {
    if (buf.length >= 256) return buf;
    const padded = Buffer.alloc(256);
    buf.copy(padded, 256 - buf.length);
    return padded;
}

// ===== SRP Tests =====

test('SRP computeSRP generates expected outputs', () => {
    const username = 'test-device-id';
    const password = '1234';
    const salt = Buffer.alloc(16, 0x01);
    const serverPubKey = Buffer.alloc(256, 0x03); // dummy server key (invalid for real SRP)

    // computeSRP should run without error and return expected shape
    const result = computeSRP(username, password, salt, serverPubKey);

    if (!Buffer.isBuffer(result.A)) throw new Error('A is not a Buffer');
    if (!Buffer.isBuffer(result.M1)) throw new Error('M1 is not a Buffer');
    if (!Buffer.isBuffer(result.K)) throw new Error('K is not a Buffer');
    if (result.A.length !== 256) throw new Error(`A length should be 256, got ${result.A.length}`);
    if (result.M1.length !== 20) throw new Error(`M1 length should be 20 (SHA-1), got ${result.M1.length}`);
    if (result.K.length !== 40) throw new Error(`K length should be 40 (interleaved SHA-1), got ${result.K.length}`);
});

test('verifyServerProof with correct values', () => {
    const username = 'test';
    const password = '1234';
    const salt = crypto.createHash('sha1').update('test-salt').digest().subarray(0, 16);
    const serverPubKey = Buffer.alloc(256, 0x55);

    const result = computeSRP(username, password, salt, serverPubKey);

    const M1_buf = result.M1;
    const A_buf = padTo256(result.A);
    const K_buf = result.K;
    const expectedM2 = crypto.createHash('sha1').update(Buffer.concat([A_buf, M1_buf, K_buf])).digest();

    const valid = verifyServerProof(result.A, result.M1, result.K, expectedM2);
    if (!valid) throw new Error('Expected verifyServerProof to return true');
});

test('verifyServerProof rejects incorrect M2', () => {
    const username = 'test';
    const password = '1234';
    const salt = crypto.createHash('sha1').update('some-salt').digest().subarray(0, 16);
    const serverPubKey = Buffer.alloc(256, 0x44);

    const result = computeSRP(username, password, salt, serverPubKey);

    // Bad proof
    const badM2 = Buffer.alloc(20, 0xFF);
    const valid = verifyServerProof(result.A, result.M1, result.K, badM2);
    if (valid !== false) throw new Error('Expected verifyServerProof to return false for bad M2');
});

test('SRP with different PINs produces different M1', () => {
    const username = 'test-id';
    const salt = Buffer.alloc(16, 0x02);
    const serverPubKey = Buffer.alloc(256, 0x06);

    const r1 = computeSRP(username, '1234', salt, serverPubKey);
    const r2 = computeSRP(username, '5678', salt, serverPubKey);

    if (r1.M1.equals(r2.M1)) throw new Error('Different PINs should produce different M1');
});

// ===== Pairing Store Tests =====

function requireFresh(modulePath) {
    delete require.cache[require.resolve(modulePath)];
    return require(modulePath);
}

test('initPairingStore creates file if not present', async () => {
    const storeFile = path.join(tmpDir, 'pairings.json');
    process.env.AIRPLAY_PAIRING_STORE = storeFile;

    const store = requireFresh('../lib/airplay-pairing-store');
    await store.initPairingStore();

    // Check that file was created
    if (!fs.existsSync(storeFile)) throw new Error('Store file not created');
    const raw = fs.readFileSync(storeFile, 'utf8');
    const data = JSON.parse(raw);
    if (data.version !== 1) throw new Error('Expected version 1');
    if (!data.pairs) throw new Error('Expected pairs object');
});

test('setPairing and getPairing round-trip', async () => {
    const storeFile = path.join(tmpDir, 'pairings2.json');
    process.env.AIRPLAY_PAIRING_STORE = storeFile;

    const store = requireFresh('../lib/airplay-pairing-store');
    await store.initPairingStore();

    const testData = {
        deviceName: 'Test Apple TV',
        deviceId: 'aa:bb:cc:dd:ee:ff',
        clientEd25519PubKey: 'test-pubkey-base64',
        clientEd25519PrivKey: 'test-privkey-base64',
        serverEd25519PubKey: 'test-server-pubkey-base64',
        salt: 'test-salt-base64',
        sharedSecret: 'test-secret-base64',
        method: 'pin'
    };

    await store.setPairing('192.168.1.100', testData);

    const retrieved = store.getPairing('192.168.1.100');
    if (!retrieved) throw new Error('Retrieved pairing is null');
    if (retrieved.deviceName !== 'Test Apple TV') throw new Error(`Got ${retrieved.deviceName}`);
    if (retrieved.clientEd25519PubKey !== 'test-pubkey-base64') throw new Error('Pubkey mismatch');
});

test('isPaired returns correct status', async () => {
    const storeFile = path.join(tmpDir, 'pairings3.json');
    process.env.AIRPLAY_PAIRING_STORE = storeFile;

    const store = requireFresh('../lib/airplay-pairing-store');
    await store.initPairingStore();

    if (store.isPaired('192.168.1.200')) throw new Error('Should not be paired initially');

    await store.setPairing('192.168.1.200', { deviceName: 'Test', method: 'pin' });

    if (!store.isPaired('192.168.1.200')) throw new Error('Should be paired after setPairing');
});

test('removePairing deletes entry', async () => {
    const storeFile = path.join(tmpDir, 'pairings4.json');
    process.env.AIRPLAY_PAIRING_STORE = storeFile;

    const store = requireFresh('../lib/airplay-pairing-store');
    await store.initPairingStore();

    await store.setPairing('192.168.1.150', { deviceName: 'Test' });
    await store.setPairing('192.168.1.151', { deviceName: 'Test2' });

    // Both should be present
    const allBefore = store.getAllPairings();
    if (allBefore.length !== 2) throw new Error(`Expected 2, got ${allBefore.length}`);

    await store.removePairing('192.168.1.150');

    const allAfter = store.getAllPairings();
    if (allAfter.length !== 1) throw new Error(`Expected 1, got ${allAfter.length}`);
    if (store.isPaired('192.168.1.150')) throw new Error('Should not be paired after remove');
    if (!store.isPaired('192.168.1.151')) throw new Error('Other entry should remain paired');
});

test('getAllPairings returns correct structure', async () => {
    const storeFile = path.join(tmpDir, 'pairings5.json');
    process.env.AIRPLAY_PAIRING_STORE = storeFile;

    const store = requireFresh('../lib/airplay-pairing-store');
    await store.initPairingStore();

    await store.setPairing('192.168.1.10', {
        deviceName: 'Living Room', deviceId: 'dev1', method: 'pin'
    });

    const all = store.getAllPairings();
    if (all.length !== 1) throw new Error('Expected 1 device');
    if (all[0].ip !== '192.168.1.10') throw new Error(`Wrong IP: ${all[0].ip}`);
    if (all[0].deviceName !== 'Living Room') throw new Error(`Wrong name: ${all[0].deviceName}`);
    if (!all[0].pairedAt) throw new Error('Missing pairedAt');
});

// ===== Module Export Tests =====

test('airplay-pairing module exports expected functions', () => {
    const mod = require('../lib/airplay-pairing');
    if (typeof mod.pairWithDevice !== 'function') throw new Error('pairWithDevice not exported');
    if (typeof mod.performPairSetup !== 'function') throw new Error('performPairSetup not exported');
    if (typeof mod.performPairVerify !== 'function') throw new Error('performPairVerify not exported');
    if (typeof mod.ensurePairVerify !== 'function') throw new Error('ensurePairVerify not exported');
    if (typeof mod.clearPairVerifySession !== 'function') throw new Error('clearPairVerifySession not exported');
});

test('bplist module exports expected functions', () => {
    const mod = require('../lib/bplist');
    if (typeof mod.encodeBPlist !== 'function') throw new Error('encodeBPlist not exported');
    if (typeof mod.decodeBPlist !== 'function') throw new Error('decodeBPlist not exported');
});

// ===== Cleanup =====

// Remove temp dir
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

// ===== Results =====
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
