const { spawn } = require('child_process');
const fs = require('fs');
const { LIVE_EDGE_OFFSET } = require('./utils');

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
// Linux; VideoToolbox is there for development on a Mac.
//
// Environment:
//   TRANSCODE_ENCODER      auto (default) | vaapi | videotoolbox | x265 | off
//   TRANSCODE_DEVICE       VAAPI render node (default: probe /dev/dri/renderD*)
//   TRANSCODE_BITRATE      target video bitrate (default 8M)
//   TRANSCODE_CONCURRENCY  simultaneous encodes (default 2)

// What the master playlist declares for a converted variant: HEVC Main,
// level 5.1 — enough for 2160p30, and what 4K Cast devices advertise.
const HEVC_CODEC = 'hvc1.1.6.L153.90';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BITRATE = process.env.TRANSCODE_BITRATE || '8M';
// Encodes, not downloads: a GPU has one or two video engines, and parallel
// encodes beyond that only slow each other down.
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '2', 10) || 2);
// Segments converted ahead of the one the receiver asked for.
const LOOKAHEAD = 3;
const JOB_TIMEOUT_MS = 30000;
const MAX_CACHED_SEGMENTS = 24; // ~2MB each at 4K/8Mbps/2s
const MAX_VARIANTS = 8;

// The working encoder once detect() has found one: { name, inputArgs, encodeArgs }.
let encoder = null;

function isAvailable() {
    return encoder !== null;
}

function encoderName() {
    return encoder?.name || null;
}

// --- Encoder profiles ---

function vaapiProfile(device, lowPower) {
    return {
        name: `vaapi (${device}${lowPower ? ', low-power' : ''})`,
        // Decode on the GPU too; `format=nv12|vaapi,hwupload` also covers
        // frames that fell back to software decoding.
        inputArgs: ['-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi'],
        encodeArgs: [
            '-vf', 'format=nv12|vaapi,hwupload',
            '-c:v', 'hevc_vaapi', ...(lowPower ? ['-low_power', '1'] : []),
            '-b:v', BITRATE, '-maxrate', BITRATE, '-bf', '0'
        ],
        // The self-test feeds generated frames, which need a device to upload to.
        testArgs: ['-vaapi_device', device]
    };
}

function videotoolboxProfile() {
    return {
        name: 'videotoolbox',
        inputArgs: ['-hwaccel', 'videotoolbox'],
        encodeArgs: ['-c:v', 'hevc_videotoolbox', '-b:v', BITRATE, '-bf', '0'],
        testArgs: []
    };
}

// Software encoding: far too slow for 4K in real time, so never picked
// automatically — it exists to exercise the pipeline where there is no GPU.
function x265Profile() {
    return {
        name: 'x265 (software)',
        inputArgs: [],
        encodeArgs: ['-c:v', 'libx265', '-preset', 'ultrafast', '-b:v', BITRATE, '-bf', '0', '-x265-params', 'log-level=error'],
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
        // older Intel and AMD parts only through the regular one.
        for (const d of devices.filter(canOpenRenderNode)) {
            profiles.push(vaapiProfile(d, false), vaapiProfile(d, true));
        }
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
                ...profile.encodeArgs, '-f', 'null', '-'
            ], null, 15000);
            encoder = profile;
            console.log(`[Transcode] HEVC conversion available via ${profile.name}`);
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

function ffmpegArgs(profile) {
    return [
        '-hide_banner', '-loglevel', 'error',
        ...profile.inputArgs,
        // Keep the source timestamps: they are what lets segments converted
        // independently line up on the receiver.
        '-copyts', '-f', 'mpegts', '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?',
        ...profile.encodeArgs, '-tag:v', 'hvc1',
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
const waiting = []; // [{ url, start }]

function withSlot(url, urgent, fn) {
    return new Promise((resolve, reject) => {
        const start = () => {
            running++;
            fn().then(resolve, reject).finally(() => {
                running--;
                waiting.shift()?.start();
            });
        };
        if (running < CONCURRENCY) start();
        else if (urgent) waiting.unshift({ url, start });
        else waiting.push({ url, start });
    });
}

// Move a queued conversion to the front: the receiver has asked for it.
function promote(url) {
    const i = waiting.findIndex(w => w.url === url);
    if (i > 0) waiting.unshift(...waiting.splice(i, 1));
}

// segment URL -> Promise<{ init, media }>, oldest first.
const jobs = new Map();
// variant playlist URL -> { segments: [url], init: Buffer|null }, oldest first.
const variants = new Map();

function remember(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
}

// The variant playlist a segment was listed in, if any.
function variantOf(segmentUrl) {
    for (const [url, v] of variants) {
        if (v.segments.includes(segmentUrl)) return { url, variant: v };
    }
    return null;
}

// Convert one segment (or join the conversion already under way).
// `fetchSegment(url)` resolves to the source bytes. `urgent`: the receiver is
// waiting for this one.
function convertSegment(segmentUrl, fetchSegment, urgent = false) {
    if (!encoder) return Promise.reject(new Error('No HEVC encoder available'));
    const existing = jobs.get(segmentUrl);
    if (existing) {
        if (urgent) promote(segmentUrl);
        return existing;
    }

    // Downloads run outside the queue, so the next segments arrive while the
    // encoder is still busy; only the encode waits for a slot.
    const started = Date.now();
    const download = fetchSegment(segmentUrl);
    download.catch(() => {}); // the job below reports it
    const job = withSlot(segmentUrl, urgent, async () => {
        const source = await download;
        const output = await runFfmpeg(ffmpegArgs(encoder), source);
        const parts = splitInit(output);
        if (!parts || parts.media.length === 0) throw new Error('ffmpeg produced no media fragments');

        const found = variantOf(segmentUrl);
        if (found && !found.variant.init) found.variant.init = parts.init;

        const name = segmentUrl.substring(segmentUrl.lastIndexOf('/') + 1).split('?')[0];
        console.log(`[Transcode] ${name}: ${(source.length / 1e6).toFixed(1)}MB H.264 -> ${(parts.media.length / 1e6).toFixed(1)}MB HEVC in ${Date.now() - started}ms`);
        return parts;
    });
    remember(jobs, segmentUrl, job, MAX_CACHED_SEGMENTS);
    job.catch(() => jobs.delete(segmentUrl));
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

// A converted media segment. Resolves to the moof+mdat fragments.
async function getSegment(segmentUrl, fetchSegment) {
    const job = convertSegment(segmentUrl, fetchSegment, true);
    const found = variantOf(segmentUrl);
    if (found) convertAhead(found.variant, found.variant.segments.indexOf(segmentUrl) + 1, fetchSegment);
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
        init: known?.init || null,
        startIndex: startIndex(segments, live)
    };
    remember(variants, variantUrl, variant, MAX_VARIANTS);
    if (!known && encoder) convertAhead(variant, variant.startIndex, fetchSegment);
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
    jobs.clear();
    variants.clear();
    waiting.length = 0;
}

module.exports = {
    HEVC_CODEC,
    detect,
    isAvailable,
    encoderName,
    getSegment,
    getInit,
    noteVariant,
    splitInit,
    canConvertMediaPlaylist,
    addInitMap,
    declareHevc,
    reset
};
