// Audio in several languages (lib/proxy.js parseHlsAudio, selectAudio;
// lib/dash.js): the one picked, else a YouTube video's original over its dubs.
const { test } = require('node:test');
const assert = require('assert');
const { parseHlsAudio, selectAudio } = require('../lib/proxy');
const dash = require('../lib/dash');
const { parseCastRequest } = require('../lib/dispatch');

// selectAudio with nothing picked.
const keepOriginalAudio = (m3u8) => selectAudio(m3u8);

const rendition = (group, lang, name, extra = 'DEFAULT=NO,AUTOSELECT=YES') =>
    `#EXT-X-MEDIA:URI="/a/${group}/${lang}.m3u8",TYPE=AUDIO,GROUP-ID="${group}",LANGUAGE="${lang}",NAME="${name}",${extra}`;

// As YouTube lists them: the dubs first, the original last, none the default.
const dubbed = [
    '#EXTM3U',
    rendition('233', 'ar', 'العربية - dubbed-auto'),
    rendition('233', 'de-DE', 'Deutsch (Deutschland) - dubbed-auto'),
    rendition('233', 'en-US', 'American English - original'),
    rendition('234', 'ar', 'العربية - dubbed-auto'),
    rendition('234', 'en-US', 'American English - original'),
    '#EXT-X-STREAM-INF:BANDWIDTH=362356,CODECS="avc1.4D4015,mp4a.40.5",AUDIO="233"',
    '/v/240.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=816634,CODECS="avc1.4D401E,mp4a.40.2",AUDIO="234"',
    '/v/360.m3u8'
].join('\n');

const audioLines = (m3u8) => m3u8.split('\n').filter(l => l.startsWith('#EXT-X-MEDIA'));

test('each audio group keeps only the original, as the default', () => {
    const lines = audioLines(keepOriginalAudio(dubbed));
    assert.strictEqual(lines.length, 2);
    for (const line of lines) {
        assert.match(line, /LANGUAGE="en-US"/);
        assert.match(line, /DEFAULT=YES/);
    }
    assert.match(keepOriginalAudio(dubbed), /\/v\/240\.m3u8\n#EXT-X-STREAM-INF.*\n\/v\/360\.m3u8$/);
});

test('the original is found by its YT-EXT-XTAGS when its name is translated', () => {
    const xtags = (acont) => Buffer.from(`\n\n\nacont${acont}`).toString('base64');
    const master = ['#EXTM3U',
        rendition('233', 'ar', 'العربية', `YT-EXT-XTAGS="${xtags('dubbed-auto')}",DEFAULT=NO`),
        rendition('233', 'en-US', 'American English', `YT-EXT-XTAGS="${xtags('original')}",DEFAULT=NO`),
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="233"', '/v.m3u8'].join('\n');
    const lines = audioLines(keepOriginalAudio(master));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /LANGUAGE="en-US".*DEFAULT=YES/);
});

test('a group that already has a default is left as it is', () => {
    const master = ['#EXTM3U',
        rendition('a', 'en', 'English', 'DEFAULT=YES,AUTOSELECT=YES'),
        rendition('a', 'fr', 'Français - original'),
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '/v.m3u8'].join('\n');
    assert.strictEqual(keepOriginalAudio(master), master);
});

test('languages with none marked original are left as they are', () => {
    const master = ['#EXTM3U', rendition('a', 'en', 'English'), rendition('a', 'fr', 'Français'),
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '/v.m3u8'].join('\n');
    assert.strictEqual(keepOriginalAudio(master), master);
});

test('an original with no DEFAULT attribute gets one; CRLF line ends survive', () => {
    const master = ['#EXTM3U', rendition('a', 'ar', 'ar - dubbed-auto', 'AUTOSELECT=YES'),
        rendition('a', 'en', 'English - original', 'AUTOSELECT=YES'),
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '/v.m3u8', ''].join('\r\n');
    const out = keepOriginalAudio(master);
    assert.match(out, /NAME="English - original",AUTOSELECT=YES,DEFAULT=YES\r\n/);
    assert.ok(!out.includes('LANGUAGE="ar"'));
});

test('a media playlist passes unchanged', () => {
    const media = '#EXTM3U\n#EXTINF:5,\nseg1.ts\n#EXT-X-ENDLIST';
    assert.strictEqual(keepOriginalAudio(media), media);
});

// ===== Picking a language =====

test('the language picked is kept in each group, as the default', () => {
    const lines = audioLines(selectAudio(dubbed, 'de-DE'));
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /GROUP-ID="233",LANGUAGE="de-DE".*DEFAULT=YES/);
    // Group 234 has no German: its original stays.
    assert.match(lines[1], /GROUP-ID="234",LANGUAGE="en-US".*DEFAULT=YES/);
    const out = selectAudio(dubbed, 'ar');
    assert.deepStrictEqual(audioLines(out).map(l => l.match(/GROUP-ID="(\d+)",LANGUAGE="([^"]+)"/).slice(1).join(' ')), ['233 ar', '234 ar']);
});

test('a picked language matches by base language, and overrides an existing default', () => {
    const master = ['#EXTM3U',
        rendition('a', 'en', 'English', 'DEFAULT=YES,AUTOSELECT=YES'),
        rendition('a', 'fr-CA', 'Français'),
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"', '/v.m3u8'].join('\n');
    const lines = audioLines(selectAudio(master, 'fr'));
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /LANGUAGE="fr-CA".*DEFAULT=YES/);
});

test('a language the master doesn\'t have leaves it to the original', () => {
    assert.deepStrictEqual(audioLines(selectAudio(dubbed, 'sv')), audioLines(keepOriginalAudio(dubbed)));
});

test('the languages on offer: one per rendition, with YouTube\'s original and dubs flagged', () => {
    assert.deepStrictEqual(parseHlsAudio(dubbed), [
        { language: 'ar', label: 'العربية', default: false, original: false, dubbed: true },
        { language: 'de-DE', label: 'Deutsch (Deutschland)', default: false, original: false, dubbed: true },
        { language: 'en-US', label: 'American English', default: false, original: true, dubbed: false }
    ]);
    assert.deepStrictEqual(parseHlsAudio('#EXTM3U\n#EXTINF:5,\nseg.ts'), []);
});

// ===== DASH =====

const multiAudioMpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1" width="1280" height="720"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="en" bandwidth="1"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="nl"><Label>Nederlands</Label><Representation id="nl" bandwidth="1"/></AdaptationSet>
  </Period>
</MPD>`;

test('an MPD\'s audio languages are listed, its main one as the default', () => {
    assert.deepStrictEqual(dash.describeMpd(multiAudioMpd).audio, [
        { language: 'en', label: 'en', default: true },
        { language: 'nl', label: 'Nederlands', default: false }
    ]);
});

test('an MPD keeps only the audio language picked, or all of them with none picked', () => {
    const rewrite = (audioLanguage) => dash.rewriteMpd(multiAudioMpd, 'https://cdn.example/m.mpd', {
        audioLanguage, toSegmentUrl: (u) => u, toManifestUrl: (u) => u
    });
    assert.deepStrictEqual(dash.describeMpd(rewrite('nl')).audio.map(a => a.language), ['nl']);
    assert.deepStrictEqual(dash.describeMpd(rewrite('sv')).audio.map(a => a.language), ['en', 'nl']);
    assert.deepStrictEqual(dash.describeMpd(rewrite(null)).audio.map(a => a.language), ['en', 'nl']);
});

// ===== The cast request =====

test('a cast carries the audio language and SponsorBlock categories picked', () => {
    const base = { ip: '10.0.0.5', url: 'https://cdn.example/master.m3u8' };
    const { cast } = parseCastRequest({ ...base, audio: 'pt-BR', sponsorBlock: ['sponsor', 'intro', 'sponsor'] });
    assert.strictEqual(cast.audio, 'pt-BR');
    assert.deepStrictEqual(cast.sponsorBlock, ['sponsor', 'intro']);
    const plain = parseCastRequest(base).cast;
    assert.strictEqual(plain.audio, null);
    assert.strictEqual(plain.sponsorBlock, undefined);
    assert.deepStrictEqual(parseCastRequest({ ...base, sponsorBlock: [] }).cast.sponsorBlock, []);
    assert.match(parseCastRequest({ ...base, audio: 'en"><script>' }).error, /audio language/);
    assert.match(parseCastRequest({ ...base, sponsorBlock: ['ads'] }).error, /SponsorBlock/);
    assert.match(parseCastRequest({ ...base, sponsorBlock: 'sponsor' }).error, /SponsorBlock/);
});
