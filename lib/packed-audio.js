// Packed audio (HLS audio renditions as raw ADTS AAC) rewrapped as MPEG-TS.
//
// YouTube's HLS keeps audio apart from video, as "packed audio" segments: an
// ID3 tag carrying the segment's start time, then bare ADTS AAC frames. Cast
// receivers load such a stream, fetch both renditions, and sit at BUFFERING
// forever, declared audio format or not; the same video plays at once without
// its audio rendition. Rewrapped as MPEG-TS — what a receiver takes an audio
// rendition to be — the audio plays, in sync, because each frame keeps the
// presentation time the ID3 tag gave it.

const TS_PACKET = 188;
const PMT_PID = 0x1000;
const AUDIO_PID = 0x101;
const STREAM_TYPE_ADTS_AAC = 0x0f;
const TIMESTAMP_OWNER = 'com.apple.streaming.transportStreamTimestamp';
const PTS_WRAP = 2 ** 33;

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const isAdtsSync = (buf, i) => buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0;

// Whether a segment is packed audio: an ID3 tag or an ADTS frame first.
function isPackedAudio(buf) {
    if (!buf || buf.length < 10) return false;
    return buf.toString('latin1', 0, 3) === 'ID3' || isAdtsSync(buf, 0);
}

// The ID3 tag's length (header and body) at the start of `buf`, or 0.
function id3Length(buf) {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const footer = buf[5] & 0x10 ? 10 : 0;
    return 10 + size + footer;
}

// The 90 kHz start time from the segment's PRIV timestamp frame, or null.
function readStartPts(buf) {
    const owner = buf.indexOf(TIMESTAMP_OWNER, 0, 'latin1');
    if (owner < 0 || owner > id3Length(buf)) return null;
    const at = owner + TIMESTAMP_OWNER.length + 1; // the owner string's NUL
    if (at + 8 > buf.length) return null;
    // A 33-bit value in the low bits of 8 big-endian bytes.
    return (buf.readUInt32BE(at) & 1) * 2 ** 32 + buf.readUInt32BE(at + 4);
}

// The ADTS frames after the tag: [{ data, samples, sampleRate }].
function readAdtsFrames(buf, from) {
    const frames = [];
    let i = from;
    while (i + 7 <= buf.length) {
        if (!isAdtsSync(buf, i)) {
            i++; // resynchronise past stray bytes
            continue;
        }
        const length = ((buf[i + 3] & 0x03) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
        if (length < 7 || i + length > buf.length) break;
        const sampleRate = SAMPLE_RATES[(buf[i + 2] >> 2) & 0x0f];
        if (!sampleRate) break;
        frames.push({ data: buf.subarray(i, i + length), samples: 1024 * ((buf[i + 6] & 0x03) + 1), sampleRate });
        i += length;
    }
    return frames;
}

// MPEG-2 CRC32 (polynomial 0x04C11DB7, no reflection), as PSI tables carry.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    return c >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
    return crc;
}

// A PSI section (PAT or PMT) in its own packet, stuffed with 0xFF.
function psiPacket(pid, tableId, idField, body) {
    const sectionLength = 5 + body.length + 4;
    const section = Buffer.from([
        tableId, 0xb0 | (sectionLength >> 8), sectionLength & 0xff,
        idField >> 8, idField & 0xff, 0xc1, 0x00, 0x00, ...body
    ]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(section));
    const packet = Buffer.alloc(TS_PACKET, 0xff);
    packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00], 0); // pointer_field 0
    packet.set(section, 5);
    packet.set(crc, 5 + section.length);
    return packet;
}

function patPacket() {
    return psiPacket(0, 0x00, 1, [0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
}

function pmtPacket() {
    return psiPacket(PMT_PID, 0x02, 1, [
        0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00, // PCR PID, no program info
        STREAM_TYPE_ADTS_AAC, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00
    ]);
}

// The 5-byte PTS field of a PES header ('0010' prefix: PTS only).
function ptsField(pts) {
    const hi = Math.floor(pts / 2 ** 30) & 0x07;
    const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
    const lo = pts & 0x7fff;
    return [0x21 | (hi << 1), mid >> 7, ((mid & 0x7f) << 1) | 1, lo >> 7, ((lo & 0x7f) << 1) | 1];
}

// The 6-byte PCR field (base only; the 27 MHz extension left 0).
function pcrField(pts) {
    return [
        Math.floor(pts / 2 ** 25) & 0xff, Math.floor(pts / 2 ** 17) & 0xff, Math.floor(pts / 2 ** 9) & 0xff,
        Math.floor(pts / 2) & 0xff, ((pts & 1) << 7) | 0x7e, 0x00
    ];
}

// One PES packet as TS packets on the audio PID, the first carrying a PCR.
function pesPackets(frame, pts, counter) {
    const header = Buffer.from([0x00, 0x00, 0x01, 0xc0, 0, 0, 0x80, 0x80, 0x05, ...ptsField(pts)]);
    header.writeUInt16BE(frame.length + 8, 4);
    let payload = Buffer.concat([header, frame]);
    const packets = [];
    let first = true;
    while (payload.length > 0) {
        const packet = Buffer.alloc(TS_PACKET, 0xff);
        // Adaptation field: the PCR on the first packet, stuffing on the last.
        const pcr = first ? pcrField(pts) : [];
        const minAdaptation = first ? 2 + pcr.length : 0; // length byte + flags + PCR
        const room = TS_PACKET - 4 - minAdaptation;
        const take = Math.min(room, payload.length);
        const adaptation = TS_PACKET - 4 - take;
        packet[0] = 0x47;
        packet[1] = (first ? 0x40 : 0) | (AUDIO_PID >> 8);
        packet[2] = AUDIO_PID & 0xff;
        packet[3] = (adaptation > 0 ? 0x30 : 0x10) | (counter.value++ & 0x0f);
        if (adaptation > 0) {
            packet[4] = adaptation - 1;
            if (adaptation > 1) {
                packet[5] = first ? 0x10 : 0x00; // PCR_flag
                if (first) packet.set(pcr, 6);
            }
        }
        payload.copy(packet, 4 + adaptation, 0, take);
        payload = payload.subarray(take);
        packets.push(packet);
        first = false;
    }
    return packets;
}

// Rewraps a packed audio segment as MPEG-TS. Returns null when `buf` isn't
// packed audio with a start time, so the caller can pass it on unchanged.
function packedAudioToTs(buf) {
    if (!isPackedAudio(buf)) return null;
    const start = readStartPts(buf);
    if (start === null) return null;
    const frames = readAdtsFrames(buf, id3Length(buf));
    if (frames.length === 0) return null;

    const counter = { value: 0 };
    const packets = [patPacket(), pmtPacket()];
    let samples = 0;
    for (const frame of frames) {
        const pts = (start + Math.round(samples * 90000 / frame.sampleRate)) % PTS_WRAP;
        packets.push(...pesPackets(frame.data, pts, counter));
        samples += frame.samples;
    }
    return Buffer.concat(packets);
}

module.exports = { isPackedAudio, readStartPts, readAdtsFrames, packedAudioToTs, crc32 };
