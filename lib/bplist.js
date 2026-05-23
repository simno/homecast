// Minimal Apple Binary Property List codec for AirPlay pairing.
// Supports NSDictionary, NSString (ASCII), NSData, and integer types.
// Format reference: https://medium.com/@karaiskc/apples-bin-plist-format-5a9604a7e1e3

// Markers (high nibble)
const TYPE_NULL = 0x00;
const TYPE_BOOL = 0x08;
const TYPE_INT  = 0x10;
const TYPE_DATA = 0x40;
const TYPE_ASCII = 0x50;
const TYPE_ARRAY = 0xA0;
const TYPE_DICT = 0xD0;

const HEADER = Buffer.from('bplist00');

function encodeBPlist(obj) {
    const objects = [];
    const refs = new Map();

    function addObject(buf) {
        const idx = objects.length;
        objects.push(buf);
        return idx;
    }

    function serialize(val) {
        // Check cache for dedup (strings and data)
        if (typeof val === 'string') {
            const key = '\x01' + val;
            if (refs.has(key)) return refs.get(key);
        } else if (Buffer.isBuffer(val)) {
            const key = '\x02' + val.toString('base64');
            if (refs.has(key)) return refs.get(key);
        }

        let buf;

        if (val === null || val === undefined) {
            buf = Buffer.from([TYPE_NULL]);
        } else if (typeof val === 'boolean') {
            buf = Buffer.from([val ? 0x09 : 0x08]);
        } else if (typeof val === 'number') {
            buf = encodeInt(val);
        } else if (typeof val === 'string') {
            buf = encodeString(val);
        } else if (Buffer.isBuffer(val)) {
            buf = encodeData(val);
        } else if (Array.isArray(val)) {
            buf = encodeCollection(TYPE_ARRAY, val, serialize);
        } else if (val !== null && typeof val === 'object') {
            buf = encodeDict(val, serialize);
        } else {
            throw new Error('Unsupported plist type: ' + (typeof val));
        }

        const idx = addObject(buf);

        if (typeof val === 'string') refs.set('\x01' + val, idx);
        if (Buffer.isBuffer(val)) refs.set('\x02' + val.toString('base64'), idx);

        return idx;
    }

    serialize(obj);

    return buildFile(objects);
}

function decodeBPlist(buf) {
    if (!Buffer.isBuffer(buf)) {
        throw new Error('Expected Buffer for binary plist');
    }

    // Verify header
    if (buf.length < 40) throw new Error('Binary plist too short');
    if (!buf.subarray(0, 8).equals(HEADER)) {
        throw new Error('Not a binary plist file');
    }

    // Read trailer (last 32 bytes)
    const trailer = buf.subarray(buf.length - 32);
    const offsetSize = trailer[6];
    const refSize = trailer[7];
    const numObjects = Number(readBigInt(trailer, 8, 8));
    const topObject = Number(readBigInt(trailer, 16, 8));
    const offsetTableStart = Number(readBigInt(trailer, 24, 8));

    // Parse objects lazily
    const cache = new Array(Number(numObjects));

    function readInt(offset, size) {
        return Number(readBigInt(buf, offset, size));
    }

    function parseObject(idx) {
        if (cache[idx] !== undefined) return cache[idx];

        const off = readInt(offsetTableStart + idx * offsetSize, offsetSize);
        const marker = buf[off];
        const type = marker & 0xF0;
        const sizeBits = marker & 0x0F;

        let val;
        if (type === TYPE_NULL || (type === TYPE_BOOL && sizeBits === 0)) {
            val = null;
        } else if (type === TYPE_BOOL) {
            val = (sizeBits === 0x09);
        } else if (type === TYPE_INT) {
            const intSize = 1 << sizeBits;
            val = readInt(off + 1, intSize);
        } else if (type === TYPE_DATA) {
            const [dataOff, len] = readSizeAndStart(off, 1);
            val = buf.subarray(dataOff, dataOff + len);
        } else if (type === TYPE_ASCII) {
            const [strOff, len] = readSizeAndStart(off, 1);
            val = buf.toString('utf8', strOff, strOff + len);
        } else if (type === TYPE_ARRAY) {
            val = parseArray(off, 1);
        } else if (type === TYPE_DICT) {
            val = parseDict(off, 1);
        } else {
            throw new Error('Unsupported plist type: 0x' + type.toString(16) + ' at offset ' + off);
        }

        cache[idx] = val;
        return val;
    }

    function readSizeAndStart(off, headerSize) {
        const marker = buf[off];
        let size = marker & 0x0F;
        let dataOff = off + headerSize;
        if (size === 0x0F) {
            // Size is in following integer
            const intMarker = buf[dataOff];
            const intSize = 1 << (intMarker & 0x0F);
            size = readInt(dataOff + 1, intSize);
            dataOff = dataOff + 1 + intSize;
        }
        return [dataOff, size];
    }

    function parseArray(off, headerSize) {
        const [dataOff, len] = readSizeAndStart(off, headerSize);
        const result = [];
        for (let i = 0; i < len; i++) {
            const refIdx = readInt(dataOff + i * refSize, refSize);
            result.push(parseObject(refIdx));
        }
        return result;
    }

    function parseDict(off, headerSize) {
        const [dataOff, len] = readSizeAndStart(off, headerSize);
        const result = {};
        for (let i = 0; i < len; i++) {
            const keyRef = readInt(dataOff + i * refSize, refSize);
            const valRef = readInt(dataOff + (len + i) * refSize, refSize);
            result[parseObject(keyRef)] = parseObject(valRef);
        }
        return result;
    }

    return parseObject(Number(topObject));
}

// ---- Encoding helpers ----

function encodeInt(val) {
    if (!Number.isInteger(val) || val < 0) {
        throw new Error('Plist integer must be non-negative: ' + val);
    }

    // Find smallest power-of-2 size that fits
    let intSize;
    if (val < 0xFF) intSize = 0;           // 1 byte
    else if (val < 0xFFFF) intSize = 1;     // 2 bytes
    else if (val < 0xFFFFFFFF) intSize = 2; // 4 bytes
    else intSize = 3;                        // 8 bytes

    const buf = Buffer.allocUnsafe(1 + (1 << intSize));
    buf[0] = TYPE_INT | intSize;

    const byteLen = 1 << intSize;
    if (byteLen === 1) buf.writeUInt8(val, 1);
    else if (byteLen === 2) buf.writeUInt16BE(val, 1);
    else if (byteLen === 4) buf.writeUInt32BE(val, 1);
    else writeBigUInt64BE(buf, val, 1);

    return buf;
}

function encodeString(val) {
    const strBuf = Buffer.from(val, 'utf8');
    if (strBuf.length < 15) {
        return Buffer.concat([Buffer.from([TYPE_ASCII | strBuf.length]), strBuf]);
    }
    const lenObj = encodeInt(strBuf.length);
    return Buffer.concat([Buffer.from([TYPE_ASCII | 0x0F]), lenObj, strBuf]);
}

function encodeData(val) {
    if (val.length < 15) {
        return Buffer.concat([Buffer.from([TYPE_DATA | val.length]), val]);
    }
    const lenObj = encodeInt(val.length);
    return Buffer.concat([Buffer.from([TYPE_DATA | 0x0F]), lenObj, val]);
}

function encodeCollection(type, arr, serializeFn) {
    const refs = arr.map(v => serializeFn(v));
    const n = arr.length;

    const refBuf = Buffer.allocUnsafe(n * 2);
    for (let i = 0; i < n; i++) refBuf.writeUInt16BE(refs[i], i * 2);

    if (n < 15) {
        return Buffer.concat([Buffer.from([type | n]), refBuf]);
    }
    return Buffer.concat([Buffer.from([type | 0x0F]), encodeInt(n), refBuf]);
}

function encodeDict(obj, serializeFn) {
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const n = keys.length;

    const refs = [];
    for (const k of keys) refs.push(serializeFn(k));
    for (const k of keys) refs.push(serializeFn(obj[k]));

    const totalRefs = n * 2;
    const refBuf = Buffer.allocUnsafe(totalRefs * 2);
    for (let i = 0; i < totalRefs; i++) refBuf.writeUInt16BE(refs[i], i * 2);

    if (n < 15) {
        return Buffer.concat([Buffer.from([TYPE_DICT | n]), refBuf]);
    }
    return Buffer.concat([Buffer.from([TYPE_DICT | 0x0F]), encodeInt(n), refBuf]);
}

// ---- File assembly ----

function buildFile(objects) {
    const headerLen = HEADER.length; // 8
    const objectSize = 2; // use 2-byte references
    const offsetSize = 2; // use 2-byte offsets

    // Compute offsets (absolute from start of file, including header)
    const offsets = [];
    let pos = headerLen;
    for (const obj of objects) {
        offsets.push(pos);
        pos += obj.length;
    }

    // Build offset table
    const offsetTable = Buffer.allocUnsafe(offsets.length * offsetSize);
    for (let i = 0; i < offsets.length; i++) {
        offsetTable.writeUInt16BE(offsets[i], i * offsetSize);
    }

    // Build trailer
    const trailer = Buffer.allocUnsafe(32);
    trailer.fill(0, 0, 6);           // unused
    trailer[6] = offsetSize;
    trailer[7] = objectSize;
    writeBigUInt64BE(trailer, BigInt(objects.length), 8);
    writeBigUInt64BE(trailer, BigInt(objects.length - 1), 16); // top object is last
    const offsetTableOffset = pos; // absolute position after all objects
    writeBigUInt64BE(trailer, BigInt(offsetTableOffset), 24);

    return Buffer.concat([HEADER, ...objects, offsetTable, trailer]);
}

// ---- Big-endian helpers ----

function readBigInt(buf, offset, size) {
    let val = 0n;
    for (let i = 0; i < size; i++) {
        val = (val << 8n) | BigInt(buf[offset + i]);
    }
    return val;
}

function writeBigUInt64BE(buf, val, offset) {
    const num = BigInt(val);
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((num >> BigInt(56 - i * 8)) & 0xFFn);
    }
}

module.exports = { encodeBPlist, decodeBPlist };
