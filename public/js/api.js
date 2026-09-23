// Talking to the server: the CSRF token every POST carries, and JSON helpers.

let csrfToken = null;

export async function fetchCsrfToken() {
    try {
        const res = await fetch('/api/csrf-token');
        if (res.ok) {
            csrfToken = (await res.json()).token;
            console.log('[CSRF] Token acquired');
        }
    } catch {
        console.log('[CSRF] Token endpoint not available (CSRF may be disabled)');
    }
}

function post(path, body, { signal, accept } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (accept) headers['Accept'] = accept;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    return fetch(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
}

// POST JSON and return the raw Response. A server restart invalidates the
// page's token (the secret is regenerated unless CSRF_SECRET is set), so a
// token rejection is retried once with a fresh one instead of failing an
// action the user can't fix.
export async function apiPost(path, body, options) {
    const res = await post(path, body, options);
    if (res.status !== 403) return res;
    const data = await res.clone().json().catch(() => ({}));
    if (data.code !== 'EBADCSRFTOKEN') return res;
    console.log('[CSRF] Token rejected, refreshing and retrying');
    await fetchCsrfToken();
    return post(path, body, options);
}

export async function checkSessionStatus(deviceIp) {
    try {
        const res = await fetch(`/api/session/${encodeURIComponent(deviceIp)}`);
        const data = await res.json();
        console.log(`[State] Session check for ${deviceIp}:`, data.active ? 'active' : 'inactive');
        return data;
    } catch (e) {
        console.error('[State] Failed to check session status:', e);
        return { active: false };
    }
}
