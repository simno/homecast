const { bufferHealthTracking } = require('./state');

// Brief BUFFERING right after a PAUSED→play resume is the player rebuilding
// its buffer, not a stall. Don't count it as a user-visible event.
const RESUME_BUFFER_GRACE_MS = 2000;

// Buffering right after a seek is the player filling its buffer at the new
// position — longer when every segment there has to be converted first — not
// a stall: it neither counts as an event nor against the score, unless it
// drags on past this.
const SEEK_BUFFER_GRACE_S = 15;
const SEEK_WINDOW_MS = 5000;

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
            hasPlayed: false,
            lastSeekAt: null,
            bufferAfterSeek: false
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
            const counted = countedBuffering(tracking, dur);
            if (tracking.bufferAfterSeek && counted > 0) tracking.bufferingEvents++; // a seek that stalled after all
            tracking.totalBufferingTime += Math.min(counted, MAX_ONGOING_BUFFER_S);
            console.log(`[PlaybackQuality] ${deviceIp} - Buffering ended (duration: ${dur.toFixed(1)}s${tracking.bufferAfterSeek ? ', after a seek' : ''}, total: ${tracking.totalBufferingTime.toFixed(1)}s)`);
            tracking.lastBufferStart = null;
            tracking.bufferAfterSeek = false;
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
            tracking.bufferAfterSeek = tracking.lastSeekAt !== null && (now - tracking.lastSeekAt) < SEEK_WINDOW_MS;
            if (tracking.bufferAfterSeek) {
                console.log(`[PlaybackQuality] ${deviceIp} - Buffering started (after a seek, not counted)`);
            } else if (!isResumeBuffer) {
                tracking.bufferingEvents++;
                console.log(`[PlaybackQuality] ${deviceIp} - Buffering started (event #${tracking.bufferingEvents})`);
            } else {
                console.log(`[PlaybackQuality] ${deviceIp} - Buffering started (resume from pause, not counted)`);
            }
        }
    }

    tracking.lastState = playerState;
}

// Seconds of a buffering spell that count against the score.
function countedBuffering(tracking, seconds) {
    return tracking.bufferAfterSeek ? Math.max(0, seconds - SEEK_BUFFER_GRACE_S) : seconds;
}

// The player was told to seek (or was seen to jump): the buffering that
// follows is expected.
function noteSeek(deviceIp) {
    const tracking = bufferHealthTracking.get(deviceIp);
    if (tracking) tracking.lastSeekAt = Date.now();
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
        const ongoing = countedBuffering(tracking, (now - tracking.lastBufferStart) / 1000);
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

module.exports = { trackBufferHealth, getBufferHealthStats, noteSeek };
