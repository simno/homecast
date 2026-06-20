// Quality Filtering Tests - Tests master-playlist variant filtering

const { filterMasterPlaylist } = require('../lib/proxy');

console.log('Running Quality Filtering Tests...\n');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        console.log(`✓ ${name}`);
        passed++;
    } else {
        console.log(`❌ ${name}`);
        if (detail) console.log(`   ${detail}`);
        failed++;
    }
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

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
