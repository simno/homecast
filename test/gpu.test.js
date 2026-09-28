const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGpuMonitor, createNvidiaMonitor, parseNvidiaSmi, gpuVendor } = require('../lib/gpu');

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
    assert.deepStrictEqual(gpu.sample(), { busyPercent: 75, clockMhz: 2050, measures: 'gpu' });
});

test('an idle instant\'s zero clock gives way to the requested clock', (t) => {
    const sys = fakeSysfs();
    t.after(sys.cleanup);
    sys.set(0, 0); // the actual clock reads 0 while the GPU is idle
    fs.writeFileSync(path.join(sys.root, 'card1/gt/gt0/rps_cur_freq_mhz'), '2050\n');
    const gpu = createGpuMonitor('/dev/dri/renderD129', { sysRoot: sys.root });
    assert.strictEqual(gpu.sample().clockMhz, 2050);
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

test('AMD reports its busy percent and active clock directly', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'renderD128/device/drm/card0'), { recursive: true });
    fs.mkdirSync(path.join(root, 'card0/device'), { recursive: true });
    fs.writeFileSync(path.join(root, 'card0/device/gpu_busy_percent'), '37\n');
    fs.writeFileSync(path.join(root, 'card0/device/pp_dpm_sclk'), '0: 500Mhz\n1: 2100Mhz *\n2: 2600Mhz\n');
    const gpu = createGpuMonitor('/dev/dri/renderD128', { sysRoot: root });
    assert.deepStrictEqual(gpu.sample(), { busyPercent: 37, clockMhz: 2100, measures: 'graphics' });
});

test('the vendor comes from the render node\'s PCI vendor ID', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [node, id] of [['renderD128', '0x8086'], ['renderD129', '0x1002'], ['renderD130', '0x10de']]) {
        fs.mkdirSync(path.join(root, node, 'device'), { recursive: true });
        fs.writeFileSync(path.join(root, node, 'device/vendor'), `${id}\n`);
    }
    assert.deepStrictEqual(
        ['renderD128', 'renderD129', 'renderD130', 'renderD131'].map(n => gpuVendor(`/dev/dri/${n}`, root)),
        ['Intel', 'AMD', 'NVIDIA', null]);
});

test('nvidia-smi output becomes the encoder\'s load', () => {
    assert.deepStrictEqual(parseNvidiaSmi('45, 1530\n'), { busyPercent: 45, clockMhz: 1530, measures: 'encoder' });
    assert.strictEqual(parseNvidiaSmi('[N/A], [N/A]'), null);
});

test('the NVIDIA monitor asks nvidia-smi in the background', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smi-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = path.join(dir, 'nvidia-smi');
    fs.writeFileSync(fake, '#!/bin/sh\necho "62, 1710"\n', { mode: 0o755 });

    const gpu = createNvidiaMonitor({ command: fake });
    for (let i = 0; i < 40 && !gpu.sample(); i++) await new Promise(r => setTimeout(r, 25));
    assert.deepStrictEqual(gpu.sample(), { busyPercent: 62, clockMhz: 1710, measures: 'encoder' });
});

test('without nvidia-smi the monitor stays quiet', async () => {
    const gpu = createNvidiaMonitor({ command: '/nonexistent/nvidia-smi' });
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(gpu.sample(), null);
});
