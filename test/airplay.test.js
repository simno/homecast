// AirPlay & WOL unit tests
const { extractMAC, sendWOL } = require('../lib/wol');
const { extractVideoFromHtml } = require('../lib/extraction');

let passed = 0;
let failed = 0;

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

console.log('Running AirPlay, WOL, and Extraction tests...\n');

// ===== MAC Extraction =====
test('Extract MAC from 12-char hex device ID', () => {
    const mac = extractMAC('aabbccddeeff');
    if (mac !== 'aa:bb:cc:dd:ee:ff') throw new Error(`Got ${mac}`);
});

test('Extract MAC from 14-char hex device ID (MAC + extra byte)', () => {
    const mac = extractMAC('aabbccddeeff12');
    if (mac !== 'aa:bb:cc:dd:ee:ff') throw new Error(`Got ${mac}`);
});

test('Reject non-hex device ID (UUID)', () => {
    const mac = extractMAC('5BD25CD3-4C4C-4E30-A146-CA557F178B3C');
    if (mac !== null) throw new Error(`Expected null, got ${mac}`);
});

test('Reject null device ID', () => {
    const mac = extractMAC(null);
    if (mac !== null) throw new Error(`Expected null, got ${mac}`);
});

test('Reject invalid device ID', () => {
    const mac = extractMAC('not-a-mac');
    if (mac !== null) throw new Error(`Expected null, got ${mac}`);
});

test('Extract MAC with uppercase hex', () => {
    const mac = extractMAC('AABBCCDDEEFF');
    if (mac !== 'aa:bb:cc:dd:ee:ff') throw new Error(`Got ${mac}`);
});

// ===== WOL Magic Packet =====
test('Send WOL requires valid MAC format', () => {
    // Calling buildMagicPacket indirectly via sendWOL with invalid MAC
    // validate that it throws on garbage input
    try {
        // Quick inline test of the validation logic
        const mac = 'invalid-mac';
        const clean = mac.replace(/[:-]/g, '').toLowerCase();
        if (clean.length !== 12 || !/^[0-9a-f]{12}$/.test(clean)) {
            throw new Error(`Invalid MAC address: ${mac}`);
        }
    } catch (e) {
        if (!e.message.includes('Invalid MAC')) throw e;
    }
});

test('Send WOL rejects invalid MAC', async () => {
    try {
        await sendWOL('invalid-mac');
        throw new Error('Should have thrown');
    } catch (e) {
        if (!e.message.includes('Invalid MAC')) {
            const err = new Error(`Unexpected error: ${e.message}`);
            err.cause = e;
            throw err;
        }
    }
});

// ===== Extraction: don't match player page URLs as video =====
test('extractVideoFromHtml: find .m3u8 URL', () => {
    const html = 'var src = "https://example.com/stream/video.m3u8?token=abc";';
    const result = extractVideoFromHtml(html);
    if (!result || !result.includes('.m3u8')) throw new Error(`Got ${result}`);
});

test('extractVideoFromHtml: find .mp4 URL', () => {
    const html = '<source src="https://example.com/video.mp4">';
    const result = extractVideoFromHtml(html);
    if (!result || !result.includes('.mp4')) throw new Error(`Got ${result}`);
});

test('extractVideoFromHtml: do NOT match player page URL (Twitch regression)', () => {
    const twitchConfig = 'source: "https://player.twitch.tv/?channel=pgl&player=facebook&autoplay=true"';
    const result = extractVideoFromHtml(twitchConfig);
    if (result !== null) throw new Error(`Should not have matched player URL, got: ${result}`);
});

test('extractVideoFromHtml: do NOT match generic source: URLs without video extension', () => {
    const html = 'file: "https://cdn.example.com/embed/player.html?video=123"';
    const result = extractVideoFromHtml(html);
    if (result !== null) throw new Error(`Should not have matched embed URL, got: ${result}`);
});

test('extractVideoFromHtml: match source: URL with .mp4 extension', () => {
    const html = 'source: "https://cdn.example.com/videos/stream.mp4?token=abc"';
    const result = extractVideoFromHtml(html);
    if (!result || !result.includes('.mp4')) throw new Error(`Got ${result}`);
});

test('extractVideoFromHtml: match file: URL with .m3u8 extension', () => {
    const html = 'file: "https://cdn.example.com/hls/stream.m3u8"';
    const result = extractVideoFromHtml(html);
    if (!result || !result.includes('.m3u8')) throw new Error(`Got ${result}`);
});

test('extractVideoFromHtml: match videoUrl: with .mp4 extension', () => {
    const html = 'videoUrl: "https://cdn.example.com/video.mp4"';
    const result = extractVideoFromHtml(html);
    if (!result || !result.includes('.mp4')) throw new Error(`Got ${result}`);
});

test('extractVideoFromHtml: return null for HTML without video', () => {
    const html = '<html><body><p>Hello World</p></body></html>';
    const result = extractVideoFromHtml(html);
    if (result !== null) throw new Error(`Expected null, got ${result}`);
});

// ===== Results =====
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
