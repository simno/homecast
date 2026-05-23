// Graph drawing functions for transfer rate and stream delay.
// Pure rendering — callers pass canvas elements and data arrays.

const MAX_HISTORY = 60;

const graphColors = {};

function refreshGraphColors() {
    const s = getComputedStyle(document.documentElement);
    graphColors.rate = s.getPropertyValue('--graph-rate').trim();
    graphColors.rateFill = s.getPropertyValue('--graph-rate-fill').trim();
    graphColors.delay = s.getPropertyValue('--graph-delay').trim();
    graphColors.delayFill = s.getPropertyValue('--graph-delay-fill').trim();
    graphColors.grid = s.getPropertyValue('--graph-grid').trim();
    graphColors.success = s.getPropertyValue('--success').trim();
    graphColors.warning = s.getPropertyValue('--warning').trim();
    graphColors.danger = s.getPropertyValue('--danger').trim();
}

function drawRateGraph(rateHistory) {
    const canvas = document.getElementById('rate-graph');
    if (!canvas) return;

    const rate = rateHistory.length > 0 ? rateHistory[rateHistory.length - 1] : 0;
    document.getElementById('graph-current-rate').textContent = `${rate} KB/s`;

    canvas.width = canvas.clientWidth;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (rateHistory.length < 2) return;

    const validRates = rateHistory.filter(r => !isNaN(r) && r !== null && r !== undefined);
    if (validRates.length === 0) return;

    const maxRate = Math.max(...validRates, 100);
    const minRate = 0;

    const yLabelsDiv = document.getElementById('graph-y-labels');
    if (yLabelsDiv) {
        const fmt = (r) => r >= 1000 ? `${(r / 1000).toFixed(1)} MB/s` : `${Math.round(r)} KB/s`;
        yLabelsDiv.innerHTML = `<span>${fmt(maxRate)}</span><span>${fmt(maxRate * 0.5)}</span><span>${fmt(minRate)}</span>`;
    }

    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;
    const dataPoints = rateHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Grid
    ctx.strokeStyle = graphColors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Line
    ctx.strokeStyle = graphColors.rate;
    ctx.lineWidth = 2;
    ctx.beginPath();
    rateHistory.forEach((r, i) => {
        const x = startX + (i * xStep);
        const y = height - padding - (r / maxRate * graphHeight);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = graphColors.rateFill;
    ctx.fill();
}

function drawDelayGraph(delayHistory) {
    const section = document.getElementById('delay-graph-section');
    if (!section) return;

    if (!delayHistory || delayHistory.length === 0) {
        section.classList.add('hidden');
        return;
    }
    section.classList.remove('hidden');

    const delay = delayHistory[delayHistory.length - 1] || 0;
    document.getElementById('graph-current-delay').textContent = `${delay.toFixed(1)}s`;

    const canvas = document.getElementById('delay-graph');
    if (!canvas) return;

    canvas.width = canvas.clientWidth;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (delayHistory.length < 2) return;

    const validDelays = delayHistory.filter(d => !isNaN(d) && d !== null && d !== undefined);
    if (validDelays.length === 0) return;

    const maxDelay = Math.max(...validDelays, 1);

    const yLabelsDiv = document.getElementById('delay-y-labels');
    if (yLabelsDiv) {
        yLabelsDiv.innerHTML = `<span>${maxDelay.toFixed(1)}s</span><span>${(maxDelay * 0.5).toFixed(1)}s</span><span>0.0s</span>`;
    }

    const padding = 10;
    const graphHeight = height - padding * 2;
    const graphWidth = width - padding * 2;
    const dataPoints = delayHistory.length;
    const xStep = graphWidth / (MAX_HISTORY - 1);
    const startX = width - padding - ((dataPoints - 1) * xStep);

    // Grid
    ctx.strokeStyle = graphColors.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + (graphHeight * i / 4);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    // Line
    ctx.strokeStyle = graphColors.delay;
    ctx.lineWidth = 2;
    ctx.beginPath();
    delayHistory.forEach((d, i) => {
        const x = startX + (i * xStep);
        const y = height - padding - (d / maxDelay * graphHeight);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill
    const lastX = startX + ((dataPoints - 1) * xStep);
    ctx.lineTo(lastX, height - padding);
    ctx.lineTo(startX, height - padding);
    ctx.closePath();
    ctx.fillStyle = graphColors.delayFill;
    ctx.fill();
}

export { drawRateGraph, drawDelayGraph, refreshGraphColors, graphColors };
