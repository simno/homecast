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
const { playedToEnd } = require('./queue');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT, LIVE_EDGE_OFFSET } = require('./utils');
const { detectFrameRate, describeHlsStream, isLiveDashStream } = require('./extraction');
const { initializeConnectionHealth, updateHeartbeat } = require('./health');
const { initializeStreamRecovery } = require('./recovery');
const { trackBufferHealth, getBufferHealthStats, noteSeek } = require('./stats');
const { wakeDevice } = require('./wol');
const { buildProxyUrl } = require('./proxy');
const { SIDELOADED_TRACK_ID, sideloadedTrack, newSubtitleState, syncSubtitles, subtitleState } = require('./subtitles');

const IS_DEV = process.env.NODE_ENV === 'development';

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

// A stand-in for the HTTP response when a cast is started by the server itself
// (a fallback recast): whatever castToDevice would send has no one to go to.
function detachedResponse() {
    return {
        headersSent: false,
        status() { return this; },
        json() { this.headersSent = true; return this; }
    };
}

// A sentence for the page from the receiver's LOAD_FAILED / ERROR message.
// detailedErrorCode groups by hundreds: 1xx media (decoding), 3xx network,
// 4xx manifest.
function describeReceiverError(message) {
    const code = message?.detailedErrorCode;
    const lowerQuality = 'Try a lower quality.';
    let what = message?.type === 'LOAD_FAILED'
        ? `The TV refused to load this stream, likely a format it can't play. ${lowerQuality}`
        : 'The TV stopped: it could not play this stream.';
    if (code >= 100 && code < 200) what = `The TV could not decode this stream. ${lowerQuality}`;
    else if (code >= 300 && code < 400) what = 'The TV could not download the stream.';
    else if (code >= 400 && code < 500) what = 'The TV could not read the stream\'s playlist.';
    return code ? `${what} (Receiver error ${code}.)` : what;
}

// Remove all session-related state for a device
function cleanupSessionMaps(ip) {
    activeSessions.get(ip)?.stopTvVolume?.();
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

// Decide the Chromecast streamType for an HLS URL, and for a live one where
// to start: { streamType, startAt } (startAt: seconds, or null).
//
// The manifest is authoritative (see isLiveHlsStream). The URL patterns below
// are only a fallback for when the manifest cannot be fetched — note that an
// explicit `type=replay` disqualifies a URL from the live guess, since that is
// how Periscope/X mark a recording served through a live-shaped playlist.
async function resolveStreamType(url, finalUrl) {
    const described = await describeHlsStream(url);
    if (described) {
        const { live, windowSeconds } = described;
        console.log(`[Cast] Manifest says ${live ? 'live' : 'recorded'}: ${url.substring(0, 80)}...`);
        // Start a live stream near its edge in the load itself. Receivers
        // otherwise start an EVENT playlist (a broadcast with its whole
        // history) at the beginning, and the seek to the edge after load
        // means buffering twice — slow, and slower still when every segment
        // is converted on the way through.
        // `type=replay` is how Periscope/X mark a recording they may still
        // serve without #EXT-X-ENDLIST; starting one at its "edge" would play
        // its last seconds and stop.
        const edgeStart = live && windowSeconds > LIVE_EDGE_OFFSET && !/type=replay/i.test(url);
        const startAt = edgeStart ? windowSeconds - LIVE_EDGE_OFFSET : null;
        return { streamType: live ? 'LIVE' : 'BUFFERED', startAt };
    }

    console.log('[Cast] Could not read manifest, guessing stream type from URL');
    const combined = finalUrl + url;
    if (/type=replay/i.test(combined)) return { streamType: 'BUFFERED', startAt: null };
    const looksLive = /type=live|master_dynamic|live\.m3u8|_live\.m3u8|\/api\/channel\/hls\//i.test(combined);
    return { streamType: looksLive ? 'LIVE' : 'BUFFERED', startAt: null };
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
// `transcode`: convert a variant the receiver can't decode to HEVC (proxy only).
async function castToDevice(ip, url, proxy, referer, quality, res, type, subtitle = null, transcode = false) {
    console.log(`[Cast] Request received for IP: ${ip}, URL: ${url}, Proxy: ${proxy}, Referer: ${referer}, Quality: ${quality}, Type: ${type || 'auto'}, Subtitles: ${subtitle ? (subtitle.label || subtitle.language) : 'off'}${transcode ? ', Convert: HEVC' : ''}`);

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
        ? buildProxyUrl(`${localIp}:${PORT}`, { url, referer, quality, type, transcode: transcode ? 'hevc' : undefined })
        : url;

    console.log(`[Cast] Final Media URL: ${finalUrl}`);

    // Converting: start on the first segments while the receiver launches.
    // Required here, not at the top: routes/proxy requires this module.
    if (proxy && transcode) {
        require('../routes/proxy').warmConvertedPlaylists({ host: `${localIp}:${PORT}`, url, referer, quality })
            .catch(err => console.log(`[Transcode] Warm-up failed: ${err.message}`));
    }
    const { contentType, videoType } = getContentType(finalUrl, type);
    console.log(`[Cast] Content-Type: ${contentType}`);

    // Ask the manifest whether this is live before telling the receiver. Only
    // the URL was consulted here before, which got Periscope/X replays exactly
    // backwards (`master_dynamic_*.m3u8?type=replay` is a finished recording)
    // and ended playback the instant it started.
    let streamType = 'BUFFERED';
    let startAt = null;
    if (videoType === 'hls') {
        ({ streamType, startAt } = await resolveStreamType(url, finalUrl));
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

            // The receiver's own account of a failure (LOAD_FAILED, ERROR with
            // a detailedErrorCode) comes as a separate message, not in the
            // status that just says idleReason ERROR.
            let receiverError = null;
            player.media?.on('message', (message) => {
                if (message.type === 'LOAD_FAILED' || message.type === 'ERROR' || message.type === 'LOAD_CANCELLED') {
                    console.error(`[Cast] Receiver reported ${message.type} on ${ip}:`, JSON.stringify(message));
                    receiverError = message;
                }
            });

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

            // A live stream starts near its edge (see resolveStreamType). The
            // manifest can still take a replay for live, so the receiver's
            // liveSeekableRange has the last word — see the status handler.
            const loadOptions = { autoplay: true };
            if (startAt !== null) {
                loadOptions.currentTime = startAt;
                console.log(`[Cast] Starting live stream near its edge: ${startAt.toFixed(1)}s`);
            }
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
                activeSessions.set(ip, { client, player, streamType, broadcastEnded: false, subtitles: newSubtitleState(subtitle) });
                initializeConnectionHealth(ip);
                initializeStreamRecovery(ip, media);
                syncSubtitles(ip, status);

                // Subtitle state and the volume ride on the response: their
                // broadcasts can reach the page before it has a stream entry
                // to put them on. The volume gets a moment to arrive.
                const firstVolume = watchVolume(ip, client);
                const respond = () => {
                    if (!res.headersSent) {
                        res.json({ status: 'casting', media: status, subtitles: subtitleState(ip), volume: activeSessions.get(ip)?.volume || null });
                    }
                };
                Promise.race([firstVolume, new Promise(resolve => setTimeout(resolve, 1500))]).then(respond, respond);
                broadcast({ type: 'status', status: 'Playing on ' + ip });

                let liveEdgeResolved = false;
                let hasPlayed = false;

                const onStatus = (status) => {
                    console.log('[Cast] Player Status Update:', status.playerState);
                    updateHeartbeat(ip);
                    if (jumped(activeSessions.get(ip), status)) noteSeek(ip); // e.g. the TV's own remote
                    rememberStatus(activeSessions.get(ip), status);

                    if (!playbackTracking.has(ip)) {
                        console.log('[Cast] Full status object:', JSON.stringify(status, null, 2));
                    }

                    if (status.playerState === 'PLAYING') hasPlayed = true;
                    trackBufferHealth(ip, status.playerState);
                    syncSubtitles(ip, status);

                    // isMovingWindow is the only reliable live/replay signal we
                    // get. Providers such as Periscope/X serve finished replays
                    // through a live-style playlist with no #EXT-X-ENDLIST, so
                    // neither the URL nor the manifest distinguishes them; only
                    // the receiver knows whether the window actually slides.
                    //
                    // A load that already asked for the edge is judged once
                    // playing: until then currentTime still reads 0.
                    const range = status.liveSeekableRange;
                    const settling = startAt !== null && range?.isMovingWindow && status.playerState !== 'PLAYING';
                    if (!liveEdgeResolved && range?.end !== undefined && !settling) {
                        liveEdgeResolved = true;
                        const seekTo = (target, what) => {
                            noteSeek(ip);
                            player.seek(target, (err) => {
                                if (err) console.error(`[Cast] ${what} seek failed:`, err.message);
                            });
                        };
                        if (range.isMovingWindow) {
                            const target = Math.max(0, range.end - LIVE_EDGE_OFFSET);
                            if (startAt !== null && Math.abs(status.currentTime - target) < LIVE_EDGE_OFFSET) {
                                console.log(`[Cast] Live window — started at the edge: ${status.currentTime.toFixed(1)}s`);
                            } else {
                                console.log(`[Cast] Live window — seeking to edge: ${target.toFixed(1)}s`);
                                seekTo(target, 'Live edge');
                            }
                        } else if (startAt !== null) {
                            console.log(`[Cast] Fixed window (replay after all, ${range.end.toFixed(1)}s) — back to the start`);
                            seekTo(0, 'Replay start');
                        } else {
                            console.log(`[Cast] Fixed window (replay, ${range.end.toFixed(1)}s) — playing from start`);
                        }
                    }

                    const session = activeSessions.get(ip);
                    if (session && !session.broadcastEnded && status.liveSeekableRange?.isLiveDone) {
                        console.log(`[Cast] Receiver reports the broadcast on ${ip} has ended`);
                        session.broadcastEnded = true;
                    }
                    const ended = !!session?.broadcastEnded;

                    // Once the broadcast is over there is no live edge to be
                    // behind; the page counts down to the end instead.
                    let delay = 0;
                    const tracking = playbackTracking.get(ip) || {};
                    if (ended) {
                        delete tracking.lastDelay;
                    } else if (status.currentTime !== undefined && status.liveSeekableRange?.end !== undefined) {
                        const liveEdge = status.liveSeekableRange.end;
                        delay = Math.max(0, liveEdge - status.currentTime);
                        console.log(`[Delay] Live stream — edge: ${liveEdge.toFixed(1)}s, current: ${status.currentTime.toFixed(1)}s, delay: ${delay.toFixed(1)}s`);
                        tracking.lastDelay = delay;
                    }
                    playbackTracking.set(ip, tracking);

                    broadcast({
                        type: 'playerStatus', deviceIp: ip, status, delay, ended,
                        bufferHealth: getBufferHealthStats(ip)
                    });

                    // Played to the end (a recording, or a broadcast that has
                    // finished). That's not a stall: end the session so
                    // recovery doesn't restart it from the beginning.
                    // The receiver gave up on the stream. Restarting it would
                    // only fail the same way (a codec or format it can't
                    // play), so end the session — which also keeps recovery
                    // off it — and tell the page why.
                    if (status.playerState === 'IDLE' && status.idleReason === 'ERROR' && transcode && !hasPlayed) {
                        // There's no asking a Cast device whether it decodes
                        // 4K HEVC, so a converted cast is the test: rejected
                        // before a frame played, it's recast as the best the
                        // device plays natively, and the page stops offering
                        // conversion for it.
                        console.warn(`[Cast] ${ip} could not play the converted stream (${describeReceiverError(receiverError)}); recasting without conversion`);
                        cleanupSessionMaps(ip);
                        client.close();
                        const message = 'This TV couldn\'t play the converted 4K stream, so HomeCast switched to the best quality it plays directly.';
                        // Kept for pages that have no entry for this stream yet
                        // (the queue started it) or open later: /api/session.
                        sessionNotices.set(ip, { type: 'warning', message, at: Date.now() });
                        broadcast({ type: 'castFallback', deviceIp: ip, message });
                        castToDevice(ip, url, proxy, referer, 'highest', detachedResponse(), type, subtitle, false)
                            .catch(err => console.error(`[Cast] Recasting ${ip} without conversion failed:`, err));
                        return;
                    }

                    if (status.playerState === 'IDLE' && status.idleReason === 'ERROR') {
                        const message = describeReceiverError(receiverError);
                        console.error(`[Cast] Playback failed on ${ip}: ${message}`);
                        cleanupSessionMaps(ip);
                        client.close();
                        broadcast({ type: 'castError', deviceIp: ip, message });
                    }

                    if (status.playerState === 'IDLE' && status.idleReason === 'FINISHED') {
                        console.log(`[Cast] Playback finished on ${ip}`);
                        cleanupSessionMaps(ip);
                        client.close();
                        broadcast({ type: 'status', status: ended ? 'Broadcast ended' : 'Playback finished' });
                        playedToEnd(ip);
                    }
                };
                player.on('status', onStatus);
                activeSessions.get(ip).onStatus = onStatus;

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

// The receiver's volume as the page shows it. `fixed`: the device doesn't
// let apps set its level (controlType 'fixed', e.g. one whose TV owns the
// volume); only the TV's remote changes it.
function pageVolume(volume) {
    return { level: volume.level, muted: !!volume.muted, fixed: volume.controlType === 'fixed' };
}

// The device's volume, kept on the session and sent to the page: once now,
// then whenever it changes (including from the TV remote). Resolves once the
// first report is in.
function watchVolume(ip, client) {
    let logged = false;
    let first;
    const firstVolume = new Promise(resolve => { first = resolve; });
    const publish = (volume) => {
        const session = activeSessions.get(ip);
        if (!session || !volume) return;
        if (!logged) {
            logged = true;
            console.log(`[Cast] Volume on ${ip}: level ${volume.level}, control ${volume.controlType || 'unknown'}` +
                (volume.stepInterval ? `, step ${volume.stepInterval}` : ''));
        }
        // The slider shows the TV's volume now (linkTvVolume): not this one.
        if (session.volumeTv) return first();
        session.volume = pageVolume(volume);
        broadcast({ type: 'volume', deviceIp: ip, volume: session.volume });
        first();
        // Volume that's the TV's business: go looking for the TV, once it has
        // had a moment to switch to this Chromecast's input.
        if (TV_CONTROL_TYPES.has(volume.controlType) && !session.tvLinkScheduled) {
            session.tvLinkScheduled = true;
            setTimeout(() => linkTvVolume(ip, client), TV_LINK_DELAY_MS);
        }
    };
    client.getVolume?.((err, volume) => {
        if (!err) publish(volume);
    });
    client.on('status', (status) => publish(status?.volume));
    return firstVolume;
}

// How long a device gets to apply a new volume level before it's asked again,
// and how far off the answer may be (devices round to their own steps).
const VOLUME_SETTLE_MS = 1200;
const VOLUME_TOLERANCE = 0.03;

// Some devices accept a volume level and do nothing with it: ask again once
// it has had time, and if it didn't move, tell the page (and show it the level
// the device really has).
function checkVolumeApplied(ip, client, level) {
    setTimeout(() => {
        const session = activeSessions.get(ip);
        if (!session || session.client !== client) return;
        client.getVolume(async (err, volume) => {
            if (err || !volume || Math.abs(volume.level - level) <= VOLUME_TOLERANCE) return;
            // Asked for another level since (the slider moved on): that one's check decides.
            if (session.requestedVolume !== level) return;
            console.warn(`[Cast] ${ip} kept its volume at ${volume.level} when set to ${level} (control ${volume.controlType || 'unknown'})`);
            // Its TV takes the level instead, if HomeCast can find it.
            if (await linkTvVolume(ip, client)) {
                await controlTvVolume(ip, session, { level }).catch(e => console.warn(`[Cast] Setting the TV volume failed: ${e.message}`));
                return;
            }
            session.volume = pageVolume(volume);
            broadcast({ type: 'volume', deviceIp: ip, volume: session.volume });
            broadcast({
                type: 'castNotice', deviceIp: ip, level: 'warning', volume: session.volume,
                message: 'The device didn\u2019t change its volume. Its volume is probably controlled by the TV: use the TV remote.'
            });
        });
    }, VOLUME_SETTLE_MS);
}

// ===== VOLUME ON THE TV =====
// A Chromecast that passes volume to its TV over HDMI (controlType 'master'
// or 'fixed', or one that ignores levels) is turned up on the TV itself when
// that's an LG TV HomeCast knows: the one showing an HDMI input, or the LG TV
// the Cast receiver is built into.

const TV_CONTROL_TYPES = new Set(['fixed', 'master']);
const TV_LINK_DELAY_MS = 3000;

// Resolves true once the session's volume is the TV's.
function linkTvVolume(ip, client) {
    const session = activeSessions.get(ip);
    if (!session || session.client !== client) return Promise.resolve(false);
    if (session.volumeTv) return Promise.resolve(true);
    session.tvLink ??= (async () => {
        // Required here: lib/webos requires modules that require this one.
        const webos = require('./webos');
        const tvIp = devices.get(ip)?.webos && await webos.isPaired(ip) ? ip : await webos.findTvShowingHdmi();
        if (!tvIp || activeSessions.get(ip) !== session) return false;
        const name = devices.get(tvIp)?.name || tvIp;
        console.log(`[Cast] ${ip} leaves its volume to the TV; the slider controls ${name} (${tvIp})`);
        session.volumeTv = { ip: tvIp, name };
        session.stopTvVolume = webos.followTvVolume(tvIp, (volume) => showTvVolume(ip, session, volume));
        return true;
    })().catch((err) => {
        console.warn(`[Cast] Looking for the TV behind ${ip} failed: ${err.message}`);
        return false;
    }).then((linked) => {
        if (!linked) session.tvLink = null; // try again next time
        return linked;
    });
    return session.tvLink;
}

function showTvVolume(ip, session, volume) {
    if (activeSessions.get(ip) !== session || !volume) return;
    session.volume = { level: volume.level, muted: volume.muted, fixed: false, via: session.volumeTv.name };
    broadcast({ type: 'volume', deviceIp: ip, volume: session.volume });
}

async function controlTvVolume(ip, session, change) {
    const volume = await require('./webos').setTvVolume(session.volumeTv.ip, change);
    showTvVolume(ip, session, volume);
}

const call = (fn) => new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)));
});

// How far the position may stray from where playback should be before it
// counts as a seek (one we didn't ask for: the TV's remote, say).
const SEEK_JUMP_S = 5;

// Whether `status` is somewhere else than the session's last status leads
// to expect: a seek.
function jumped(session, status) {
    const last = session?.lastStatus;
    if (!last || last.currentTime === undefined || status.currentTime === undefined) return false;
    const elapsed = last.playerState === 'PLAYING' ? (Date.now() - session.lastStatusAt) / 1000 : 0;
    return Math.abs(status.currentTime - (last.currentTime + elapsed)) > SEEK_JUMP_S;
}

// Keep a session's latest receiver status for pages that open mid-stream.
// Receivers send status only on changes (play, pause, buffering, seek), and
// the media's duration only in the first one after loading — later statuses
// leave `media` out — so it's carried over from whichever status had it.
function rememberStatus(session, status) {
    if (!session || !status) return;
    session.lastStatus = { ...status, media: status.media || session.lastStatus?.media };
    session.lastStatusAt = Date.now();
}

const STATUS_REFRESH_TIMEOUT_MS = 1500;

// Where a Chromecast session stands now, for a page restoring its dashboard:
// { status, statusAgeMs, ended }. Asks the receiver for a fresh status, and
// falls back to the last one it sent if it doesn't answer quickly.
async function sessionPlayback(ip) {
    const session = activeSessions.get(ip);
    if (!session) return null;
    try {
        const fresh = await Promise.race([
            call(cb => session.player.getStatus(cb)),
            new Promise((resolve) => setTimeout(resolve, STATUS_REFRESH_TIMEOUT_MS).unref())
        ]);
        if (fresh) rememberStatus(session, fresh);
    } catch { /* the last status will do */ }
    if (!session.lastStatus) return null;
    return {
        status: session.lastStatus,
        statusAgeMs: Date.now() - session.lastStatusAt,
        ended: !!session.broadcastEnded
    };
}

// The proxy saw this device's live playlist gain #EXT-X-ENDLIST: the
// broadcast is over. Ask the receiver where things stand once it has had a
// moment to load that final playlist, and report it like any status.
const BROADCAST_END_SETTLE_MS = 2000;

function markBroadcastEnded(ip) {
    const session = activeSessions.get(ip);
    if (!session || session.streamType !== 'LIVE' || session.broadcastEnded) return;
    console.log(`[Cast] Broadcast on ${ip} has ended (playlist closed)`);
    session.broadcastEnded = true;
    setTimeout(() => {
        if (activeSessions.get(ip) !== session) return;
        session.player.getStatus((err, status) => {
            if (!err && status) session.onStatus?.(status);
        });
    }, BROADCAST_END_SETTLE_MS).unref();
}

// Keep a seek inside what the receiver can play: a live stream's seekable
// window (short of the edge, see LIVE_EDGE_OFFSET), or before a recording ends.
function clampSeek(status, target) {
    const range = status?.liveSeekableRange;
    if (Number.isFinite(range?.end)) {
        const start = range.start || 0;
        // A finished broadcast's end is fixed and fully downloadable.
        const margin = range.isLiveDone ? 1 : LIVE_EDGE_OFFSET;
        return Math.min(Math.max(target, start), Math.max(start, range.end - margin));
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
            noteSeek(ip);
            const status = await call(cb => player.getStatus(cb));
            const target = action === 'seek' ? (status?.currentTime || 0) + value : value;
            await call(cb => player.seek(clampSeek(status, target), cb));
            break;
        }
        case 'live': {
            noteSeek(ip);
            const status = await call(cb => player.getStatus(cb));
            const edge = status?.liveSeekableRange?.end;
            if (!Number.isFinite(edge)) throw new Error('This stream has no live edge to jump to');
            await call(cb => player.seek(Math.max(0, edge - LIVE_EDGE_OFFSET), cb));
            break;
        }
        case 'volume': {
            if (session.volumeTv) {
                await controlTvVolume(ip, session, { level: value });
                break;
            }
            if (session.volume?.fixed) throw new Error('This device\u2019s volume is set with the TV remote');
            session.volume = { ...session.volume, level: value, muted: false };
            session.requestedVolume = value;
            const reported = await call(cb => client.setVolume({ level: value }, cb));
            console.log(`[Cast] Volume on ${ip} set to ${value}; device reports ${reported?.level ?? 'nothing'}`);
            checkVolumeApplied(ip, client, value);
            break;
        }
        case 'mute':
            if (session.volumeTv) {
                await controlTvVolume(ip, session, { muted: value });
                break;
            }
            session.volume = { ...session.volume, muted: value };
            await call(cb => client.setVolume({ muted: value }, cb));
            break;
        default:
            throw new Error('Unknown playback action');
    }
    return { volume: session.volume || null };
}

// Something to tell the page about a device's current stream, beyond what its
// status says (ip -> { type, message, at }): the recast without conversion.
// A new cast or a stop clears it; it's only offered for a while.
const sessionNotices = new Map();
const NOTICE_TTL_MS = 10 * 60 * 1000;

function sessionNotice(ip) {
    const notice = sessionNotices.get(ip);
    if (!notice || Date.now() - notice.at > NOTICE_TTL_MS) return null;
    return { type: notice.type, message: notice.message };
}

function clearSessionNotice(ip) {
    sessionNotices.delete(ip);
}

function stopCasting(ip) {
    clearSessionNotice(ip);
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

module.exports = { castToDevice, stopCasting, sessionNotice, clearSessionNotice, controlPlayback, cleanupSessionMaps, getContentType, clampSeek, markBroadcastEnded, describeReceiverError, sessionPlayback };
