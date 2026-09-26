// Connection health monitoring and stall recovery, driven tick by tick with
// mocked time. Defaults apply: heartbeat 5s, unhealthy after 3 missed,
// reconnect after 10s up to 3 times; stall after 15s, up to 3 recoveries.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('assert');
const { activeSessions, connectionHealth, streamRecovery, bufferHealthTracking } = require('../lib/state');
const { initializeConnectionHealth, updateHeartbeat, checkConnectionHealth } = require('../lib/health');
const { initializeStreamRecovery, trackStreamActivity, checkStreamStalls } = require('../lib/recovery');
const { trackBufferHealth } = require('../lib/stats');

const IP = '192.168.1.80';
const MEDIA = { contentId: 'http://h/proxy?url=x', contentType: 'application/x-mpegURL', streamType: 'BUFFERED' };

// Let pending promise callbacks run (setImmediate isn't mocked).
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A castv2 session whose player answers as told and records what it's asked.
function fakeSession({ statusOk = true, stopThrows = false } = {}) {
    const calls = [];
    const session = {
        client: { close: () => calls.push('close') },
        player: {
            getStatus: (cb) => {
                calls.push('getStatus');
                cb(statusOk ? null : new Error('timeout'), statusOk ? { playerState: 'PLAYING' } : undefined);
            },
            stop: (cb) => {
                calls.push('stop');
                // castv2 reads currentSession.mediaSessionId synchronously.
                if (stopThrows) throw new TypeError("Cannot read properties of undefined (reading 'mediaSessionId')");
                cb();
            },
            load: (media, options, cb) => {
                calls.push({ load: media, options });
                cb(null, {});
            }
        },
        subtitles: { tracks: [], activeTrackId: null, wanted: null }
    };
    activeSessions.set(IP, session);
    return { session, calls };
}

beforeEach(() => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    for (const map of [activeSessions, connectionHealth, streamRecovery, bufferHealthTracking]) map.clear();
});

afterEach(() => mock.timers.reset());

const health = () => connectionHealth.get(IP);

// ===== Connection health =====

test('missed heartbeats degrade, then mark the connection unhealthy', () => {
    fakeSession();
    initializeConnectionHealth(IP);

    mock.timers.tick(10_001); // 2 missed
    checkConnectionHealth();
    assert.strictEqual(health().connectionState, 'degraded');

    mock.timers.tick(5_000); // 3 missed
    checkConnectionHealth();
    assert.strictEqual(health().connectionState, 'unhealthy');
});

test('a device that answers the reconnect check is healthy again', async () => {
    const { calls } = fakeSession({ statusOk: true });
    initializeConnectionHealth(IP);
    mock.timers.tick(15_001);
    checkConnectionHealth();

    mock.timers.tick(10_000); // reconnect delay
    await settle();
    assert.deepStrictEqual(calls, ['getStatus']);
    assert.strictEqual(health().connectionState, 'healthy');
    assert.strictEqual(health().reconnectAttempts, 0);
});

test('a silent device is retried 3 times, then given up on and cleaned up', async () => {
    const { calls } = fakeSession({ statusOk: false });
    initializeConnectionHealth(IP);
    mock.timers.tick(15_001);
    checkConnectionHealth();

    for (let attempt = 1; attempt <= 3; attempt++) {
        mock.timers.tick(10_000);
        await settle();
    }
    assert.deepStrictEqual(calls, ['getStatus', 'getStatus', 'getStatus', 'close']);
    assert.strictEqual(activeSessions.has(IP), false, 'the dead session is torn down');
    assert.strictEqual(connectionHealth.has(IP), false);

    mock.timers.tick(60_000); // and nothing is retried afterwards
    await settle();
    assert.strictEqual(calls.length, 4);
});

test('proxy traffic shows the stream is alive but does not reset reconnect attempts', () => {
    fakeSession();
    initializeConnectionHealth(IP);
    Object.assign(health(), { connectionState: 'unhealthy', reconnectAttempts: 2 });

    updateHeartbeat(IP, 'media');
    assert.strictEqual(health().connectionState, 'healthy');
    assert.strictEqual(health().reconnectAttempts, 2);

    health().connectionState = 'unhealthy';
    updateHeartbeat(IP, 'control');
    assert.strictEqual(health().reconnectAttempts, 0);
});

test('health for a device without a session is dropped', () => {
    initializeConnectionHealth(IP);
    checkConnectionHealth();
    assert.strictEqual(connectionHealth.has(IP), false);
});

// ===== Stall recovery =====

// A session that played, then started buffering.
function stalledSession(options) {
    const fake = fakeSession(options);
    initializeStreamRecovery(IP, MEDIA);
    trackBufferHealth(IP, 'PLAYING');
    mock.timers.tick(1_000);
    trackBufferHealth(IP, 'BUFFERING');
    return fake;
}

async function runRecovery() {
    checkStreamStalls();
    await settle();
    mock.timers.tick(2_000); // pause between stop and reload
    await settle();
}

test('a stream buffering for over 15s with no media requests is reloaded as it was', async () => {
    const { calls } = stalledSession();
    mock.timers.tick(15_001);
    await runRecovery();

    assert.deepStrictEqual(calls, ['stop', { load: MEDIA, options: { autoplay: true } }]);
    assert.strictEqual(streamRecovery.get(IP).recoveryAttempts, 1);
    assert.strictEqual(streamRecovery.get(IP).stallDetected, false, 'a successful reload clears the stall');
});

test('buffering while media is still being fetched is not a stall', async () => {
    const { calls } = stalledSession();
    mock.timers.tick(10_000);
    trackStreamActivity(IP);
    mock.timers.tick(10_000);
    await runRecovery();
    assert.deepStrictEqual(calls, []);
});

test('buffering is not a stall until the timeout passes', async () => {
    const { calls } = stalledSession();
    mock.timers.tick(14_000);
    await runRecovery();
    assert.deepStrictEqual(calls, []);
});

test('recovery stops after 3 attempts', async () => {
    const { calls } = stalledSession();
    streamRecovery.get(IP).recoveryAttempts = 3;
    mock.timers.tick(15_001);
    await runRecovery();
    assert.deepStrictEqual(calls, []);
});

test('a session that cannot be stopped is still reloaded', async () => {
    // A receiver that answers a status probe with an empty status array leaves
    // castv2's currentSession undefined, and stop() then throws before it can
    // send. The reload is the point of the recovery; a failed stop must not
    // abandon it, which is how a recoverable stall became a dead session.
    const { calls } = stalledSession({ stopThrows: true });
    mock.timers.tick(15_001);
    await runRecovery();

    assert.strictEqual(calls[0], 'stop');
    assert.deepStrictEqual(calls[1].load, MEDIA);
    assert.strictEqual(streamRecovery.get(IP).stallDetected, false, 'the reload went ahead');
});

test('a stream that went idle on its own is reloaded', async () => {
    const { calls } = fakeSession();
    initializeStreamRecovery(IP, MEDIA);
    trackBufferHealth(IP, 'PLAYING');
    trackBufferHealth(IP, 'IDLE');
    mock.timers.tick(15_001);
    await runRecovery();
    assert.strictEqual(calls[0], 'stop');
    assert.deepStrictEqual(calls[1].load, MEDIA);
});

test('a reload keeps the sideloaded subtitles on', async () => {
    const { session, calls } = stalledSession();
    session.subtitles = { tracks: [{ trackId: 1, name: 'English', language: 'en' }], activeTrackId: 1, wanted: null };
    streamRecovery.get(IP).media = { ...MEDIA, tracks: [{ trackId: 1, type: 'TEXT' }] };
    mock.timers.tick(15_001);
    await runRecovery();
    assert.deepStrictEqual(calls[1].options, { autoplay: true, activeTrackIds: [1] });
});
