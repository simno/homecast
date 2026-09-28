// HomeCast's player on an LG TV (webos-player.html). The TV's browser plays
// HLS natively; this page reports playback to HomeCast over its WebSocket and
// takes play/pause/seek from it (lib/webos.js). A plain script, not a module:
// the TV's browser is the only thing that loads it.
(() => {
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session');
    const video = document.getElementById('video');
    const message = document.getElementById('message');

    // How often a playing video reports where it is (the dashboard fills the
    // gaps from its own clock).
    const REPORT_INTERVAL_MS = 5000;
    const SKIP_S = { ArrowLeft: -10, ArrowRight: 10, 412: -10, 417: 30 };
    const LIVE_EDGE_OFFSET_S = 3;
    const ERRORS = { 1: 'loading was aborted', 2: 'a network error', 3: 'the video could not be decoded', 4: 'the format is not supported' };

    let ws = null;
    let stopped = false;

    function show(text) {
        message.textContent = text || '';
        message.classList.toggle('hidden', !text);
    }

    function send(event, status) {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'webosPlayer', session, event, status }));
    }

    function playerState() {
        if (video.ended) return 'IDLE';
        if (video.paused) return 'PAUSED';
        return video.readyState < 3 ? 'BUFFERING' : 'PLAYING';
    }

    function report() {
        const live = video.duration === Infinity;
        const seekable = video.seekable.length ? video.seekable : null;
        send('status', {
            playerState: playerState(),
            currentTime: video.currentTime,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            live,
            seekableStart: seekable ? seekable.start(0) : null,
            seekableEnd: seekable ? seekable.end(seekable.length - 1) : null,
            // HomeCast clicks the page until this is true.
            fullscreen: !!document.fullscreenElement
        });
    }

    function connect() {
        ws = new WebSocket(`ws://${window.location.host}`);
        ws.onopen = () => {
            send('hello');
            report();
        };
        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }
            if (msg.session !== session) return;
            if (msg.type === 'webosMedia') load(msg);
            else if (msg.type === 'webosCommand') run(msg.action, msg.value);
        };
        ws.onclose = () => {
            if (!stopped) setTimeout(connect, 2000);
        };
    }

    function seekTo(time) {
        const seekable = video.seekable;
        if (!seekable.length) return;
        const start = seekable.start(0);
        const end = seekable.end(seekable.length - 1);
        video.currentTime = Math.min(Math.max(time, start), Math.max(start, end - 1));
    }

    function run(action, value) {
        if (action === 'pause') video.pause();
        else if (action === 'play') video.play();
        else if (action === 'seek') seekTo(video.currentTime + value);
        else if (action === 'seekTo') seekTo(value);
        else if (action === 'live' && video.seekable.length) {
            seekTo(video.seekable.end(video.seekable.length - 1) - LIVE_EDGE_OFFSET_S);
        } else if (action === 'stop') {
            stopped = true;
            video.removeAttribute('src');
            video.load();
            show('');
            ws?.close();
        }
    }

    // Subtitles in the stream itself, picked by language when casting.
    function showSubtitleLanguage(lang) {
        const wanted = lang.toLowerCase();
        for (const track of video.textTracks) {
            const match = (track.language || '').toLowerCase().startsWith(wanted) ||
                (track.label || '').toLowerCase() === wanted;
            if (match) track.mode = 'showing';
        }
    }

    // What to play, from HomeCast when the page checks in (again after a
    // reconnect, when it's already playing).
    function load({ src, sub, subLang }) {
        if (video.getAttribute('src') || stopped) return;
        if (sub) {
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.src = sub;
            track.srclang = subLang || 'und';
            track.default = true;
            video.appendChild(track);
        } else if (subLang) {
            video.textTracks.addEventListener('addtrack', () => showSubtitleLanguage(subLang));
            video.addEventListener('loadedmetadata', () => showSubtitleLanguage(subLang));
        }
        video.src = src;
    }

    function fullScreen() {
        if (document.fullscreenElement) return;
        const request = document.documentElement.requestFullscreen?.();
        request?.catch?.((err) => send('status', { fullscreenError: `${err.name}: ${err.message}` }));
    }

    // HomeCast clicks the page once the video plays (the browser only allows
    // full screen after a user gesture); the remote's keys work too.
    document.addEventListener('fullscreenchange', report);
    document.addEventListener('click', fullScreen);
    document.addEventListener('keydown', (event) => {
        fullScreen();
        const key = event.key in SKIP_S ? event.key : event.keyCode;
        if (key in SKIP_S) {
            seekTo(video.currentTime + SKIP_S[key]);
        } else if (event.key === 'MediaPlayPause' || event.keyCode === 415 || event.keyCode === 19) {
            if (video.paused) video.play();
            else video.pause();
        } else {
            return;
        }
        event.preventDefault();
    });

    for (const name of ['playing', 'pause', 'waiting', 'seeked', 'ended']) {
        video.addEventListener(name, report);
    }
    video.addEventListener('playing', () => show(''));
    video.addEventListener('waiting', () => { if (video.currentTime === 0) show('Loading…'); });
    video.addEventListener('error', () => {
        const reason = ERRORS[video.error?.code] || 'an unknown error';
        show(`This stream can't be played here: ${reason}.`);
        send('status', { error: reason });
    });
    setInterval(() => { if (!video.paused) report(); }, REPORT_INTERVAL_MS);

    connect();
})();
