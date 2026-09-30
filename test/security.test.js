// SSRF guard tests. Run with protection ON (the default).
delete process.env.DISABLE_SSRF_PROTECTION;

const { test } = require('node:test');
const assert = require('assert');
const http = require('http');
const axios = require('axios');
const dns = require('dns');
const { isPrivateIP, validateProxyUrl, guardRedirect, safeLookup, safeRequestOptions } = require('../lib/security');

test('private and special IPv4 ranges are blocked', () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
        '172.16.0.1', '172.31.255.255', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
        assert.ok(isPrivateIP(ip), ip);
    }
});

test('public IPv4 addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '93.184.216.34']) {
        assert.ok(!isPrivateIP(ip), ip);
    }
});

test('the whole IPv6 unique-local and link-local blocks are covered', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fdff::1', 'fe80::1', 'febf::1', 'fe80::1%en0', '[::1]']) {
        assert.ok(isPrivateIP(ip), ip);
    }
    assert.ok(!isPrivateIP('2606:4700::1111'));
});

test('IPv4-mapped IPv6 is judged as the IPv4 address, in both notations', () => {
    assert.ok(isPrivateIP('::ffff:127.0.0.1'));
    assert.ok(isPrivateIP('::ffff:7f00:1'));
    assert.ok(isPrivateIP('::ffff:a9fe:a9fe')); // 169.254.169.254
    assert.ok(!isPrivateIP('::ffff:8.8.8.8'));
});

test('hostnames are not addresses', () => {
    assert.ok(!isPrivateIP('10.example.com'));
    assert.ok(!isPrivateIP('localhost'));
    assert.ok(!isPrivateIP(undefined));
});

test('validateProxyUrl blocks local targets and odd protocols', async () => {
    for (const url of ['http://127.0.0.1/', 'http://localhost:3000/', 'http://app.localhost/',
        'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://[::ffff:7f00:1]/']) {
        const result = await validateProxyUrl(url);
        assert.strictEqual(result.valid, false, url);
    }
    assert.strictEqual((await validateProxyUrl('file:///etc/passwd')).valid, false);
    assert.strictEqual((await validateProxyUrl('not a url')).valid, false);
});

test('guardRedirect rejects private and non-http hops', () => {
    assert.throws(() => guardRedirect({ protocol: 'http:', hostname: '169.254.169.254' }));
    assert.throws(() => guardRedirect({ protocol: 'http:', hostname: '[::1]' }));
    assert.throws(() => guardRedirect({ protocol: 'file:', hostname: '' }));
    assert.doesNotThrow(() => guardRedirect({ protocol: 'https:', hostname: 'cdn.example.com' }));
});

// The hole guardRedirect closes: Node never calls `lookup` for an IP-literal
// host, so a redirect to one sailed past safeLookup.
test('a redirect to an IP literal is refused end to end', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/secret') return res.end('SECRET');
        res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/secret` });
        res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const outcome = await axios.get(`http://127.0.0.1:${server.address().port}/start`, safeRequestOptions)
            .then(r => r.data, e => e.message);
        assert.notStrictEqual(outcome, 'SECRET');
        assert.match(outcome, /Blocked redirect/);
    } finally {
        server.close();
    }
});

// ===== Names that resolve to private addresses =====
// A public-looking name can point anywhere; what it resolves to decides.

test('validateProxyUrl blocks a name that resolves to a private address', async (t) => {
    t.mock.method(dns.promises, 'lookup', async (host) => (host === 'intranet.example.com'
        ? [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }]));
    const blocked = await validateProxyUrl('http://intranet.example.com/admin');
    assert.strictEqual(blocked.valid, false);
    assert.match(blocked.reason, /10\.0\.0\.5/);
    assert.strictEqual((await validateProxyUrl('https://cdn.example.com/v.m3u8')).valid, true);
});

test('a name that does not resolve is left for the request to fail on', async (t) => {
    t.mock.method(dns.promises, 'lookup', async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
    assert.strictEqual((await validateProxyUrl('https://nowhere.invalid/')).valid, true);
});

// DNS rebinding: the name passed validation, then resolves somewhere else
// when the connection is made. safeLookup checks again at that point.
test('safeLookup refuses a connection to a private address, single or all', async (t) => {
    const answers = { 'rebound.example.com': '169.254.169.254', 'cdn.example.com': '93.184.216.34' };
    t.mock.method(dns, 'lookup', (host, options, cb) => {
        const address = answers[host];
        if (options.all) return cb(null, [{ address: '93.184.216.34', family: 4 }, { address, family: 4 }]);
        cb(null, address, 4);
    });
    const lookup = (host, options = {}) => new Promise((resolve, reject) => {
        safeLookup(host, options, (err, address) => (err ? reject(err) : resolve(address)));
    });

    await assert.rejects(lookup('rebound.example.com'), /Blocked connection to private IP \(169\.254\.169\.254\)/);
    await assert.rejects(lookup('rebound.example.com', { all: true }), /169\.254\.169\.254/);
    assert.strictEqual(await lookup('cdn.example.com'), '93.184.216.34');
    // The (host, callback) form Node also uses.
    await new Promise((resolve) => safeLookup('rebound.example.com', (err) => {
        assert.match(err.message, /Blocked/);
        resolve();
    }));
});

test('axios requests go through the check at connect time', async (t) => {
    t.mock.method(dns, 'lookup', (host, options, cb) => (options.all
        ? cb(null, [{ address: '127.0.0.1', family: 4 }])
        : cb(null, '127.0.0.1', 4)));
    await assert.rejects(axios.get('http://rebound.example.com/', { ...safeRequestOptions, timeout: 2000 }), /Blocked connection to private IP/);
});

// The headless browser runs the page inside our network: it's held to the
// same rules, starting with the page itself.
test('the headless browser won\'t load a page on a private address', async (t) => {
    const { chromium } = require('playwright');
    try {
        await (await chromium.launch()).close();
    } catch {
        return t.skip('Playwright Chromium not installed');
    }
    const { extractWithBrowser, closeBrowser } = require('../lib/browser');
    t.after(closeBrowser);
    let requested = false;
    const site = http.createServer((req, res) => {
        requested = true;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<script>fetch("/live.m3u8")</script>');
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    t.after(() => site.close());

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    assert.strictEqual(await extractWithBrowser(`http://127.0.0.1:${site.address().port}/`, { signal: controller.signal }), null);
    assert.strictEqual(requested, false);
});
