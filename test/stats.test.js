const { test, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const { bufferHealthTracking } = require('../lib/state');
const { trackBufferHealth, getBufferHealthStats, noteSeek } = require('../lib/stats');

const IP = '10.0.0.9';
const realNow = Date.now;
let now;

beforeEach(() => {
    bufferHealthTracking.clear();
    now = 1_000_000;
    Date.now = () => now;
});

afterEach(() => {
    Date.now = realNow;
});

// Play for `playing` seconds, then buffer for `buffering` seconds, then play again.
function playThenBuffer(playing, buffering, { seek = false } = {}) {
    trackBufferHealth(IP, 'PLAYING');
    now += playing * 1000;
    if (seek) noteSeek(IP);
    trackBufferHealth(IP, 'BUFFERING');
    now += buffering * 1000;
    trackBufferHealth(IP, 'PLAYING');
    now += 10_000;
}

test('buffering during playback is a stall, and counts against the score', () => {
    playThenBuffer(30, 5);
    const stats = getBufferHealthStats(IP);
    assert.strictEqual(stats.bufferingEvents, 1);
    assert.strictEqual(stats.totalBufferingTime, 5);
    assert.ok(stats.healthScore < 100);
});

test('buffering after a seek is the player filling up at the new position, not a stall', () => {
    playThenBuffer(30, 5.5, { seek: true });
    assert.deepStrictEqual(getBufferHealthStats(IP), { healthScore: 100, bufferingEvents: 0, totalBufferingTime: 0 });
});

test('a seek that stalls for longer than a seek should still counts, beyond the grace', () => {
    playThenBuffer(30, 40, { seek: true });
    const stats = getBufferHealthStats(IP);
    assert.strictEqual(stats.bufferingEvents, 1);
    assert.strictEqual(stats.totalBufferingTime, 25, '40s of buffering, the first 15s forgiven');
});

test('only the buffering that follows the seek is forgiven', () => {
    playThenBuffer(30, 5, { seek: true });
    now += 60_000;
    playThenBuffer(30, 5);
    assert.strictEqual(getBufferHealthStats(IP).bufferingEvents, 1);
});
