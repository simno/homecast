// The compose form: analyze a URL, pick a stream, quality and subtitles, cast.
// In setup mode it's the page; in dashboard mode it opens as an overlay.
import {
    composePanel, composeOverlay, videoUrlInput, analyzeBtn, analyzeBtnLabel,
    resolvedUrlContainer, streamsFoundText, streamOptionsContainer,
    qualitySelectRow, qualitySelect, qualityNote, qualityNoteText, qualityNoteSwitch, deviceSelect,
    useProxyCheckbox, castBtn, castBtnLabel, statusCard,
    videoPreview, videoPreviewImg, videoPreviewTitle, videoPreviewHost
} from './dom.js';
import { state, saveState } from './state.js';
import { apiPost } from './api.js';
import { updateStatus } from './status.js';
import { createStreamEntry, renderStreamBar, setMode } from './streams.js';
import {
    findDeviceName, filterDeviceDropdown, pickOnlyDevice, selectedDeviceIp, selectedDeviceKey, selectedDeviceType, showManualIpHint
} from './devices.js';
import { applyQueue } from './queue.js';
import { renderDashboard } from './dashboard.js';
import { showPinPrompt } from './pairing.js';
import {
    populateSubtitleOptions, subtitleChoiceReady, selectedSubtitle, rememberSubtitleChoice
} from './subtitles.js';
import { addRecent, rememberDevice, renderRecent, cannotPlayConverted } from './recent.js';

// ===== FORM STATE =====

export function resetComposeForm() {
    cancelAnalyze();
    videoUrlInput.value = '';
    resolvedUrlContainer.classList.add('hidden');
    streamOptionsContainer.innerHTML = '';
    statusCard.classList.add('hidden');
    showPreview(null);
    populateSubtitleOptions(null);
    setCastButton({ busy: false });
    castBtn.disabled = true;
    state.compose.analyzedStreams = [];
    state.compose.status = null;
    renderRecent();
}

// `queueFor`: a playing stream's IP. The form then queues a video to play
// after it, on its device, instead of starting a new stream.
export function openComposeOverlay({ queueFor = null } = {}) {
    resetComposeForm();
    state.compose.queueFor = queueFor;
    if (queueFor) pickOnlyDevice(queueFor, state.streams.get(queueFor)?.deviceType);
    else filterDeviceDropdown();
    setCastButton({ busy: false });
    composeOverlay.classList.remove('hidden');
    composePanel.classList.add('overlay-active');
}

export function closeComposeOverlay() {
    composeOverlay.classList.add('hidden');
    composePanel.classList.remove('overlay-active');
    state.compose.queueFor = null;
    setCastButton({ busy: false });
}

export function isComposeOverlayOpen() {
    return !composeOverlay.classList.contains('hidden');
}

function selectedStream() {
    const radio = document.querySelector('input[name="stream-select"]:checked');
    return radio ? state.compose.analyzedStreams[parseInt(radio.value)] : null;
}

export function checkReady() {
    showManualIpHint();
    castBtn.disabled = !(selectedDeviceIp() && selectedStream() && subtitleChoiceReady());
}

// The device changed: re-check, and re-offer qualities and subtitles for what
// it can show.
export function onDeviceChanged() {
    populateQualityOptions(selectedStream(), { keep: true });
    populateSubtitleOptions(selectedStream(), selectedDeviceType());
    checkReady();
}

function setCastButton({ busy }) {
    if (state.compose.queueFor) castBtnLabel.textContent = busy ? 'Adding…' : 'Play next';
    else castBtnLabel.textContent = busy ? 'Casting…' : 'Start Casting';
}

// ===== ANALYZE =====

// The in-flight analysis, if any. While it runs the Analyze button is a
// Cancel button, and closing the form or starting another analysis aborts it
// (which also stops the server's search and its headless browser).
let analyzeController = null;

function setAnalyzing(active) {
    analyzeBtn.classList.toggle('is-cancel', active);
    analyzeBtnLabel.textContent = active ? 'Cancel' : 'Analyze';
}

function cancelAnalyze() {
    analyzeController?.abort();
}

// Reads the extract endpoint's NDJSON stream, reporting progress lines as
// they arrive, and returns the final payload. Validation errors are sent as
// plain JSON before streaming starts, so those are read as-is.
async function readExtractResponse(res, onProgress) {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('ndjson') || !res.body) return res.json();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    const handle = (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.progress) onProgress(msg.progress);
        else result = msg;
    };

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            handle(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
        }
    }
    handle(buffer + decoder.decode());
    return result || { error: 'The server closed the connection unexpectedly' };
}

// The page's title and picture, so the user can tell it's the right video
// before casting. The picture comes through the server (it only passes images).
function showPreview(data) {
    const title = data?.title || null;
    const thumbnail = data?.thumbnail || null;
    videoPreview.classList.toggle('hidden', !title && !thumbnail);
    if (!title && !thumbnail) {
        videoPreviewImg.removeAttribute('src');
        return;
    }

    videoPreviewTitle.textContent = title || 'Untitled video';
    try {
        videoPreviewHost.textContent = new URL(videoUrlInput.value.trim()).hostname.replace(/^www\./, '');
    } catch {
        videoPreviewHost.textContent = '';
    }

    videoPreviewImg.classList.add('hidden');
    if (thumbnail) {
        const params = new URLSearchParams({ url: thumbnail, referer: videoUrlInput.value.trim(), type: 'image' });
        videoPreviewImg.onload = () => videoPreviewImg.classList.remove('hidden');
        videoPreviewImg.onerror = () => videoPreviewImg.classList.add('hidden');
        videoPreviewImg.src = `/proxy?${params}`;
    } else {
        videoPreviewImg.removeAttribute('src');
    }
}

function showAnalyzeResult(data) {
    const videos = data.videos || [];
    const playableCount = videos.filter(v => !v.unsupported).length;
    state.compose.title = data.title || null;

    if (videos.length > 0) showPreview(data);

    if (playableCount > 0) {
        state.compose.analyzedStreams = videos;
        displayStreamOptions(videos);
        updateStatus(`Found ${playableCount} stream${playableCount > 1 ? 's' : ''}`, 'success');
        checkReady();
    } else if (videos.length > 0) {
        // Streams were found but none are playable (e.g. MJPEG only) —
        // don't report this as a success, or the user is left staring
        // at a disabled Cast button with no idea why.
        state.compose.analyzedStreams = videos;
        displayStreamOptions(videos);
        updateStatus(videos[0].reason || 'Found a stream, but its format is not supported for casting', 'error');
    } else {
        updateStatus(data.error || 'No video found at this URL', 'error');
    }
}

// `restart`: a new URL arrived (Enter, paste) — replace any running analysis.
// Otherwise (the button) a second press cancels the running one.
export async function fetchAndAnalyze({ restart = false } = {}) {
    if (analyzeController) {
        cancelAnalyze();
        if (!restart) return;
    }

    const url = videoUrlInput.value.trim();
    if (!url) {
        statusCard.classList.remove('hidden');
        updateStatus('Please enter a URL first', 'error');
        videoUrlInput.focus();
        return;
    }

    const controller = new AbortController();
    analyzeController = controller;
    setAnalyzing(true);
    updateStatus('Analyzing URL…', 'loading');
    statusCard.classList.remove('hidden');

    // Clear the previous result so a stale stream can't be cast by mistake.
    state.compose.analyzedStreams = [];
    state.compose.title = null;
    streamOptionsContainer.innerHTML = '';
    resolvedUrlContainer.classList.add('hidden');
    qualitySelectRow.classList.add('hidden');
    showPreview(null);
    populateSubtitleOptions(null);
    checkReady();
    renderRecent();

    try {
        const res = await apiPost('/api/extract', { url }, { signal: controller.signal, accept: 'application/x-ndjson' });
        const data = await readExtractResponse(res, (progress) => {
            if (analyzeController === controller) updateStatus(progress, 'loading');
        });
        if (analyzeController === controller) showAnalyzeResult(data);
    } catch (e) {
        if (e.name === 'AbortError') {
            if (analyzeController === controller) updateStatus('Analysis cancelled', 'info');
        } else {
            console.error('Extract error:', e);
            updateStatus('Failed to analyze URL', 'error');
        }
    } finally {
        if (analyzeController === controller) {
            analyzeController = null;
            setAnalyzing(false);
        }
    }
}

// ===== STREAM OPTIONS =====

function formatSize(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function badge(className, text) {
    const span = document.createElement('span');
    span.className = `stream-option-type ${className}`;
    span.textContent = text;
    return span;
}

function displayStreamOptions(videos) {
    streamOptionsContainer.innerHTML = '';
    streamsFoundText.textContent = videos.length > 1 ? `${videos.length} streams found:` : 'Video found:';
    resolvedUrlContainer.classList.remove('hidden');

    videos.forEach((video, index) => {
        const option = document.createElement('div');
        option.className = `stream-option${video.unsupported ? ' stream-option-unsupported' : ''}`;

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'stream-select';
        radio.value = index;
        radio.id = `stream-${index}`;
        radio.disabled = video.unsupported;
        if (index === 0 && !video.unsupported) radio.checked = true;

        const label = document.createElement('label');
        label.setAttribute('for', `stream-${index}`);
        label.className = 'stream-option-content';

        const urlSpan = document.createElement('div');
        urlSpan.className = 'stream-option-url';
        urlSpan.textContent = video.url;

        const badges = document.createElement('div');
        badges.className = 'stream-option-badges';
        badges.appendChild(badge(video.type, video.type.toUpperCase() + (video.unsupported ? ' (UNSUPPORTED)' : '')));
        if (video.resolution) badges.appendChild(badge('resolution', video.resolution));
        if (video.live) badges.appendChild(badge('live', 'LIVE'));
        if (video.size) badges.appendChild(badge('size', formatSize(video.size)));
        if (video.subtitles?.length) {
            const cc = badges.appendChild(badge('subtitles', 'CC'));
            cc.title = 'Subtitles available';
        }

        if (video.reason) option.title = video.reason;

        label.appendChild(urlSpan);
        label.appendChild(badges);
        option.appendChild(radio);
        option.appendChild(label);

        if (!video.unsupported) {
            option.onclick = () => {
                radio.checked = true;
                selectStream(video);
            };
        }

        streamOptionsContainer.appendChild(option);
    });

    selectStream(videos.find(v => !v.unsupported) || null);
}

function selectStream(video) {
    populateQualityOptions(video);
    populateSubtitleOptions(video, selectedDeviceType());
    checkReady();
}

// Build the quality dropdown for a stream. Defaults to "Highest available";
// the server forces that variant unless the user picks a specific quality
// (or "Auto" for adaptive bitrate). Hidden for progressive files (MP4 etc.),
// which have no selectable variants. A Chromecast can't decode some variants
// (4K H.264): it loads them, plays a couple of segments, then stops. For a
// Chromecast those are offered only when the server can convert them to HEVC
// on the way through, and say so — and "Highest available" then means the
// converted top quality, unless this device has already failed to play one.
// `keep`: hold on to the current choice if still offered.
function populateQualityOptions(video, { keep = false } = {}) {
    const previous = keep ? qualitySelect.value : 'highest';
    qualitySelect.innerHTML = '';

    if (!video || (video.type !== 'hls' && video.type !== 'dash')) {
        qualitySelectRow.classList.add('hidden');
        return;
    }

    const addOption = (value, label, transcode = false) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (transcode) opt.dataset.transcode = 'hevc';
        qualitySelect.appendChild(opt);
    };

    // Apple TVs and LG TVs (webOS) decode every variant as it is.
    const isChromecast = selectedDeviceType() === 'chromecast';
    const topConvertible = isChromecast && !cannotPlayConverted(selectedDeviceIp())
        ? (video.qualities || []).find(q => q.convertible)
        : null;
    if (topConvertible) addOption('highest', `Highest available (${topConvertible.label}, converted)`, true);
    else addOption('highest', 'Highest available');
    (video.qualities || []).forEach(q => {
        if (!isChromecast || q.chromecast !== false) addOption(q.value, q.label);
        else if (q.convertible) addOption(q.value, `${q.label} (converted, 4K Chromecasts)`, true);
    });
    addOption('auto', 'Auto (adaptive)');

    const kept = [...qualitySelect.options].some(o => o.value === previous);
    qualitySelect.value = kept ? previous : 'highest';
    qualitySelectRow.classList.remove('hidden');
    renderQualityNote(video);
}

// An LG TV picked by its Cast receiver, for a stream with 4K H.264: over Cast
// that's converted (or plays at 1080p), while the TV's own browser plays it
// as it is. Say so, with a switch to the LG webOS option.
function renderQualityNote(video) {
    const device = state.devices.find(d => d.ip === selectedDeviceIp());
    const has4kH264 = (video?.qualities || []).some(q => q.chromecast === false);
    const offer = selectedDeviceType() === 'chromecast' && device?.webos && has4kH264;
    qualityNote.classList.toggle('hidden', !offer);
    if (offer) qualityNoteText.textContent = `${device.name} can also play the 4K stream as it is, without conversion.`;
}

qualityNoteSwitch.addEventListener('click', () => {
    const ip = selectedDeviceIp();
    if (!ip) return;
    deviceSelect.value = `webos:${ip}`;
    deviceSelect.dispatchEvent(new window.Event('change'));
});

// ===== CASTING =====

// Shared by startCasting() and the retry after AirPlay pairing — both POST
// the same params to /api/cast and handle the same needsPairing/error/success
// shapes, so a fix to one path can't silently miss the other.
// `page`: the URL and title the user analysed, remembered as a recent cast.
// `queue`: add it to the device's Up next (/api/queue) rather than cast now;
// with nothing playing there any more, the server casts it now after all.
async function performCast(params, { loadingMessage, allowPairingRetry, page, deviceKey, queue = false }) {
    castBtn.disabled = true;
    setCastButton({ busy: true });
    updateStatus(loadingMessage, 'loading');

    try {
        const res = queue
            ? await apiPost('/api/queue', { ...params, title: page?.title, page: page?.url })
            : await apiPost('/api/cast', params);
        const data = await res.json();

        if (data.needsPairing && allowPairingRetry) {
            showPinPrompt(data.deviceIp, data.deviceName, () => {
                performCast(params, { loadingMessage: 'Retrying cast after pairing...', allowPairingRetry: false, page, deviceKey, queue });
            });
            castBtn.disabled = false;
            setCastButton({ busy: false });
            return;
        }

        if (data.error) {
            throw new Error(data.error);
        }

        rememberSubtitleChoice(params.subtitle);
        if (page?.url) addRecent(page.url, page.title);
        if (data.queued) {
            applyQueue(params.ip, data.items);
            closeComposeOverlay();
            renderDashboard();
            return;
        }
        rememberDevice(deviceKey || params.ip);
        // A manually entered IP may still be a discovered device of known type;
        // an LG TV cast to through its browser shares its IP with its Cast receiver.
        const deviceType = params.deviceType === 'webos' ? 'webos'
            : state.devices.find(d => d.ip === params.ip)?.type || params.deviceType;
        createStreamEntry(params.ip, findDeviceName(params.ip), deviceType);
        if (data.subtitles) state.streams.get(params.ip).subtitles = data.subtitles;
        if (data.volume) state.streams.get(params.ip).volume = data.volume;
        state.activeStreamIp = params.ip;
        renderStreamBar();
        closeComposeOverlay();
        setMode('dashboard');
        updateStatus('Casting started!', 'success');
        saveState();
    } catch (e) {
        console.error('Cast error:', e);
        updateStatus(`Cast failed: ${e.message}`, 'error');
        castBtn.disabled = false;
        setCastButton({ busy: false });
    }
}

export async function startCasting() {
    if (castBtn.disabled) return; // already casting, ignore duplicate clicks

    const ip = selectedDeviceIp();
    const stream = selectedStream();
    if (!ip || !stream) return;

    const qualityHidden = qualitySelectRow.classList.contains('hidden');
    const quality = qualityHidden ? 'highest' : qualitySelect.value;
    const transcode = !qualityHidden && qualitySelect.selectedOptions[0]?.dataset.transcode === 'hevc';

    await performCast({
        ip,
        url: stream.url,
        proxy: useProxyCheckbox.checked,
        referer: stream.referer,
        deviceType: selectedDeviceType(),
        quality,
        transcode,
        type: stream.type,
        subtitle: selectedSubtitle()
    }, {
        loadingMessage: state.compose.queueFor ? 'Adding to Up next…' : 'Connecting to device...',
        allowPairingRetry: true,
        page: { url: videoUrlInput.value.trim(), title: state.compose.title },
        deviceKey: selectedDeviceKey(),
        queue: !!state.compose.queueFor
    });
}
