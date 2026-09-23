// Subtitles: HLS rendition parsing, conversion to WebVTT, matching the
// receiver's tracks, and the per-session state that switches them.
const { test, beforeEach } = require('node:test');
const assert = require('assert');
const { EventEmitter } = require('events');
const { activeSessions } = require('../lib/state');
const subs = require('../lib/subtitles');

// --- HLS renditions ---

test('SUBTITLES renditions are listed once each, with language, name and flags', () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="a/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s1",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="s/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s1",NAME="English (forced)",LANGUAGE="en",FORCED=YES,URI="s/en-f.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s2",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="s2/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s1",NAME="Français, sous-titres",LANGUAGE="fr",URI="s/fr.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s1"',
        'v.m3u8'
    ].join('\n');
    assert.deepStrictEqual(subs.parseHlsSubtitles(master), [
        { language: 'en', label: 'English', default: true, forced: false },
        { language: 'en', label: 'English (forced)', default: false, forced: true },
        { language: 'fr', label: 'Français, sous-titres', default: false, forced: false }
    ]);
});

test('a playlist without subtitle renditions has none', () => {
    assert.deepStrictEqual(subs.parseHlsSubtitles('#EXTM3U\n#EXTINF:4,\nseg.ts\n'), []);
    assert.deepStrictEqual(subs.parseHlsSubtitles(undefined), []);
});

// --- WebVTT conversion ---

const SRT = '1\r\n0:00:01,500 --> 0:00:03,000\r\nHello\r\n\r\n2\r\n00:01:02,003 --> 00:01:04,000\r\nWorld\r\n';

test('SRT becomes WebVTT: header, dot decimals, two-digit hours, LF line endings', () => {
    assert.strictEqual(subs.srtToVtt(SRT),
        'WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n\n2\n00:01:02.003 --> 00:01:04.000\nWorld\n');
});

test('WebVTT passes through, minus a byte-order mark', () => {
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n';
    assert.strictEqual(subs.toWebVtt(Buffer.from('﻿' + vtt)), vtt);
});

test('SRT is detected and converted', () => {
    assert.match(subs.toWebVtt(Buffer.from(SRT)), /^WEBVTT\n\n1\n00:00:01\.500 --> /);
});

test('a Windows-1252 SRT is decoded as such, not as broken UTF-8', () => {
    const latin1 = Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf'), Buffer.from([0xE9]), Buffer.from('\n')]);
    assert.match(subs.toWebVtt(latin1), /Café/);
});

test('UTF-16 files with a byte-order mark are decoded', () => {
    const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('WEBVTT\n\n00:01.000 --> 00:02.000\nÜber\n', 'utf16le')]);
    assert.match(subs.toWebVtt(utf16), /^WEBVTT[\s\S]*Über/);
});

test('anything else is not a subtitle file', () => {
    assert.strictEqual(subs.toWebVtt(Buffer.from('<html><body>Not found</body></html>')), null);
});

// --- Receiver tracks ---

test('the sideloaded track is a WebVTT SUBTITLES track with a language', () => {
    assert.deepStrictEqual(subs.sideloadedTrack('http://h/proxy?x', { label: 'English' }), {
        trackId: subs.SIDELOADED_TRACK_ID, type: 'TEXT', subtype: 'SUBTITLES',
        trackContentId: 'http://h/proxy?x', trackContentType: 'text/vtt', name: 'English', language: 'und'
    });
});

const TRACKS = [
    { trackId: 3, name: 'English', language: 'en-US' },
    { trackId: 4, name: 'English SDH', language: 'en-US' },
    { trackId: 5, name: 'Español', language: 'es' }
];

test('a manifest rendition is matched by name and language first', () => {
    assert.strictEqual(subs.matchTrack(TRACKS, { language: 'en-US', label: 'English SDH' }).trackId, 4);
});

test('then by exact language, then by base language', () => {
    assert.strictEqual(subs.matchTrack(TRACKS, { language: 'es', label: 'Spanish' }).trackId, 5);
    assert.strictEqual(subs.matchTrack(TRACKS, { language: 'en', label: 'Other' }).trackId, 3);
});

test('no match is null', () => {
    assert.strictEqual(subs.matchTrack(TRACKS, { language: 'ja', label: '日本語' }), null);
});

test('only TEXT tracks are reported', () => {
    const media = { tracks: [{ trackId: 1, type: 'AUDIO', language: 'en' }, { trackId: 2, type: 'TEXT', name: 'Deutsch', language: 'de' }] };
    assert.deepStrictEqual(subs.textTracks(media), [{ trackId: 2, name: 'Deutsch', language: 'de' }]);
});

// --- Switching on the receiver ---

// A castv2-client player whose media controller records what it is sent.
function fakePlayer({ hasSession = true } = {}) {
    const sent = [];
    const player = new EventEmitter();
    player.media = {
        currentSession: hasSession ? { mediaSessionId: 1 } : null,
        getStatus(cb) {
            sent.push({ type: 'GET_STATUS' });
            this.currentSession = { mediaSessionId: 1 };
            cb(null, {});
        },
        sessionRequest(data, cb) {
            sent.push(data);
            cb(null, {});
        }
    };
    return { player, sent };
}

test('switching sends EDIT_TRACKS_INFO; null turns subtitles off', async () => {
    const { player, sent } = fakePlayer();
    await subs.setActiveTextTrack(player, 5);
    await subs.setActiveTextTrack(player, null);
    assert.deepStrictEqual(sent, [
        { type: 'EDIT_TRACKS_INFO', activeTrackIds: [5] },
        { type: 'EDIT_TRACKS_INFO', activeTrackIds: [] }
    ]);
});

test('without a media session yet, the status is fetched first', async () => {
    const { player, sent } = fakePlayer({ hasSession: false });
    await subs.setActiveTextTrack(player, 5);
    assert.deepStrictEqual(sent.map(m => m.type), ['GET_STATUS', 'EDIT_TRACKS_INFO']);
});

// --- Session state ---

const IP = '192.168.1.60';
beforeEach(() => activeSessions.clear());

test('a manifest choice is applied once the receiver lists its tracks', async () => {
    const { player, sent } = fakePlayer();
    activeSessions.set(IP, { player, subtitles: subs.newSubtitleState({ language: 'es', label: 'Español' }) });

    subs.syncSubtitles(IP, { playerState: 'BUFFERING' }); // no tracks yet
    assert.deepStrictEqual(sent, []);

    subs.syncSubtitles(IP, { media: { tracks: TRACKS.map(t => ({ ...t, type: 'TEXT' })) }, activeTrackIds: [] });
    await new Promise(setImmediate);
    assert.deepStrictEqual(sent, [{ type: 'EDIT_TRACKS_INFO', activeTrackIds: [5] }]);
    assert.deepStrictEqual(subs.subtitleState(IP), { tracks: TRACKS, activeTrackId: 5 });

    // Applied once only, not on every later status.
    subs.syncSubtitles(IP, { media: { tracks: TRACKS.map(t => ({ ...t, type: 'TEXT' })) }, activeTrackIds: [5] });
    await new Promise(setImmediate);
    assert.strictEqual(sent.length, 1);
});

test('a sideloaded choice needs no switching after load', () => {
    const { player, sent } = fakePlayer();
    activeSessions.set(IP, { player, subtitles: subs.newSubtitleState({ url: 'https://s/en.vtt', label: 'English' }) });
    subs.syncSubtitles(IP, { media: { tracks: [{ trackId: 1, type: 'TEXT', name: 'English' }] }, activeTrackIds: [1] });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(subs.subtitleState(IP).activeTrackId, 1);
});

test('the active track ignores audio and video track ids', () => {
    const { player } = fakePlayer();
    activeSessions.set(IP, { player, subtitles: subs.newSubtitleState(null) });
    subs.syncSubtitles(IP, { media: { tracks: [{ trackId: 1, type: 'AUDIO' }, { trackId: 2, type: 'TEXT', name: 'English' }] }, activeTrackIds: [1] });
    assert.strictEqual(subs.subtitleState(IP).activeTrackId, null);
});

test('a reload keeps a sideloaded track by id and re-picks a manifest track by name', () => {
    const { player } = fakePlayer();
    activeSessions.set(IP, { player, subtitles: { tracks: [{ trackId: 1, name: 'English', language: 'en' }], activeTrackId: 1, wanted: null } });
    assert.deepStrictEqual(subs.reloadOptions(IP, { tracks: [{ trackId: 1 }] }), { activeTrackIds: [1] });

    activeSessions.set(IP, { player, subtitles: { tracks: TRACKS, activeTrackId: 4, wanted: null } });
    assert.deepStrictEqual(subs.reloadOptions(IP, {}), {});
    assert.deepStrictEqual(activeSessions.get(IP).subtitles.wanted, { language: 'en-US', label: 'English SDH' });
});

test('with subtitles off, a reload changes nothing', () => {
    const { player } = fakePlayer();
    activeSessions.set(IP, { player, subtitles: { tracks: TRACKS, activeTrackId: null, wanted: null } });
    assert.deepStrictEqual(subs.reloadOptions(IP, {}), {});
    assert.strictEqual(activeSessions.get(IP).subtitles.wanted, null);
});
