// The dashboard for the stream being viewed: stats, health, graphs.
import { drawRateGraph, drawDelayGraph, graphColors } from './graphs.js';
import { dashboardDeviceName, healthDot, healthText, stat } from './dom.js';
import { state, HEALTH_LABELS, MAX_HISTORY, STALE_TIMEOUT } from './state.js';
import { renderDashboardSubtitles } from './subtitles.js';

export function renderDashboard() {
    const stream = state.streams.get(state.activeStreamIp);
    if (!stream) return;

    const typeLabel = stream.deviceType === 'airplay' ? ' (Apple TV)' : '';
    dashboardDeviceName.textContent = stream.deviceName + typeLabel;

    updateConnectionHealthUI(stream.health);

    if (stream.stats && Object.keys(stream.stats).length > 0) {
        renderStats(stream.stats);
    } else {
        resetDashboardStats();
    }

    if (stream.bufferHealth) {
        renderBufferHealth(stream.bufferHealth);
    }

    renderDashboardSubtitles(stream);

    // Redraw graphs from stored history
    requestAnimationFrame(() => {
        drawRateGraph(stream.rateHistory);
        drawDelayGraph(stream.delayHistory);
    });
}

export function renderStats(stats) {
    let resolutionDisplay = stats.resolution || 'Unknown';
    if (stats.bitrate && (!stats.resolution || stats.resolution === 'Live Stream')) {
        if (stats.bitrate >= 8000) resolutionDisplay = 'Live Stream (4K est.)';
        else if (stats.bitrate >= 5000) resolutionDisplay = 'Live Stream (1080p est.)';
        else if (stats.bitrate >= 2500) resolutionDisplay = 'Live Stream (720p est.)';
        else if (stats.bitrate >= 1000) resolutionDisplay = 'Live Stream (480p est.)';
        else resolutionDisplay = 'Live Stream';
    }

    let bitrateDisplay = '- Kbps';
    if (stats.bitrate) {
        bitrateDisplay = stats.bitrate >= 1000
            ? `${(stats.bitrate / 1000).toFixed(1)} Mbps`
            : `${stats.bitrate} Kbps`;
    }

    let transferredDisplay = '0 MB';
    if (stats.totalMB) {
        const mb = parseFloat(stats.totalMB);
        transferredDisplay = mb >= 1000
            ? `${(mb / 1024).toFixed(2)} GB`
            : `${mb.toFixed(2)} MB`;
    }

    let durationDisplay = '0s';
    if (stats.duration) {
        const totalSeconds = parseInt(stats.duration);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        if (hours > 0) durationDisplay = `${hours}h ${minutes}m ${seconds}s`;
        else if (minutes > 0) durationDisplay = `${minutes}m ${seconds}s`;
        else durationDisplay = `${seconds}s`;
    }

    stat.resolution.textContent = resolutionDisplay;
    stat.bitrate.textContent = bitrateDisplay;
    stat.transferred.textContent = transferredDisplay;
    stat.segments.textContent = stats.segmentCount || 0;
    stat.duration.textContent = durationDisplay;
    stat.cache.textContent = stats.cacheHits || 0;
    stat.frameRate.textContent = stats.frameRate
        ? `${Math.round(stats.frameRate)} FPS`
        : '-';
}

function resetDashboardStats() {
    stat.resolution.textContent = 'Unknown';
    stat.frameRate.textContent = '-';
    stat.bitrate.textContent = '- Kbps';
    stat.transferred.textContent = '0 MB';
    stat.segments.textContent = '0';
    stat.duration.textContent = '0s';
    stat.cache.textContent = '0';
    stat.bufferHealth.textContent = '-';
    stat.bufferHealth.style.color = '';
}

export function renderBufferHealth(bufferHealth) {
    if (!bufferHealth) return;
    const { healthScore, bufferingEvents, totalBufferingTime } = bufferHealth;
    const el = stat.bufferHealth;

    let text = `${healthScore}%`;
    if (bufferingEvents > 0) {
        text += ` (${bufferingEvents} events, ${totalBufferingTime}s)`;
    }
    el.textContent = text;

    if (healthScore >= 95) el.style.color = graphColors.success;
    else if (healthScore >= 85) el.style.color = graphColors.warning;
    else el.style.color = graphColors.danger;
}

export function updateConnectionHealthUI(healthState) {
    healthDot.className = 'health-dot';
    if (healthState) healthDot.classList.add(healthState);

    // Map 'stale' to the 'degraded' CSS class for the yellow dot
    if (healthState === 'stale') healthDot.classList.add('degraded');

    healthText.textContent = HEALTH_LABELS[healthState] || 'Connected';
}

// Redraw the active stream's graphs, e.g. after a color scheme change.
export function redrawActiveGraphs() {
    const stream = state.streams.get(state.activeStreamIp);
    if (!stream) return;
    drawRateGraph(stream.rateHistory);
    drawDelayGraph(stream.delayHistory);
    if (stream.bufferHealth) renderBufferHealth(stream.bufferHealth);
}

// Sample current values once per second so the graphs' x-axis is real time
// (60 points = 60 seconds), and mark streams stale when their stats stop.
// Stats arrive on segment boundaries (every 2-10s), so without the sampler
// the labelled "60s ago" would be wildly off.
export function startDashboardTimers({ onStale }) {
    setInterval(() => {
        state.streams.forEach((stream, ip) => {
            stream.rateHistory.push(stream.currentRate || 0);
            if (stream.rateHistory.length > MAX_HISTORY) stream.rateHistory.shift();

            if (stream.hasDelay) {
                stream.delayHistory.push(stream.currentDelay || 0);
                if (stream.delayHistory.length > MAX_HISTORY) stream.delayHistory.shift();
            }

            if (ip === state.activeStreamIp) {
                drawRateGraph(stream.rateHistory);
                if (stream.delayHistory.length > 0) drawDelayGraph(stream.delayHistory);
            }
        });
    }, 1000);

    setInterval(() => {
        const now = Date.now();
        state.streams.forEach((stream, ip) => {
            if (stream.health !== 'stale' && stream.lastStatsAt && (now - stream.lastStatsAt > STALE_TIMEOUT)) {
                stream.health = 'stale';
                console.log(`[Health] Stream ${ip} marked stale (no stats for ${STALE_TIMEOUT / 1000}s)`);
                onStale(ip);
            }
        });
    }, 5000);
}
