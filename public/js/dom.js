// Elements the UI modules share. Looked up once: index.html is static.
const $ = (id) => document.getElementById(id);

export const app = $('app');

// Compose form
export const composePanel = $('compose-panel');
export const composeOverlay = $('compose-overlay');
export const deviceSelect = $('device-select');
export const rescanBtn = $('rescan-btn');
export const deviceHint = $('device-hint');
export const deviceHintText = $('device-hint-text');
export const manualIpLink = $('manual-ip-link');
export const manualIpContainer = $('manual-ip-container');
export const manualIpInput = $('manual-ip');
export const manualIpHint = $('manual-ip-hint');
export const videoUrlInput = $('video-url');
export const analyzeBtn = $('analyze-btn');
export const analyzeBtnLabel = $('analyze-btn-label');
export const recentUrls = $('recent-urls');
export const recentList = $('recent-list');
export const recentClearBtn = $('recent-clear');
export const videoPreview = $('video-preview');
export const videoPreviewImg = $('video-preview-img');
export const videoPreviewTitle = $('video-preview-title');
export const videoPreviewHost = $('video-preview-host');
export const resolvedUrlContainer = $('resolved-url-container');
export const streamsFoundText = $('streams-found-text');
export const streamOptionsContainer = $('stream-options');
export const qualitySelectRow = $('quality-select-row');
export const qualitySelect = $('quality-select');
export const subtitleSelectRow = $('subtitle-select-row');
export const subtitleSelect = $('subtitle-select');
export const subtitleUrlInput = $('subtitle-url');
export const subtitleNote = $('subtitle-note');
export const useProxyCheckbox = $('use-proxy');
export const advancedNote = $('advanced-note');
export const castBtn = $('cast-btn');
export const castBtnLabel = $('cast-btn-label');

// Status line
export const statusCard = $('status-card');
export const statusText = $('status-text');
export const statusSpinner = $('status-spinner');
export const statusSuccess = $('status-success');
export const statusError = $('status-error');

// Stream bar and dashboard
export const streamBar = $('stream-bar');
export const addStreamBtn = $('add-stream-btn');
export const dashboardDeviceName = $('dashboard-device-name');
export const healthDot = $('health-dot');
export const healthText = $('health-text');
export const dashboardSubtitles = $('dashboard-subtitles');
export const dashboardSubtitleSelect = $('dashboard-subtitle-select');
export const stopBtn = $('stop-btn');
export const stopBtnLabel = $('stop-btn-label');
export const dashboardNotice = $('dashboard-notice');
export const dashboardNoticeText = $('dashboard-notice-text');
export const dashboardNoticeClose = $('dashboard-notice-close');
export const statsDetails = $('stats-details');
export const delayValue = $('graph-current-delay');

// Remote control
export const playback = {
    seekBack: $('seek-back-btn'),
    playPause: $('play-pause-btn'),
    playIcon: $('play-icon'),
    pauseIcon: $('pause-icon'),
    seekForward: $('seek-fwd-btn'),
    position: $('playback-position'),
    volumeControl: $('volume-control'),
    muteBtn: $('mute-btn'),
    volumeIcon: $('volume-icon'),
    mutedIcon: $('muted-icon'),
    volumeSlider: $('volume-slider'),
    volumeNote: $('volume-note')
};
export const stat = {
    resolution: $('stat-resolution'),
    bitrate: $('stat-bitrate'),
    transferred: $('stat-transferred'),
    duration: $('stat-duration'),
    frameRate: $('stat-framerate'),
    segments: $('stat-segments'),
    cache: $('stat-cache'),
    bufferHealth: $('stat-buffer-health'),
    bufferDetail: $('stat-buffer-detail')
};

// PIN pairing modal
export const pinModal = $('pin-modal');
export const pinTitle = $('pin-title');
export const pinDeviceName = $('pin-device-name');
export const pinInput = $('pin-input');
export const pinStatus = $('pin-status');
export const pinSubmitBtn = $('pin-submit-btn');
export const pinCancelBtn = $('pin-cancel-btn');
export const pinCloseBtn = $('pin-close-btn');

// Help modal
export const helpBtn = $('help-btn');
export const helpModal = $('help-modal');
export const helpCloseBtn = $('help-close-btn');
