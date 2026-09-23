// The fully wired app from server.js: security headers, CSRF, SSRF and the
// WebSocket origin check, exercised over real HTTP. Unit tests cover the
// pieces; these catch a piece that is correct but not mounted where it
// should be. Runs with every protection at its default (on).
delete process.env.DISABLE_SSRF_PROTECTION;
delete process.env.DISABLE_CSRF;

const { test, before, after } = require('node:test');
const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');

let base;

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections();
    server.close();
});

// A token and the cookie it is bound to, as the UI gets them on page load.
async function csrf() {
    const res = await fetch(`${base}/api/csrf-token`);
    const { token } = await res.json();
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { token, cookie };
}

function postJson(path, body, { token, cookie } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-CSRF-Token'] = token;
    if (cookie) headers.Cookie = cookie;
    return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// --- Static UI and headers ---

test('the UI is served with a CSP that forbids framing', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header missing');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
});

test('no HSTS or upgrade-insecure-requests on a plain-HTTP LAN service', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.headers.get('strict-transport-security'), null);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});

test('the device list is readable without a CSRF token', async () => {
    const res = await fetch(`${base}/api/devices`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
});

// --- CSRF ---

for (const path of ['/api/cast', '/api/stop', '/api/extract', '/api/airplay/pair/192.168.1.50', '/api/airplay/unpair/192.168.1.50']) {
    test(`POST ${path} without a CSRF token is refused`, async () => {
        const res = await postJson(path, {});
        assert.strictEqual(res.status, 403);
    });
}

test('a token without its cookie is refused', async () => {
    const { token } = await csrf();
    const res = await postJson('/api/cast', {}, { token });
    assert.strictEqual(res.status, 403);
});

test('a valid token reaches the cast route, which then validates the body', async () => {
    const res = await postJson('/api/cast', { ip: 'not-an-ip', url: 'https://cdn.example/v.mp4' }, await csrf());
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /IP address/);
});

test('a valid token reaches the stop route', async () => {
    const res = await postJson('/api/stop', {}, await csrf());
    assert.strictEqual(res.status, 400);
});

// --- SSRF ---

test('extract refuses a loopback URL', async () => {
    const res = await postJson('/api/extract', { url: 'http://127.0.0.1:1/page' }, await csrf());
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /blocked by security policy/);
});

test('extract refuses the cloud metadata endpoint', async () => {
    const res = await postJson('/api/extract', { url: 'http://169.254.169.254/latest/meta-data/' }, await csrf());
    assert.strictEqual(res.status, 403);
});

test('proxy refuses a loopback URL', async () => {
    const res = await fetch(`${base}/proxy?url=${encodeURIComponent('http://127.0.0.1:1/x.m3u8')}`);
    assert.strictEqual(res.status, 403);
});

test('proxy requires a url parameter', async () => {
    const res = await fetch(`${base}/proxy`);
    assert.strictEqual(res.status, 400);
});

// --- /proxy header overrides ---

test('proxy responses carry no CSP and are cross-origin readable', async () => {
    // The receiver fetches from its own origin; helmet's same-origin CORP
    // default would make every segment unreadable.
    const res = await fetch(`${base}/proxy`);
    assert.strictEqual(res.headers.get('content-security-policy'), null);
    assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

// --- WebSocket origin check ---

function wsOutcome(origin) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(base.replace('http', 'ws'), origin ? { origin } : {});
        ws.on('open', () => setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
                resolve('open');
            }
        }, 100));
        ws.on('close', (code) => resolve(code));
        ws.on('error', reject);
    });
}

test('a WebSocket from another origin is closed with 1008', async () => {
    assert.strictEqual(await wsOutcome('http://evil.example'), 1008);
});

test('a same-origin WebSocket stays open', async () => {
    assert.strictEqual(await wsOutcome(base), 'open');
});
