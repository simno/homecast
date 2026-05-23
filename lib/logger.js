// Lightweight structured logger.
// In production (NODE_ENV=production), outputs JSON to stdout/stderr.
// In development, outputs human-readable prefixed lines.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const isProd = process.env.NODE_ENV === 'production';

function log(level, ctx, message, data) {
    const lvl = LEVELS[level] ?? 1;
    if (isProd) {
        const entry = { ts: new Date().toISOString(), level: LABELS[lvl], ctx, msg: message };
        if (data !== undefined) entry.data = data;
        (lvl >= 3 ? process.stderr : process.stdout).write(JSON.stringify(entry) + '\n');
    } else {
        const extra = data !== undefined ? ' ' + JSON.stringify(data) : '';
        const fn = lvl >= 3 ? console.error : lvl >= 2 ? console.warn : console.log;
        fn(`[${LABELS[lvl]}] [${ctx}] ${message}${extra}`);
    }
}

const logger = {
    debug: (ctx, msg, data) => log('debug', ctx, msg, data),
    info: (ctx, msg, data) => log('info', ctx, msg, data),
    warn: (ctx, msg, data) => log('warn', ctx, msg, data),
    error: (ctx, msg, data) => log('error', ctx, msg, data)
};

module.exports = logger;
