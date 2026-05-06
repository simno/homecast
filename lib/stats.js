const { bufferHealthTracking } = require('./state');

// Brief BUFFERING right after a PAUSED→play resume is the player rebuilding
// its buffer, not a stall. Don't count it as a user-visible event.
const RESUME_BUFFER_GRACE_MS = 2000;

// Cap ongoing buffering at 5 minutes so a missed "buffering ended" message
// can't drive the score to 0.
const MAX_ONGOING_BUFFER_S = 300;

// --- Playback Quality Tracking ---
// Score = playingTime / (playingTime + bufferingTime). Anything that isn't
// PLAYING or BUFFERING (PAUSED, IDLE, UNKNOWN, ...) is excluded from both
// numerator and denominator, so the user isn't penalised for time the player
// wasn't actively trying to play.
function trackBufferHealth(deviceIp, playerState) {
    let tracking = bufferHealthTracking.get(deviceIp);

    if (!tracking) {
        tracking = {
            bufferingEvents: 0,
            totalPlayingTime: 0,
            totalBufferingTime: 0,
            lastPlayStart: null,
            lastBufferStart: null,
            lastPauseEnd: null,
            lastState: null,
            hasPlayed: false
        };
        bufferHealthTracking.set(deviceIp, tracking);
    }

    const now = Date.now();
    const prev = tracking.lastState;

    if (playerState === prev) return;

    // Start the session on first PLAYING state
    if (playerState === 'PLAYING' && !tracking.hasPlayed) {
        tracking.hasPlayed = true;
        console.log(`[PlaybackQuality] ${deviceIp} - Playback started`);
    }

    if (tracking.hasPlayed) {
        // Close out the previous state's accumulator
        if (prev === 'PLAYING' && tracking.lastPlayStart) {
            tracking.totalPlayingTime += (now - tracking.lastPlayStart) / 1000;
            tracking.lastPlayStart = null;
        } else if (prev === 'BUFFERING' && tracking.lastBufferStart) {
            const dur = (now - tracking.lastBufferStart) / 1000;
            tracking.totalBufferingTime += Math.min(dur, MAX_ONGOING_BUFFER_S);
            console.log(`[PlaybackQuality] ${deviceIp} - Buffering ended (duration: ${dur.toFixed(1)}s, total: ${tracking.totalBufferingTime.toFixed(1)}s)`);
            tracking.lastBufferStart = null;
        } else if (prev === 'PAUSED') {
            tracking.lastPauseEnd = now;
        }

        // Open the new state's accumulator
        if (playerState === 'PLAYING') {
            tracking.lastPlayStart = now;
        } else if (playerState === 'BUFFERING') {
            tracking.lastBufferStart = now;
            const isResumeBuffer = tracking.lastPauseEnd &&
                (now - tracking.lastPauseEnd) < RESUME_BUFFER_GRACE_MS;
            if (!isResumeBuffer) {
                tracking.bufferingEvents++;
                console.log(`[PlaybackQuality] ${deviceIp} - Buffering started (event #${tracking.bufferingEvents})`);
            } else {
                console.log(`[PlaybackQuality] ${deviceIp} - Buffering started (resume from pause, not counted)`);
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

    let playingTime = tracking.totalPlayingTime;
    if (tracking.lastPlayStart) {
        playingTime += (now - tracking.lastPlayStart) / 1000;
    }

    let bufferingTime = tracking.totalBufferingTime;
    if (tracking.lastBufferStart) {
        const ongoing = (now - tracking.lastBufferStart) / 1000;
        bufferingTime += Math.min(ongoing, MAX_ONGOING_BUFFER_S);
    }

    const qualifyingTime = playingTime + bufferingTime;
    if (qualifyingTime <= 0) {
        return null;
    }

    const healthScore = Math.round((playingTime / qualifyingTime) * 100);

    return {
        healthScore: Math.max(0, Math.min(100, healthScore)),
        bufferingEvents: tracking.bufferingEvents,
        totalBufferingTime: Math.round(bufferingTime)
    };
}

module.exports = { trackBufferHealth, getBufferHealthStats };
