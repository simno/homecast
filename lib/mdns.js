const mdns = require('mdns-js');
const { ServiceType } = require('mdns-js/lib/service_type');

// mdns-js, as required by discovery, with service type parsing that can't
// take the process down.
//
// mdns-js rejects service names over 20 characters (and other oddities) by
// throwing — from inside its socket's message handler, where nothing can
// catch it. Real devices advertise longer names (Spotify clients announce
// _spotify-social-listening._tcp), so one such packet on the network was an
// uncaught exception, and the server restarted in a loop for as long as the
// device stayed on. A packet often lists several services, so dropping it
// whole could also hide a Chromecast; instead the odd record parses leniently
// and the rest of the packet is read as usual.

const strictFromString = ServiceType.prototype.fromString;

ServiceType.prototype.fromString = function fromString(text) {
    try {
        strictFromString.call(this, text);
    } catch {
        // `_name._proto[.local]`, whatever the name's length; anything
        // unrecognisable becomes an empty type that matches no browser.
        const m = /^_([^.,]+)\._(tcp|udp)\b/.exec(String(text));
        this.name = m ? m[1] : '';
        this.protocol = m ? m[2] : '';
        this.subtypes = [];
    }
};

module.exports = mdns;
