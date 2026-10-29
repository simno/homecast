// Dailymotion through yt-dlp (lib/dailymotion.js): how yt-dlp's answers
// become a stream or a message. A shell script stands in for yt-dlp.
// site-resolvers.test.js covers which URLs are Dailymotion's.
const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDailymotion, pickVariant } = require('../lib/dailymotion');

const variant = (height, tbr) => ({
    format_id: `hls-${height}`, protocol: 'm3u8_native', ext: 'mp4', height, tbr,
    url: `https://vod.example/${height}_${tbr}.m3u8`,
    manifest_url: 'https://cdndirector.dailymotion.com/cdn/manifest/video/x8j6bwk.m3u8?sec=s',
    vcodec: 'avc1.64001f', acodec: 'mp4a.40.2'
});
const info = {
    title: 'Popeye (1933) E0108 Many Tanks',
    is_live: null,
    thumbnail: 'https://s1.dmcdn.net/v/Um9J41gVy2S2I9wzH/x1080',
    formats: [variant(380, 460), variant(720, 2200), variant(720, 1800), variant(480, 900)]
};

let dir;
// Points YTDLP_PATH at a script that prints `stdout` and `stderr` and exits with `code`.
function fakeYtDlp(t, { stdout = '', stderr = '', code = 0 }) {
    const script = path.join(dir, `yt-dlp-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(path.join(dir, 'out.txt'), stdout);
    fs.writeFileSync(script, [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
        'cat "$(dirname "$0")/out.txt"',
        `printf '%s' '${stderr.replace(/'/g, '\'\\\'\'')}' >&2`,
        `exit ${code}`
    ].join('\n'), { mode: 0o755 });
    const previous = process.env.YTDLP_PATH;
    process.env.YTDLP_PATH = script;
    t.after(() => {
        if (previous === undefined) delete process.env.YTDLP_PATH;
        else process.env.YTDLP_PATH = previous;
    });
}
const lastArgs = () => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split('\n');

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-dailymotion-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the tallest variant is played, the higher bitrate of equals', () => {
    assert.strictEqual(pickVariant(info).url, 'https://vod.example/720_2200.m3u8');
    assert.strictEqual(pickVariant({ formats: [{ protocol: 'https', url: 'https://vod.example/a.mp4' }] }), null);
    assert.strictEqual(pickVariant({}), null);
});

test('a video resolves through yt-dlp to its best variant, not the refused master', async (t) => {
    fakeYtDlp(t, { stdout: JSON.stringify(info) });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'), {
        status: 'ok', type: 'hls', referer: 'https://www.dailymotion.com/', live: false,
        url: 'https://vod.example/720_2200.m3u8',
        title: 'Popeye (1933) E0108 Many Tanks', thumbnail: 'https://s1.dmcdn.net/v/Um9J41gVy2S2I9wzH/x1080'
    });
    assert.deepStrictEqual(lastArgs().slice(-2), ['--', 'https://www.dailymotion.com/video/x8j6bwk'],
        'every URL form is asked for as the video page, and can\'t be read as an option');
});

test('a live stream is live, and a missing title costs nothing', async (t) => {
    fakeYtDlp(t, { stdout: JSON.stringify({ formats: info.formats, is_live: true }) });
    const result = await resolveDailymotion('https://www.dailymotion.com/video/x8j6bwk');
    assert.deepStrictEqual([result.status, result.live, result.title, result.thumbnail], ['ok', true, null, null]);
});

test('refusals are offline, with Dailymotion\'s reason', async (t) => {
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [dailymotion] x8j6bwk: Not found.' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'),
        { status: 'offline', message: 'Dailymotion: Not found.' });
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [dailymotion] x9zenyk: dailymotion said: Private content.' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x9zenyk'),
        { status: 'offline', message: 'Dailymotion: Private content.' });
});

test('any other yt-dlp failure is an error suggesting an update', async (t) => {
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [dailymotion] x8j6bwk: Unable to download JSON metadata: HTTP Error 500' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'), {
        status: 'error',
        message: 'yt-dlp couldn\'t read this Dailymotion video: Unable to download JSON metadata: HTTP Error 500. Updating yt-dlp often fixes this'
    });
});

test('no yt-dlp installed says so', async (t) => {
    const previous = process.env.YTDLP_PATH;
    process.env.YTDLP_PATH = path.join(dir, 'missing-yt-dlp');
    t.after(() => {
        if (previous === undefined) delete process.env.YTDLP_PATH;
        else process.env.YTDLP_PATH = previous;
    });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'), {
        status: 'unavailable', message: 'Playing Dailymotion needs yt-dlp, which isn\'t installed on the HomeCast server'
    });
});

test('unreadable output, or no variant, is an error', async (t) => {
    fakeYtDlp(t, { stdout: 'not json' });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'),
        { status: 'error', message: 'yt-dlp gave an answer HomeCast couldn\'t read' });
    fakeYtDlp(t, { stdout: JSON.stringify({ title: 'Nothing', formats: [] }) });
    assert.deepStrictEqual(await resolveDailymotion('https://dai.ly/x8j6bwk'),
        { status: 'error', message: 'Dailymotion offered no stream a TV can play for this video' });
});

test('an unrecognised URL never reaches yt-dlp', async () => {
    assert.deepStrictEqual(await resolveDailymotion('https://www.dailymotion.com/tv'),
        { status: 'error', message: 'Unrecognised Dailymotion URL' });
});
