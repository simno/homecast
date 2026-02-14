// Shared state Maps used across the application

// Discovered Chromecast devices (IP -> device info)
const devices = {};

// Track when devices were last seen for staleness detection
const deviceLastSeen = new Map();

// Active cast sessions (IP -> { client, player })
const activeSessions = new Map();

// Playlist cache (URL -> { content, timestamp, isLive })
const playlistCache = new Map();

// Stream statistics (deviceIp -> { totalBytes, startTime, lastActivity, ... })
const streamStats = new Map();

// Playback tracking for delay calculation (deviceIp -> { playbackStartPosition, lastDelay })
const playbackTracking = new Map();

// Buffer health tracking (deviceIp -> { bufferingEvents, totalBufferingTime, ... })
const bufferHealthTracking = new Map();

// Stream stall detection and recovery (deviceIp -> { lastProxyRequest, ... })
const streamRecovery = new Map();

// Connection health monitoring (deviceIp -> { lastHeartbeat, missedHeartbeats, ... })
const connectionHealth = new Map();

// Map device IPs to their streaming client IPs (chromecastIp -> clientIp)
const deviceToClientMap = new Map();

module.exports = {
    devices,
    deviceLastSeen,
    activeSessions,
    playlistCache,
    streamStats,
    playbackTracking,
    bufferHealthTracking,
    streamRecovery,
    connectionHealth,
    deviceToClientMap,
};
