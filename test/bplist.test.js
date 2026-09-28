const { test } = require('node:test');
const assert = require('assert');
const { encodeBPlist, decodeBPlist } = require('../lib/bplist');

// A binary plist written by macOS (plutil -convert binary1) holding
// { rate: 1.0 (real), when: 2026-09-28T12:00:00Z (date), name: 'Café ☕' (UTF-16) }.
const FROM_PLUTIL = Buffer.from(
    '62706c6973743030d3010203040506546e616d65547768656e54726174656600430061006600e9002026153341c835' +
    '4720000000233ff0000000000000080f14191e2b34000000000000010100000000000000070000000000000000000000' +
    '000000003d', 'hex');

test('booleans survive a round trip (true used to decode as null)', () => {
    const decoded = decodeBPlist(encodeBPlist({ yes: true, no: false, nothing: null }));
    assert.deepStrictEqual(decoded, { yes: true, no: false, nothing: null });
});

test('fractional and negative numbers encode as reals', () => {
    const value = { position: 12.75, offset: -3, count: 7, list: [0.5, 2] };
    assert.deepStrictEqual(decodeBPlist(encodeBPlist(value)), value);
});

test('reals, dates and UTF-16 strings from an Apple-written plist decode', () => {
    assert.deepStrictEqual(decodeBPlist(FROM_PLUTIL), {
        name: 'Café ☕',
        rate: 1,
        when: 812289600 // seconds since 2001-01-01
    });
});
