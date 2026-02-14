const {
    activeSessions,
    bufferHealthTracking,
    streamRecovery
} = require('./state');
const { broadcast } = require('./websocket');
const { getLocalIp, PORT, MAX_RECOVERY_ATTEMPTS, STALL_TIMEOUT } = require('./utils');

function trackStreamActivity(deviceIp) {
    const recovery = streamRecovery.get(deviceIp);
    if (recovery) {
        recovery.lastProxyRequest = Date.now();
        recovery.stallDetected = false;
    }
}

function initializeStreamRecovery(deviceIp, streamUrl, referer) {
    streamRecovery.set(deviceIp, {
        lastProxyRequest: Date.now(),
        bufferingStartTime: null,
        stallDetected: false,
        recoveryAttempts: 0,
        lastRecoveryAttempt: null,
        streamUrl,
        referer
    });
    console.log(`[Recovery] Initialized stall detection for ${deviceIp}`);
}

async function checkStreamStalls() {
    const now = Date.now();

    for (const [deviceIp, recovery] of streamRecovery.entries()) {
        const bufferHealth = bufferHealthTracking.get(deviceIp);

        if (bufferHealth && bufferHealth.lastState === 'BUFFERING' && bufferHealth.lastBufferStart) {
            const bufferingDuration = now - bufferHealth.lastBufferStart;
            const timeSinceLastRequest = now - recovery.lastProxyRequest;
            if (bufferingDuration > STALL_TIMEOUT && timeSinceLastRequest > STALL_TIMEOUT) {
                if (!recovery.stallDetected && recovery.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                    recovery.stallDetected = true;
                    recovery.recoveryAttempts++;
                    recovery.lastRecoveryAttempt = now;
                    console.log(`[Recovery] Stream stalled for ${deviceIp} (${Math.round(bufferingDuration / 1000)}s), attempting recovery (${recovery.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);
                    await attemptStreamRecovery(deviceIp, recovery);
                }
            }
        } else if (bufferHealth && bufferHealth.lastState === 'IDLE') {
            const session = activeSessions.get(deviceIp);
            const timeSinceLastRequest = now - recovery.lastProxyRequest;
            const timeSinceLastRecovery = recovery.lastRecoveryAttempt ? (now - recovery.lastRecoveryAttempt) : Infinity;

            if (session && timeSinceLastRequest > 15000 && timeSinceLastRecovery > 5000 && !recovery.stallDetected && recovery.recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
                recovery.stallDetected = true;
                recovery.recoveryAttempts++;
                recovery.lastRecoveryAttempt = now;
                console.log(`[Recovery] Stream went IDLE unexpectedly for ${deviceIp}, attempting recovery (${recovery.recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);
                await attemptStreamRecovery(deviceIp, recovery);
            }
        } else {
            if (recovery.stallDetected && bufferHealth && bufferHealth.lastState === 'PLAYING') {
                const timeSinceLastRequest = now - recovery.lastProxyRequest;
                if (timeSinceLastRequest < 10000) {
                    const timeSinceLastRecovery = recovery.lastRecoveryAttempt ? (now - recovery.lastRecoveryAttempt) : 0;
                    if (timeSinceLastRecovery > 30000) {
                        console.log(`[Recovery] Stream recovered for ${deviceIp}, resetting recovery counter`);
                        recovery.recoveryAttempts = 0;
                        recovery.stallDetected = false;
                    }
                }
            }
        }
    }
}

async function attemptStreamRecovery(deviceIp, recovery) {
    try {
        const session = activeSessions.get(deviceIp);
        if (!session) {
            console.log(`[Recovery] No active session for ${deviceIp}, cannot recover`);
            return;
        }

        const { player } = session;

        broadcast({
            type: 'streamRecovery',
            deviceIp,
            status: 'attempting',
            attempt: recovery.recoveryAttempts,
            maxAttempts: MAX_RECOVERY_ATTEMPTS
        });

        console.log(`[Recovery] Stopping stalled stream on ${deviceIp}`);
        await new Promise((resolve) => {
            player.stop((err) => {
                if (err && !err.message.includes('INVALID_MEDIA_SESSION_ID')) {
                    console.error('[Recovery] Stop error:', err.message);
                }
                resolve();
            });
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`[Recovery] Restarting stream on ${deviceIp}`);
        const localIp = getLocalIp();
        const media = {
            contentId: `http://${localIp}:${PORT}/proxy?url=${encodeURIComponent(recovery.streamUrl)}&referer=${encodeURIComponent(recovery.referer || '')}`,
            contentType: 'application/x-mpegURL',
            streamType: 'LIVE'
        };

        player.load(media, { autoplay: true }, (err, _status) => {
            if (err) {
                console.error(`[Recovery] Recovery failed for ${deviceIp}:`, err.message);
                broadcast({
                    type: 'streamRecovery',
                    deviceIp,
                    status: 'failed',
                    attempt: recovery.recoveryAttempts,
                    maxAttempts: MAX_RECOVERY_ATTEMPTS
                });

                if (recovery.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                    console.log(`[Recovery] Max recovery attempts reached for ${deviceIp}, giving up`);
                    broadcast({
                        type: 'streamRecovery',
                        deviceIp,
                        status: 'giveup',
                        message: 'Stream recovery failed after multiple attempts. Please restart manually.'
                    });
                }
            } else {
                console.log(`[Recovery] Stream restarted successfully for ${deviceIp}`);
                recovery.lastProxyRequest = Date.now();
                recovery.stallDetected = false;
                broadcast({
                    type: 'streamRecovery',
                    deviceIp,
                    status: 'success',
                    attempt: recovery.recoveryAttempts
                });
            }
        });
    } catch (error) {
        console.error(`[Recovery] Recovery error for ${deviceIp}:`, error.message);
    }
}

function startStallDetection() {
    setInterval(checkStreamStalls, 10000);
    console.log('[Recovery] Stream stall detection started');
}

module.exports = {
    trackStreamActivity,
    initializeStreamRecovery,
    startStallDetection
};
