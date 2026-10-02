const cheerio = require('cheerio');
const { pickVariant } = require('./proxy');

// MPEG-DASH support: reading an MPD for the extractor, and rewriting it so a
// cast receiver fetches everything through our proxy.
//
// HLS references are whole URLs, so the proxy can wrap each one in
// /proxy?url=... . DASH can't be done that way: segment URLs are templates
// (seg-$Number$.m4s) the receiver fills in itself, and they resolve against
// a chain of BaseURLs. So DASH gets a path-shaped proxy space instead:
//
//   https://cdn.example/v/seg-$Number$.m4s
//     -> http://<us>/proxy/dash/<token>/v/seg-$Number$.m4s
//
// The token carries only the upstream origin (and Referer); the path and
// query ride along unchanged, so relative resolution and template
// substitution behave exactly as they would against the CDN.

const DASH_PATH_PREFIX = '/proxy/dash/';

// Attributes that hold URLs (SegmentTemplate, SegmentList, SegmentBase, xlink).
const URL_ATTRS = ['media', 'initialization', 'index', 'sourceURL', 'xlink:href'];

function localName(el) {
    return (el.name || '').replace(/^.*:/, '');
}

function childElements(el) {
    return (el.children || []).filter(c => c.type === 'tag');
}

// The DOM is kept in raw (entity-encoded) form so serialisation leaves `$`
// and everything else exactly as written; we decode on read, encode on write.
function xmlDecode(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

function xmlEncode(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textOf(el) {
    return xmlDecode((el.children || []).filter(c => c.type === 'text').map(c => c.data).join('')).trim();
}

function loadMpd(xml) {
    if (typeof xml !== 'string' || !/<(?:\w+:)?MPD[\s>]/.test(xml)) return null;
    const $ = cheerio.load(xml, { xml: { decodeEntities: false } });
    const root = $.root().children().toArray().find(el => localName(el) === 'MPD');
    return root ? { $, root } : null;
}

function allElements(root) {
    const out = [];
    const walk = (el) => {
        out.push(el);
        childElements(el).forEach(walk);
    };
    walk(root);
    return out;
}

function attr(el, name) {
    const v = el.attribs?.[name];
    return v === undefined ? undefined : xmlDecode(v);
}

// Video Representations with their effective attributes (a Representation
// inherits height/codecs/mimeType from its AdaptationSet).
function videoRepresentations(root) {
    const reps = [];
    for (const set of allElements(root).filter(el => localName(el) === 'AdaptationSet')) {
        for (const rep of childElements(set).filter(el => localName(el) === 'Representation')) {
            const get = (name) => attr(rep, name) ?? attr(set, name);
            const mime = get('mimeType') || '';
            const contentType = attr(set, 'contentType') || '';
            const height = parseInt(get('height') || '0', 10) || 0;
            const isVideo = contentType === 'video' || mime.startsWith('video/') || (height > 0 && !mime.startsWith('audio/'));
            if (!isVideo) continue;
            reps.push({
                el: rep,
                set,
                height,
                width: parseInt(get('width') || '0', 10) || 0,
                bandwidth: parseInt(attr(rep, 'bandwidth') || '0', 10) || 0,
                codecs: get('codecs') || '',
                frameRate: get('frameRate') || ''
            });
        }
    }
    return reps;
}

function frameRateOf(value) {
    if (!value) return null;
    const [num, den] = value.split('/').map(Number);
    const fps = den ? num / den : num;
    return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : null;
}

// Text AdaptationSets (subtitles/captions), as [{ language, label }]: WebVTT
// or TTML, as sidecar files or in fMP4 (wvtt/stpp). The receiver lists these
// as text tracks itself; this is only so the UI can offer them before casting.
function textTracksOf(root) {
    const out = [];
    const seen = new Set();
    for (const set of allElements(root).filter(el => localName(el) === 'AdaptationSet')) {
        const rep = childElements(set).find(el => localName(el) === 'Representation');
        const get = (name) => attr(set, name) ?? (rep && attr(rep, name));
        const mime = get('mimeType') || '';
        const codecs = get('codecs') || '';
        const isText = attr(set, 'contentType') === 'text' || /^text\/|ttml/.test(mime) || /^(?:wvtt|stpp)/.test(codecs);
        if (!isText) continue;
        const language = get('lang') || null;
        const labelEl = childElements(set).find(el => localName(el) === 'Label');
        const label = (labelEl && textOf(labelEl)) || get('label') || language;
        if (!label) continue;
        const key = `${language}|${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ language, label });
    }
    return out;
}

// Audio AdaptationSets in a language, as [{ el, language, label, main }].
// `main`: its Role is "main", how an MPD marks the original audio.
function audioSets(root) {
    const out = [];
    for (const set of allElements(root).filter(el => localName(el) === 'AdaptationSet')) {
        const rep = childElements(set).find(el => localName(el) === 'Representation');
        const get = (name) => attr(set, name) ?? (rep && attr(rep, name));
        const isAudio = attr(set, 'contentType') === 'audio' || /^audio\//.test(get('mimeType') || '');
        const language = get('lang') || null;
        if (!isAudio || !language) continue;
        const labelEl = childElements(set).find(el => localName(el) === 'Label');
        const main = childElements(set).some(el => localName(el) === 'Role' && attr(el, 'value') === 'main');
        out.push({ el: set, language, label: (labelEl && textOf(labelEl)) || get('label') || language, main });
    }
    return out;
}

// The audio languages an MPD offers, one per language and label, for the UI:
// [{ language, label, default }].
function audioTracksOf(root) {
    const seen = new Set();
    return audioSets(root)
        .filter(({ language, label }) => !seen.has(`${language}|${label}`) && seen.add(`${language}|${label}`))
        .map(({ language, label, main }) => ({ language, label, default: main }));
}

const baseLanguage = (tag) => (tag || '').toLowerCase().split(/[-_]/)[0];

// Keep only the audio in `language` (exact, then the same base language),
// when the MPD has it. Audio in no stated language stays.
function filterAudioLanguage($, root, language) {
    if (!language) return;
    const sets = audioSets(root);
    const wanted = language.toLowerCase();
    let keep = sets.filter(s => s.language.toLowerCase() === wanted);
    if (keep.length === 0) keep = sets.filter(s => baseLanguage(s.language) === baseLanguage(wanted));
    if (keep.length === 0) return;
    for (const s of sets) if (!keep.includes(s)) $(s.el).remove();
}

// What the extractor needs to know about an MPD. Returns null if `xml`
// isn't one. Qualities use the same shape as HLS ({ value, label, height,
// bandwidth }), highest first.
function describeMpd(xml) {
    const doc = loadMpd(xml);
    if (!doc) return null;
    const { root } = doc;

    const seen = new Set();
    const qualities = videoRepresentations(root)
        .filter(r => r.height > 0)
        .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)
        .filter(r => !seen.has(r.height) && seen.add(r.height))
        .map(r => {
            const fps = frameRateOf(r.frameRate);
            return {
                value: String(r.height),
                label: `${r.height}p${fps && fps > 30 ? fps : ''}`,
                height: r.height,
                bandwidth: r.bandwidth
            };
        });

    return {
        live: attr(root, 'type') === 'dynamic',
        // Any ContentProtection means encrypted media; the default receiver
        // has no licence server to ask.
        drm: allElements(root).some(el => localName(el) === 'ContentProtection'),
        qualities,
        subtitles: textTracksOf(root),
        audio: audioTracksOf(root)
    };
}

// Keep one video Representation for the requested quality, the same way the
// HLS path keeps one variant (see pickVariant). Audio and text are untouched.
// `convertible`: the receiver plays every variant (an LG TV), so 'highest'
// may pick one a Chromecast couldn't decode.
function filterVideoQuality($, root, quality, convertible) {
    if (quality === 'auto') return;
    const reps = videoRepresentations(root);
    if (reps.length < 2) return;
    const chosen = pickVariant(reps, quality || 'highest', { convertible });
    for (const r of reps) {
        if (r !== chosen) $(r.el).remove();
    }
    for (const set of new Set(reps.map(r => r.set))) {
        if (!childElements(set).some(el => localName(el) === 'Representation')) $(set).remove();
    }
}

function resolveHttp(ref, base) {
    try {
        const u = new URL(ref, base);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
        return null;
    }
}

// A reference that would escape the proxy space if left as written:
// absolute, protocol-relative or root-relative.
function escapesProxySpace(ref) {
    return /^[a-z][a-z0-9+.-]*:|^\//i.test(ref);
}

// Rewrite an MPD so every fetch it implies goes through the proxy.
//   toSegmentUrl(absUrl)  -> proxy URL for media/init segments and BaseURLs
//   toManifestUrl(absUrl) -> proxy URL for a refreshed MPD (<Location>)
// Returns the new XML, or null if `xml` isn't an MPD.
function rewriteMpd(xml, mpdUrl, { quality = 'highest', convertible = false, audioLanguage = null, toSegmentUrl, toManifestUrl }) {
    const doc = loadMpd(xml);
    if (!doc) return null;
    const { $, root } = doc;

    filterVideoQuality($, root, quality, convertible);
    filterAudioLanguage($, root, audioLanguage);

    // Collect first, edit after: every resolution must see the original values.
    const textEdits = [];
    const attrEdits = [];
    const walk = (el, inherited) => {
        const kids = childElements(el);
        let base = inherited;
        // Several BaseURLs are CDN alternatives; the first sets the context.
        kids.filter(k => localName(k) === 'BaseURL').forEach((b, i) => {
            const abs = resolveHttp(textOf(b), inherited);
            if (!abs) return;
            textEdits.push([b, toSegmentUrl(abs)]);
            if (i === 0) base = abs;
        });
        for (const name of URL_ATTRS) {
            const value = attr(el, name);
            if (!value || !escapesProxySpace(value)) continue;
            const abs = resolveHttp(value, base);
            if (abs) attrEdits.push([el, name, toSegmentUrl(abs)]);
        }
        kids.filter(k => localName(k) !== 'BaseURL').forEach(k => walk(k, base));
    };
    walk(root, mpdUrl);

    for (const loc of childElements(root).filter(el => localName(el) === 'Location')) {
        const abs = resolveHttp(textOf(loc), mpdUrl);
        if (abs) textEdits.push([loc, toManifestUrl(abs)]);
    }

    for (const [el, url] of textEdits) $(el).text(xmlEncode(url));
    for (const [el, name, url] of attrEdits) el.attribs[name] = xmlEncode(url);

    // Relative references with no BaseURL above them resolve against the MPD's
    // own URL — which on the receiver is /proxy?url=..., the wrong place. Give
    // them the MPD's upstream directory, in proxy space.
    if (!childElements(root).some(el => localName(el) === 'BaseURL')) {
        const baseEl = `<BaseURL>${xmlEncode(toSegmentUrl(new URL('.', mpdUrl).href))}</BaseURL>`;
        const programInfo = childElements(root).filter(el => localName(el) === 'ProgramInformation').pop();
        if (programInfo) $(programInfo).after(baseEl);
        else $(root).prepend(baseEl);
    }

    return $.xml();
}

// --- Proxy-space URLs ---

function encodeDashToken({ origin, referer }) {
    const payload = referer ? { o: origin, r: referer } : { o: origin };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeDashToken(token) {
    try {
        const { o, r } = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        const origin = new URL(o);
        if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
        return { origin: origin.origin, referer: typeof r === 'string' ? r : '' };
    } catch {
        return null;
    }
}

// http://<host>/proxy/dash/<token>/<upstream path + query>
function dashSegmentUrl(host, absUrl, referer) {
    const u = new URL(absUrl);
    return `http://${host}${DASH_PATH_PREFIX}${encodeDashToken({ origin: u.origin, referer })}${u.pathname}${u.search}`;
}

// The upstream URL for a /proxy/dash/... request path (with query), or null.
function upstreamFromDashPath(originalUrl) {
    const m = originalUrl.match(/^\/proxy\/dash\/([A-Za-z0-9_-]+)(\/[^?#]*)(\?[^#]*)?$/);
    if (!m) return null;
    const token = decodeDashToken(m[1]);
    if (!token) return null;
    return { url: token.origin + m[2] + (m[3] || ''), referer: token.referer };
}

module.exports = {
    describeMpd,
    rewriteMpd,
    dashSegmentUrl,
    upstreamFromDashPath,
    encodeDashToken,
    decodeDashToken
};
