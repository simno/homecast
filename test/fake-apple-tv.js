// A fake Apple TV for tests: the AirPlay 1 HTTP API casting uses (/play,
// /stop, /rate, /scrub, /playback-info, /server-info) and the server side of
// PIN pairing (/pair-setup: SRP-6a over the RFC 5054 2048-bit group, then
// /pair-verify: Ed25519 signatures over X25519 keys), so lib/airplay-pairing.js
// is checked against an independent implementation of the protocol.
const http = require('http');
const crypto = require('crypto');
const { encodeBPlist, decodeBPlist } = require('../lib/bplist');

const dh = crypto.getDiffieHellman('modp14');
const N_BUF = dh.getPrime();
const G_BUF = dh.getGenerator();
const toBig = (buf) => BigInt('0x' + (buf.toString('hex') || '0'));
const N = toBig(N_BUF);
const G = toBig(G_BUF);

const sha1 = (...parts) => crypto.createHash('sha1').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();

function pad(buf, len = 256) {
    if (buf.length >= len) return buf;
    return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
}

function toBuf(big) {
    let hex = big.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
}

function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % mod;
        exp >>= 1n;
        base = (base * base) % mod;
    }
    return result;
}

// SRP's session key: SHA-1 of the even and the odd bytes of S, interleaved.
function interleaveHash(s) {
    const even = Buffer.from(s.filter((_, i) => i % 2 === 0));
    const odd = Buffer.from(s.filter((_, i) => i % 2 === 1));
    const he = sha1(even);
    const ho = sha1(odd);
    return Buffer.from(Array.from({ length: 40 }, (_, i) => (i % 2 ? ho : he)[i >> 1]));
}

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const rawKey = (key) => key.export({ format: 'der', type: 'spki' }).subarray(12);

function createFakeAppleTv({ pin = null, liveWindow = null, duration = 600, position = 30 } = {}) {
    const identity = crypto.generateKeyPairSync('ed25519');
    const state = {
        requests: [],
        playing: null,
        rate: null,
        scrubbedTo: null,
        verified: false,
        clientSignature: null,
        srp: null
    };

    const plist = (res, status, body) => {
        const payload = encodeBPlist(body);
        res.writeHead(status, { 'Content-Type': 'application/x-apple-binary-plist', 'Content-Length': payload.length });
        res.end(payload);
    };

    function pairSetup(body, res) {
        if (body.method === 'pin') {
            const salt = crypto.randomBytes(16);
            const x = toBig(sha1(salt, sha1(`${body.user}:${pin}`)));
            const v = modPow(G, x, N);
            const b = toBig(crypto.randomBytes(32));
            const k = toBig(sha1(N_BUF, pad(G_BUF)));
            const B = pad(toBuf((k * v + modPow(G, b, N)) % N));
            state.srp = { user: body.user, salt, v, b, B };
            return plist(res, 200, { pk: B, salt });
        }
        if (!state.srp || !body.pk || !body.proof) return plist(res, 470, {});
        const { user, salt, v, b, B } = state.srp;
        const A = pad(body.pk);
        const u = toBig(sha1(A, B));
        const S = modPow((toBig(A) * modPow(v, u, N)) % N, b, N);
        const K = interleaveHash(pad(toBuf(S)));
        const hN = sha1(N_BUF);
        const hG = sha1(pad(G_BUF));
        const M1 = sha1(Buffer.from(hN.map((byte, i) => byte ^ hG[i])), sha1(user), salt, A, B, K);
        if (!M1.equals(body.proof)) return plist(res, 403, {});

        // The proof, then the accessory's long-term key encrypted with keys
        // derived from the SRP session key.
        const aesKey = Buffer.from(crypto.hkdfSync('sha512', K, salt, 'Pair-Setup-AES-Key', 32));
        const aesIv = Buffer.from(crypto.hkdfSync('sha512', K, salt, 'Pair-Setup-AES-IV', 16));
        const cipher = crypto.createCipheriv('aes-256-ctr', aesKey, aesIv);
        const encryptedKey = Buffer.concat([cipher.update(rawKey(identity.publicKey)), cipher.final()]);
        return plist(res, 200, { proof: Buffer.concat([sha1(A, body.proof, K), encryptedKey]) });
    }

    function pairVerify(body, res) {
        if (!body.pk || body.pk.length !== 32 || !body.sig) return plist(res, 470, {});
        state.clientSignature = body.sig;
        const ephemeral = crypto.generateKeyPairSync('x25519');
        const ephemeralPub = rawKey(ephemeral.publicKey);
        const sig = crypto.sign(null, Buffer.concat([rawKey(identity.publicKey), Buffer.from([0x01]), ephemeralPub]), identity.privateKey);
        // The shared secret has to be computable from the client's key.
        crypto.diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, body.pk]), format: 'der', type: 'spki' })
        });
        state.verified = true;
        return plist(res, 200, { pk: ephemeralPub, sig });
    }

    function playbackInfo() {
        const ranges = liveWindow
            ? `<key>seekableTimeRanges</key><array><dict><key>duration</key><real>${liveWindow.duration}</real><key>start</key><real>${liveWindow.start}</real></dict></array>`
            : '';
        return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>position</key><real>${position}</real>${ranges}</dict></plist>`;
    }

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url, 'http://apple-tv');
            state.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers });
            const route = `${req.method} ${url.pathname}`;
            const body = chunks.length && req.headers['content-type'] === 'application/x-apple-binary-plist'
                ? decodeBPlist(Buffer.concat(chunks)) : null;

            if (route === 'POST /pair-setup') return pairSetup(body, res);
            if (route === 'POST /pair-verify') return pairVerify(body, res);
            if (route === 'POST /play') {
                if (pin && !state.verified) {
                    res.writeHead(403);
                    return res.end();
                }
                state.playing = req.headers['content-location'];
                res.writeHead(200);
                return res.end();
            }
            if (route === 'POST /stop') {
                state.playing = null;
                res.writeHead(200);
                return res.end();
            }
            if (route === 'POST /rate') {
                state.rate = parseFloat(url.searchParams.get('value'));
                res.writeHead(200);
                return res.end();
            }
            if (route === 'GET /scrub') {
                res.writeHead(200, { 'Content-Type': 'text/parameters' });
                return res.end(`duration: ${duration.toFixed(6)}\nposition: ${position.toFixed(6)}\n`);
            }
            if (route === 'POST /scrub') {
                state.scrubbedTo = parseFloat(url.searchParams.get('position'));
                res.writeHead(200);
                return res.end();
            }
            if (route === 'GET /playback-info') {
                res.writeHead(200, { 'Content-Type': 'text/x-apple-plist+xml' });
                return res.end(playbackInfo());
            }
            if (route === 'GET /server-info') {
                res.writeHead(200);
                return res.end();
            }
            res.writeHead(404);
            res.end();
        });
    });

    return {
        server,
        state,
        // Forget the pair-verify, as an Apple TV does when the connection closes.
        forgetVerify: () => { state.verified = false; },
        listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
        close: () => new Promise(resolve => server.close(resolve))
    };
}

module.exports = { createFakeAppleTv };
