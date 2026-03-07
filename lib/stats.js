const { bufferHealthTracking } = require('./state');

// --- Buffer Health Tracking ---
function trackBufferHealth(deviceIp, playerState) {
    let tracking = bufferHealthTracking.get(deviceIp);

    if (!tracking) {
        tracking = {
            bufferingEvents: 0,
            totalBufferingTime: 0,
            totalPausedTime: 0,
            lastBufferStart: null,
            lastPauseStart: null,
            lastState: null,
            sessionStartTime: null,
            hasPlayed: false
        };
        bufferHealthTracking.set(deviceIp, tracking);
    }

    const now = Date.now();

    // Start the session clock on first PLAYING state
    if (playerState === 'PLAYING' && !tracking.hasPlayed) {
        tracking.hasPlayed = true;
        tracking.sessionStartTime = now;
        console.log(`[BufferHealth] ${deviceIp} - Playback started, session clock begins`);
    }

    // Only track events after playback has started
    if (tracking.hasPlayed) {
        // Buffering tracking
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

        // Pause tracking — exclude paused time from health calculation
        if (playerState === 'PAUSED' && tracking.lastState !== 'PAUSED') {
            tracking.lastPauseStart = now;
        } else if (tracking.lastState === 'PAUSED' && playerState !== 'PAUSED') {
            if (tracking.lastPauseStart) {
                tracking.totalPausedTime += (now - tracking.lastPauseStart) / 1000;
                tracking.lastPauseStart = null;
            }
        }
    }

    tracking.lastState = playerState;
}

function getBufferHealthStats(deviceIp) {
    const tracking = bufferHealthTracking.get(deviceIp);
    if (!tracking || !tracking.hasPlayed) {
        return null;
    }

    const now = Date.now();

    // Cap ongoing buffering at 5 minutes to avoid runaway scores from stale state
    const MAX_ONGOING_BUFFER = 300;
    let currentBufferingTime = tracking.totalBufferingTime;
    if (tracking.lastBufferStart) {
        const ongoing = (now - tracking.lastBufferStart) / 1000;
        currentBufferingTime += Math.min(ongoing, MAX_ONGOING_BUFFER);
    }

    // Exclude paused time from total session
    let currentPausedTime = tracking.totalPausedTime;
    if (tracking.lastPauseStart) {
        currentPausedTime += (now - tracking.lastPauseStart) / 1000;
    }

    const totalSessionTime = (now - tracking.sessionStartTime) / 1000 - currentPausedTime;
    if (totalSessionTime <= 0) {
        return null;
    }

    const playingTime = totalSessionTime - currentBufferingTime;
    const healthScore = Math.round((playingTime / totalSessionTime) * 100);

    return {
        healthScore: Math.max(0, Math.min(100, healthScore)),
        bufferingEvents: tracking.bufferingEvents,
        totalBufferingTime: Math.round(currentBufferingTime)
    };
}

module.exports = { trackBufferHealth, getBufferHealthStats };
