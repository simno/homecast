const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// GPU load for the dashboard while streams are converted, from what each
// vendor's driver makes readable without privileges:
//
//   Intel (i915, xe)  the share of time out of the idle power state (RC6) —
//                     the whole GPU, video engines included
//   AMD (amdgpu)      gpu_busy_percent — the graphics engine; the video engine
//                     (VCN) that encodes isn't in it, so it reads low
//   NVIDIA            nvidia-smi's encoder utilisation — the NVENC engine itself
//
// sample() returns { busyPercent, clockMhz, measures: 'gpu' | 'graphics' | 'encoder' }.
// Null anywhere none of these can be read (a Mac, a container without /sys).

const MIN_SAMPLE_MS = 1000;
const NVIDIA_SAMPLE_MS = 2000;

const VENDORS = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA' };

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function readNumber(file) {
    const n = parseFloat(readText(file));
    return Number.isFinite(n) ? n : null;
}

// 'Intel', 'AMD', 'NVIDIA' or null, from the PCI vendor ID behind a render node.
function gpuVendor(renderNode, sysRoot = '/sys/class/drm') {
    const id = readText(`${sysRoot}/${path.basename(renderNode)}/device/vendor`)?.trim().toLowerCase();
    return VENDORS[id] || null;
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

// Intel: idle-residency counter (ms, cumulative), and the actual and requested
// clocks (MHz). The actual clock reads 0 whenever the GPU happens to be idle
// at that instant — between two segment encodes, say — so the requested one
// stands in then.
function intelFiles(card) {
    const candidates = [
        { idle: `${card}/gt/gt0/rc6_residency_ms`, freq: `${card}/gt/gt0/rps_act_freq_mhz`, cur: `${card}/gt/gt0/rps_cur_freq_mhz` }, // i915
        { idle: `${card}/power/rc6_residency_ms`, freq: `${card}/gt_act_freq_mhz`, cur: `${card}/gt_cur_freq_mhz` }, // i915, older kernels
        { idle: `${card}/device/tile0/gt0/gtidle/idle_residency_ms`, freq: `${card}/device/tile0/gt0/freq0/act_freq`, cur: `${card}/device/tile0/gt0/freq0/cur_freq` } // xe
    ];
    return candidates.find(c => readNumber(c.idle) !== null) || null;
}

function intelMonitor(files) {
    const clock = () => readNumber(files.freq) || readNumber(files.cur);
    let previous = { idleMs: readNumber(files.idle), at: Date.now() };
    let latest = { busyPercent: null, clockMhz: clock(), measures: 'gpu' };
    return {
        sample() {
            const now = Date.now();
            if (now - previous.at < MIN_SAMPLE_MS) return latest;
            const idleMs = readNumber(files.idle);
            if (idleMs === null) return latest;
            const idleShare = (idleMs - previous.idleMs) / (now - previous.at);
            latest = {
                busyPercent: Math.round(Math.min(100, Math.max(0, (1 - idleShare) * 100))),
                clockMhz: clock(),
                measures: 'gpu'
            };
            previous = { idleMs, at: now };
            return latest;
        }
    };
}

// AMD: busy percent directly, and the active shader clock — the line marked
// '*' in pp_dpm_sclk ("1: 2100Mhz *").
function amdMonitor(card) {
    const busy = `${card}/device/gpu_busy_percent`;
    if (readNumber(busy) === null) return null;
    const clock = () => {
        const active = readText(`${card}/device/pp_dpm_sclk`)?.split('\n').find(l => l.includes('*'));
        const m = active && /(\d+)\s*Mhz/i.exec(active);
        return m ? parseInt(m[1], 10) : null;
    };
    return {
        sample: () => ({ busyPercent: readNumber(busy), clockMhz: clock(), measures: 'graphics' })
    };
}

// A sampler for the GPU behind `renderNode` (Intel or AMD), or null.
function createGpuMonitor(renderNode, { sysRoot } = {}) {
    const card = cardDir(renderNode, sysRoot);
    if (!card) return null;
    const intel = intelFiles(card);
    return intel ? intelMonitor(intel) : amdMonitor(card);
}

// "45, 1530" (encoder %, video clock MHz) from nvidia-smi.
function parseNvidiaSmi(output) {
    const [encoder, clock] = String(output).trim().split('\n')[0].split(',').map(v => parseFloat(v));
    if (!Number.isFinite(encoder)) return null;
    return { busyPercent: Math.round(encoder), clockMhz: Number.isFinite(clock) ? clock : null, measures: 'encoder' };
}

// NVIDIA: nvidia-smi, asked in the background at most every two seconds;
// sample() returns the latest answer. Null until it has answered once — and
// for good if it isn't there (the container needs the 'utility' capability).
function createNvidiaMonitor({ command = 'nvidia-smi' } = {}) {
    let latest = null;
    let askedAt = 0;
    let broken = false;
    const ask = () => {
        askedAt = Date.now();
        execFile(command, ['--query-gpu=utilization.encoder,clocks.video', '--format=csv,noheader,nounits'],
            { timeout: 3000 }, (err, stdout) => {
                if (err) {
                    if (err.code === 'ENOENT') broken = true;
                    return;
                }
                latest = parseNvidiaSmi(stdout) || latest;
            });
    };
    ask();
    return {
        sample() {
            if (!broken && Date.now() - askedAt >= NVIDIA_SAMPLE_MS) ask();
            return latest;
        }
    };
}

module.exports = { createGpuMonitor, createNvidiaMonitor, parseNvidiaSmi, gpuVendor, cardDir };
