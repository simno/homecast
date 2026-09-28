const EventEmitter = require('events');
const makeMulticastDns = require('multicast-dns');

// mDNS service browsing for discovery (Chromecasts, AirPlay devices), on
// multicast-dns.
//
// This replaced mdns-js, which is unmaintained and threw from its socket
// handler on service names it disliked — a Spotify client announcing
// _spotify-social-listening._tcp was enough to restart the server in a loop.
// multicast-dns decodes any well-formed packet; which services matter is
// decided here.
//
// A browser emits 'update' for every response naming an instance of its
// service type — every time, not just the first, since discovery uses each
// sighting to keep a device from going stale. The event's data keeps the shape
// discovery was written against:
//   { type: [{ name, protocol }], fullname, host, port, addresses, txt: ['k=v'] }

let shared = null;
const browsers = new Set();

function sharedResponder() {
    if (shared) return shared;
    shared = makeMulticastDns();
    shared.on('response', (packet, rinfo) => {
        for (const browser of browsers) {
            for (const service of servicesInResponse(packet, rinfo, browser.serviceType)) {
                browser.emit('update', service);
            }
        }
    });
    shared.on('error', (err) => {
        for (const browser of browsers) browser.emit('error', err);
    });
    shared.on('warning', (err) => console.warn('[mDNS]', err.message || err));
    return shared;
}

const txtStrings = (data) => (Array.isArray(data) ? data : [data])
    .map(entry => (Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry)))
    .filter(Boolean);

// Every instance of `serviceType` ('_googlecast._tcp') a response describes,
// in the shape above. Pure, for tests.
function servicesInResponse(packet, rinfo, serviceType) {
    const records = [...(packet.answers || []), ...(packet.additionals || [])];
    const domain = `${serviceType}.local`.toLowerCase();
    const [name, protocol] = serviceType.replace(/^_/, '').split('._');

    // Instances: named by PTR records, or by SRV/TXT records of the type
    // (announcements and answers don't always repeat the PTR).
    const instances = new Set();
    for (const r of records) {
        const owner = String(r.name || '');
        if (r.type === 'PTR' && owner.toLowerCase() === domain) instances.add(String(r.data));
        if ((r.type === 'SRV' || r.type === 'TXT') && owner.toLowerCase().endsWith(`.${domain}`)) instances.add(owner);
    }

    return [...instances].map((fullname) => {
        const lower = fullname.toLowerCase();
        const srv = records.find(r => r.type === 'SRV' && String(r.name).toLowerCase() === lower);
        const txt = records.find(r => r.type === 'TXT' && String(r.name).toLowerCase() === lower);
        const host = srv?.data?.target || null;
        const addresses = records
            .filter(r => r.type === 'A' && host && String(r.name).toLowerCase() === host.toLowerCase())
            .map(r => r.data);
        // Without an A record, the address the response came from.
        if (addresses.length === 0 && rinfo?.address) addresses.push(rinfo.address);
        return {
            type: [{ name, protocol }],
            fullname,
            host,
            port: srv?.data?.port || null,
            addresses: [...new Set(addresses)],
            txt: txt ? txtStrings(txt.data) : []
        };
    });
}

class Browser extends EventEmitter {
    constructor(serviceType) {
        super();
        this.serviceType = serviceType;
        browsers.add(this);
        const responder = sharedResponder();
        // Listeners attach after this returns; tell them once it's up.
        setImmediate(() => this.emit('ready'));
        this.responder = responder;
    }

    // Ask the network for this service type now; answers arrive as 'update'.
    discover() {
        this.responder.query({ questions: [{ name: `${this.serviceType}.local`, type: 'PTR' }] });
    }

    stop() {
        browsers.delete(this);
        if (browsers.size === 0 && shared) {
            shared.destroy();
            shared = null;
        }
    }
}

// Same entry points as mdns-js: createBrowser(tcp('googlecast')).
const tcp = (name) => `_${name}._tcp`;
const createBrowser = (serviceType) => new Browser(serviceType);

module.exports = { createBrowser, tcp, servicesInResponse };
