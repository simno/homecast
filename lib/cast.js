const { Client, DefaultMediaReceiver } = require('castv2-client');
const {
    devices,
    activeSessions,
    playbackTracking,
    bufferHealthTracking,
    streamRecovery,
    streamStats,
    deviceToClientMap,
    connectionHealth,
} = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT } = require('./utils');
const { detectFrameRate } = require('./extraction');
const { initializeConnectionHealth, updateHeartbeat } = require('./health');
const { initializeStreamRecovery } = require('./recovery');
const { trackBufferHealth, getBufferHealthStats } = require('./stats');

const IS_DEV = process.env.NODE_ENV === 'development';

function castToDevice(ip, url, proxy, referer, res) {
    console.log(`[Cast] Request received for IP: ${ip}, URL: ${url}, Proxy: ${proxy}, Referer: ${referer}`);

    // Clear any existing session and stats for this device
    if (activeSessions.has(ip)) {
        console.log(`[Cast] Stopping existing session on ${ip} before starting new stream`);
        const existingSession = activeSessions.get(ip);
        try {
            existingSession.player.stop(() => {
                existingSession.client.close();
            });
        } catch (err) {
            console.warn('[Cast] Error stopping existing session:', err.message);
        }
        activeSessions.delete(ip);
    }

    playbackTracking.delete(ip);
    streamStats.delete(ip);
    deviceToClientMap.delete(ip);
    console.log('[Cast] Statistics reset for new stream on', ip);

    const localIp = getLocalIp();
    const isMockDevice = IS_DEV && devices[ip]?.isMock;

    const clientIpForMapping = isMockDevice ? localIp : ip;
    deviceToClientMap.set(ip, clientIpForMapping);
    console.log(`[Cast] Mapped device ${ip} to client ${clientIpForMapping}${isMockDevice ? ' (mock device)' : ''}`);

    let client, launchReceiver;
    if (isMockDevice) {
        console.log('[Cast] Using mock Chromecast device');
        const mockModule = require('../mock-chromecast');
        // Need to get mockDevice from discovery - use a simple approach
        const MockCastClient = mockModule.MockCastClient;
        const MockPlayer = mockModule.MockPlayer;
        // For mock, we create a temporary mock device connection
        const MockChromecast = mockModule.MockChromecast;
        const tempMock = new MockChromecast('Mock Chromecast (Dev)', 8009);
        client = new MockCastClient(tempMock);
        launchReceiver = (_ReceiverType, callback) => {
            const player = new MockPlayer(client, tempMock);
            callback(null, player);
        };
    } else {
        client = new Client();
        launchReceiver = (ReceiverType, callback) => {
            client.launch(ReceiverType, callback);
        };
    }

    const finalUrl = proxy
        ? `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer || '')}`
        : url;

    console.log(`[Cast] Final Media URL: ${finalUrl}`);

    let contentType = 'video/mp4';
    let videoType = 'mp4';
    const lowerUrl = finalUrl.toLowerCase();
    if (lowerUrl.includes('.m3u8') || lowerUrl.includes('playlist')) {
        contentType = 'application/x-mpegURL';
        videoType = 'hls';
    }
    if (lowerUrl.includes('.webm')) {
        contentType = 'video/webm';
        videoType = 'webm';
    }
    console.log(`[Cast] Content-Type: ${contentType}`);

    if (videoType === 'mp4') {
        detectFrameRate(url, 'mp4').then(fps => {
            if (fps && streamStats.has(ip)) {
                streamStats.get(ip).frameRate = fps;
                console.log(`[Cast] Detected MP4 frame rate: ${fps} FPS`);
                broadcast({
                    type: 'streamStats',
                    deviceIp: ip,
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
                contentType: contentType,
                streamType: 'LIVE'
            };

            console.log('[Cast] Media object:', JSON.stringify(media, null, 2));

            const loadTimeout = setTimeout(() => {
                console.error('[Cast] Load timeout - Chromecast may not be able to reach the proxy URL');
                if (!res.headersSent) {
                    res.status(408).json({
                        error: 'Load timeout - Chromecast cannot reach proxy',
                        proxyUrl: finalUrl,
                        troubleshooting: {
                            chromecastIp: ip,
                            proxyIp: localIp,
                            proxyPort: PORT,
                            message: 'Ensure Chromecast can reach the proxy IP. Check firewall and network settings.'
                        }
                    });
                }
                client.close();
            }, 10000);

            player.load(media, { autoplay: true }, (err, status) => {
                clearTimeout(loadTimeout);

                if (err) {
                    console.error('[Cast] Load failed:', err);
                    if (!res.headersSent) res.status(500).json({ error: 'Load failed: ' + err.message });
                    client.close();
                    return;
                }

                console.log('[Cast] Media loaded successfully');
                if (!res.headersSent) res.json({ status: 'casting', media: status });
                broadcast({ type: 'status', status: 'Playing on ' + ip });

                activeSessions.set(ip, { client, player });
                initializeConnectionHealth(ip);
                initializeStreamRecovery(ip, url, referer || '');

                player.on('status', (status) => {
                    console.log('[Cast] Player Status Update:', status.playerState);
                    updateHeartbeat(ip);

                    if (!playbackTracking.has(ip)) {
                        console.log('[Cast] Full status object:', JSON.stringify(status, null, 2));
                    }

                    trackBufferHealth(ip, status.playerState);

                    let delay = 0;
                    if (status.currentTime !== undefined && status.liveSeekableRange && status.liveSeekableRange.end !== undefined) {
                        const liveEdge = status.liveSeekableRange.end;
                        delay = Math.max(0, liveEdge - status.currentTime);
                        console.log(`[Delay] Live stream - edge: ${liveEdge.toFixed(1)}s, current: ${status.currentTime.toFixed(1)}s, delay: ${delay.toFixed(1)}s`);

                        const tracking = playbackTracking.get(ip) || {};
                        tracking.lastDelay = delay;
                        playbackTracking.set(ip, tracking);
                    }

                    const bufferHealth = getBufferHealthStats(ip);

                    broadcast({
                        type: 'playerStatus',
                        deviceIp: ip,
                        status,
                        delay,
                        bufferHealth
                    });
                });

                player.on('close', () => {
                    console.log('[Cast] Player closed for', ip);
                    activeSessions.delete(ip);
                    playbackTracking.delete(ip);
                    bufferHealthTracking.delete(ip);
                    streamRecovery.delete(ip);
                    deviceToClientMap.delete(ip);
                    connectionHealth.delete(ip);
                    streamStats.delete(ip);
                    broadcast({ type: 'status', status: 'Playback ended' });
                });
            });
        });
    });

    client.on('error', (err) => {
        console.error('[Cast] Client error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Client error: ' + err.message });
        activeSessions.delete(ip);
        playbackTracking.delete(ip);
        deviceToClientMap.delete(ip);
        streamStats.delete(ip);
        client.close();
    });
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
                activeSessions.delete(ip);
                playbackTracking.delete(ip);
                bufferHealthTracking.delete(ip);
                streamRecovery.delete(ip);
                deviceToClientMap.delete(ip);
                connectionHealth.delete(ip);
                streamStats.delete(ip);

                broadcast({ type: 'status', status: 'Playback stopped' });
                resolve();
            });
        } catch (err) {
            activeSessions.delete(ip);
            streamRecovery.delete(ip);
            deviceToClientMap.delete(ip);
            streamStats.delete(ip);
            reject(err);
        }
    });
}

module.exports = { castToDevice, stopCasting };
