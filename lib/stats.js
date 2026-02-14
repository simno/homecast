const { bufferHealthTracking } = require('./state');

// --- Buffer Health Tracking ---
function trackBufferHealth(deviceIp, playerState) {
    let tracking = bufferHealthTracking.get(deviceIp);

    if (!tracking) {
        tracking = {
            bufferingEvents: 0,
            totalBufferingTime: 0,
            lastBufferStart: null,
            lastState: null,
            sessionStartTime: null, // Set when playback first starts
            hasPlayed: false        // True after first PLAYING state
        };
        bufferHealthTracking.set(deviceIp, tracking);
    }

    const now = Date.now();

    // Start the session clock on first PLAYING state, not on first status update
    if (playerState === 'PLAYING' && !tracking.hasPlayed) {
        tracking.hasPlayed = true;
        tracking.sessionStartTime = now;
        console.log(`[BufferHealth] ${deviceIp} - Playback started, session clock begins`);
    }

    // Only track buffering events after playback has started
    if (tracking.hasPlayed) {
        if (playerState === 'BUFFERING' && tracking.lastState !== 'BUFFERING') {
            tracking.bufferingEvents++;
            tracking.lastBufferStart = now;
            console.log(`[BufferHealth] ${deviceIp} - Buffering started (event #${tracking.bufferingEvents})`);
        } else if (tracking.lastState === 'BUFFERING' && playerState !== 'BUFFERING') {
            if (tracking.lastBufferStart) {
                const bufferingDuration = (now - tracking.lastBufferStart) / 1000;
                tracking.totalBufferingTime += bufferingDuration;
                console.log(`[BufferHealth] ${deviceIp} - Buffering ended (duration: ${bufferingDuration.toFixed(1)}s, total: ${tracking.totalBufferingTime.toFixed(1)}s)`);
                tracking.lastBufferStart = null;
            }
        }
    }

    tracking.lastState = playerState;
}

function getBufferHealthStats(deviceIp) {
    const tracking = bufferHealthTracking.get(deviceIp);
    if (!tracking || !tracking.hasPlayed) {
        return {
            healthScore: 100,
            bufferingEvents: 0,
            totalBufferingTime: 0
        };
    }

    let currentBufferingTime = tracking.totalBufferingTime;
    if (tracking.lastBufferStart) {
        currentBufferingTime += (Date.now() - tracking.lastBufferStart) / 1000;
    }

    const totalSessionTime = (Date.now() - tracking.sessionStartTime) / 1000;
    const playingTime = totalSessionTime - currentBufferingTime;
    const healthScore = totalSessionTime > 0 ? Math.round((playingTime / totalSessionTime) * 100) : 100;

    return {
        healthScore: Math.max(0, Math.min(100, healthScore)),
        bufferingEvents: tracking.bufferingEvents,
        totalBufferingTime: Math.round(currentBufferingTime)
    };
}

module.exports = { trackBufferHealth, getBufferHealthStats };
