const { test } = require('node:test');
const assert = require('assert');
require('../lib/mdns');
const { DNSPacket, DNSRecord } = require('dns-js');
const decoder = require('mdns-js/lib/decoder');
const { ServiceType } = require('mdns-js/lib/service_type');

// A service-enumeration answer, as devices send them, listing `types`.
function enumerationResponse(types) {
    const packet = new DNSPacket();
    packet.header.qr = 1;
    for (const type of types) {
        const rec = new DNSRecord('_services._dns-sd._udp.local', DNSRecord.Type.PTR, 1, 120);
        rec.data = type;
        packet.answer.push(rec);
    }
    return DNSPacket.toBuffer(packet);
}

test('a service name over mdns-js\'s 20-character limit no longer throws, and the rest of the packet is read', () => {
    // Spotify clients announce this; stock mdns-js threw from its socket
    // handler and took the server down in a restart loop.
    const data = decoder.decodeMessage(enumerationResponse([
        '_spotify-social-listening._tcp.local',
        '_googlecast._tcp.local'
    ]));
    assert.deepStrictEqual(data.type.map(t => t.toString()), ['_spotify-social-listening._tcp', '_googlecast._tcp']);
});

test('an unparseable service type becomes an empty type instead of an exception', () => {
    const type = new ServiceType('not a service');
    assert.strictEqual(type.name, '');
    assert.strictEqual(type.protocol, '');
});

test('valid service types parse as before', () => {
    const type = new ServiceType('_googlecast._tcp');
    assert.strictEqual(type.name, 'googlecast');
    assert.strictEqual(type.protocol, 'tcp');
});
