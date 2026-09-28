// Frame-rate header repair for H.264 HLS segments (MPEG-TS).
//
// An H.264 stream can declare its frame rate in the SPS (VUI timing info).
// Some sources get it badly wrong: X/Periscope broadcasts declare
// num_units_in_tick=1, time_scale=2000 — 1000 fps — for 29.97 fps video. Cast
// receivers ignore that, but LG's webOS player sets its pipeline up from it and
// plays the stream visibly choppy. Rewriting just those two fields (no
// re-encode) makes it play smoothly.
//
// A segment is only touched when the declared rate disagrees with the one its
// timestamps show; a correct or undeclared rate passes through untouched.
//
// The header is rewritten in place: every SPS in the segment gets the new
// values, and when the rewritten SPS comes out shorter (emulation-prevention
// bytes can disappear) the gap is filled with zero bytes, which H.264's byte
// stream allows after a NAL unit. Nothing else in the segment moves. When it
// would come out longer, ffmpeg's h264_metadata filter remuxes it instead.

const { runFfmpeg } = require('./transcode');

const TS_PACKET = 188;
const STREAM_TYPE_H264 = 0x1b;

// Profiles whose SPS carries chroma format and scaling lists (H.264 7.3.2.1.1).
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// Common rates and the tick rate (2 x fps) ffmpeg is given for them.
const STANDARD_RATES = [
    [24000 / 1001, '48000/1001'], [24, '48/1'], [25, '50/1'], [30000 / 1001, '60000/1001'],
    [30, '60/1'], [50, '100/1'], [60000 / 1001, '120000/1001'], [60, '120/1']
];

function isMpegTs(buf) {
    return buf.length >= TS_PACKET * 2 && buf[0] === 0x47 && buf[TS_PACKET] === 0x47;
}

// Payload of one TS packet, or null (no payload / not a sync'd packet).
function packetPayload(buf, off) {
    if (buf[off] !== 0x47) return null;
    const afc = (buf[off + 3] >> 4) & 0x3;
    if (!(afc & 0x1)) return null;
    let start = off + 4;
    if (afc & 0x2) start += 1 + buf[off + 4];
    return start < off + TS_PACKET ? buf.subarray(start, off + TS_PACKET) : null;
}

// The H.264 video PID from the PMT, found via the PAT.
function findVideoPid(buf) {
    let pmtPid = null;
    for (let off = 0; off + TS_PACKET <= buf.length; off += TS_PACKET) {
        const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
        const pusi = (buf[off + 1] & 0x40) !== 0;
        if (!pusi || (pid !== 0 && pid !== pmtPid)) continue;
        const p = packetPayload(buf, off);
        if (!p) continue;
        const section = p.subarray(1 + p[0]);
        const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
        const end = Math.min(3 + sectionLength - 4, section.length);
        if (pid === 0) {
            for (let i = 8; i + 4 <= end; i += 4) {
                const program = (section[i] << 8) | section[i + 1];
                if (program !== 0) { pmtPid = ((section[i + 2] & 0x1f) << 8) | section[i + 3]; break; }
            }
        } else {
            const infoLength = ((section[10] & 0x0f) << 8) | section[11];
            for (let i = 12 + infoLength; i + 5 <= end;) {
                const esPid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
                if (section[i] === STREAM_TYPE_H264) return esPid;
                i += 5 + (((section[i + 3] & 0x0f) << 8) | section[i + 4]);
            }
            return null;
        }
    }
    return null;
}

// The video PES packets' presentation times (90 kHz) and the first one's data.
function readVideoPes(buf, videoPid) {
    const pts = [];
    const first = [];
    let pesCount = 0;
    for (let off = 0; off + TS_PACKET <= buf.length; off += TS_PACKET) {
        const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
        if (pid !== videoPid) continue;
        const p = packetPayload(buf, off);
        if (!p) continue;
        if (buf[off + 1] & 0x40) {
            pesCount++;
            if (p[0] !== 0 || p[1] !== 0 || p[2] !== 1) continue;
            const flags = p[7];
            if (flags & 0x80) {
                pts.push(((p[9] & 0x0e) * 536870912) + (p[10] << 22) + ((p[11] & 0xfe) << 14) +
                    (p[12] << 7) + (p[13] >> 1));
            }
            if (pesCount === 1) first.push(p.subarray(9 + p[8]));
        } else if (pesCount === 1) {
            first.push(p);
        }
    }
    return { pts, firstPes: Buffer.concat(first) };
}

// The SPS NAL unit (header byte included) from an Annex B byte stream.
function findSps(data) {
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
        if ((data[i + 3] & 0x1f) !== 7) continue;
        // Up to the next start code (00 00 01, or 00 00 00 before one).
        let end = i + 4;
        while (end + 2 < data.length && !(data[end] === 0 && data[end + 1] === 0 && data[end + 2] <= 1)) end++;
        if (end + 2 >= data.length) end = data.length;
        return data.subarray(i + 3, end);
    }
    return null;
}

class BitReader {
    constructor(nal) {
        // Drop emulation-prevention bytes (00 00 03 -> 00 00).
        const bytes = [];
        for (let i = 0; i < nal.length; i++) {
            if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
            bytes.push(nal[i]);
        }
        this.bytes = bytes;
        this.pos = 0;
    }
    bit() {
        if (this.pos >= this.bytes.length * 8) throw new Error('SPS truncated');
        const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return b;
    }
    bits(n) {
        let v = 0;
        for (let i = 0; i < n; i++) v = v * 2 + this.bit();
        return v;
    }
    ue() {
        let zeros = 0;
        while (this.bit() === 0) {
            if (++zeros > 31) throw new Error('bad Exp-Golomb code');
        }
        return 2 ** zeros - 1 + this.bits(zeros);
    }
    se() {
        const k = this.ue();
        return k % 2 ? (k + 1) / 2 : -k / 2;
    }
}

function skipScalingList(r, size) {
    let last = 8;
    let next = 8;
    for (let j = 0; j < size; j++) {
        if (next !== 0) next = (last + r.se() + 256) % 256;
        last = next === 0 ? last : next;
    }
}

// An SPS's VUI timing: { numUnitsInTick, timeScale, bitPos (of
// num_units_in_tick in the unescaped bytes), rbsp }, or null when it has none.
function readTiming(sps) {
    const r = new BitReader(sps);
    r.bits(8); // NAL header
    const profile = r.bits(8);
    r.bits(16); // constraint flags, level
    r.ue(); // seq_parameter_set_id
    if (HIGH_PROFILES.has(profile)) {
        const chroma = r.ue();
        if (chroma === 3) r.bit();
        r.ue(); r.ue(); r.bit();
        if (r.bit()) {
            for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
                if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
            }
        }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
        r.bit(); r.se(); r.se();
        const n = r.ue();
        for (let i = 0; i < n; i++) r.se();
    }
    r.ue(); r.bit(); // max_num_ref_frames, gaps_in_frame_num_allowed
    r.ue(); r.ue(); // picture size in macroblocks
    if (!r.bit()) r.bit(); // frame_mbs_only, mb_adaptive_frame_field
    r.bit(); // direct_8x8_inference
    if (r.bit()) { r.ue(); r.ue(); r.ue(); r.ue(); } // cropping
    if (!r.bit()) return null; // no VUI
    if (r.bit() && r.bits(8) === 255) r.bits(32); // aspect ratio (extended SAR)
    if (r.bit()) r.bit(); // overscan
    if (r.bit()) { r.bits(4); if (r.bit()) r.bits(24); } // video signal type, colour description
    if (r.bit()) { r.ue(); r.ue(); } // chroma location
    if (!r.bit()) return null; // no timing info
    const bitPos = r.pos;
    const numUnitsInTick = r.bits(32);
    const timeScale = r.bits(32);
    return { numUnitsInTick, timeScale, bitPos, rbsp: r.bytes };
}

// The frame rate an SPS declares (time_scale / 2 x num_units_in_tick), or
// null when it declares none.
function declaredFrameRate(sps) {
    const timing = readTiming(sps);
    return timing?.numUnitsInTick > 0 ? timing.timeScale / (2 * timing.numUnitsInTick) : null;
}

// The SPS with new timing values, emulation prevention reapplied.
function rewriteSps(sps, numUnitsInTick, timeScale) {
    const { bitPos, rbsp } = readTiming(sps);
    const bytes = [...rbsp];
    const put = (pos, value) => {
        for (let i = 0; i < 32; i++) {
            const bit = Math.floor(value / 2 ** (31 - i)) % 2;
            const at = pos + i;
            const mask = 0x80 >> (at & 7);
            bytes[at >> 3] = bit ? bytes[at >> 3] | mask : bytes[at >> 3] & ~mask;
        }
    };
    put(bitPos, numUnitsInTick);
    put(bitPos + 32, timeScale);
    const out = [];
    let zeros = 0;
    for (const b of bytes) {
        if (zeros >= 2 && b <= 3) {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
}

// The frame rate the segment's timestamps show: the average gap between
// presentation times (frames arrive in decode order, so sorted first). An
// average, not the typical gap: X rounds timestamps to the millisecond, so
// 29.97 fps shows as a mix of 33 and 34 ms gaps.
function measuredFrameRate(pts) {
    if (pts.length < 3) return null;
    const sorted = [...pts].sort((a, b) => a - b);
    const span = sorted[sorted.length - 1] - sorted[0];
    return span > 0 ? 90000 * (sorted.length - 1) / span : null;
}

// The tick rate (2 x fps) to declare for a measured frame rate.
function tickRateFor(fps) {
    for (const [rate, tick] of STANDARD_RATES) {
        if (Math.abs(fps - rate) / rate < 0.01) return tick;
    }
    return `${Math.round(fps * 2000)}/1000`;
}

// What a segment declares and shows. `fix` is the tick rate to write when
// the two disagree (by more than half), otherwise null.
function inspectSegment(buf) {
    if (!isMpegTs(buf)) return null;
    const videoPid = findVideoPid(buf);
    if (videoPid === null) return null;
    const { pts, firstPes } = readVideoPes(buf, videoPid);
    const sps = findSps(firstPes);
    if (!sps) return null;
    let declared;
    try {
        declared = declaredFrameRate(sps);
    } catch {
        return null;
    }
    const measured = measuredFrameRate(pts);
    const wrong = declared !== null && measured !== null &&
        (declared > measured * 1.5 || declared < measured / 1.5);
    return { declared, measured, fix: wrong ? tickRateFor(measured) : null };
}

// The video stream's bytes (PES headers left out) and where each one sits in
// the segment, so a change to them can be written back in place.
function videoBytes(buf, videoPid) {
    const offsets = new Int32Array(buf.length);
    let length = 0;
    for (let off = 0; off + TS_PACKET <= buf.length; off += TS_PACKET) {
        const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
        if (pid !== videoPid) continue;
        const p = packetPayload(buf, off);
        if (!p) continue;
        let start = p.byteOffset - buf.byteOffset;
        if (buf[off + 1] & 0x40) {
            if (p[0] !== 0 || p[1] !== 0 || p[2] !== 1) continue;
            start += 9 + p[8];
        }
        for (let i = start; i < off + TS_PACKET; i++) offsets[length++] = i;
    }
    const es = Buffer.alloc(length);
    for (let i = 0; i < length; i++) es[i] = buf[offsets[i]];
    return { es, offsets };
}

// A copy of the segment with every SPS declaring `tickRate`, or null when a
// rewritten SPS wouldn't fit where the old one was.
function patchSegmentTiming(buf, tickRate) {
    const [timeScale, numUnitsInTick] = tickRate.split('/').map(Number);
    const videoPid = findVideoPid(buf);
    if (videoPid === null) return null;
    const { es, offsets } = videoBytes(buf, videoPid);
    const out = Buffer.from(buf);
    let patched = 0;
    for (let i = 0; i + 3 < es.length; i++) {
        if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1 || (es[i + 3] & 0x1f) !== 7) continue;
        const sps = findSps(es.subarray(i));
        const start = i + 3;
        let replacement;
        try {
            if (!readTiming(sps)) continue;
            replacement = rewriteSps(sps, numUnitsInTick, timeScale);
        } catch {
            return null;
        }
        if (replacement.length > sps.length) return null;
        for (let j = 0; j < sps.length; j++) out[offsets[start + j]] = j < replacement.length ? replacement[j] : 0;
        patched++;
        i = start + sps.length - 1;
    }
    return patched > 0 ? out : null;
}

// Warn once per declared/measured pair, not for every segment.
const warned = new Set();

// The segment with a corrected frame-rate header, or unchanged when it needs
// none (or can't be fixed: not TS, or no ffmpeg for the rare remux).
async function fixSegmentTiming(buf) {
    const info = inspectSegment(buf);
    if (!info?.fix) return buf;
    const key = `${info.declared}|${info.fix}`;
    if (!warned.has(key)) {
        warned.add(key);
        console.log(`[Timing] Segment declares ${Math.round(info.declared * 100) / 100} fps but plays at ` +
            `${Math.round(info.measured * 100) / 100} fps; correcting the header (tick rate ${info.fix})`);
    }
    const patched = patchSegmentTiming(buf, info.fix);
    if (patched) return patched;
    try {
        return await runFfmpeg([
            '-hide_banner', '-loglevel', 'error',
            '-f', 'mpegts', '-i', 'pipe:0',
            '-map', '0:v', '-map', '0:a?', '-c', 'copy',
            '-bsf:v', `h264_metadata=tick_rate=${info.fix}`,
            '-copyts', '-muxdelay', '0', '-muxpreload', '0',
            '-f', 'mpegts', 'pipe:1'
        ], buf, 15000);
    } catch (err) {
        // No ffmpeg (the arm64 image has none) fails the same way every time.
        if (!warned.has(err.message)) {
            warned.add(err.message);
            console.warn(`[Timing] Could not correct segments, sending them as they are: ${err.message}`);
        }
        return buf;
    }
}

module.exports = { inspectSegment, fixSegmentTiming, patchSegmentTiming, declaredFrameRate, rewriteSps, measuredFrameRate, tickRateFor };
