const axios = require('axios');

// --- Helper: Try Next Segment ---
async function tryNextSegment(currentUrl) {
    try {
        const match = currentUrl.match(/(\d+)\.(?:ts|m4s|mp4)(\?.*)?$/);
        if (!match) return null;

        const segmentNumber = parseInt(match[1]);
        const nextSegmentNumber = segmentNumber + 1;
        const nextUrl = currentUrl.replace(`${segmentNumber}.`, `${nextSegmentNumber}.`);

        const response = await axios({
            method: 'head',
            url: nextUrl,
            timeout: 1000,
            validateStatus: (status) => status < 500
        });

        if (response.status === 200) {
            console.log(`[Proxy] Next segment exists (${nextSegmentNumber}), skipping missing segment ${segmentNumber}`);
            return nextUrl;
        }
    } catch {
        // Next segment doesn't exist or error checking
    }
    return null;
}

// --- Helper: Parse #EXT-X-STREAM-INF attributes ---
// Returns a plain object of the comma-separated KEY=VALUE pairs, with any
// surrounding double-quotes stripped from the value.
function parseStreamInfAttrs(line) {
    const attrs = {};
    const body = line.slice(line.indexOf(':') + 1);
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        let value = m[2];
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        attrs[m[1]] = value;
    }
    return attrs;
}

// --- Helper: Filter a master playlist down to a single quality variant ---
// `quality` is one of:
//   'auto'                  -> return the playlist unchanged (receiver picks via ABR)
//   'highest' / '' / undef  -> keep only the highest-BANDWIDTH variant
//   a height string ('1080')-> keep the variant with that RESOLUTION height,
//                              or the nearest available height if absent
// A media playlist (no #EXT-X-STREAM-INF) is returned unchanged, so this is
// safe to call on every playlist the proxy serves.
function filterMasterPlaylist(m3u8, quality) {
    if (quality === 'auto') return m3u8;
    if (!/#EXT-X-STREAM-INF/i.test(m3u8)) return m3u8;

    const lines = m3u8.split('\n');

    // Collect each variant as the STREAM-INF line paired with the next
    // non-comment URI line that follows it.
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
        let uriIndex = -1;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t === '' || t.startsWith('#')) continue;
            uriIndex = j;
            break;
        }
        if (uriIndex === -1) continue;
        const attrs = parseStreamInfAttrs(lines[i]);
        const resolution = attrs.RESOLUTION || '';
        const height = resolution.includes('x') ? parseInt(resolution.split('x')[1], 10) : 0;
        variants.push({
            infIndex: i,
            uriIndex,
            attrs,
            height: Number.isFinite(height) ? height : 0,
            bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) || 0
        });
    }

    if (variants.length === 0) return m3u8;

    let chosen;
    const target = parseInt(quality, 10);
    if (Number.isFinite(target) && target > 0) {
        // Nearest height; break ties by higher bandwidth.
        chosen = variants.reduce((best, v) => {
            const dBest = Math.abs(best.height - target);
            const dV = Math.abs(v.height - target);
            if (dV < dBest) return v;
            if (dV === dBest && v.bandwidth > best.bandwidth) return v;
            return best;
        });
    } else {
        // 'highest' (default): max bandwidth, tie-break on height.
        chosen = variants.reduce((best, v) => {
            if (v.bandwidth > best.bandwidth) return v;
            if (v.bandwidth === best.bandwidth && v.height > best.height) return v;
            return best;
        });
    }

    // Groups the chosen variant references — used to drop now-orphaned
    // #EXT-X-MEDIA renditions (audio/video/subtitle) for other variants.
    const keepGroups = new Set();
    for (const key of ['VIDEO', 'AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS']) {
        const g = chosen.attrs[key];
        if (g && g !== 'NONE') keepGroups.add(g);
    }

    const dropIndices = new Set();
    for (const v of variants) {
        if (v === chosen) continue;
        dropIndices.add(v.infIndex);
        dropIndices.add(v.uriIndex);
    }

    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (dropIndices.has(i)) continue;
        const trimmed = lines[i].trim();
        if (/^#EXT-X-MEDIA/i.test(trimmed)) {
            const groupMatch = trimmed.match(/GROUP-ID="([^"]*)"/i);
            if (groupMatch && !keepGroups.has(groupMatch[1])) continue;
        }
        out.push(lines[i]);
    }

    return out.join('\n');
}

// --- Helper: Resolve M3U8 URLs ---
function resolveM3u8Url(line, baseUrl) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
        return { isUrl: false, url: null };
    }

    try {
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            new URL(trimmed);
            return { isUrl: true, url: trimmed };
        }

        if (trimmed.startsWith('//')) {
            const absoluteUrl = baseUrl.protocol + trimmed;
            new URL(absoluteUrl);
            return { isUrl: true, url: absoluteUrl };
        }

        const absoluteUrl = new URL(trimmed, baseUrl).href;
        return { isUrl: true, url: absoluteUrl };
    } catch {
        console.log(`[Proxy] Failed to parse URL: ${trimmed.substring(0, 100)}`);
        return { isUrl: false, url: null };
    }
}

module.exports = { tryNextSegment, resolveM3u8Url, filterMasterPlaylist };
