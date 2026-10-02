// YouTube through yt-dlp (lib/youtube.js): which URLs go to it, and how its
// answers become streams or messages. A shell script stands in for yt-dlp.
const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isYouTubeUrl, resolveYouTube, pickStreams, pickSubtitles, ytDlpReason } = require('../lib/youtube');

const MASTER = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/abc/file/index.m3u8';
const info = {
    title: 'Big Buck Bunny',
    is_live: false,
    thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg',
    formats: [
        { format_id: '139', protocol: 'https', ext: 'm4a', url: 'https://rr.example/audio', vcodec: 'none', acodec: 'mp4a.40.5' },
        { format_id: '230', protocol: 'm3u8_native', ext: 'mp4', url: 'https://rr.example/230.m3u8', manifest_url: MASTER, vcodec: 'avc1.4D401E', acodec: 'none' },
        { format_id: '18', protocol: 'https', ext: 'mp4', url: 'https://rr.example/18.mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360 },
        { format_id: '137', protocol: 'https', ext: 'mp4', url: 'https://rr.example/137.mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080 }
    ]
};

let dir;
// Points YTDLP_PATH at a script that prints `stdout` and `stderr` and exits with `code`.
function fakeYtDlp(t, { stdout = '', stderr = '', code = 0, sleep = 0 }) {
    const script = path.join(dir, `yt-dlp-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(path.join(dir, 'out.txt'), stdout);
    fs.writeFileSync(script, [
        '#!/bin/sh',
        'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
        sleep ? `sleep ${sleep}` : '',
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

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homecast-ytdlp-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('video pages and channel live pages go to yt-dlp', () => {
    for (const url of [
        'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        'https://m.youtube.com/watch?v=aqz-KE-bpKQ&list=PL1',
        'https://youtu.be/aqz-KE-bpKQ?t=10',
        'https://www.youtube.com/live/mlfzT_nD6GE',
        'https://www.youtube.com/shorts/aqz-KE-bpKQ',
        'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
        'https://www.youtube.com/@NASA/live',
        'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ/live'
    ]) assert.strictEqual(isYouTubeUrl(url), true, url);
});

test('channel, playlist and other pages are not handed to yt-dlp', () => {
    for (const url of [
        'https://www.youtube.com/',
        'https://www.youtube.com/@NASA',
        'https://www.youtube.com/@NASA/videos',
        'https://www.youtube.com/playlist?list=PL1',
        'https://www.youtube.com/watch?v=short',
        'https://youtu.be/',
        'https://notyoutube.com/watch?v=aqz-KE-bpKQ'
    ]) assert.strictEqual(isYouTubeUrl(url), false, url);
});

test('the HLS master comes first, then the best progressive MP4 with sound', () => {
    assert.deepStrictEqual(pickStreams(info), [
        { url: MASTER, type: 'hls' },
        { url: 'https://rr.example/18.mp4', type: 'mp4' }
    ]);
    assert.deepStrictEqual(pickStreams({}), []);
});

test('captions: the uploader\'s, then each audio track\'s speech recognition, original language first; no translations', () => {
    const vtt = (url, name) => [{ ext: 'json3', url: `${url}&fmt=json3`, name }, { ext: 'vtt', url, name }];
    const info = {
        language: 'en-US',
        subtitles: {
            nl: vtt('https://yt/sub?lang=nl', 'Dutch'),
            en: vtt('https://yt/sub?lang=en', 'English'),
            live_chat: [{ ext: 'json', url: 'https://yt/chat' }]
        },
        automatic_captions: {
            'de-orig': vtt('https://yt/asr?lang=de', 'German (Original)'),
            de: vtt('https://yt/asr?lang=ar&tlang=de', 'German'),
            'en-orig': vtt('https://yt/asr?lang=en', 'English (Original)'),
            fr: vtt('https://yt/asr?lang=en&tlang=fr', 'French')
        }
    };
    assert.deepStrictEqual(pickSubtitles(info), [
        { url: 'https://yt/sub?lang=en', language: 'en', label: 'English', auto: false, original: true },
        { url: 'https://yt/sub?lang=nl', language: 'nl', label: 'Dutch', auto: false, original: false },
        { url: 'https://yt/asr?lang=en', language: 'en', label: 'English (auto-generated)', auto: true, original: true },
        { url: 'https://yt/asr?lang=de', language: 'de', label: 'German (auto-generated)', auto: true, original: false }
    ]);
    assert.deepStrictEqual(pickSubtitles({}), []);
});

test('yt-dlp\'s reason is read from its last ERROR line', () => {
    assert.strictEqual(ytDlpReason('WARNING: x\nERROR: [youtube] aqz-KE-bpKQ: Private video. Sign in if you\'ve been granted access\n'),
        'Private video. Sign in if you\'ve been granted access');
    assert.strictEqual(ytDlpReason('ERROR: Unable to download webpage: HTTP Error 429'), 'Unable to download webpage: HTTP Error 429');
    assert.strictEqual(ytDlpReason(''), null);
});

test('a video resolves through yt-dlp, run with Node for YouTube\'s challenges', async (t) => {
    fakeYtDlp(t, { stdout: JSON.stringify(info) });
    const result = await resolveYouTube('https://youtu.be/aqz-KE-bpKQ');
    assert.deepStrictEqual(result, {
        status: 'ok',
        streams: pickStreams(info),
        referer: 'https://www.youtube.com/',
        live: false,
        subtitles: [],
        title: 'Big Buck Bunny',
        thumbnail: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/maxresdefault.jpg'
    });
    const args = lastArgs();
    assert.deepStrictEqual(args.slice(-2), ['--', 'https://youtu.be/aqz-KE-bpKQ'], 'the URL can\'t be read as an option');
    assert.ok(args.includes('--no-playlist'));
    assert.strictEqual(args[args.indexOf('--js-runtimes') + 1], 'node');
});

test('a live stream is live', async (t) => {
    fakeYtDlp(t, { stdout: JSON.stringify({ ...info, is_live: true }) });
    assert.strictEqual((await resolveYouTube('https://www.youtube.com/@NASA/live')).live, true);
});

test('an unplayable video is offline, with yt-dlp\'s reason', async (t) => {
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [youtube] aqz-KE-bpKQ: Private video. Sign in if you\'ve been granted access to this video' });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'), {
        status: 'offline', message: 'YouTube: Private video. Sign in if you\'ve been granted access to this video'
    });
});

test('YouTube\'s bot check is explained, not blamed on yt-dlp', async (t) => {
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser' });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'), {
        status: 'error',
        message: 'YouTube is refusing this server\'s address as a possible bot. That happens to data-centre and VPN addresses'
    });
});

test('any other yt-dlp failure is an error suggesting an update', async (t) => {
    fakeYtDlp(t, { code: 1, stderr: 'ERROR: [youtube] aqz-KE-bpKQ: Signature extraction failed' });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'), {
        status: 'error',
        message: 'yt-dlp couldn\'t read this YouTube video: Signature extraction failed. Updating yt-dlp often fixes this'
    });
});

test('no yt-dlp installed says so', async (t) => {
    const previous = process.env.YTDLP_PATH;
    process.env.YTDLP_PATH = path.join(dir, 'missing-yt-dlp');
    t.after(() => {
        if (previous === undefined) delete process.env.YTDLP_PATH;
        else process.env.YTDLP_PATH = previous;
    });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'), {
        status: 'unavailable', message: 'Playing YouTube needs yt-dlp, which isn\'t installed on the HomeCast server'
    });
});

test('unreadable output, or no stream a TV can play, is an error', async (t) => {
    fakeYtDlp(t, { stdout: 'not json' });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'),
        { status: 'error', message: 'yt-dlp gave an answer HomeCast couldn\'t read' });
    fakeYtDlp(t, { stdout: JSON.stringify({ title: 'Audio', formats: [info.formats[0]] }) });
    assert.deepStrictEqual(await resolveYouTube('https://youtu.be/aqz-KE-bpKQ'),
        { status: 'error', message: 'YouTube offered no stream a TV can play for this video' });
});

test('cancelling stops yt-dlp', async (t) => {
    fakeYtDlp(t, { stdout: JSON.stringify(info), sleep: 5 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = resolveYouTube('https://youtu.be/aqz-KE-bpKQ', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    assert.deepStrictEqual(await pending, { status: 'error', message: 'Cancelled' });
    assert.ok(Date.now() - started < 3000, 'yt-dlp was left running');
});
