// Subtitle pickers: one in the compose form (what to cast with) and one on
// the dashboard (switch or turn off while playing, Chromecast only).
import {
    subtitleSelectRow, subtitleSelect, subtitleUrlInput, subtitleNote,
    dashboardSubtitles, dashboardSubtitleSelect
} from './dom.js';
import { state } from './state.js';
import { apiPost } from './api.js';
import { updateStatus } from './status.js';

const OFF = 'off';
const FROM_URL = 'url';
const PREF_KEY = 'homecast_subtitle_language';

let languageNames = null;
try {
    languageNames = new Intl.DisplayNames([navigator.language, 'en'], { type: 'language' });
} catch { /* old browser: raw tags it is */ }

function languageName(tag) {
    if (!tag || tag === 'und') return null;
    try {
        return languageNames?.of(tag) || tag;
    } catch {
        return tag; // not a valid BCP 47 tag
    }
}

// "English", "Deutsch (CC)"; a label that is only the language tag ('de')
// gets the language's name instead.
function trackLabel({ label, name, language }) {
    const text = label || name;
    if (text && text !== language) return text;
    return languageName(language) || text || 'Subtitles';
}

// The last subtitle language actually cast with (null = off), so the next
// video defaults to it. A per-browser convenience; storage may be blocked.
function preferredLanguage() {
    try {
        return localStorage.getItem(PREF_KEY);
    } catch {
        return null;
    }
}

function rememberLanguage(language) {
    try {
        if (language) localStorage.setItem(PREF_KEY, language);
        else localStorage.removeItem(PREF_KEY);
    } catch { /* not important */ }
}

const baseLanguage = (tag) => (tag || '').toLowerCase().split(/[-_]/)[0];

// ===== COMPOSE PICKER =====

let offered = []; // the selected video's subtitles, indexed by option value

function addOption(select, value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
}

// Fill the picker for a stream about to be cast to a device of `deviceType`.
export function populateSubtitleOptions(video, deviceType) {
    offered = video?.subtitles || [];
    subtitleSelect.innerHTML = '';
    subtitleUrlInput.classList.add('hidden');
    subtitleNote.classList.add('hidden');

    if (!video) {
        subtitleSelectRow.classList.add('hidden');
        return;
    }

    addOption(subtitleSelect, OFF, 'Off');

    // AirPlay 1 has no text tracks: a separate file can't be shown at all, and
    // HLS subtitles are chosen on the Apple TV itself.
    if (deviceType === 'airplay') {
        subtitleSelect.disabled = true;
        const inManifest = offered.some(s => s.source === 'manifest');
        if (offered.length === 0) {
            subtitleSelectRow.classList.add('hidden');
            return;
        }
        subtitleNote.textContent = inManifest
            ? 'On Apple TV, turn subtitles on with the TV remote during playback.'
            : 'Apple TV can\'t show subtitles from a separate file.';
        subtitleNote.classList.remove('hidden');
        subtitleSelectRow.classList.remove('hidden');
        return;
    }

    subtitleSelect.disabled = false;
    offered.forEach((s, i) => addOption(subtitleSelect, String(i), trackLabel(s)));
    addOption(subtitleSelect, FROM_URL, 'From a URL…');

    // Default to the language last cast with: exact tag, then base language.
    const preferred = preferredLanguage()?.toLowerCase();
    let index = -1;
    if (preferred) {
        index = offered.findIndex(s => (s.language || '').toLowerCase() === preferred);
        if (index === -1) index = offered.findIndex(s => baseLanguage(s.language) === baseLanguage(preferred));
    }
    subtitleSelect.value = index === -1 ? OFF : String(index);
    subtitleSelectRow.classList.remove('hidden');
}

function validHttpUrl(value) {
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

// False while "From a URL…" is picked without a usable URL.
export function subtitleChoiceReady() {
    if (subtitleSelectRow.classList.contains('hidden') || subtitleSelect.value !== FROM_URL) return true;
    return validHttpUrl(subtitleUrlInput.value.trim());
}

// The choice as /api/cast takes it: null (off), { url, language, label } to
// sideload, or { language, label } for a rendition inside the manifest.
export function selectedSubtitle() {
    if (subtitleSelectRow.classList.contains('hidden') || subtitleSelect.disabled) return null;
    const value = subtitleSelect.value;
    if (value === OFF) return null;
    if (value === FROM_URL) {
        const url = subtitleUrlInput.value.trim();
        return validHttpUrl(url) ? { url, label: 'Subtitles' } : null;
    }
    const s = offered[Number(value)];
    if (!s) return null;
    const label = trackLabel(s);
    return s.source === 'page' ? { url: s.url, language: s.language, label } : { language: s.language, label };
}

// Called once a cast has started, so only real choices become the default.
export function rememberSubtitleChoice(choice) {
    if (subtitleSelectRow.classList.contains('hidden') || subtitleSelect.disabled) return;
    if (choice?.url && !choice.language) return; // a one-off file says nothing about language
    rememberLanguage(choice?.language || null);
}

// ===== DASHBOARD PICKER =====

// stream.subtitles: { tracks: [{ trackId, name, language }], activeTrackId }
export function renderDashboardSubtitles(stream) {
    const tracks = stream?.subtitles?.tracks || [];
    if (!stream || stream.deviceType === 'airplay' || tracks.length === 0) {
        dashboardSubtitles.classList.add('hidden');
        return;
    }
    dashboardSubtitleSelect.innerHTML = '';
    addOption(dashboardSubtitleSelect, '', 'Subtitles off');
    for (const t of tracks) addOption(dashboardSubtitleSelect, String(t.trackId), trackLabel(t));
    dashboardSubtitleSelect.value = stream.subtitles.activeTrackId === null ? '' : String(stream.subtitles.activeTrackId);
    dashboardSubtitles.classList.remove('hidden');
}

async function switchSubtitles() {
    const ip = state.activeStreamIp;
    const stream = state.streams.get(ip);
    if (!stream) return;
    const trackId = dashboardSubtitleSelect.value === '' ? null : Number(dashboardSubtitleSelect.value);

    dashboardSubtitleSelect.disabled = true;
    try {
        const res = await apiPost('/api/subtitles', { ip, trackId });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        stream.subtitles = data;
        const track = data.tracks.find(t => t.trackId === data.activeTrackId);
        rememberLanguage(track?.language || null);
    } catch (e) {
        console.error('[Subtitles] Switch failed:', e);
        updateStatus(`Could not switch subtitles: ${e.message}`, 'error');
    } finally {
        dashboardSubtitleSelect.disabled = false;
        if (state.activeStreamIp === ip) renderDashboardSubtitles(stream);
    }
}

export function wireSubtitleControls({ onComposeChange }) {
    subtitleSelect.addEventListener('change', () => {
        const fromUrl = subtitleSelect.value === FROM_URL;
        subtitleUrlInput.classList.toggle('hidden', !fromUrl);
        if (fromUrl) subtitleUrlInput.focus();
        onComposeChange();
    });
    subtitleUrlInput.addEventListener('input', onComposeChange);
    dashboardSubtitleSelect.addEventListener('change', switchSubtitles);
}
