const { connectionHealth, activeSessions } = require('./state');
const { broadcast } = require('./websocket');
const {
    HEARTBEAT_INTERVAL,
    MAX_MISSED_HEARTBEATS,
    RECONNECT_DELAY,
    MAX_RECONNECT_ATTEMPTS,
} = require('./utils');

function initializeConnectionHealth(deviceIp) {
    connectionHealth.set(deviceIp, {
        lastHeartbeat: Date.now(),
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

function updateHeartbeat(deviceIp) {
    const health = connectionHealth.get(deviceIp);
    if (health) {
        health.lastHeartbeat = Date.now();
        health.lastActivity = Date.now();
        health.missedHeartbeats = 0;
        if (health.connectionState !== 'healthy') {
            health.connectionState = 'healthy';
            health.reconnectAttempts = 0;
            console.log(`[Health] Connection restored for ${deviceIp}`);
            broadcast({
                type: 'connectionHealth',
                deviceIp,
                state: 'healthy',
                message: 'Connection restored'
            });
        }
    }
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

async function attemptReconnect(deviceIp) {
    const health = connectionHealth.get(deviceIp);
    if (!health || health.connectionState === 'healthy') return;

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

    try {
        const session = activeSessions.get(deviceIp);
        if (session && session.player) {
            session.player.getStatus((err, status) => {
                if (!err && status) {
                    console.log(`[Health] Reconnection successful for ${deviceIp}`);
                    updateHeartbeat(deviceIp);
                } else {
                    console.warn(`[Health] Reconnection failed for ${deviceIp}: ${err?.message || 'No status'}`);
                    if (health.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        console.error(`[Health] Max reconnection attempts reached for ${deviceIp}, giving up`);
                        broadcast({
                            type: 'connectionHealth',
                            deviceIp,
                            state: 'failed',
                            message: 'Connection lost. Please restart casting.'
                        });
                    }
                }
            });
        }
    } catch (error) {
        console.error(`[Health] Reconnection error for ${deviceIp}:`, error.message);
    }
}

function startHealthMonitoring() {
    setInterval(checkConnectionHealth, HEARTBEAT_INTERVAL);
    console.log('[Health] Connection monitoring started');
}

module.exports = {
    initializeConnectionHealth,
    updateHeartbeat,
    startHealthMonitoring,
};
