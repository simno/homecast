// Packed audio rewrapped as MPEG-TS (lib/packed-audio.js), checked by taking
// the output apart again: tables with valid CRCs, one PES per AAC frame, each
// frame's bytes intact and its PTS counted on from the ID3 timestamp.
const { test } = require('node:test');
const assert = require('assert');
const { isPackedAudio, readStartPts, readAdtsFrames, packedAudioToTs, crc32 } = require('../lib/packed-audio');

// An ADTS frame of `size` bytes in all (header included): AAC LC, 44.1 kHz, stereo.
function adtsFrame(size, fill) {
    const frame = Buffer.alloc(size, fill);
    frame.set([0xff, 0xf1, 0x50, 0x80 | ((size >> 11) & 0x03), (size >> 3) & 0xff, ((size & 0x07) << 5) | 0x1f, 0xfc]);
    return frame;
}

// An ID3v2.4 tag with Apple's PRIV timestamp frame.
function timestampTag(pts) {
    const owner = Buffer.from('com.apple.streaming.transportStreamTimestamp\0', 'latin1');
    const stamp = Buffer.alloc(8);
    stamp.writeUInt32BE(Math.floor(pts / 2 ** 32), 0);
    stamp.writeUInt32BE(pts % 2 ** 32, 4);
    const body = Buffer.concat([owner, stamp]);
    const frameHeader = Buffer.from([0x50, 0x52, 0x49, 0x56, 0, 0, 0, body.length, 0, 0]); // PRIV
    const size = frameHeader.length + body.length;
    return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, size]), frameHeader, body]);
}

const START = 95.805522 * 90000;
const frames = [adtsFrame(371, 0x11), adtsFrame(184, 0x22), adtsFrame(500, 0x33)];
const packed = Buffer.concat([timestampTag(Math.round(START)), ...frames]);

// Packets by PID, and the PES packets reassembled from the audio PID.
function demux(ts) {
    const packets = [];
    for (let off = 0; off < ts.length; off += 188) packets.push(ts.subarray(off, off + 188));
    const pes = [];
    for (const p of packets) {
        assert.strictEqual(p[0], 0x47, 'sync byte');
        const pid = ((p[1] & 0x1f) << 8) | p[2];
        if (pid !== 0x101) continue;
        const afc = (p[3] >> 4) & 0x3;
        const start = afc === 0x3 ? 5 + p[4] : 4;
        if (p[1] & 0x40) pes.push({ bytes: [], pcr: afc === 0x3 && p[5] & 0x10 });
        pes.at(-1).bytes.push(p.subarray(start));
    }
    return { packets, pes: pes.map(({ bytes, pcr }) => ({ data: Buffer.concat(bytes), pcr })) };
}

const readPts = (b) => (b[0] >> 1 & 0x07) * 2 ** 30 + (b[1] << 22 | (b[2] >> 1) << 15 | b[3] << 7 | b[4] >> 1);

test('packed audio is told from TS, and its start time and frames are read', () => {
    assert.strictEqual(isPackedAudio(packed), true);
    assert.strictEqual(isPackedAudio(Buffer.concat(frames)), true, 'ADTS without a tag');
    assert.strictEqual(isPackedAudio(Buffer.from([0x47, 0x40, 0, 0x10, 0, 0, 0, 0, 0, 0])), false);
    assert.strictEqual(readStartPts(packed), Math.round(START));
    assert.deepStrictEqual(readAdtsFrames(packed, 0).map(f => [f.data.length, f.samples, f.sampleRate]),
        [[371, 1024, 44100], [184, 1024, 44100], [500, 1024, 44100]]);
});

test('the TS carries a PAT and a PMT naming one ADTS AAC stream, with valid CRCs', () => {
    const { packets } = demux(packedAudioToTs(packed));
    const section = (p) => {
        const length = ((p[6] & 0x0f) << 8) | p[7];
        return p.subarray(5, 5 + 3 + length);
    };
    for (const p of packets.slice(0, 2)) assert.strictEqual(crc32(section(p)), 0, 'a section with its CRC sums to 0');
    const pmt = section(packets[1]);
    assert.strictEqual(pmt[0], 0x02);
    assert.deepStrictEqual([pmt[12], ((pmt[13] & 0x1f) << 8) | pmt[14]], [0x0f, 0x101], 'ADTS AAC on PID 0x101');
});

test('each frame becomes a PES with its bytes intact and its time counted from the tag', () => {
    const { packets, pes } = demux(packedAudioToTs(packed));
    assert.ok(packets.every(p => p.length === 188));
    assert.deepStrictEqual(pes.map(p => p.data.subarray(14)), frames);
    const step = 1024 * 90000 / 44100;
    assert.deepStrictEqual(pes.map(p => readPts(p.data.subarray(9, 14))),
        [0, 1, 2].map(i => Math.round(START) + Math.round(i * step)));
    assert.ok(pes.every(p => p.pcr), 'every PES starts with a PCR');
    const counters = packets.filter(p => (((p[1] & 0x1f) << 8) | p[2]) === 0x101).map(p => p[3] & 0x0f);
    assert.deepStrictEqual(counters, counters.map((_, i) => i % 16), 'continuity counters run on');
});

test('anything that isn\'t packed audio with a timestamp is left alone', () => {
    assert.strictEqual(packedAudioToTs(Buffer.alloc(376, 0x47)), null);
    assert.strictEqual(packedAudioToTs(Buffer.concat(frames)), null, 'no ID3 timestamp to place it by');
    assert.strictEqual(packedAudioToTs(timestampTag(0)), null, 'no frames');
});
