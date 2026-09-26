const net = require('net');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const {
    devices,
    activeSessions,
    playbackTracking,
    bufferHealthTracking,
    streamRecovery,
    streamStats,
    deviceToClientMap,
    connectionHealth
} = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT } = require('./utils');
const { detectFrameRate, isLiveHlsStream, isLiveDashStream } = require('./extraction');
const { initializeConnectionHealth, updateHeartbeat } = require('./health');
const { initializeStreamRecovery } = require('./recovery');
const { trackBufferHealth, getBufferHealthStats } = require('./stats');
const { wakeDevice } = require('./wol');
const { buildProxyUrl } = require('./proxy');
const { SIDELOADED_TRACK_ID, sideloadedTrack, newSubtitleState, syncSubtitles, subtitleState } = require('./subtitles');

const IS_DEV = process.env.NODE_ENV === 'development';

// How far back from the live edge to start a genuinely live stream. Seeking to
// the exact edge risks landing in a region the receiver has not buffered yet.
const LIVE_EDGE_OFFSET = 15;

// Quick TCP connectivity check before attempting full castv2 connection
function checkReachable(ip, port = 8009, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(timeoutMs);
        sock.on('connect', () => { sock.destroy(); resolve(); });
        sock.on('error', (err) => { sock.destroy(); reject(err); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error(`Timed out after ${timeoutMs}ms`)); });
        sock.connect(port, ip);
    });
}

// Remove all session-related state for a device
function cleanupSessionMaps(ip) {
    activeSessions.delete(ip);
    playbackTracking.delete(ip);
    bufferHealthTracking.delete(ip);
    streamRecovery.delete(ip);
    deviceToClientMap.delete(ip);
    connectionHealth.delete(ip);
    streamStats.delete(ip);
}

// Stop a running session on a device before starting a new one
function stopExistingSession(ip) {
    if (!activeSessions.has(ip)) return;
    console.log(`[Cast] Stopping existing session on ${ip} before starting new stream`);
    const existingSession = activeSessions.get(ip);
    try {
        existingSession.player.stop(() => {
            existingSession.client.close();
        });
    } catch (err) {
        console.warn('[Cast] Error stopping existing session:', err.message);
    }
}

// Derive Chromecast content type and video type. The extractor's verdict wins
// when there is one — it sniffed the actual response, while the URL of an
// extensionless stream says nothing.
function getContentType(finalUrl, typeHint) {
    if (typeHint === 'hls') return { contentType: 'application/x-mpegURL', videoType: 'hls' };
    if (typeHint === 'dash') return { contentType: 'application/dash+xml', videoType: 'dash' };
    if (typeHint === 'webm') return { contentType: 'video/webm', videoType: 'webm' };
    if (typeHint === 'mp4') return { contentType: 'video/mp4', videoType: 'mp4' };
    const lowerUrl = finalUrl.toLowerCase();
    if (lowerUrl.includes('.mpd')) {
        return { contentType: 'application/dash+xml', videoType: 'dash' };
    }
    if (lowerUrl.includes('.webm')) {
        return { contentType: 'video/webm', videoType: 'webm' };
    }
    if (lowerUrl.includes('.m3u8') || lowerUrl.includes('playlist')) {
        return { contentType: 'application/x-mpegURL', videoType: 'hls' };
    }
    return { contentType: 'video/mp4', videoType: 'mp4' };
}

// Decide the Chromecast streamType for an HLS URL.
//
// The manifest is authoritative (see isLiveHlsStream). The URL patterns below
// are only a fallback for when the manifest cannot be fetched — note that an
// explicit `type=replay` disqualifies a URL from the live guess, since that is
// how Periscope/X mark a recording served through a live-shaped playlist.
async function resolveStreamType(url, finalUrl) {
    const live = await isLiveHlsStream(url);
    if (live !== null) {
        console.log(`[Cast] Manifest says ${live ? 'live' : 'recorded'}: ${url.substring(0, 80)}...`);
        return live ? 'LIVE' : 'BUFFERED';
    }

    console.log('[Cast] Could not read manifest, guessing stream type from URL');
    const combined = finalUrl + url;
    if (/type=replay/i.test(combined)) return 'BUFFERED';
    const looksLive = /type=live|master_dynamic|live\.m3u8|_live\.m3u8|\/api\/channel\/hls\//i.test(combined);
    return looksLive ? 'LIVE' : 'BUFFERED';
}

// Check if the device is reachable; if not, try Wake-on-LAN.
// Returns true if we should proceed with casting, false if an error was already sent.
async function ensureReachable(ip, res) {
    // Discovered Chromecasts listen on 8009; only the dev mock says otherwise.
    const port = devices.get(ip)?.port || 8009;
    try {
        await checkReachable(ip, port);
        console.log(`[Cast] Device ${ip}:${port} is reachable`);
        return true;
    } catch (err) {
        console.log(`[Cast] Device ${ip} unreachable (${err.message}), attempting Wake-on-LAN...`);
    }

    const deviceId = devices.get(ip)?.id;
    const woken = await wakeDevice(ip, deviceId);

    if (!woken) {
        if (!res.headersSent) {
            res.status(502).json({
                error: `Cannot reach device at ${ip}:${port} — No MAC address available for Wake-on-LAN.`,
                troubleshooting: {
                    serverIp: getLocalIp(),
                    deviceIp: ip,
                    check: 'Device may be offline or on a different network.'
                }
            });
        }
        return false;
    }

    console.log(`[Cast] WOL sent, waiting for ${ip} to wake...`);
    for (let attempt = 1; attempt <= 6; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        try {
            await checkReachable(ip, port, 3000);
            console.log(`[Cast] Device ${ip} woke up after ${attempt * 5}s`);
            return true;
        } catch {
            console.log(`[Cast] Still waiting for ${ip} (attempt ${attempt}/6)...`);
        }
    }

    if (!res.headersSent) {
        res.status(502).json({
            error: `Sent Wake-on-LAN packet but ${ip} did not wake up within 30s.`,
            troubleshooting: {
                serverIp: getLocalIp(),
                deviceIp: ip,
                check: 'Is the TV plugged in and on the same subnet? WOL only works over wired Ethernet on most TVs.'
            }
        });
    }
    return false;
}

// Set up mock Chromecast client (dev mode only)
function setupMockClient() {
    console.log('[Cast] Using mock Chromecast device');
    const mockModule = require('./mock-chromecast');
    const MockCastClient = mockModule.MockCastClient;
    const MockPlayer = mockModule.MockPlayer;
    const MockChromecast = mockModule.MockChromecast;
    const tempMock = new MockChromecast('Mock Chromecast (Dev)', 8009);
    const client = new MockCastClient(tempMock);
    const launchReceiver = (_ReceiverType, callback) => {
        const player = new MockPlayer(client, tempMock);
        callback(null, player);
    };
    return { client, launchReceiver };
}

// `subtitle`: null, a file to sideload ({ url, language, label }) or a
// manifest rendition to select once loaded ({ language, label }).
async function castToDevice(ip, url, proxy, referer, quality, res, type, subtitle = null) {
    console.log(`[Cast] Request received for IP: ${ip}, URL: ${url}, Proxy: ${proxy}, Referer: ${referer}, Quality: ${quality}, Type: ${type || 'auto'}, Subtitles: ${subtitle ? (subtitle.label || subtitle.language) : 'off'}`);

    stopExistingSession(ip);
    cleanupSessionMaps(ip);
    console.log('[Cast] Statistics reset for new stream on', ip);

    const localIp = getLocalIp();
    const isMockDevice = IS_DEV && devices.get(ip)?.isMock;
    const clientIpForMapping = isMockDevice ? localIp : ip;
    deviceToClientMap.set(ip, clientIpForMapping);
    console.log(`[Cast] Mapped device ${ip} to client ${clientIpForMapping}${isMockDevice ? ' (mock device)' : ''}`);

    const { client, launchReceiver } = isMockDevice
        ? setupMockClient()
        : { client: new Client(), launchReceiver: (ReceiverType, cb) => { client.launch(ReceiverType, cb); } };

    const finalUrl = proxy
        ? buildProxyUrl(`${localIp}:${PORT}`, { url, referer, quality, type })
        : url;

    console.log(`[Cast] Final Media URL: ${finalUrl}`);
    const { contentType, videoType } = getContentType(finalUrl, type);
    console.log(`[Cast] Content-Type: ${contentType}`);

    // Ask the manifest whether this is live before telling the receiver. Only
    // the URL was consulted here before, which got Periscope/X replays exactly
    // backwards (`master_dynamic_*.m3u8?type=replay` is a finished recording)
    // and ended playback the instant it started.
    let streamType = 'BUFFERED';
    if (videoType === 'hls') {
        streamType = await resolveStreamType(url, finalUrl);
    } else if (videoType === 'dash') {
        streamType = (await isLiveDashStream(url)) ? 'LIVE' : 'BUFFERED';
    }
    console.log(`[Cast] Stream type: ${streamType}`);

    if (!(await ensureReachable(ip, res))) return;

    // Kick off async MP4 frame rate detection (best-effort)
    if (videoType === 'mp4') {
        detectFrameRate(url, 'mp4').then(fps => {
            if (fps && streamStats.has(ip)) {
                streamStats.get(ip).frameRate = fps;
                console.log(`[Cast] Detected MP4 frame rate: ${fps} FPS`);
                broadcast({
                    type: 'streamStats', deviceIp: ip,
                    bufferHealth: getBufferHealthStats(ip),
                    stats: { ...streamStats.get(ip) }
                });
            }
        }).catch(err => {
            console.log(`[Cast] Could not detect MP4 frame rate: ${err.message}`);
        });
    }

    client.connect(ip, () => {
        console.log(`[Cast] Connected to device ${ip}`);
        launchReceiver(DefaultMediaReceiver, (err, player) => {
            if (err) {
                console.error('[Cast] Launch failed:', err);
                if (!res.headersSent) res.status(500).json({ error: 'Launch failed: ' + err.message });
                client.close();
                return;
            }
            console.log('[Cast] DefaultMediaReceiver launched');

            const media = {
                contentId: finalUrl,
                contentType,
                streamType
            };

            // Sideloaded subtitles always go through the proxy, whatever the
            // proxy setting: receivers refuse text tracks without CORS headers.
            if (subtitle?.url) {
                const trackUrl = buildProxyUrl(`${localIp}:${PORT}`, { url: subtitle.url, referer, type: 'subtitle' });
                media.tracks = [sideloadedTrack(trackUrl, subtitle)];
            }

            console.log('[Cast] Media object:', JSON.stringify(media, null, 2));

            const loadTimeout = setTimeout(() => {
                console.error('[Cast] Load timeout — Chromecast cannot reach the proxy URL');
                if (!res.headersSent) {
                    res.status(408).json({
                        error: 'Load timeout — Chromecast cannot reach proxy',
                        proxyUrl: finalUrl,
                        troubleshooting: {
                            chromecastIp: ip, proxyIp: localIp, proxyPort: PORT,
                            message: 'Ensure Chromecast can reach the proxy IP. Check firewall and network settings.'
                        }
                    });
                }
                client.close();
            }, 10000);

            // No forced currentTime here: the URL alone cannot tell a live
            // window from a finished replay, and seeking blindly to the edge
            // lands past the end of a replay and stops playback. The receiver
            // reports liveSeekableRange after load — see the status handler.
            const loadOptions = { autoplay: true };
            if (media.tracks) loadOptions.activeTrackIds = [SIDELOADED_TRACK_ID];

            player.load(media, loadOptions, (err, status) => {
                clearTimeout(loadTimeout);

                if (err) {
                    console.error('[Cast] Load failed:', err);
                    if (!res.headersSent) res.status(500).json({ error: 'Load failed: ' + err.message });
                    client.close();
                    return;
                }

                console.log('[Cast] Media loaded successfully');
                activeSessions.set(ip, { client, player, subtitles: newSubtitleState(subtitle) });
                initializeConnectionHealth(ip);
                initializeStreamRecovery(ip, media);
                syncSubtitles(ip, status);

                // Subtitle state rides on the response: its broadcast went out
                // before this page had a stream entry to put it on.
                if (!res.headersSent) res.json({ status: 'casting', media: status, subtitles: subtitleState(ip) });
                broadcast({ type: 'status', status: 'Playing on ' + ip });
                watchVolume(ip, client);

                let liveEdgeResolved = false;

                player.on('status', (status) => {
                    console.log('[Cast] Player Status Update:', status.playerState);
                    updateHeartbeat(ip);

                    if (!playbackTracking.has(ip)) {
                        console.log('[Cast] Full status object:', JSON.stringify(status, null, 2));
                    }

                    trackBufferHealth(ip, status.playerState);
                    syncSubtitles(ip, status);

                    // isMovingWindow is the only reliable live/replay signal we
                    // get. Providers such as Periscope/X serve finished replays
                    // through a live-style playlist with no #EXT-X-ENDLIST, so
                    // neither the URL nor the manifest distinguishes them; only
                    // the receiver knows whether the window actually slides.
                    if (!liveEdgeResolved && status.liveSeekableRange?.end !== undefined) {
                        liveEdgeResolved = true;
                        const range = status.liveSeekableRange;
                        if (range.isMovingWindow) {
                            const target = Math.max(0, range.end - LIVE_EDGE_OFFSET);
                            console.log(`[Cast] Live window — seeking to edge: ${target.toFixed(1)}s`);
                            player.seek(target, (err) => {
                                if (err) console.error('[Cast] Live edge seek failed:', err.message);
                            });
                        } else {
                            console.log(`[Cast] Fixed window (replay, ${range.end.toFixed(1)}s) — playing from start`);
                        }
                    }

                    let delay = 0;
                    if (status.currentTime !== undefined && status.liveSeekableRange?.end !== undefined) {
                        const liveEdge = status.liveSeekableRange.end;
                        delay = Math.max(0, liveEdge - status.currentTime);
                        console.log(`[Delay] Live stream — edge: ${liveEdge.toFixed(1)}s, current: ${status.currentTime.toFixed(1)}s, delay: ${delay.toFixed(1)}s`);
                        const tracking = playbackTracking.get(ip) || {};
                        tracking.lastDelay = delay;
                        playbackTracking.set(ip, tracking);
                    }

                    broadcast({
                        type: 'playerStatus', deviceIp: ip, status, delay,
                        bufferHealth: getBufferHealthStats(ip)
                    });
                });

                player.on('close', () => {
                    console.log('[Cast] Player closed for', ip);
                    cleanupSessionMaps(ip);
                    broadcast({ type: 'status', status: 'Playback ended' });
                });
            });
        });
    });

    client.on('error', (err) => {
        console.error('[Cast] Client error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Client error: ' + err.message });
        cleanupSessionMaps(ip);
        client.close();
    });
}

// The device's volume, kept on the session and sent to the page: once now,
// then whenever it changes (including from the TV remote).
function watchVolume(ip, client) {
    const publish = (volume) => {
        const session = activeSessions.get(ip);
        if (!session || !volume) return;
        session.volume = { level: volume.level, muted: !!volume.muted };
        broadcast({ type: 'volume', deviceIp: ip, volume: session.volume });
    };
    client.getVolume?.((err, volume) => {
        if (!err) publish(volume);
    });
    client.on('status', (status) => publish(status?.volume));
}

const call = (fn) => new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)));
});

// Keep a seek inside what the receiver can play: a live stream's seekable
// window (short of the edge, see LIVE_EDGE_OFFSET), or before a recording ends.
function clampSeek(status, target) {
    const range = status?.liveSeekableRange;
    if (Number.isFinite(range?.end)) {
        const start = range.start || 0;
        return Math.min(Math.max(target, start), Math.max(start, range.end - LIVE_EDGE_OFFSET));
    }
    const duration = status?.media?.duration;
    target = Math.max(0, target);
    if (Number.isFinite(duration) && duration > 0) target = Math.min(target, Math.max(0, duration - 1));
    return target;
}

// Remote control for a playing session. `action`: 'pause', 'play',
// 'seek' (value: seconds to skip, negative for back), 'seekTo' (value: a
// position in seconds), 'live' (jump to the live edge), 'volume' (value: 0-1)
// or 'mute' (value: boolean). Resolves to the session's state afterwards.
async function controlPlayback(ip, action, value) {
    const session = activeSessions.get(ip);
    if (!session) throw new Error('No active session found for this device');
    const { client, player } = session;

    switch (action) {
        case 'pause':
            await call(cb => player.pause(cb));
            break;
        case 'play':
            await call(cb => player.play(cb));
            break;
        case 'seek':
        case 'seekTo': {
            const status = await call(cb => player.getStatus(cb));
            const target = action === 'seek' ? (status?.currentTime || 0) + value : value;
            await call(cb => player.seek(clampSeek(status, target), cb));
            break;
        }
        case 'live': {
            const status = await call(cb => player.getStatus(cb));
            const edge = status?.liveSeekableRange?.end;
            if (!Number.isFinite(edge)) throw new Error('This stream has no live edge to jump to');
            await call(cb => player.seek(Math.max(0, edge - LIVE_EDGE_OFFSET), cb));
            break;
        }
        case 'volume':
            session.volume = { ...session.volume, level: value, muted: false };
            await call(cb => client.setVolume({ level: value }, cb));
            break;
        case 'mute':
            session.volume = { ...session.volume, muted: value };
            await call(cb => client.setVolume({ muted: value }, cb));
            break;
        default:
            throw new Error('Unknown playback action');
    }
    return { volume: session.volume || null };
}

function stopCasting(ip) {
    const session = activeSessions.get(ip);
    if (!session) return null;

    return new Promise((resolve, reject) => {
        try {
            const { client, player } = session;

            player.stop((err) => {
                if (err) {
                    console.error('[Stop] Failed to stop player:', err);
                } else {
                    console.log('[Stop] Player stopped successfully');
                }

                client.close();
                cleanupSessionMaps(ip);
                broadcast({ type: 'status', status: 'Playback stopped' });
                resolve();
            });
        } catch (err) {
            cleanupSessionMaps(ip);
            reject(err);
        }
    });
}

module.exports = { castToDevice, stopCasting, controlPlayback, cleanupSessionMaps, getContentType, clampSeek };
