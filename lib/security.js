const dns = require('dns');
const net = require('net');

// Security: Enable strict SSRF protection (can be disabled for trusted LANs)
const ENABLE_SSRF_PROTECTION = process.env.DISABLE_SSRF_PROTECTION !== 'true';

// Security: SSRF Protection - every address range a request must never reach.
// A CIDR list rather than string prefixes: prefixes like /^fd00:/ only ever
// matched one /16 of the fc00::/7 unique-local block.
const blockedRanges = new net.BlockList();
for (const [prefix, bits] of [
    ['0.0.0.0', 8],         // "This" network
    ['10.0.0.0', 8],        // Private Class A
    ['100.64.0.0', 10],     // CGNAT
    ['127.0.0.0', 8],       // Loopback
    ['169.254.0.0', 16],    // Link-local (cloud metadata)
    ['172.16.0.0', 12],     // Private Class B
    ['192.0.0.0', 24],      // IETF protocol assignments
    ['192.168.0.0', 16],    // Private Class C
    ['198.18.0.0', 15],     // Benchmarking
    ['224.0.0.0', 4],       // Multicast
    ['240.0.0.0', 4]        // Reserved + broadcast
]) {
    blockedRanges.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
    ['::', 128],            // Unspecified
    ['::1', 128],           // Loopback
    ['fc00::', 7],          // Unique local
    ['fe80::', 10],         // Link-local
    ['ff00::', 8]           // Multicast
]) {
    blockedRanges.addSubnet(prefix, bits, 'ipv6');
}

// An IPv4-mapped IPv6 address (::ffff:10.0.0.1 or its hex form ::ffff:a00:1)
// reaches the IPv4 host, so it has to be judged as that IPv4 address.
function unmapIPv4(ip) {
    const m = ip.match(/^::ffff:(.+)$/i);
    if (!m) return ip;
    if (net.isIPv4(m[1])) return m[1];
    const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (!hex) return ip;
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

// True when `ip` is an address literal inside a blocked range. Hostnames are
// not addresses and return false — resolve them first.
function isPrivateIP(ip) {
    if (typeof ip !== 'string') return false;
    const bare = unmapIPv4(ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
    const family = net.isIP(bare);
    if (family === 0) return false;
    return blockedRanges.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

function isBlockedHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || isPrivateIP(host);
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

// Security: Node never calls `lookup` for an IP-literal host, so safeLookup
// alone lets a public server 302 us to http://169.254.169.254/. follow-redirects
// runs this before each hop; throwing aborts the request.
function guardRedirect(options) {
    if (!ENABLE_SSRF_PROTECTION) return;
    if (options.protocol && !['http:', 'https:'].includes(options.protocol)) {
        throw new Error(`Blocked redirect to ${options.protocol} URL`);
    }
    if (options.hostname && isBlockedHostname(options.hostname)) {
        throw new Error(`Blocked redirect to private host (${options.hostname})`);
    }
}

// Spread into every axios config that fetches a user-influenced URL.
const safeRequestOptions = { lookup: safeLookup, beforeRedirect: guardRedirect };

// Security: Validate URL for SSRF protection
async function validateProxyUrl(urlString) {
    if (!ENABLE_SSRF_PROTECTION) {
        return { valid: true };
    }

    try {
        const url = new URL(urlString);

        // Block non-HTTP protocols
        if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, reason: `Protocol ${url.protocol} not allowed` };
        }

        if (isBlockedHostname(url.hostname)) {
            return { valid: false, reason: `Access to private or local hosts is blocked (${url.hostname})` };
        }

        // Resolve the way the connection will (A + AAAA, /etc/hosts). A name that
        // does not resolve is left for the request itself to fail on.
        const addresses = await dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
            .catch(() => []);
        for (const { address } of addresses) {
            if (isPrivateIP(address)) {
                return {
                    valid: false,
                    reason: `Access to private IP ranges is blocked (${address})`
                };
            }
        }

        return { valid: true };
    } catch (err) {
        return { valid: false, reason: `Invalid URL: ${err.message}` };
    }
}

module.exports = { isPrivateIP, validateProxyUrl, safeLookup, guardRedirect, safeRequestOptions };
