const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGpuMonitor } = require('../lib/gpu');

// A fake /sys/class/drm: renderD129 belongs to card1, whose i915 counters we control.
function fakeSysfs({ idleFile = 'gt/gt0/rc6_residency_ms', freqFile = 'gt/gt0/rps_act_freq_mhz' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-'));
    fs.mkdirSync(path.join(root, 'renderD129/device/drm/card1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'card1', path.dirname(idleFile)), { recursive: true });
    fs.mkdirSync(path.join(root, 'card1', path.dirname(freqFile)), { recursive: true });
    const set = (idleMs, mhz) => {
        fs.writeFileSync(path.join(root, 'card1', idleFile), `${idleMs}\n`);
        fs.writeFileSync(path.join(root, 'card1', freqFile), `${mhz}\n`);
    };
    return { root, set, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('GPU busy share comes from the idle (RC6) counter between two samples', (t) => {
    const sys = fakeSysfs();
    t.after(sys.cleanup);
    sys.set(10000, 300);
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    t.after(() => { Date.now = realNow; });

    const gpu = createGpuMonitor('/dev/dri/renderD129', { sysRoot: sys.root });
    now += 2000;
    sys.set(10500, 2050); // idle 0.5 s of the last 2 s
    assert.deepStrictEqual(gpu.sample(), { busyPercent: 75, clockMhz: 2050 });
});

test('the xe driver\'s counters are found too', (t) => {
    const sys = fakeSysfs({ idleFile: 'device/tile0/gt0/gtidle/idle_residency_ms', freqFile: 'device/tile0/gt0/freq0/act_freq' });
    t.after(sys.cleanup);
    sys.set(0, 1500);
    assert.ok(createGpuMonitor('/dev/dri/renderD129', { sysRoot: sys.root }));
});

test('no readable counters means no monitor', () => {
    assert.strictEqual(createGpuMonitor('/dev/dri/renderD129', { sysRoot: path.join(os.tmpdir(), 'no-such-drm') }), null);
});
