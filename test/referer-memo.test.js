// Referer Memo Tests - Tests the per-host "this CDN rejects Referer" cache
// that lets the proxy skip a doomed first request on hosts like pscp.tv.

const assert = require('assert');
const { shouldSendReferer, noteRefererRejected, clearRefererMemo } = require('../lib/proxy');

console.log('Running Referer Memo Tests...\n');

let passed = 0;
let failed = 0;

function test(description, fn) {
    try {
        clearRefererMemo();
        fn();
        console.log(`✓ ${description}`);
        passed++;
    } catch (err) {
        console.error(`✗ ${description}`);
        console.error(`  ${err.message}`);
        failed++;
    }
}

const PSCP = 'https://prod-fastly-us-east-1.video.pscp.tv/Transcoding/v1/hls/x/master.m3u8?type=replay';

test('an unseen host is sent the Referer', () => {
    assert.strictEqual(shouldSendReferer(PSCP), true);
});

test('a host that rejected the Referer is not sent it again', () => {
    noteRefererRejected(PSCP);
    assert.strictEqual(shouldSendReferer(PSCP), false);
});

test('the memo applies to every path on that host', () => {
    noteRefererRejected(PSCP);
    assert.strictEqual(
        shouldSendReferer('https://prod-fastly-us-east-1.video.pscp.tv/some/other/chunk_1.ts'),
        false
    );
});

test('other hosts are unaffected', () => {
    noteRefererRejected(PSCP);
    assert.strictEqual(shouldSendReferer('https://cdn.example.com/master.m3u8'), true);
});

test('port is part of host identity', () => {
    noteRefererRejected('https://cdn.example.com:8443/a.m3u8');
    assert.strictEqual(shouldSendReferer('https://cdn.example.com:8443/b.m3u8'), false);
    assert.strictEqual(shouldSendReferer('https://cdn.example.com/b.m3u8'), true);
});

test('a malformed URL defaults to sending the Referer', () => {
    assert.strictEqual(shouldSendReferer('not a url'), true);
});

test('recording a malformed URL does not throw or poison the memo', () => {
    noteRefererRejected('not a url');
    assert.strictEqual(shouldSendReferer(PSCP), true);
});

test('the memo is bounded and evicts the oldest host', () => {
    // 50 is the cap; adding 60 must not grow past it.
    for (let i = 0; i < 60; i++) {
        noteRefererRejected(`https://host${i}.example.com/a.m3u8`);
    }
    assert.strictEqual(shouldSendReferer('https://host0.example.com/a.m3u8'), true,
        'oldest entry should have been evicted');
    assert.strictEqual(shouldSendReferer('https://host59.example.com/a.m3u8'), false,
        'newest entry should still be remembered');
});

test('clearing the memo restores the default', () => {
    noteRefererRejected(PSCP);
    clearRefererMemo();
    assert.strictEqual(shouldSendReferer(PSCP), true);
});

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50) + '\n');

if (failed > 0) process.exit(1);
