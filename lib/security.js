const dns = require('dns');

// Security: Enable strict SSRF protection (can be disabled for trusted LANs)
const ENABLE_SSRF_PROTECTION = process.env.DISABLE_SSRF_PROTECTION !== 'true';

// Security: SSRF Protection - Block private IP ranges
function isPrivateIP(ip) {
    const privateRanges = [
        /^127\./,                    // Loopback
        /^10\./,                     // Private Class A
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
        /^192\.168\./,               // Private Class C
        /^169\.254\./,               // Link-local (AWS metadata)
        /^::1$/,                     // IPv6 loopback
        /^fe80:/,                    // IPv6 link-local
        /^fc00:/,                    // IPv6 private
        /^fd00:/                     // IPv6 private
    ];

    return privateRanges.some(range => range.test(ip));
}

// Security: Validate URL for SSRF protection
async function validateProxyUrl(urlString) {
    if (!ENABLE_SSRF_PROTECTION) {
        console.log('[Security] SSRF protection disabled via environment variable');
        return { valid: true };
    }

    try {
        const url = new URL(urlString);

        // Block non-HTTP protocols
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, reason: `Protocol ${url.protocol} not allowed` };
        }

        // Resolve hostname to IP
        const addresses = await dns.promises.resolve(url.hostname).catch(() => [url.hostname]);

        // Check if any resolved IP is private
        for (const addr of addresses) {
            if (isPrivateIP(addr)) {
                return {
                    valid: false,
                    reason: `Access to private IP ranges is blocked (${addr})`
                };
            }
        }

        // Block localhost variations
        const localhostPatterns = ['localhost', '0.0.0.0', '127.0.0.1', '::1'];
        if (localhostPatterns.some(pattern => url.hostname.toLowerCase().includes(pattern))) {
            return { valid: false, reason: 'Access to localhost is blocked' };
        }

        return { valid: true };
    } catch (err) {
        return { valid: false, reason: `Invalid URL: ${err.message}` };
    }
}

module.exports = { isPrivateIP, validateProxyUrl };
