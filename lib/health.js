const { connectionHealth, activeSessions } = require('./state');
const { broadcast } = require('./websocket');
const {
    HEARTBEAT_INTERVAL,
    MAX_MISSED_HEARTBEATS,
    RECONNECT_DELAY,
    MAX_RECONNECT_ATTEMPTS
} = require('./utils');

function initializeConnectionHealth(deviceIp) {
    connectionHealth.set(deviceIp, {
        lastHeartbeat: Date.now(),
        // Tracked separately from lastHeartbeat: proxy traffic proves the TV is
        // still pulling video, which says nothing about whether the castv2
        // control channel still works. The two die independently.
        lastControlHeartbeat: Date.now(),
        missedHeartbeats: 0,
        connectionState: 'healthy',
        reconnectAttempts: 0,
        lastActivity: Date.now()
    });
    console.log(`[Health] Initialized monitoring for ${deviceIp}`);

    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'healthy',
        message: 'Connected'
    });
}

// `source` is 'control' for evidence the castv2 control channel is alive (a
// player status event, or a successful getStatus), and 'media' for proxy
// traffic. Only the control channel may clear the reconnect counter: media
// traffic continues long after the control channel has died, and letting it
// reset the counter meant a dead session retried "attempt 1/3" forever and
// never reached the give-up-and-clean-up path.
function updateHeartbeat(deviceIp, source = 'control') {
    const health = connectionHealth.get(deviceIp);
    if (!health) return;

    health.lastHeartbeat = Date.now();
    health.lastActivity = Date.now();
    health.missedHeartbeats = 0;
    if (source === 'control') health.lastControlHeartbeat = Date.now();

    if (health.connectionState === 'healthy') return;

    health.connectionState = 'healthy';
    if (source === 'control') health.reconnectAttempts = 0;
    console.log(`[Health] Connection restored for ${deviceIp}`);
    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'healthy',
        message: 'Connection restored'
    });
}

function checkConnectionHealth() {
    const now = Date.now();

    for (const [deviceIp, health] of connectionHealth.entries()) {
        const timeSinceLastHeartbeat = now - health.lastHeartbeat;
        const session = activeSessions.get(deviceIp);

        if (!session) {
            connectionHealth.delete(deviceIp);
            continue;
        }

        if (timeSinceLastHeartbeat > HEARTBEAT_INTERVAL) {
            health.missedHeartbeats = Math.floor(timeSinceLastHeartbeat / HEARTBEAT_INTERVAL);

            if (health.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
                if (health.connectionState !== 'unhealthy' && health.connectionState !== 'reconnecting') {
                    health.connectionState = 'unhealthy';
                    console.warn(`[Health] Connection unhealthy for ${deviceIp} (${health.missedHeartbeats} missed heartbeats)`);
                    broadcast({
                        type: 'connectionHealth',
                        deviceIp,
                        state: 'unhealthy',
                        message: `No response for ${Math.round(timeSinceLastHeartbeat / 1000)}s`,
                        missedHeartbeats: health.missedHeartbeats
                    });

                    if (health.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        setTimeout(() => attemptReconnect(deviceIp), RECONNECT_DELAY);
                    }
                }
            } else if (health.missedHeartbeats >= 2) {
                if (health.connectionState === 'healthy') {
                    health.connectionState = 'degraded';
                    console.log(`[Health] Connection degraded for ${deviceIp}`);
                    broadcast({
                        type: 'connectionHealth',
                        deviceIp,
                        state: 'degraded',
                        message: 'Connection may be unstable'
                    });
                }
            }
        }
    }
}

// A reconnect attempt that did not reach the device. Escalates towards giving
// up and schedules the next try itself: checkConnectionHealth only arms a
// reconnect on the transition *into* 'unhealthy', so a failed attempt that
// left the state alone would never be retried.
function handleReconnectFailure(deviceIp, reason) {
    const health = connectionHealth.get(deviceIp);
    if (!health) return;

    console.warn(`[Health] Reconnection failed for ${deviceIp}: ${reason}`);

    if (health.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        health.connectionState = 'unhealthy';
        setTimeout(() => attemptReconnect(deviceIp), RECONNECT_DELAY);
        return;
    }

    console.error(`[Health] Max reconnection attempts reached for ${deviceIp}, giving up`);
    health.connectionState = 'failed';
    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'failed',
        message: 'Connection lost. Please restart casting.'
    });

    // The device went silent without ever firing the player/client 'close' or
    // 'error' events that normally trigger cleanup (e.g. unplugged, dropped off
    // the network) — tear the session down here so activeSessions and its
    // dependent maps don't leak.
    const session = activeSessions.get(deviceIp);
    if (session) {
        try { session.client.close(); } catch { /* already gone */ }
    }
    require('./cast').cleanupSessionMaps(deviceIp);
}

async function attemptReconnect(deviceIp) {
    const health = connectionHealth.get(deviceIp);
    if (!health) return;

    // Only a live control channel means there is nothing to reconnect. Testing
    // connectionState here instead would abort the retry whenever proxy traffic
    // had just flipped the session back to 'healthy'.
    if (Date.now() - health.lastControlHeartbeat < HEARTBEAT_INTERVAL) return;

    health.reconnectAttempts++;
    health.connectionState = 'reconnecting';

    console.log(`[Health] Attempting reconnection for ${deviceIp} (attempt ${health.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    broadcast({
        type: 'connectionHealth',
        deviceIp,
        state: 'reconnecting',
        message: `Reconnecting... (${health.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
        attempt: health.reconnectAttempts
    });

    const session = activeSessions.get(deviceIp);
    if (!session || !session.player) {
        handleReconnectFailure(deviceIp, 'no active session');
        return;
    }

    try {
        session.player.getStatus((err, status) => {
            if (!err && status) {
                console.log(`[Health] Reconnection successful for ${deviceIp}`);
                updateHeartbeat(deviceIp, 'control');
            } else {
                handleReconnectFailure(deviceIp, err?.message || 'No status');
            }
        });
    } catch (error) {
        // getStatus throws synchronously ("Cannot read properties of null
        // (reading 'send')") once castv2 has torn the socket down. Swallowing
        // it here meant the surest sign of a dead session was the one case
        // that never counted as a failed attempt.
        handleReconnectFailure(deviceIp, error.message);
    }
}

function startHealthMonitoring() {
    setInterval(checkConnectionHealth, HEARTBEAT_INTERVAL);
    console.log('[Health] Connection monitoring started');
}

module.exports = {
    initializeConnectionHealth,
    updateHeartbeat,
    startHealthMonitoring
};
