// Quality Filtering Tests - Tests master-playlist variant filtering

const { test } = require('node:test');
const assert = require('assert');
const { filterMasterPlaylist } = require('../lib/proxy');

function check(name, condition, detail) {
    test(name, () => assert.ok(condition, detail));
}

// A Twitch-style master playlist with VIDEO media groups + variants.
const twitchMaster = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-edge-1"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO="chunked"
https://cdn.example.com/chunked/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,VIDEO="720p60"
https://cdn.example.com/720p60/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p",AUTOSELECT=YES,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=852x480,FRAME-RATE=30.000,VIDEO="480p30"
https://cdn.example.com/480p30/index.m3u8`;

// --- highest (default) keeps only the top-bandwidth variant ---
{
    const out = filterMasterPlaylist(twitchMaster, 'highest');
    const streamInfs = (out.match(/#EXT-X-STREAM-INF/g) || []).length;
    check('highest keeps exactly one variant', streamInfs === 1, `found ${streamInfs}`);
    check('highest keeps the 1080 variant', out.includes('chunked/index.m3u8') && !out.includes('720p60/index.m3u8'));
    check('highest drops orphaned 720p MEDIA line', !out.includes('GROUP-ID="720p60"'));
    check('highest keeps the referenced chunked MEDIA line', out.includes('GROUP-ID="chunked"'));
    check('highest preserves header tags', out.includes('#EXTM3U') && out.includes('#EXT-X-TWITCH-INFO'));
}

// --- absent/empty quality defaults to highest ---
{
    const out = filterMasterPlaylist(twitchMaster, '');
    check('empty quality defaults to highest', out.includes('chunked/index.m3u8') && !out.includes('720p60/index.m3u8'));
    const undef = filterMasterPlaylist(twitchMaster, undefined);
    check('undefined quality defaults to highest', undef.includes('chunked/index.m3u8') && !undef.includes('480p30/index.m3u8'));
}

// --- specific height selects that variant ---
{
    const out = filterMasterPlaylist(twitchMaster, '720');
    check('720 keeps only the 720 variant', out.includes('720p60/index.m3u8') && !out.includes('chunked/index.m3u8') && !out.includes('480p30/index.m3u8'));
    check('720 keeps its referenced MEDIA group', out.includes('GROUP-ID="720p60"') && !out.includes('GROUP-ID="chunked"'));
}

// --- nearest height when exact not present ---
{
    const out = filterMasterPlaylist(twitchMaster, '650'); // 480 (Δ170) vs 720 (Δ70) -> nearest 720
    check('nearest height picks closest variant (650 -> 720)', out.includes('720p60/index.m3u8'));
}

// --- auto returns playlist unchanged ---
{
    const out = filterMasterPlaylist(twitchMaster, 'auto');
    check('auto leaves all variants intact', (out.match(/#EXT-X-STREAM-INF/g) || []).length === 3);
}

// --- media playlist (no variants) returned unchanged ---
{
    const media = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
seg1.ts
#EXTINF:4.0,
seg2.ts
#EXT-X-ENDLIST`;
    const out = filterMasterPlaylist(media, 'highest');
    check('media playlist passes through unchanged', out === media);
}

// --- separate AUDIO group is preserved for the chosen variant ---
{
    const withAudio = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="aud"
hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"
lo.m3u8`;
    const out = filterMasterPlaylist(withAudio, 'highest');
    check('audio group preserved for chosen variant', out.includes('GROUP-ID="aud"') && out.includes('hi.m3u8') && !out.includes('lo.m3u8'));
}

// --- 'highest' skips 4K H.264, which cast receivers cannot decode ---
{
    // Periscope/X shape: top rendition is 3840x2160 H.264.
    const h264_4k = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"
v2160.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
v1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2750000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
v720.m3u8`;

    const out = filterMasterPlaylist(h264_4k, 'highest');
    check('highest skips 4K H.264 and picks 1080p', out.includes('v1080.m3u8') && !out.includes('v2160.m3u8'));

    const explicit = filterMasterPlaylist(h264_4k, '2160');
    check('explicit 2160 still honours the user choice', explicit.includes('v2160.m3u8') && !explicit.includes('v1080.m3u8'));

    // 4K is fine in codecs receivers actually decode at that size.
    const hevc4k = h264_4k.replace('avc1.640033', 'hvc1.1.6.L153.90');
    const hevcOut = filterMasterPlaylist(hevc4k, 'highest');
    check('highest keeps 4K HEVC', hevcOut.includes('v2160.m3u8'));

    // Don't break a stream whose only rendition is 4K H.264.
    const only4k = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS="avc1.640033"
only.m3u8`;
    check('4K H.264 still served when it is the only variant',
        filterMasterPlaylist(only4k, 'highest').includes('only.m3u8'));

    // No CODECS attribute means no claim to act on — behave as before.
    const noCodecs = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160
a.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
b.m3u8`;
    check('variants without CODECS are unaffected',
        filterMasterPlaylist(noCodecs, 'highest').includes('a.m3u8'));

    // 1080p H.264 is the common case and must not be caught by the guard.
    check('1080p H.264 is still eligible for highest',
        filterMasterPlaylist(twitchMaster, 'highest').includes('chunked/index.m3u8'));
}

// YouTube's shape: H.264 up to 1080p and VP9 up to 4K, audio as renditions.
const youtubeMaster = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:URI="https://yt.example/audio/233.m3u8",TYPE=AUDIO,GROUP-ID="233",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-MEDIA:URI="https://yt.example/audio/234.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="Default",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="234"
https://yt.example/h264/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4200000,CODECS="vp09.00.41.08,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="234"
https://yt.example/vp9/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,CODECS="vp09.00.41.08,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60,AUDIO="234"
https://yt.example/vp9/1080-hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=20000000,CODECS="vp09.00.51.08,mp4a.40.2",RESOLUTION=3840x2160,FRAME-RATE=60,AUDIO="234"
https://yt.example/vp9/2160.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4D4015,mp4a.40.5",RESOLUTION=426x240,FRAME-RATE=30,AUDIO="233"
https://yt.example/h264/240.m3u8`;

// --- VP9/AV1 beside H.264: the automatic pick takes the codec every receiver has ---
{
    const out = filterMasterPlaylist(youtubeMaster, 'highest');
    check('highest prefers H.264 1080p over VP9 4K', out.includes('h264/1080.m3u8') && !out.includes('vp9/'));
    check('highest keeps the chosen variant\'s audio rendition', out.includes('GROUP-ID="234"'));
    const converted = filterMasterPlaylist(youtubeMaster, 'highest', { convertible: true });
    check('a converted pick is H.264 too', converted.includes('h264/1080.m3u8') && !converted.includes('vp9/'));
}

// --- an explicit height breaks ties toward H.264, and still reaches VP9-only heights ---
{
    const tie = filterMasterPlaylist(youtubeMaster, '1080');
    check('1080 picks the H.264 variant over higher-bandwidth VP9', tie.includes('h264/1080.m3u8') && !tie.includes('vp9/'));
    const uhd = filterMasterPlaylist(youtubeMaster, '2160');
    check('2160 picks the VP9 4K variant', uhd.includes('vp9/2160.m3u8') && !uhd.includes('h264/'));
}

// --- VP9 only: still played ---
{
    const vp9Only = youtubeMaster.split('\n').filter((line, i, lines) =>
        !line.includes('avc1') && !(lines[i - 1] || '').includes('avc1')).join('\n');
    const out = filterMasterPlaylist(vp9Only, 'highest');
    check('with no H.264 variant, highest takes the top VP9 one', out.includes('vp9/2160.m3u8'));
}

// --- auto: only variants a Cast receiver can switch between ---
{
    const out = filterMasterPlaylist(youtubeMaster, 'auto');
    check('auto drops VP9 beside H.264', !out.includes('vp9/'));
    check('auto keeps the H.264 variants sharing the best one\'s audio', out.includes('h264/1080.m3u8') && !out.includes('h264/240.m3u8'));
    check('auto keeps that audio rendition only', out.includes('GROUP-ID="234"') && !out.includes('GROUP-ID="233"'));
    const sameAudio = youtubeMaster.replace('AUDIO="233"', 'AUDIO="234"');
    const vp9Free = sameAudio.split('\n').filter((line, i, lines) =>
        !line.includes('vp09') && !(lines[i - 1] || '').includes('vp09')).join('\n');
    check('auto leaves a master of one codec and one audio rendition unchanged', filterMasterPlaylist(vp9Free, 'auto') === vp9Free);
}
