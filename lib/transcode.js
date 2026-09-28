const { spawn } = require('child_process');
const fs = require('fs');
const { LIVE_EDGE_OFFSET } = require('./utils');
const { createGpuMonitor, createNvidiaMonitor, gpuVendor } = require('./gpu');

// Live H.264 -> HEVC conversion for Chromecasts, one HLS segment at a time.
//
// Cast receivers decode 4K only as HEVC/VP9/AV1, and some sources (Periscope/X
// broadcasts) offer 4K solely as H.264. The proxy can hand such a variant to a
// Chromecast by re-encoding every segment as it passes through: each 2-6s .ts
// segment starts on a keyframe, so it converts on its own, and the output keeps
// the source timestamps (tfdt) so consecutive segments join seamlessly.
//
// Output is fragmented MP4 — receivers only take HEVC over HLS in fMP4, not TS.
// The encoder produces the same init section (ftyp+moov) for every segment
// (only the informational audio bitrate differs), so a variant is served one
// shared #EXT-X-MAP, cut from whichever segment is converted first.
//
// Hardware only: a software 4K HEVC encode can't keep up with real time on the
// machines this runs on. VAAPI covers Intel (Arc, Quick Sync) and AMD GPUs on
// Linux, NVENC NVIDIA GPUs, and VideoToolbox Macs (running HomeCast natively).
// The Docker image's FFmpeg is Jellyfin's build, which has all of them.
//
// Environment:
//   TRANSCODE_ENCODER      auto (default) | vaapi | nvenc | videotoolbox | x265 | off
//   TRANSCODE_DEVICE       VAAPI render node (default: probe /dev/dri/renderD*)
//   TRANSCODE_BITRATE      highest video bitrate a segment gets (default 25M)
//   TRANSCODE_CONCURRENCY  simultaneous encodes (default 1)

// What the master playlist declares for a converted variant: HEVC Main,
// level 5.1 — enough for 2160p30, and what 4K Cast devices advertise.
const HEVC_CODEC = 'hvc1.1.6.L153.90';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// "8M", "8000k" or plain bits per second.
function parseBitrate(text) {
    const m = /^([\d.]+)\s*([kKmM]?)$/.exec(String(text).trim());
    if (!m) return null;
    return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
}
const MAX_BITRATE = parseBitrate(process.env.TRANSCODE_BITRATE || '25M') || 25e6;
const MIN_BITRATE = 1e6;
// Converting an already-compressed stream costs bits: the encoder has to
// reproduce the source's artifacts as well as its picture, so HEVC needs
// *more* than the H.264 it came from, not the half a fresh encode would.
// Measured on a 5.5 Mbps 4K Periscope stream (VMAF against the source): the
// 1080p variant upscaled scores 85; converted 4K at 0.8x the source 84.5,
// 2x 93, 4x 95, 7x 96. 4x is where it levels off. The network is a LAN.
const SOURCE_BITRATE_SHARE = 4;
// HEVC Main level 5.1, what the master playlist declares (HEVC_CODEC).
const LEVEL_MAX_BITRATE = 40e6;
// Encodes, not downloads (those overlap regardless). One at a time: an Arc,
// like most GPUs, has a single video engine, and two encodes only take turns
// on it — measured, a 2s 4K segment takes 0.65s alone but 1.5s each in a pair,
// for no more throughput and double the wait for the segment the receiver
// needs after a seek.
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '1', 10) || 1);
// Segments converted ahead of the one the receiver asked for.
const LOOKAHEAD = 3;
const JOB_TIMEOUT_MS = 30000;
const MAX_CACHED_SEGMENTS = 24; // ~5MB each at 4K/20Mbps/2s
const MAX_VARIANTS = 8;

// The working encoder once detect() has found one:
// { name, label, inputArgs, encodeArgs(bitrate), testArgs, device? }.
let encoder = null;
// Load on the GPU doing the encoding, where it can be read (lib/gpu.js).
let gpu = null;

function isAvailable() {
    return encoder !== null;
}

function encoderName() {
    return encoder?.name || null;
}

// --- Encoder profiles ---

const maxrate = bitrate => String(Math.round(Math.min(bitrate * 1.5, LEVEL_MAX_BITRATE)));

// Intel and AMD GPUs on Linux.
function vaapiProfile(device, lowPower) {
    const vendor = gpuVendor(device);
    return {
        name: `vaapi (${device}${lowPower ? ', low-power' : ''})`,
        label: `${vendor ? `${vendor} ` : ''}GPU (VAAPI), ${device.split('/').pop()}`,
        device,
        // Decode on the GPU too; `format=nv12|vaapi,hwupload` also covers
        // frames that fell back to software decoding.
        inputArgs: ['-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi'],
        encodeArgs: bitrate => [
            '-vf', 'format=nv12|vaapi,hwupload',
            '-c:v', 'hevc_vaapi', ...(lowPower ? ['-low_power', '1'] : []),
            '-b:v', String(bitrate), '-maxrate', maxrate(bitrate), '-bf', '0'
        ],
        // The self-test feeds generated frames, which need a device to upload to.
        testArgs: ['-vaapi_device', device]
    };
}

// NVIDIA GPUs. Decoded frames stay on the GPU; NVENC takes software-decoded
// ones too, should a stream fall back.
function nvencProfile() {
    return {
        name: 'nvenc',
        label: 'NVIDIA GPU (NVENC)',
        nvidia: true,
        inputArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
        encodeArgs: bitrate => [
            '-c:v', 'hevc_nvenc', '-preset', 'p4', '-rc', 'vbr',
            '-b:v', String(bitrate), '-maxrate', maxrate(bitrate), '-bf', '0'
        ],
        testArgs: []
    };
}

function videotoolboxProfile() {
    return {
        name: 'videotoolbox',
        label: 'Apple VideoToolbox',
        inputArgs: ['-hwaccel', 'videotoolbox'],
        encodeArgs: bitrate => ['-c:v', 'hevc_videotoolbox', '-b:v', String(bitrate), '-bf', '0'],
        testArgs: []
    };
}

// Software encoding: far too slow for 4K in real time, so never picked
// automatically — it exists to exercise the pipeline where there is no GPU.
function x265Profile() {
    return {
        name: 'x265 (software)',
        label: 'Software (x265)',
        inputArgs: [],
        encodeArgs: bitrate => ['-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', String(bitrate), '-bf', '0', '-x265-params', 'log-level=error'],
        testArgs: []
    };
}

// TRANSCODE_DEVICE may name the node the way intel_gpu_top lists it
// ("renderD129") rather than by path; ffmpeg needs the path.
function renderNodePath(device) {
    return device.includes('/') ? device : `/dev/dri/${device}`;
}

// The container runs unprivileged, so a render node passed through without
// its host group is visible but unusable — and ffmpeg's own error for that
// says nothing about permissions.
function canOpenRenderNode(device) {
    try {
        fs.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log(`[Transcode] ${device} does not exist — is /dev/dri passed through to the container?`);
        } else {
            console.log(`[Transcode] No permission to use ${device} (${e.code}). Add the group that owns it on the host ` +
                `to the container (docker-compose: group_add; find it with: stat -c %g ${device}).`);
        }
        return false;
    }
}

function candidateProfiles() {
    const wanted = (process.env.TRANSCODE_ENCODER || 'auto').toLowerCase();
    if (wanted === 'off') return [];

    const profiles = [];
    if (wanted === 'auto' || wanted === 'vaapi') {
        let devices = process.env.TRANSCODE_DEVICE ? [renderNodePath(process.env.TRANSCODE_DEVICE)] : [];
        if (devices.length === 0) {
            try {
                devices = fs.readdirSync('/dev/dri')
                    .filter(n => n.startsWith('renderD'))
                    .sort()
                    .map(renderNodePath);
            } catch { /* no GPU nodes */ }
        }
        // Arc only encodes HEVC through the low-power (VDEnc) entrypoint;
        // older Intel and AMD parts only through the regular one. NVIDIA's
        // render node has no VAAPI encoder: that's NVENC's, below.
        for (const d of devices.filter(d => gpuVendor(d) !== 'NVIDIA').filter(canOpenRenderNode)) {
            profiles.push(vaapiProfile(d, false), vaapiProfile(d, true));
        }
    }
    // Only where an NVIDIA GPU is passed through, so other hosts don't log a
    // failed NVENC check.
    if ((wanted === 'auto' && fs.existsSync('/dev/nvidiactl')) || wanted === 'nvenc') {
        profiles.push(nvencProfile());
    }
    if ((wanted === 'auto' && process.platform === 'darwin') || wanted === 'videotoolbox') {
        profiles.push(videotoolboxProfile());
    }
    if (wanted === 'x265') profiles.push(x265Profile());
    return profiles;
}

// --- Running ffmpeg ---

// Run ffmpeg with `input` on stdin; resolves to stdout. Rejects with the tail
// of stderr on failure.
function runFfmpeg(args, input, timeoutMs = JOB_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        const out = [];
        let err = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
        proc.stdout.on('data', c => out.push(c));
        proc.stderr.on('data', c => { err = (err + c).slice(-2000); });
        proc.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        proc.on('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve(Buffer.concat(out));
            reject(new Error(signal ? `ffmpeg killed (${signal})` : `ffmpeg exited ${code}: ${err.trim().split('\n').pop()}`));
        });
        // ffmpeg may exit before reading all of stdin (e.g. a bad device);
        // that error surfaces through 'close' instead.
        proc.stdin.on('error', () => {});
        proc.stdin.end(input || undefined);
    });
}

// Find the first profile that actually encodes a frame on this machine.
async function detect() {
    for (const profile of candidateProfiles()) {
        try {
            await runFfmpeg([
                '-hide_banner', '-loglevel', 'error', ...profile.testArgs,
                '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.2',
                ...profile.encodeArgs(MAX_BITRATE), '-f', 'null', '-'
            ], null, 15000);
            encoder = profile;
            gpu = profile.nvidia ? createNvidiaMonitor()
                : profile.device ? createGpuMonitor(profile.device) : null;
            const onGpu = profile.nvidia || profile.device;
            console.log(`[Transcode] HEVC conversion available via ${profile.label}` +
                (onGpu ? (gpu ? ' (GPU load readable)' : ' (GPU load not readable)') : ''));
            return true;
        } catch (e) {
            if (e.code === 'ENOENT') {
                console.log('[Transcode] ffmpeg not found — 4K conversion for Chromecast disabled');
                return false;
            }
            console.log(`[Transcode] ${profile.name} unusable: ${e.message}`);
        }
    }
    console.log('[Transcode] No hardware HEVC encoder — 4K conversion for Chromecast disabled');
    return false;
}

function ffmpegArgs(profile, bitrate) {
    return [
        '-hide_banner', '-loglevel', 'error',
        ...profile.inputArgs,
        // Keep the source timestamps: they are what lets segments converted
        // independently line up on the receiver.
        '-copyts', '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?',
        ...profile.encodeArgs(bitrate), '-tag:v', 'hvc1',
        '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc',
        '-f', 'mp4',
        // frag_discont + no negative-ts shifting + no edit list: tfdt carries
        // the real decode time instead of restarting at 0 in every segment.
        // delay_moov: the AAC config (AudioSpecificConfig) only exists once
        // aac_adtstoasc has seen a packet; written up front, the init's esds
        // lacks it and Cast receivers reject the stream (LOAD_FAILED).
        '-movflags', '+frag_keyframe+empty_moov+delay_moov+default_base_moof+frag_discont+skip_trailer',
        '-avoid_negative_ts', 'disabled', '-use_editlist', '0',
        '-video_track_timescale', '90000',
        'pipe:1'
    ];
}

// --- fMP4 helpers ---

// Split a fragmented MP4 into its init section (everything before the first
// moof) and the media fragments. Returns null if there is no moof.
function splitInit(mp4) {
    let offset = 0;
    while (offset + 8 <= mp4.length) {
        let size = mp4.readUInt32BE(offset);
        const type = mp4.toString('latin1', offset + 4, offset + 8);
        if (size === 1 && offset + 16 <= mp4.length) size = Number(mp4.readBigUInt64BE(offset + 8));
        if (type === 'moof') return { init: mp4.subarray(0, offset), media: mp4.subarray(offset) };
        if (size < 8) break;
        offset += size;
    }
    return null;
}

// --- Jobs ---

// Conversions queue behind a small pool: the GPU copes with a few at once, and
// unbounded parallel 4K encodes would only make every one of them late.
// A segment the receiver is waiting for goes ahead of ones converted on spec.
let running = 0;
const waiting = []; // queued jobs: { url, urgent, start, cancel }

// Run `fn` when an encode slot is free. `entry` ({ url, urgent }) gains
// start() and cancel(err); a cancelled entry leaves the queue unrun.
function withSlot(entry, fn) {
    return new Promise((resolve, reject) => {
        entry.start = () => {
            running++;
            fn().then(resolve, reject).finally(() => {
                running--;
                waiting.shift()?.start();
            });
        };
        entry.cancel = (err) => {
            const i = waiting.indexOf(entry);
            if (i !== -1) waiting.splice(i, 1);
            reject(err);
        };
        if (running < CONCURRENCY) entry.start();
        else if (entry.urgent) waiting.unshift(entry);
        else waiting.push(entry);
    });
}

// Move a queued conversion to the front: the receiver has asked for it.
function promote(url) {
    const i = waiting.findIndex(w => w.url === url);
    if (i === -1) return;
    const [entry] = waiting.splice(i, 1);
    entry.urgent = true;
    waiting.unshift(entry);
}

// segment URL -> Promise<{ init, media }>, oldest first.
const jobs = new Map();
// Segments whose conversion has finished (and is still in `jobs`).
const ready = new Set();
// variant playlist URL -> { segments: [url], durations: [s], init, startIndex, stats }.
const variants = new Map();

function remember(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
        ready.delete(oldest);
    }
}

// The variant playlist a segment was listed in, if any, and its position.
function variantOf(segmentUrl) {
    for (const [url, variant] of variants) {
        const index = variant.segments.indexOf(segmentUrl);
        if (index !== -1) return { url, variant, index };
    }
    return null;
}

// Bitrate to encode a segment at: a share of what the source spent on it,
// within [MIN_BITRATE, MAX_BITRATE]. The cap alone when its length is unknown.
function targetBitrate(sourceBytes, seconds) {
    if (!(seconds > 0)) return MAX_BITRATE;
    const source = (sourceBytes * 8) / seconds;
    return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, source * SOURCE_BITRATE_SHARE)));
}

// The last few encodes, for the dashboard's speed: { start, end, seconds }.
const recentEncodes = [];
const RECENT_ENCODES = 8;

// Seconds of video converted per second of wall time, over the recent
// encodes. Overlapping encodes count their shared time once, and time with
// no encode running (the converter waiting, well ahead) not at all.
function throughput() {
    if (recentEncodes.length === 0) return null;
    const spans = [...recentEncodes].sort((a, b) => a.start - b.start);
    let busyMs = 0;
    let [from, to] = [spans[0].start, spans[0].end];
    for (const { start, end } of spans.slice(1)) {
        if (start > to) {
            busyMs += to - from;
            [from, to] = [start, end];
        } else {
            to = Math.max(to, end);
        }
    }
    busyMs += to - from;
    const seconds = recentEncodes.reduce((sum, e) => sum + e.seconds, 0);
    return busyMs > 0 && seconds > 0 ? seconds / (busyMs / 1000) : null;
}

function newStats() {
    return { segments: 0, mediaSeconds: 0, sourceBits: 0, outputBits: 0, last: null };
}

// Convert one segment (or join the conversion already under way).
// `fetchSegment(url, signal)` resolves to the source bytes. `urgent`: the
// receiver is waiting for this one.
function convertSegment(segmentUrl, fetchSegment, urgent = false) {
    if (!encoder) return Promise.reject(new Error('No HEVC encoder available'));
    const existing = jobs.get(segmentUrl);
    if (existing) {
        if (urgent) promote(segmentUrl);
        return existing;
    }

    // Downloads run outside the queue, so the next segments arrive while the
    // encoder is still busy; only the encode waits for a slot.
    const abort = new AbortController();
    const download = fetchSegment(segmentUrl, abort.signal);
    download.catch(() => {}); // the job below reports it
    const entry = { url: segmentUrl, urgent, abort };
    const job = withSlot(entry, async () => {
        const source = await download;
        const found = variantOf(segmentUrl);
        const seconds = found?.variant.durations[found.index] || 0;
        const bitrate = targetBitrate(source.length, seconds);

        const encodeStarted = Date.now();
        const output = await runFfmpeg(ffmpegArgs(encoder, bitrate), source);
        const encodeMs = Date.now() - encodeStarted;
        if (seconds > 0) {
            recentEncodes.push({ start: encodeStarted, end: encodeStarted + encodeMs, seconds });
            if (recentEncodes.length > RECENT_ENCODES) recentEncodes.shift();
        }
        const parts = splitInit(output);
        if (!parts || parts.media.length === 0) throw new Error('ffmpeg produced no media fragments');

        if (found) {
            if (!found.variant.init) found.variant.init = parts.init;
            const stats = found.variant.stats;
            stats.segments++;
            stats.mediaSeconds += seconds;
            stats.sourceBits += source.length * 8;
            stats.outputBits += parts.media.length * 8;
            stats.last = { encodeMs, seconds, bitrate, sourceBytes: source.length, outputBytes: parts.media.length };
        }

        const name = segmentUrl.substring(segmentUrl.lastIndexOf('/') + 1).split('?')[0];
        console.log(`[Transcode] ${name}: ${(source.length / 1e6).toFixed(1)}MB H.264 -> ${(parts.media.length / 1e6).toFixed(1)}MB HEVC ` +
            `at ${(bitrate / 1e6).toFixed(1)} Mbps in ${encodeMs}ms`);
        return parts;
    });
    remember(jobs, segmentUrl, job, MAX_CACHED_SEGMENTS);
    job.then(() => ready.add(segmentUrl), () => {
        jobs.delete(segmentUrl);
        ready.delete(segmentUrl);
    });
    return job;
}

// Start converting the segments from `index` on, so they are ready (or close)
// by the time the receiver asks. Receivers buffer several segments before
// they start playing, so one ahead is not enough.
function convertAhead(variant, index, fetchSegment) {
    for (const url of variant.segments.slice(index, index + LOOKAHEAD)) {
        if (!jobs.has(url)) convertSegment(url, fetchSegment).catch(() => {});
    }
}

// The receiver is now at `index`: queued conversions of this variant that it
// no longer needs (after a seek, or guesses about where it would start) are
// dropped, downloads included, so they don't hold up the ones it does.
function dropStale(variant, index) {
    for (const entry of [...waiting]) {
        if (entry.urgent) continue;
        const i = variant.segments.indexOf(entry.url);
        if (i === -1 || (i >= index && i <= index + LOOKAHEAD)) continue;
        entry.abort.abort();
        entry.cancel(new Error('No longer needed'));
    }
}

// A converted media segment. Resolves to the moof+mdat fragments.
async function getSegment(segmentUrl, fetchSegment) {
    const found = variantOf(segmentUrl);
    if (found) dropStale(found.variant, found.index);
    const job = convertSegment(segmentUrl, fetchSegment, true);
    if (found) {
        found.variant.position = found.index;
        convertAhead(found.variant, found.index + 1, fetchSegment);
    }
    return (await job).media;
}

// The shared init section for a variant: the one already cut, or the one from
// whichever of its conversions finishes first — noteVariant started those.
async function getInit(variantUrl, fetchSegment) {
    const variant = variants.get(variantUrl);
    if (!variant) throw new Error('Unknown variant playlist');
    if (variant.init) return variant.init;

    const started = variant.segments.map(url => jobs.get(url)).filter(Boolean);
    if (started.length === 0) {
        const segment = variant.segments[variant.startIndex];
        if (!segment) throw new Error('Variant playlist lists no segments');
        started.push(convertSegment(segment, fetchSegment, true));
    }
    const { init } = await Promise.any(started);
    return variant.init || init;
}

// Where a receiver starts in a media playlist: a recording from the top, a
// live one LIVE_EDGE_OFFSET seconds short of its newest segment (where the
// cast asks it to start, see lib/cast.js).
function startIndex(segments, live) {
    if (!live) return 0;
    let fromEnd = 0;
    for (let i = segments.length - 1; i >= 0; i--) {
        fromEnd += segments[i].duration;
        if (fromEnd >= LIVE_EDGE_OFFSET) return i;
    }
    return 0;
}

// Record the segments a variant playlist currently lists ([{ url, duration }],
// absolute URLs). The first time a variant is seen, a receiver is about to
// start on it: start converting where it will begin, before it asks.
function noteVariant(variantUrl, segments, { live, fetchSegment }) {
    const known = variants.get(variantUrl);
    const variant = {
        segments: segments.map(s => s.url),
        durations: segments.map(s => s.duration),
        init: known?.init || null,
        startIndex: startIndex(segments, live),
        position: known?.position ?? null,
        stats: known?.stats || newStats()
    };
    remember(variants, variantUrl, variant, MAX_VARIANTS);
    if (!known && encoder) convertAhead(variant, variant.startIndex, fetchSegment);
}

// How the conversion of the variant `segmentUrl` belongs to is going, for the
// dashboard. Null when the segment isn't part of a converted variant.
function statsFor(segmentUrl) {
    const found = variantOf(segmentUrl);
    if (!found) return null;
    const { variant } = found;
    const { stats } = variant;
    let ahead = 0;
    for (let i = found.index + 1; i < variant.segments.length && ready.has(variant.segments[i]); i++) ahead++;
    return {
        encoder: encoder?.label || null,
        segments: stats.segments,
        // Above 1, conversion keeps ahead of playback.
        speed: throughput(),
        lastEncodeMs: stats.last?.encodeMs ?? null,
        lastSegmentSeconds: stats.last?.seconds ?? null,
        sourceKbps: stats.mediaSeconds > 0 ? Math.round(stats.sourceBits / stats.mediaSeconds / 1000) : null,
        outputKbps: stats.mediaSeconds > 0 ? Math.round(stats.outputBits / stats.mediaSeconds / 1000) : null,
        targetKbps: stats.last ? Math.round(stats.last.bitrate / 1000) : null,
        readyAhead: ahead,
        queued: waiting.length,
        running,
        gpu: gpu?.sample() || null
    };
}

// --- Playlists ---

// Whether a media playlist's segments can be converted: MPEG-TS only (an fMP4
// segment can't be decoded without its init section) and unencrypted.
function canConvertMediaPlaylist(m3u8) {
    return !/#EXT-X-MAP:/i.test(m3u8) && !/#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(m3u8);
}

// Rewrite a (source) media playlist for conversion: an #EXT-X-MAP for the
// shared init section ahead of the first segment, and a version that allows it.
function addInitMap(m3u8, initUrl) {
    const lines = m3u8.split('\n');
    const first = lines.findIndex(l => /^#EXTINF/i.test(l.trim()));
    if (first === -1) return m3u8;
    lines.splice(first, 0, `#EXT-X-MAP:URI="${initUrl}"`);
    const out = lines.join('\n');
    if (/#EXT-X-VERSION:/i.test(out)) {
        return out.replace(/#EXT-X-VERSION:(\d+)/i, (m, v) => `#EXT-X-VERSION:${Math.max(6, parseInt(v, 10))}`);
    }
    return out.replace(/^#EXTM3U/, '#EXTM3U\n#EXT-X-VERSION:6');
}

// Declare the converted codec for the variant a master playlist kept: its
// H.264 entry in CODECS becomes HEVC, the audio entry stays.
function declareHevc(masterM3u8) {
    return masterM3u8.replace(/(#EXT-X-STREAM-INF:[^\n]*CODECS=")([^"]*)(")/gi, (m, pre, codecs, post) =>
        pre + codecs.split(',').map(c => (/^(avc1|avc3)\./i.test(c.trim()) ? HEVC_CODEC : c)).join(',') + post);
}

// Test seam.
function reset() {
    encoder = null;
    gpu = null;
    jobs.clear();
    ready.clear();
    variants.clear();
    waiting.length = 0;
    recentEncodes.length = 0;
}

module.exports = {
    HEVC_CODEC,
    detect,
    isAvailable,
    encoderName,
    getSegment,
    getInit,
    noteVariant,
    statsFor,
    targetBitrate,
    splitInit,
    canConvertMediaPlaylist,
    addInitMap,
    declareHevc,
    reset,
    runFfmpeg
};
