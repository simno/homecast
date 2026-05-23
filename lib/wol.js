const dgram = require('dgram');
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

// Send a magic packet to the broadcast address
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
            // Send to standard WOL ports: 9 (primary) and 7 (echo, fallback)
            socket.send(packet, 0, packet.length, 9, '255.255.255.255', (err) => {
                if (err) console.warn('[WOL] Port 9 send error:', err.message);
            });
            socket.send(packet, 0, packet.length, 7, '255.255.255.255', (err) => {
                if (err) console.warn('[WOL] Port 7 send error:', err.message);
            });
            // Also send to subnet-directed broadcast (more reliable across routers)
            socket.send(packet, 0, packet.length, 9, '192.168.255.255', (err) => {
                if (err) { /* ignore */ }
            });
            socket.close();
            resolve();
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

// Try to resolve a MAC for an IP via the ARP table.
// This only works if the device was recently reachable.
function resolveMACFromARP(ip) {
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

module.exports = { wakeDevice, sendWOL, extractMAC, resolveMACFromARP };
