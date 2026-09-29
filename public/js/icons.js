// Line icons shared across the UI, in the style of the page's inline SVGs
// (24px grid, 2px round stroke, currentColor).

const PATHS = {
    chromecast: '<path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><line x1="2" y1="20" x2="2.01" y2="20"/>',
    airplay: '<path d="M5 17H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-1"/><polygon points="12 15 17 21 7 21 12 15"/>',
    webos: '<rect x="2" y="7" width="20" height="15" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
};

// How each way of casting is named wherever a device is shown.
export const PROTOCOLS = { chromecast: 'Chromecast', airplay: 'AirPlay', webos: 'LG webOS' };

// An icon's markup, decorative unless given a `label`.
export function icon(name, className, label) {
    const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
    return `<svg class="${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${PATHS[name]}</svg>`;
}

// The icon for a way of casting, named for screen readers.
export function protocolIcon(type, className) {
    const known = PROTOCOLS[type] ? type : 'chromecast';
    return icon(known, className, PROTOCOLS[known]);
}
