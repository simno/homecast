// The audio picker in the compose form, for a stream with audio in more than
// one language (YouTube's dubbed videos, multi-language broadcasts). The
// proxy keeps the one picked (lib/proxy.js selectAudio, lib/dash.js).
import { audioSelectRow, audioSelect, audioNote, useProxyCheckbox } from './dom.js';
import { languageName } from './subtitles.js';

let offered = []; // the selected video's audio tracks, indexed by option value

// "English (original)", "Deutsch (Deutschland) (auto-dubbed)"; a label that
// is only the language tag gets the language's name instead.
function audioLabel({ label, language, original, dubbed }) {
    const name = label && label !== language ? label : languageName(language) || label || 'Audio';
    return name + (original ? ' (original)' : '') + (dubbed ? ' (auto-dubbed)' : '');
}

// Fill the picker for a stream about to be cast to a device of `deviceType`.
// Defaults to the original audio, else the stream's own default.
export function populateAudioOptions(video, deviceType) {
    offered = video?.audioTracks || [];
    audioSelect.innerHTML = '';
    audioSelectRow.classList.toggle('hidden', offered.length < 2);
    if (offered.length < 2) return;

    offered.forEach((track, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = audioLabel(track);
        audioSelect.appendChild(opt);
    });
    const original = offered.findIndex(t => t.original);
    const fallback = offered.findIndex(t => t.default);
    audioSelect.value = String(original !== -1 ? original : Math.max(fallback, 0));
    renderAudioNote(deviceType);
}

// An LG TV always plays through the proxy; the others only with it on.
export function renderAudioNote(deviceType) {
    audioNote.classList.toggle('hidden', useProxyCheckbox.checked || deviceType === 'webos');
}

// The language tag to cast with, or null to leave it to the stream.
export function selectedAudio() {
    if (audioSelectRow.classList.contains('hidden')) return null;
    return offered[Number(audioSelect.value)]?.language || null;
}
