// SSRF guard tests. Run with protection ON (the default).
delete process.env.DISABLE_SSRF_PROTECTION;

const assert = require('assert');
const http = require('http');
const axios = require('axios');
const { isPrivateIP, validateProxyUrl, guardRedirect, safeRequestOptions } = require('../lib/security');

console.log('Running Security Tests...\n');

let passed = 0;
let failed = 0;
const tests = [];
function test(description, fn) {
    tests.push({ description, fn });
}

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

async function run() {
    for (const { description, fn } of tests) {
        try {
            await fn();
            console.log(`✓ ${description}`);
            passed++;
        } catch (err) {
            console.error(`✗ ${description}`);
            console.error(`  ${err.message}`);
            failed++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50) + '\n');

    if (failed > 0) process.exit(1);
}

run();
