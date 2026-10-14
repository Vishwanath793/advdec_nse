/**
 * Browser build: every call goes to the Node backend (server/index.js).
 * Same interface as ./android.js.
 */

async function json(responsePromise) {
  const response = await responsePromise;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (HTTP ${response.status}).`);
  return payload;
}
const post = (path, body, method = 'POST') => fetch(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createWebApi() {
  return {
    platform: 'web',
    features: { tvResearch: true },
    master: {
      /** Saved upload ({ name, uploadedAt, rows }) or null when none / backend unreachable. */
      async get() {
        try {
          const r = await fetch('/api/master-stock');
          return r.ok ? r.json() : null;
        } catch { return null; }
      },
      save: (name, rows) => json(post('/api/master-stock', { name, rows }, 'PUT')),
      async reset() {
        const r = await fetch('/api/master-stock', { method: 'DELETE' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      },
    },
    preopen: {
      /** Server-sent events: cached status once, then updates. Returns an unsubscribe function. */
      subscribe(onUpdate, onError) {
        let events;
        // Defer connection until after React StrictMode's setup/cleanup check.
        const startup = setTimeout(() => {
          events = new EventSource('/api/nse/preopen/events');
          events.onmessage = (event) => {
            try { onUpdate(JSON.parse(event.data)); }
            catch { onError('Could not read the NSE update. Reload the page to reconnect.'); }
          };
          events.onerror = () => onError('NSE updates disconnected. Reconnecting to the backend…');
        }, 0);
        return () => { clearTimeout(startup); events?.close(); };
      },
      refresh: () => json(fetch('/api/nse/preopen/refresh', { method: 'POST' })),
      saveSchedule: (config) => json(post('/api/nse/schedule', config, 'PUT')),
    },
    priceBands: { get: () => json(fetch('/api/nse/price-bands')) },
    context: { get: () => json(fetch('/api/nse/context')) },
    kite: {
      createSession: async (body) => (await json(post('/api/kite/session', body))).session,
      positions: async (body) => {
        const { positions } = await json(post('/api/kite/positions', body));
        return Array.isArray(positions) ? positions : [];
      },
      accountSummary: async (body) => (await json(post('/api/kite/account-summary', body))).account ?? null,
      placeOrder: async (body) => (await json(post('/api/kite/order', body))).order,
    },
  };
}
