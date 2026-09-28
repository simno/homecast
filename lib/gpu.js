const fs = require('fs');
const path = require('path');

// GPU load for the dashboard while streams are converted: the share of time
// the GPU spent out of its idle power state (RC6) since the last look, and
// its current clock. Read from the kernel's counters in /sys, which need no
// privileges — intel_gpu_top's per-engine figures need root.
//
// Intel only (i915, and xe on newer kernels); null anywhere these counters
// don't exist (a Mac, AMD, a container without /sys).

const MIN_SAMPLE_MS = 1000;

function readNumber(file) {
    try {
        const n = parseFloat(fs.readFileSync(file, 'utf8'));
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

// The DRM card directory behind a render node: /dev/dri/renderD129 ->
// /sys/class/drm/card1 (the Arc, when an iGPU is card0). `sysRoot`: a test seam.
function cardDir(renderNode, sysRoot = '/sys/class/drm') {
    const node = path.basename(renderNode);
    try {
        const card = fs.readdirSync(`${sysRoot}/${node}/device/drm`).find(n => /^card\d+$/.test(n));
        return card ? `${sysRoot}/${card}` : null;
    } catch {
        return null;
    }
}

// Where this driver keeps the idle-residency counter (ms) and actual clock (MHz).
function counterFiles(card) {
    const candidates = [
        { idle: `${card}/gt/gt0/rc6_residency_ms`, freq: `${card}/gt/gt0/rps_act_freq_mhz` }, // i915
        { idle: `${card}/power/rc6_residency_ms`, freq: `${card}/gt_act_freq_mhz` }, // i915, older kernels
        { idle: `${card}/device/tile0/gt0/gtidle/idle_residency_ms`, freq: `${card}/device/tile0/gt0/freq0/act_freq` } // xe
    ];
    return candidates.find(c => readNumber(c.idle) !== null) || null;
}

// A sampler for the GPU behind `renderNode`, or null if it can't be read.
// sample() returns { busyPercent, clockMhz }, refreshed at most once a second.
function createGpuMonitor(renderNode, { sysRoot } = {}) {
    const card = cardDir(renderNode, sysRoot);
    const files = card && counterFiles(card);
    if (!files) return null;

    let previous = { idleMs: readNumber(files.idle), at: Date.now() };
    let latest = { busyPercent: null, clockMhz: readNumber(files.freq) };

    return {
        sample() {
            const now = Date.now();
            if (now - previous.at < MIN_SAMPLE_MS) return latest;
            const idleMs = readNumber(files.idle);
            if (idleMs === null) return latest;
            const idleShare = (idleMs - previous.idleMs) / (now - previous.at);
            latest = {
                busyPercent: Math.round(Math.min(100, Math.max(0, (1 - idleShare) * 100))),
                clockMhz: readNumber(files.freq)
            };
            previous = { idleMs, at: now };
            return latest;
        }
    };
}

module.exports = { createGpuMonitor, cardDir };
