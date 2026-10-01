// Stopping a Chromecast session (lib/cast.js stopCasting) whose receiver has
// stopped answering: the session ends anyway, after a wait, rather than the
// Stop button hanging and the session staying on.
const { test } = require('node:test');
const assert = require('assert');
const { activeSessions } = require('../lib/state');
const { stopCasting } = require('../lib/cast');

function fakeSession(ip, stop) {
    const closed = [];
    activeSessions.set(ip, { client: { close: () => closed.push(true) }, player: { stop } });
    return closed;
}

test('a receiver that never acknowledges the stop is let go after five seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ip = '10.0.0.90';
    const closed = fakeSession(ip, () => { /* never answers */ });
    let done = false;
    const stopping = stopCasting(ip).then(() => { done = true; });

    t.mock.timers.tick(4900);
    await Promise.resolve();
    assert.strictEqual(done, false);
    assert.ok(activeSessions.has(ip));

    t.mock.timers.tick(100);
    await stopping;
    assert.deepStrictEqual(closed, [true]);
    assert.strictEqual(activeSessions.has(ip), false);
});

test('an answered stop ends the session at once, and a late timer does nothing more', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const ip = '10.0.0.91';
    const closed = fakeSession(ip, (cb) => cb(null));
    await stopCasting(ip);
    t.mock.timers.tick(10000);
    assert.deepStrictEqual(closed, [true], 'closed once');
    assert.strictEqual(activeSessions.has(ip), false);
});
