const http = require('http');
const crypto = require('crypto');
const { encodeBPlist, decodeBPlist } = require('./bplist');

const AIRPLAY_PORT = 7000;

// SRP constants (2048-bit group from RFC 5054, modp14)
const dh = crypto.getDiffieHellman('modp14');
const N = dh.getPrime();     // 256 bytes
const g = dh.getGenerator(); // 1 byte: 0x02

const serverDeviceId = crypto.randomUUID();

// Active pair-verify sessions (in-memory, 1-hour TTL)
const verifySessions = new Map();

// ===== SRP Implementation =====

function padTo(buf, len) {
    if (buf.length >= len) return buf;
    const padded = Buffer.alloc(len);
    buf.copy(padded, len - buf.length);
    return padded;
}

function interleaveHash(buf) {
    // Interleaved SHA-1: split even/odd bytes, hash separately, interleave
    const even = Buffer.alloc(Math.ceil(buf.length / 2));
    const odd = Buffer.alloc(Math.floor(buf.length / 2));
    for (let i = 0; i < buf.length; i++) {
        if (i % 2 === 0) even[i >> 1] = buf[i];
        else odd[i >> 1] = buf[i];
    }
    const hEven = crypto.createHash('sha1').update(even).digest();
    const hOdd = crypto.createHash('sha1').update(odd).digest();
    const result = Buffer.alloc(40);
    for (let i = 0; i < 20; i++) {
        result[i * 2] = hEven[i];
        result[i * 2 + 1] = hOdd[i];
    }
    return result;
}

function xorHashes(a, b) {
    // XOR of SHA-1 hashes
    const ha = crypto.createHash('sha1').update(a).digest();
    const hb = crypto.createHash('sha1').update(b).digest();
    const result = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) result[i] = ha[i] ^ hb[i];
    return result;
}

function computeSRP(username, password, salt, serverPubKey) {
    // RFC 5054 SRP-6a with SHA-1
    // x = SHA1(salt | SHA1(username | ":" | password))
    const inner = crypto.createHash('sha1').update(username + ':' + password).digest();
    const xHash = crypto.createHash('sha1').update(Buffer.concat([salt, inner])).digest();
    const x = BigInt('0x' + xHash.toString('hex'));

    // k = SHA1(N | PAD(g))
    const kHash = crypto.createHash('sha1').update(Buffer.concat([N, padTo(g, 256)])).digest();
    const k = BigInt('0x' + kHash.toString('hex'));

    // Generate random a (at least 256 bits)
    const aBytes = crypto.randomBytes(32);
    const a = BigInt('0x' + aBytes.toString('hex'));

    // A = g^a mod N
    const A_bn = modPow(gBN(), a, N_bn());
    const A = padTo(bnToBuf(A_bn), 256);

    const B = serverPubKey;
    const B_bn = BigInt('0x' + B.toString('hex'));

    // u = SHA1(PAD(A) | PAD(B))
    const uHash = crypto.createHash('sha1').update(Buffer.concat([padTo(A, 256), padTo(B, 256)])).digest();
    const u = BigInt('0x' + uHash.toString('hex'));
    const N_bn_val = N_bn();

    // S = (B - k*g^x)^(a + u*x) mod N
    const gx = modPow(gBN(), x, N_bn_val);
    const kgx = (k * gx) % N_bn_val;
    const base = (B_bn - kgx) % N_bn_val;
    if (base < 0n) {
        // Handle negative: B is in [0, N-1], so base should be non-negative
        // If it's negative (can happen due to subtraction), add N
    }
    const exp = (a + u * x) % (N_bn_val - 1n);
    const S_bn = modPow(base < 0n ? base + N_bn_val : base, exp, N_bn_val);

    const S = padTo(bnToBuf(S_bn), 256);
    const K = interleaveHash(S); // 40 bytes

    // M1 = H(H(N) ^ H(g) | H(user) | salt | A | B | K)
    const hn_xor_hg = xorHashes(N, padTo(g, 256));
    const hUser = crypto.createHash('sha1').update(username).digest();
    const M1 = crypto.createHash('sha1').update(Buffer.concat([
        hn_xor_hg, hUser, salt, padTo(A, 256), padTo(B, 256), K
    ])).digest();

    return { A, M1, K, a, x, u };
}

function verifyServerProof(A, M1, K, serverM2) {
    // M2 = H(A | M1 | K)
    const expectedM2 = crypto.createHash('sha1').update(Buffer.concat([
        padTo(A, 256), M1, K
    ])).digest();
    return expectedM2.equals(serverM2.slice(0, 20));
}

// ===== BigInt Helpers =====

function N_bn() { return BigInt('0x' + N.toString('hex')); }
function gBN() { return BigInt('0x' + g.toString('hex')); }

function modPow(base, exp, mod) {
    if (mod <= 0n) return 0n;
    let result = 1n;
    base = base % mod;
    if (base < 0n) base += mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

function bnToBuf(bn) {
    let hex = bn.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
}

// ===== HTTP Helpers =====

function airPlayPlistRequest(ip, path, body) {
    return new Promise((resolve, reject) => {
        const payload = encodeBPlist(body);

        const req = http.request({
            hostname: ip,
            port: AIRPLAY_PORT,
            path,
            method: 'POST',
            headers: {
                'User-Agent': 'HomeCast/1.0',
                'Content-Type': 'application/x-apple-binary-plist',
                'X-Apple-Device-ID': serverDeviceId,
                'Content-Length': String(payload.length)
            },
            timeout: 15000
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const bodyBuf = Buffer.concat(chunks);
                let result;
                try {
                    result = decodeBPlist(bodyBuf);
                } catch {
                    result = { _raw: bodyBuf.toString('utf8').substring(0, 500) };
                }
                resolve({ statusCode: res.statusCode, headers: res.headers, body: result });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('AirPlay pairing request timeout'));
        });
        req.write(payload);
        req.end();
    });
}

// ===== Pair-Setup Protocol =====

async function performPairSetup(ip, pin) {
    // Step 1: Send pairing request
    console.log('[AirPlay-Pairing] Step 1: Requesting pair-setup challenge from', ip);
    const step1 = await airPlayPlistRequest(ip, '/pair-setup', {
        method: 'pin',
        user: serverDeviceId
    });

    if (step1.statusCode !== 200) {
        const raw = step1.body._raw || JSON.stringify(step1.body);
        throw Object.assign(new Error('Pair-setup step 1 failed: HTTP ' + step1.statusCode + ' - ' + raw), {
            code: 'PAIR_SETUP_FAILED',
            statusCode: step1.statusCode
        });
    }

    const serverPk = step1.body.pk;
    const salt = step1.body.salt;

    if (!serverPk || !salt) {
        throw Object.assign(new Error('Pair-setup: missing pk or salt in server response'), {
            code: 'INVALID_RESPONSE'
        });
    }

    console.log('[AirPlay-Pairing] Step 2: Computing SRP proof');
    const srpResult = computeSRP(serverDeviceId, pin, salt, serverPk);

    console.log('[AirPlay-Pairing] Step 3: Sending SRP proof');
    const step2 = await airPlayPlistRequest(ip, '/pair-setup', {
        pk: srpResult.A,
        proof: srpResult.M1
    });

    if (step2.statusCode !== 200) {
        // 403 or 401 = wrong PIN
        if (step2.statusCode === 403 || step2.statusCode === 401) {
            throw Object.assign(new Error('Wrong PIN code. Check the number on your Apple TV.'),
                { code: 'WRONG_PIN' });
        }
        const raw = step2.body._raw || JSON.stringify(step2.body);
        throw Object.assign(new Error('Pair-setup step 2 failed: HTTP ' + step2.statusCode + ' - ' + raw), {
            code: 'PAIR_SETUP_FAILED',
            statusCode: step2.statusCode
        });
    }

    const serverM2 = step2.body.proof;
    if (!serverM2) {
        throw Object.assign(new Error('Pair-setup: missing proof in server response'),
            { code: 'INVALID_RESPONSE' });
    }

    // Verify server proof
    const valid = verifyServerProof(srpResult.A, srpResult.M1, srpResult.K, serverM2);
    if (!valid) {
        throw Object.assign(new Error('Server proof verification failed - possible PIN mismatch'),
            { code: 'PROOF_VERIFICATION_FAILED' });
    }

    console.log('[AirPlay-Pairing] Server proof verified, extracting encrypted payload');

    // Decrypt server's long-term Ed25519 public key from M2 payload
    // The encrypted data is at offset 20 in serverM2 (after the 20-byte SHA-1 proof)
    const encryptedData = serverM2.length > 20 ? serverM2.subarray(20) : null;
    let serverEd25519PubKey = null;

    if (encryptedData && encryptedData.length > 0) {
        try {
            // Derive AES key from SRP session key
            const aesKey = crypto.hkdfSync('sha512', srpResult.K, salt,
                'Pair-Setup-AES-Key', 32);
            const aesIV = crypto.hkdfSync('sha512', srpResult.K, salt,
                'Pair-Setup-AES-IV', 16);

            const decipher = crypto.createDecipheriv('aes-256-ctr', aesKey, aesIV);
            const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
            // The decrypted payload contains the server's Ed25519 public key (first 32 bytes)
            serverEd25519PubKey = decrypted.subarray(0, 32);
            console.log('[AirPlay-Pairing] Extracted server Ed25519 public key');
        } catch (err) {
            console.error('[AirPlay-Pairing] Failed to decrypt server key:', err.message);
        }
    }

    // Generate client's long-term Ed25519 keypair
    const clientKeys = crypto.generateKeyPairSync('ed25519');
    const clientEd25519PubKey = clientKeys.publicKey.export({ format: 'der', type: 'spki' });
    const clientEd25519PrivKey = clientKeys.privateKey.export({ format: 'der', type: 'pkcs8' });

    // Extract raw 32-byte public key from SPKI DER
    const rawClientPubKey = extractEd25519RawKey(clientEd25519PubKey);

    console.log('[AirPlay-Pairing] Pair-setup complete for', ip);

    return {
        serverEd25519PubKey, // raw 32 bytes (or null if not extracted)
        clientEd25519PubKey: rawClientPubKey,
        clientEd25519PrivKey,
        sharedSecret: srpResult.K, // SRP session key (for AES context)
        salt,
        method: 'pin'
    };
}

function extractEd25519RawKey(derBuf) {
    // Ed25519 SPKI DER: 30 2A 30 05 06 03 2B 65 70 03 21 00 <32 bytes>
    if (derBuf.length === 44) {
        return derBuf.subarray(12, 44);
    }
    // If it's already 32 bytes, return as-is
    if (derBuf.length === 32) return derBuf;
    // Fallback: try to find the 32-byte key
    for (let i = 0; i < derBuf.length - 32; i++) {
        if (derBuf[i] === 0x00 && derBuf[i + 1] === 0x20 && derBuf[i + 2] === 32) {
            return derBuf.subarray(i + 3, i + 35);
        }
    }
    // Best guess: last 32 bytes
    return derBuf.subarray(derBuf.length - 32);
}

// ===== Pair-Verify Protocol =====

async function performPairVerify(ip, pairingData) {
    console.log('[AirPlay-Pairing] Starting pair-verify with', ip);

    // Generate ephemeral X25519 keypair
    const ephemeralKeys = crypto.generateKeyPairSync('x25519');
    const ephemeralPubKey = ephemeralKeys.publicKey.export({ format: 'der', type: 'spki' });
    const ephemeralPrivKey = ephemeralKeys.privateKey.export({ format: 'der', type: 'pkcs8' });

    const rawEphemeralPubKey = extractRawPublicKey(ephemeralPubKey); // 32 bytes

    // Load client Ed25519 keys
    const clientEd25519PubKey = pairingData.clientEd25519PubKey; // raw 32 bytes
    const clientEd25519PrivKey = crypto.createPrivateKey({
        key: pairingData.clientEd25519PrivKey,
        format: 'der',
        type: 'pkcs8'
    });

    // Sign: clientEd25519PubKey || 0x00 || ephemeralPubKey
    const toSign = Buffer.concat([clientEd25519PubKey, Buffer.from([0x00]), rawEphemeralPubKey]);
    const signature = crypto.sign(null, toSign, clientEd25519PrivKey);

    // Step 1: Send pair-verify request
    const step1 = await airPlayPlistRequest(ip, '/pair-verify', {
        pk: rawEphemeralPubKey,
        sig: signature
    });

    if (step1.statusCode !== 200) {
        const raw = step1.body._raw || JSON.stringify(step1.body);
        throw Object.assign(new Error('Pair-verify step 1 failed: HTTP ' + step1.statusCode + ' - ' + raw), {
            code: 'PAIR_VERIFY_FAILED',
            statusCode: step1.statusCode
        });
    }

    const serverEphemeralPubKey = step1.body.pk; // 32 bytes
    const serverSignature = step1.body.sig;       // 64 bytes

    if (!serverEphemeralPubKey || !serverSignature) {
        throw Object.assign(new Error('Pair-verify: missing pk or sig in response'),
            { code: 'INVALID_RESPONSE' });
    }

    // Verify server signature: serverEd25519PubKey || 0x01 || serverEphemeralPubKey
    const toVerify = Buffer.concat([pairingData.serverEd25519PubKey, Buffer.from([0x01]), serverEphemeralPubKey]);
    const serverEd25519PubKeyObj = crypto.createPublicKey({
        key: Buffer.concat([
            Buffer.from([0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70, 0x03, 0x21, 0x00]),
            pairingData.serverEd25519PubKey
        ]),
        format: 'der',
        type: 'spki'
    });

    const sigValid = crypto.verify(null, toVerify, serverEd25519PubKeyObj, serverSignature);
    if (!sigValid) {
        throw Object.assign(new Error('Pair-verify: server signature verification failed'),
            { code: 'SIGNATURE_VERIFICATION_FAILED' });
    }

    console.log('[AirPlay-Pairing] Server signature verified');

    // Compute shared secret via X25519 DH
    const serverEphemeralPubKeyObj = crypto.createPublicKey({
        key: Buffer.concat([
            Buffer.from([0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x6E, 0x03, 0x21, 0x00]),
            serverEphemeralPubKey
        ]),
        format: 'der',
        type: 'spki'
    });

    const clientEphemeralPrivKeyObj = crypto.createPrivateKey({
        key: ephemeralPrivKey,
        format: 'der',
        type: 'pkcs8'
    });

    const sharedSecret = crypto.diffieHellman({
        publicKey: serverEphemeralPubKeyObj,
        privateKey: clientEphemeralPrivKeyObj
    });

    // Derive session key using HKDF
    const sessionKey = crypto.hkdfSync('sha512', sharedSecret,
        Buffer.from('Pair-Verify-Encrypt-Salt'),
        Buffer.from('Pair-Verify-Encrypt-Info'), 32);

    console.log('[AirPlay-Pairing] Pair-verify complete for', ip);

    // Cache the session
    verifySessions.set(ip, {
        sessionKey,
        verifiedAt: Date.now()
    });

    return { sessionKey };
}

function extractRawPublicKey(derBuf) {
    // X25519 SPKI DER: 30 2A 30 05 06 03 2B 65 6E 03 21 00 <32 bytes>
    if (derBuf.length === 44) {
        return derBuf.subarray(12, 44);
    }
    if (derBuf.length === 32) return derBuf;
    // Fallback
    return derBuf.subarray(derBuf.length - 32);
}

// ===== High-Level API =====

async function pairWithDevice(ip, pin) {
    console.log('[AirPlay-Pairing] Pairing with device', ip);
    const pairingData = await performPairSetup(ip, pin);

    // Store pairing data for future use
    const { setPairing } = require('./airplay-pairing-store');
    await setPairing(ip, {
        deviceId: null, // unknown at this point
        clientEd25519PubKey: pairingData.clientEd25519PubKey.toString('base64'),
        clientEd25519PrivKey: pairingData.clientEd25519PrivKey.toString('base64'),
        serverEd25519PubKey: pairingData.serverEd25519PubKey
            ? pairingData.serverEd25519PubKey.toString('base64') : null,
        sharedSecret: pairingData.sharedSecret.toString('base64'), // SRP session key (legacy)
        salt: pairingData.salt.toString('base64'),
        method: pairingData.method
    });

    // Perform initial pair-verify to establish session
    const { devices } = require('./state');
    const deviceName = devices[ip]?.name || ip;
    try {
        await performPairVerify(ip, loadPairingForVerify(pairingData));
        console.log('[AirPlay-Pairing] Initial pair-verify complete for', ip);
    } catch (err) {
        console.error('[AirPlay-Pairing] Initial pair-verify failed:', err.message);
        // Pair-setup succeeded, pair-verify can be retried later
    }

    return { success: true, deviceName, deviceIp: ip };
}

function loadPairingForVerify(data) {
    return {
        clientEd25519PubKey: Buffer.from(data.clientEd25519PubKey, 'base64'),
        clientEd25519PrivKey: Buffer.from(data.clientEd25519PrivKey, 'base64'),
        serverEd25519PubKey: Buffer.from(data.serverEd25519PubKey, 'base64'),
        sharedSecret: Buffer.from(data.sharedSecret, 'base64'),
        salt: Buffer.from(data.salt, 'base64'),
        method: data.method
    };
}

async function ensurePairVerify(ip) {
    // Check for cached session
    const cached = verifySessions.get(ip);
    if (cached && (Date.now() - cached.verifiedAt < 3600000)) { // 1 hour
        console.log('[AirPlay-Pairing] Using cached pair-verify session for', ip);
        return cached.sessionKey;
    }

    // Load pairing data
    const pairingStore = require('./airplay-pairing-store');
    const pairingData = pairingStore.getPairing(ip);
    if (!pairingData) {
        throw Object.assign(new Error('No pairing data for ' + ip), { code: 'NOT_PAIRED' });
    }

    const data = loadPairingForVerify(pairingData);
    const result = await performPairVerify(ip, data);
    return result.sessionKey;
}

function clearPairVerifySession(ip) {
    verifySessions.delete(ip);
}

module.exports = {
    performPairSetup,
    performPairVerify,
    pairWithDevice,
    ensurePairVerify,
    clearPairVerifySession,
    // Exported for testing
    computeSRP,
    verifyServerProof
};
