const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Build a magic packet: 6 bytes of 0xFF + target MAC repeated 16 times
function buildMagicPacket(mac) {
    const clean = mac.replace(/[:-]/g, '').toLowerCase();
    if (clean.length !== 12 || !/^[0-9a-f]{12}$/.test(clean)) {
        throw new Error(`Invalid MAC address: ${mac}`);
    }
    const macBytes = Buffer.from(clean, 'hex');
    const packet = Buffer.alloc(6 + 16 * 6);
    packet.fill(0xFF, 0, 6);
    for (let i = 0; i < 16; i++) {
        macBytes.copy(packet, 6 + i * 6);
    }
    return packet;
}

// The directed broadcast address of every IPv4 network this machine is on
// (192.168.2.255 for 192.168.2.10/24). Routers and some TVs ignore the
// limited broadcast 255.255.255.255; an LG TV in standby was only woken by its
// own subnet's broadcast.
function subnetBroadcasts() {
    const addresses = new Set();
    for (const iface of Object.values(os.networkInterfaces()).flat()) {
        if (!iface || iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
        const ip = iface.address.split('.').map(Number);
        const mask = iface.netmask.split('.').map(Number);
        addresses.add(ip.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.'));
    }
    return [...addresses];
}

// Send a magic packet to the broadcast addresses
function sendWOL(mac) {
    return new Promise((resolve, reject) => {
        const packet = buildMagicPacket(mac);
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('error', (err) => {
            socket.close();
            reject(err);
        });

        socket.bind(() => {
            socket.setBroadcast(true);
            // Standard WOL ports 9 (primary) and 7 (echo, fallback) on the
            // limited broadcast, and port 9 on each local subnet's own.
            const targets = [
                ['255.255.255.255', 9],
                ['255.255.255.255', 7],
                ...subnetBroadcasts().map(address => [address, 9])
            ];
            // Close only once every packet is out: closing earlier drops them.
            let pending = targets.length;
            for (const [address, port] of targets) {
                socket.send(packet, 0, packet.length, port, address, (err) => {
                    if (err) console.warn(`[WOL] ${address}:${port} send error:`, err.message);
                    if (--pending === 0) {
                        socket.close();
                        resolve();
                    }
                });
            }
        });
    });
}

// Try to extract a MAC from a Chromecast device ID.
// Some devices use the MAC as the ID (hex, 12 chars), others embed it.
function extractMAC(deviceId) {
    if (!deviceId) return null;

    // Strip common prefixes and normalize to lowercase
    const id = deviceId.replace(/^uuid:/i, '').toLowerCase();

    // Direct MAC: 12 hex chars
    if (/^[0-9a-f]{12}$/i.test(id)) {
        return id.match(/.{2}/g).join(':');
    }

    // Some Chromecast IDs are like "aabbccddeeff12" (MAC + 1 extra byte)
    if (/^[0-9a-f]{14}$/i.test(id)) {
        return id.slice(0, 12).match(/.{2}/g).join(':');
    }

    return null;
}

// The MAC for `ip` in Linux's ARP table, read from /proc (the Docker image
// has no `arp` command). Null elsewhere, or when the entry is incomplete.
function macFromProcArp(ip, table = '/proc/net/arp') {
    let text;
    try {
        text = fs.readFileSync(table, 'utf8');
    } catch {
        return null;
    }
    for (const line of text.split('\n').slice(1)) {
        const [address, , , mac] = line.trim().split(/\s+/);
        if (address === ip && mac && mac !== '00:00:00:00:00:00') return mac.toLowerCase();
    }
    return null;
}

// Try to resolve a MAC for an IP via the ARP table.
// This only works if the device was recently reachable.
function resolveMACFromARP(ip) {
    const fromProc = macFromProcArp(ip);
    if (fromProc) return fromProc;
    try {
        // macOS / Linux: try `arp -n`
        const output = execSync(`arp -n ${ip} 2>/dev/null || arp ${ip} 2>/dev/null`, {
            timeout: 2000,
            encoding: 'utf8'
        });
        // Parse lines like: 192.168.1.50   ether   aa:bb:cc:dd:ee:ff   ...
        const match = output.match(/([0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2}:[0-9a-f]{1,2})/i);
        if (match) return match[1];
    } catch {
        // arp command not available or failed
    }
    return null;
}

// Wake a device, then wait for it to come online
async function wakeDevice(ip, deviceId) {
    // Try to get the MAC from the device ID first, then ARP
    let mac = extractMAC(deviceId);
    if (!mac) {
        mac = resolveMACFromARP(ip);
    }

    if (!mac) {
        console.log(`[WOL] Could not determine MAC for ${ip} (deviceId: ${deviceId})`);
        return false;
    }

    console.log(`[WOL] Sending magic packet to ${mac} for device ${ip}`);
    try {
        await sendWOL(mac);
        console.log('[WOL] Magic packet sent, waiting for device to wake...');
        return true;
    } catch (err) {
        console.error(`[WOL] Failed to send magic packet: ${err.message}`);
        return false;
    }
}

module.exports = { wakeDevice, sendWOL, extractMAC, resolveMACFromARP, macFromProcArp, subnetBroadcasts };
