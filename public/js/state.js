// UI state shared by the modules, and the bit of it that survives a reload.

export const MAX_HISTORY = 60;      // graph points: one per second
export const STALE_TIMEOUT = 15000; // 15s without stats = stale

// Text alternative for the pill health dot, which otherwise communicates
// stream health via color alone.
export const HEALTH_LABELS = {
    healthy: 'Connected',
    stale: 'No data received',
    degraded: 'Connection unstable',
    unhealthy: 'Connection lost',
    reconnecting: 'Reconnecting...',
    failed: 'Connection failed'
};

export const state = {
    mode: 'setup',              // 'setup' | 'dashboard'
    devices: [],                // from WebSocket
    streams: new Map(),         // deviceIp -> stream entry (see createStreamEntry)
    activeStreamIp: null,       // currently viewed stream
    compose: {
        analyzedStreams: [],
        title: null,            // the analysed page's title
        status: null
    },
    pairedDevices: new Set()    // IPs of known-paired devices from server
};

// ===== PERSISTENCE =====
const STATE_KEY = 'homecast_state';

export function loadState() {
    try {
        const saved = localStorage.getItem(STATE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            console.log('[State] Loaded persisted state:', parsed);
            return parsed;
        }
    } catch (e) {
        console.error('[State] Failed to load state:', e);
    }
    return null;
}

export function saveState() {
    try {
        const activeStreams = [];
        state.streams.forEach((stream, ip) => {
            activeStreams.push({ ip, deviceName: stream.deviceName, deviceType: stream.deviceType });
        });
        const saved = {
            activeStreams,
            activeStreamIp: state.activeStreamIp,
            timestamp: Date.now()
        };
        localStorage.setItem(STATE_KEY, JSON.stringify(saved));
        console.log('[State] Saved state:', saved);
    } catch (e) {
        console.error('[State] Failed to save state:', e);
    }
}

export function clearState() {
    try {
        localStorage.removeItem(STATE_KEY);
        console.log('[State] Cleared persisted state');
    } catch (e) {
        console.error('[State] Failed to clear state:', e);
    }
}
