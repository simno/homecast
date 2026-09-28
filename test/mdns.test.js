const { test } = require('node:test');
const assert = require('assert');
const dnsPacket = require('dns-packet');
const { servicesInResponse, tcp } = require('../lib/mdns');

// A response as a Cast TV sends it: the PTR naming the instance, and its SRV,
// TXT and A records.
function castResponse({ extraPtrs = [] } = {}) {
    const instance = 'OLED77G36LA-f270._googlecast._tcp.local';
    return {
        type: 'response',
        answers: [
            ...extraPtrs.map(data => ({ name: '_services._dns-sd._udp.local', type: 'PTR', data })),
            { name: '_googlecast._tcp.local', type: 'PTR', data: instance }
        ],
        additionals: [
            { name: instance, type: 'SRV', data: { target: 'f270.local', port: 8009 } },
            { name: instance, type: 'TXT', data: [Buffer.from('id=f270'), Buffer.from('fn=LG G3 TV'), Buffer.from('md=OLED77G36LA')] },
            { name: 'f270.local', type: 'A', data: '192.168.2.17' }
        ]
    };
}

test('a Cast device is read from its response, in the shape discovery expects', () => {
    const [service] = servicesInResponse(castResponse(), { address: '192.168.2.99' }, tcp('googlecast'));
    assert.deepStrictEqual(service, {
        type: [{ name: 'googlecast', protocol: 'tcp' }],
        fullname: 'OLED77G36LA-f270._googlecast._tcp.local',
        host: 'f270.local',
        port: 8009,
        addresses: ['192.168.2.17'],
        txt: ['id=f270', 'fn=LG G3 TV', 'md=OLED77G36LA']
    });
});

test('a service name longer than 20 characters is just another record (it crashed mdns-js)', () => {
    // Round-trip through the wire format, as multicast-dns decodes it.
    const wire = dnsPacket.encode(castResponse({ extraPtrs: ['_spotify-social-listening._tcp.local'] }));
    const services = servicesInResponse(dnsPacket.decode(wire), { address: '192.168.2.17' }, tcp('googlecast'));
    assert.deepStrictEqual(services.map(s => s.txt.find(t => t.startsWith('fn='))), ['fn=LG G3 TV']);
});

test('other service types are ignored', () => {
    assert.deepStrictEqual(servicesInResponse(castResponse(), {}, tcp('airplay')), []);
});

test('without an A record, the address the response came from is used', () => {
    const packet = castResponse();
    packet.additionals = packet.additionals.filter(r => r.type !== 'A');
    const [service] = servicesInResponse(packet, { address: '192.168.2.17' }, tcp('googlecast'));
    assert.deepStrictEqual(service.addresses, ['192.168.2.17']);
});
