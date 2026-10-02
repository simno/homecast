// SponsorBlock categories under Advanced, for a YouTube video: which marked
// segments to skip (lib/sponsorblock.js). Ticked as the server skips them.
import { sponsorBlockOptions, sponsorBlockCategories } from './dom.js';

// `categories`: the analysis' [{ id, name, skip }], or null for a video that
// isn't on YouTube.
export function populateSponsorBlockOptions(categories) {
    sponsorBlockCategories.innerHTML = '';
    sponsorBlockOptions.classList.toggle('hidden', !categories?.length);
    for (const { id, name, skip } of categories || []) {
        const label = document.createElement('label');
        label.className = 'checkbox-label';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = id;
        box.checked = skip;
        const text = document.createElement('span');
        text.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        label.append(box, text);
        sponsorBlockCategories.appendChild(label);
    }
}

// The categories to skip as /api/cast takes them, or undefined (not YouTube:
// the server's own setting).
export function selectedSponsorBlock() {
    if (sponsorBlockOptions.classList.contains('hidden')) return undefined;
    return [...sponsorBlockCategories.querySelectorAll('input:checked')].map(box => box.value);
}
