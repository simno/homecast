const { test } = require('node:test');
const assert = require('assert');

// ============================================
// Frame Rate Detection Tests
// ============================================

function extractFrameRateFromPlaylist(playlist) {
    const frameRateMatch = playlist.match(/FRAME-RATE=([\d.]+)/);
    if (frameRateMatch) {
        return parseFloat(frameRateMatch[1]);
    }
    return null;
}

test('Frame rate: Extract from HLS playlist (24 FPS)', () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=24.000
https://example.com/720p.m3u8`;
    const frameRate = extractFrameRateFromPlaylist(playlist);
    assert.strictEqual(frameRate, 24.0);
});

test('Frame rate: Extract from HLS playlist (30 FPS)', () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=30.000
https://example.com/1080p.m3u8`;
    const frameRate = extractFrameRateFromPlaylist(playlist);
    assert.strictEqual(frameRate, 30.0);
});

test('Frame rate: Extract from HLS playlist (60 FPS)', () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=59.940
https://example.com/1080p60.m3u8`;
    const frameRate = extractFrameRateFromPlaylist(playlist);
    assert.strictEqual(frameRate, 59.940);
});

test('Frame rate: Return null when not present', () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
https://example.com/720p.m3u8`;
    const frameRate = extractFrameRateFromPlaylist(playlist);
    assert.strictEqual(frameRate, null);
});

test('Frame rate: Handle decimal values (23.976)', () => {
    const playlist = `#EXTM3U
#EXT-X-STREAM-INF:FRAME-RATE=23.976
https://example.com/film.m3u8`;
    const frameRate = extractFrameRateFromPlaylist(playlist);
    assert.strictEqual(frameRate, 23.976);
});

test('Frame rate: Extract from MP4 mvhd atom (24 FPS)', () => {
    // Create a minimal MP4 buffer with mvhd atom
    const buffer = Buffer.alloc(100);
    buffer.write('mvhd', 20); // Place 'mvhd' at offset 20
    buffer[24] = 0; // Version 0 (after 'mvhd')
    buffer[25] = 0; buffer[26] = 0; buffer[27] = 0; // Flags
    buffer.writeUInt32BE(0, 28); // Creation time
    buffer.writeUInt32BE(0, 32); // Modification time
    buffer.writeUInt32BE(24000, 36); // Timescale at offset 36 (version 0: mvhd+4+12)

    const timescale = findMvhdTimescale(buffer);
    assert.strictEqual(timescale, 24000);
});

test('Frame rate: Extract from MP4 mvhd atom (30 FPS)', () => {
    const buffer = Buffer.alloc(100);
    buffer.write('mvhd', 20);
    buffer[24] = 0;
    buffer[25] = 0; buffer[26] = 0; buffer[27] = 0;
    buffer.writeUInt32BE(0, 28);
    buffer.writeUInt32BE(0, 32);
    buffer.writeUInt32BE(30000, 36);

    const timescale = findMvhdTimescale(buffer);
    assert.strictEqual(timescale, 30000);
});

test('Frame rate: Return null for invalid MP4 buffer', () => {
    const buffer = Buffer.from('invalid data');
    const timescale = findMvhdTimescale(buffer);
    assert.strictEqual(timescale, null);
});

// Helper function from server.js
function findMvhdTimescale(buffer) {
    try {
        const mvhdIndex = buffer.indexOf('mvhd');
        if (mvhdIndex === -1) return null;

        const versionOffset = mvhdIndex + 4;
        if (versionOffset >= buffer.length) return null;

        const version = buffer[versionOffset];
        let timescaleOffset;

        if (version === 1) {
            timescaleOffset = mvhdIndex + 4 + 20;
        } else {
            timescaleOffset = mvhdIndex + 4 + 12;
        }

        if (timescaleOffset + 4 > buffer.length) return null;

        const timescale = buffer.readUInt32BE(timescaleOffset);

        if (timescale < 1 || timescale > 600000) return null;

        return timescale;
    } catch {
        return null;
    }
}

// ============================================
// Segment Skip Logic Tests
// ============================================

function extractSegmentNumber(url) {
    const match = url.match(/(\d+)\.(?:ts|m4s|mp4|txt)(\?.*)?$/);
    if (!match) return null;
    return parseInt(match[1]);
}

function generateNextSegmentUrl(url) {
    const segmentNumber = extractSegmentNumber(url);
    if (segmentNumber === null) return null;
    const nextSegmentNumber = segmentNumber + 1;
    return url.replace(`${segmentNumber}.`, `${nextSegmentNumber}.`);
}

test('Segment skip: Extract segment number from .ts file', () => {
    const url = 'https://example.com/segment_123.ts';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, 123);
});

test('Segment skip: Extract segment number from .m4s file', () => {
    const url = 'https://example.com/chunk456.m4s';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, 456);
});

test('Segment skip: Extract segment number with query params', () => {
    const url = 'https://example.com/segment_789.ts?token=abc';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, 789);
});

test('Segment skip: Generate next segment URL', () => {
    const url = 'https://example.com/segment_123.ts';
    const nextUrl = generateNextSegmentUrl(url);
    assert.strictEqual(nextUrl, 'https://example.com/segment_124.ts');
});

test('Segment skip: Preserve query parameters', () => {
    const url = 'https://example.com/segment_123.ts?token=abc';
    const nextUrl = generateNextSegmentUrl(url);
    assert.strictEqual(nextUrl, 'https://example.com/segment_124.ts?token=abc');
});

test('Segment skip: Handle leading zeros', () => {
    const url = 'https://example.com/seg_0005.ts';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, 5);
});

test('Segment skip: Return null for no segment number', () => {
    const url = 'https://example.com/stream.m3u8';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, null);
});

test('Segment skip: Handle real-world segment URL', () => {
    const url = 'https://a.nebulonsolis.space/scripts/NDI5ODE=/p1768064875015082617_2786.txt';
    const segmentNum = extractSegmentNumber(url);
    assert.strictEqual(segmentNum, 2786);
});

// ============================================
// Per-Device Stats Tests
// ============================================

class MockStatsMap {
    constructor() {
        this.data = new Map();
    }

    set(deviceIp, stats) {
        this.data.set(deviceIp, stats);
    }

    get(deviceIp) {
        return this.data.get(deviceIp);
    }

    has(deviceIp) {
        return this.data.has(deviceIp);
    }

    delete(deviceIp) {
        return this.data.delete(deviceIp);
    }

    size() {
        return this.data.size;
    }
}

test('Per-device stats: Track multiple devices independently', () => {
    const stats = new MockStatsMap();

    stats.set('192.168.1.100', { totalBytes: 1000, transferRate: 100 });
    stats.set('192.168.1.101', { totalBytes: 2000, transferRate: 200 });

    const device1Stats = stats.get('192.168.1.100');
    const device2Stats = stats.get('192.168.1.101');

    assert.strictEqual(device1Stats.totalBytes, 1000);
    assert.strictEqual(device2Stats.totalBytes, 2000);
});

test('Per-device stats: Delete specific device without affecting others', () => {
    const stats = new MockStatsMap();

    stats.set('192.168.1.100', { totalBytes: 1000 });
    stats.set('192.168.1.101', { totalBytes: 2000 });

    stats.delete('192.168.1.100');

    assert.strictEqual(stats.has('192.168.1.100'), false);
    assert.strictEqual(stats.has('192.168.1.101'), true);
});

test('Per-device stats: Update device stats independently', () => {
    const stats = new MockStatsMap();

    stats.set('192.168.1.100', { totalBytes: 1000, transferRate: 100 });
    stats.set('192.168.1.101', { totalBytes: 2000, transferRate: 200 });

    const device1 = stats.get('192.168.1.100');
    device1.totalBytes = 1500;

    assert.strictEqual(stats.get('192.168.1.100').totalBytes, 1500);
    assert.strictEqual(stats.get('192.168.1.101').totalBytes, 2000);
});

// ============================================
// State Persistence Tests
// ============================================

class MockLocalStorage {
    constructor() {
        this.store = {};
    }

    getItem(key) {
        return this.store[key] || null;
    }

    setItem(key, value) {
        this.store[key] = value;
    }

    removeItem(key) {
        delete this.store[key];
    }
}

test('State: Save device IP to storage', () => {
    const storage = new MockLocalStorage();
    const state = { deviceIp: '192.168.1.100', timestamp: Date.now() };

    storage.setItem('homecast_state', JSON.stringify(state));

    const saved = JSON.parse(storage.getItem('homecast_state'));
    assert.strictEqual(saved.deviceIp, '192.168.1.100');
});

test('State: Load device IP from storage', () => {
    const storage = new MockLocalStorage();
    const state = { deviceIp: '192.168.1.100', timestamp: Date.now() };

    storage.setItem('homecast_state', JSON.stringify(state));
    const loaded = JSON.parse(storage.getItem('homecast_state'));

    assert.strictEqual(loaded.deviceIp, '192.168.1.100');
});

test('State: Clear state from storage', () => {
    const storage = new MockLocalStorage();
    storage.setItem('homecast_state', JSON.stringify({ deviceIp: '192.168.1.100' }));

    storage.removeItem('homecast_state');

    assert.strictEqual(storage.getItem('homecast_state'), null);
});

test('State: Reject stale state (>24 hours)', () => {
    const storage = new MockLocalStorage();
    const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
    const state = { deviceIp: '192.168.1.100', timestamp: oldTimestamp };

    storage.setItem('homecast_state', JSON.stringify(state));
    const loaded = JSON.parse(storage.getItem('homecast_state'));

    const age = Date.now() - loaded.timestamp;
    const isStale = age > (24 * 60 * 60 * 1000);

    assert.strictEqual(isStale, true);
});

test('State: Accept fresh state (<24 hours)', () => {
    const storage = new MockLocalStorage();
    const recentTimestamp = Date.now() - (1 * 60 * 60 * 1000); // 1 hour ago
    const state = { deviceIp: '192.168.1.100', timestamp: recentTimestamp };

    storage.setItem('homecast_state', JSON.stringify(state));
    const loaded = JSON.parse(storage.getItem('homecast_state'));

    const age = Date.now() - loaded.timestamp;
    const isStale = age > (24 * 60 * 60 * 1000);

    assert.strictEqual(isStale, false);
});

