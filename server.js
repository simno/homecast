const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const { createWebSocketServer } = require('./lib/websocket');
const { initDiscovery } = require('./lib/discovery');
const { startHealthMonitoring } = require('./lib/health');
const { startStallDetection } = require('./lib/recovery');
const { getLocalIp, PORT, STALE_DEVICE_TIMEOUT_MS } = require('./lib/utils');

// Route modules
const devicesRouter = require('./routes/devices');
const extractRouter = require('./routes/extract');
const castRouter = require('./routes/cast');
const statsRouter = require('./routes/stats');
const proxyRouter = require('./routes/proxy');

const app = express();
const server = http.createServer(app);

// WebSocket server with origin validation
const wss = createWebSocketServer(server);
wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin) {
        try {
            const originHost = new URL(origin).host;
            if (originHost !== host) {
                console.warn(`[Security] Rejected WebSocket connection: origin ${origin} != host ${host}`);
                ws.close(1008, 'Origin mismatch');
                return;
            }
        } catch {
            console.warn(`[Security] Rejected WebSocket connection: invalid origin ${origin}`);
            ws.close(1008, 'Invalid origin');
            return;
        }
    }
});

// Security: Helmet.js headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            imgSrc: ["'self'", 'data:'],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// Skip CSP for /proxy route (Chromecast needs Access-Control-Allow-Origin: *)
app.use('/proxy', (_req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
});

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// CSRF protection (optional, can be disabled via DISABLE_CSRF=true)
const CSRF_ENABLED = process.env.DISABLE_CSRF !== 'true';

if (CSRF_ENABLED) {
    const csrfSecret = process.env.CSRF_SECRET || require('crypto').randomBytes(32).toString('hex');

    const { generateCsrfToken, doubleCsrfProtection } = doubleCsrf({
        getSecret: () => csrfSecret,
        getSessionIdentifier: () => '',
        cookieName: 'csrf-token',
        cookieOptions: {
            sameSite: 'strict',
            path: '/',
            secure: false, // Allow HTTP for local network usage
            httpOnly: true
        },
        getCsrfTokenFromRequest: (req) => req.headers['x-csrf-token']
    });

    // Endpoint to get CSRF token
    app.get('/api/csrf-token', (req, res) => {
        const token = generateCsrfToken(req, res);
        res.json({ token });
    });

    // Apply CSRF protection to POST endpoints only
    app.use('/api/cast', doubleCsrfProtection);
    app.use('/api/stop', doubleCsrfProtection);
    app.use('/api/extract', doubleCsrfProtection);

    console.log('[Security] CSRF protection enabled');
} else {
    console.log('[Security] CSRF protection disabled via DISABLE_CSRF=true');
}

// Routes
app.use(devicesRouter);
app.use(extractRouter);
app.use(castRouter);
app.use(statsRouter);
app.use(proxyRouter);

// Global error handler
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// Initialize subsystems
initDiscovery();
startHealthMonitoring();
startStallDetection();

// Only start server if not being required as a module
if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`HomeCast running on port ${PORT}`);
        console.log(`[Server] Stale device timeout: ${STALE_DEVICE_TIMEOUT_MS / 1000 / 60 / 60} hours`);
        console.log(`[Server] Access the web interface at http://localhost:${PORT}`);
        console.log(`[Server] Local IP: ${getLocalIp()}`);
        console.log('[Server] Waiting for Chromecast devices...');
    });
}

// Re-export for backward compatibility with tests
const { resolveM3u8Url } = require('./lib/proxy');
module.exports = { resolveM3u8Url };
