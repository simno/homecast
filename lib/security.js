const dns = require('dns');

// Security: Enable strict SSRF protection (can be disabled for trusted LANs)
const ENABLE_SSRF_PROTECTION = process.env.DISABLE_SSRF_PROTECTION !== 'true';

// Security: SSRF Protection - Block private IP ranges
function isPrivateIP(ip) {
    const privateRanges = [
        /^0\./,                      // "This" network
        /^127\./,                    // Loopback
        /^10\./,                     // Private Class A
        /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // CGNAT (100.64.0.0/10)
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
        /^192\.168\./,               // Private Class C
        /^169\.254\./,               // Link-local (AWS metadata)
        /^::$/,                      // IPv6 unspecified
        /^::1$/,                     // IPv6 loopback
        /^fe80:/i,                   // IPv6 link-local
        /^fc00:/i,                   // IPv6 private
        /^fd00:/i,                   // IPv6 private
        /^::ffff:0*127\.\d+\.\d+\.\d+$/i, // IPv4-mapped IPv6 loopback
        /^::ffff:0*10\.\d+\.\d+\.\d+$/i,  // IPv4-mapped IPv6 private
        /^::ffff:0*192\.168\.\d+\.\d+$/i, // IPv4-mapped IPv6 private
        /^::ffff:0*172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/i, // IPv4-mapped IPv6 private
        /^::ffff:0*169\.254\.\d+\.\d+$/i  // IPv4-mapped IPv6 link-local
    ];

    return privateRanges.some(range => range.test(ip));
}

// Security: DNS-pinned lookup for axios's `lookup` config option. Re-checks
// the resolved address at actual connection time (not just at the earlier
// validateProxyUrl() check), so a DNS answer that changes between validation
// and connect (DNS rebinding) can't bypass the private-IP block.
function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    if (!ENABLE_SSRF_PROTECTION) {
        return dns.lookup(hostname, options, callback);
    }

    dns.lookup(hostname, options, (err, address, family) => {
        if (err) return callback(err);

        const addresses = Array.isArray(address) ? address : [{ address, family }];
        for (const a of addresses) {
            if (isPrivateIP(a.address)) {
                return callback(new Error(`Blocked connection to private IP (${a.address})`));
            }
        }

        callback(null, address, family);
    });
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

module.exports = { isPrivateIP, validateProxyUrl, safeLookup };
