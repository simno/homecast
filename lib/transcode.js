const { spawn } = require('child_process');
const fs = require('fs');

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
//   TRANSCODE_CONCURRENCY  simultaneous conversions (default 2)

// What the master playlist declares for a converted variant: HEVC Main,
// level 5.1 — enough for 2160p30, and what 4K Cast devices advertise.
const HEVC_CODEC = 'hvc1.1.6.L153.90';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const BITRATE = process.env.TRANSCODE_BITRATE || '8M';
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '2', 10) || 2);
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
        inputArgs: [],
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

function candidateProfiles() {
    const wanted = (process.env.TRANSCODE_ENCODER || 'auto').toLowerCase();
    if (wanted === 'off') return [];

    const profiles = [];
    if (wanted === 'auto' || wanted === 'vaapi') {
        let devices = process.env.TRANSCODE_DEVICE ? [process.env.TRANSCODE_DEVICE] : [];
        if (devices.length === 0) {
            try {
                devices = fs.readdirSync('/dev/dri')
                    .filter(n => n.startsWith('renderD'))
                    .sort()
                    .map(n => `/dev/dri/${n}`);
            } catch { /* no GPU nodes */ }
        }
        // Arc only encodes HEVC through the low-power (VDEnc) entrypoint;
        // older Intel and AMD parts only through the regular one.
        for (const d of devices) profiles.push(vaapiProfile(d, false), vaapiProfile(d, true));
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
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof+frag_discont+skip_trailer',
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
let running = 0;
const waiting = [];

async function withSlot(fn) {
    if (running >= CONCURRENCY) await new Promise(resolve => waiting.push(resolve));
    running++;
    try {
        return await fn();
    } finally {
        running--;
        waiting.shift()?.();
    }
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
// `fetchSegment(url)` resolves to the source bytes.
function convertSegment(segmentUrl, fetchSegment) {
    if (!encoder) return Promise.reject(new Error('No HEVC encoder available'));
    const existing = jobs.get(segmentUrl);
    if (existing) return existing;

    const job = withSlot(async () => {
        const started = Date.now();
        const source = await fetchSegment(segmentUrl);
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

// Start converting the segment after this one, so it is ready (or close) by
// the time the receiver asks for it.
function prefetchNext(segmentUrl, fetchSegment) {
    const found = variantOf(segmentUrl);
    if (!found) return;
    const next = found.variant.segments[found.variant.segments.indexOf(segmentUrl) + 1];
    if (next && !jobs.has(next)) convertSegment(next, fetchSegment).catch(() => {});
}

// A converted media segment. Resolves to the moof+mdat fragments.
async function getSegment(segmentUrl, fetchSegment) {
    const job = convertSegment(segmentUrl, fetchSegment);
    prefetchNext(segmentUrl, fetchSegment);
    return (await job).media;
}

// The shared init section for a variant: the one already cut, or one cut from
// the newest listed segment — the one a live receiver is about to fetch anyway.
async function getInit(variantUrl, fetchSegment) {
    const variant = variants.get(variantUrl);
    if (!variant) throw new Error('Unknown variant playlist');
    if (variant.init) return variant.init;
    const segment = variant.segments[variant.segments.length - 1];
    if (!segment) throw new Error('Variant playlist lists no segments');
    const { init } = await convertSegment(segment, fetchSegment);
    return variant.init || init;
}

// Record the segments a variant playlist currently lists (absolute URLs).
function noteVariant(variantUrl, segmentUrls) {
    const init = variants.get(variantUrl)?.init || null;
    remember(variants, variantUrl, { segments: segmentUrls, init }, MAX_VARIANTS);
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
