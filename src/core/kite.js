/**
 * Kite Connect v3 calls, shared by the Node backend (proxy) and the Android app
 * (direct). `fetchImpl` is fetch-compatible.
 */

export const KITE_API = 'https://api.kite.trade';
export const kiteLoginUrl = (apiKey) => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

export class KiteError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** Hex SHA-256 (Web Crypto: available in Node 20+ and the Android WebView). */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Kite's order form fields (the variety goes in the URL path). */
export function orderForm(order) {
  return new URLSearchParams({
    exchange: order.exchange,
    tradingsymbol: order.tradingsymbol,
    transaction_type: order.transaction_type,
    quantity: String(order.quantity ?? 0),
    product: order.product ?? 'MIS',
    order_type: order.order_type ?? 'MARKET',
    validity: order.validity ?? 'DAY',
    ...(order.price !== undefined ? { price: String(order.price) } : {}),
    ...(order.trigger_price !== undefined ? { trigger_price: String(order.trigger_price) } : {}),
    ...(order.disclosed_quantity !== undefined ? { disclosed_quantity: String(order.disclosed_quantity) } : {}),
    ...(order.market_protection !== undefined ? { market_protection: String(order.market_protection) } : {}),
    ...(order.autoslice !== undefined ? { autoslice: String(!!order.autoslice) } : {}),
    ...(order.tag ? { tag: order.tag } : {}),
  });
}

/** Equity margins payload -> the account summary shown in Settings. */
export function summarizeMargins(payload) {
  const data = payload?.data?.equity ?? payload?.data ?? {};
  const availableCash = Number(data.availablecash ?? data.available_cash ?? data.available?.cash ?? data.available ?? 0) || 0;
  const net = Number(data.net ?? data.equity ?? 0) || 0;
  const utilized = Number(data.utilizeddebits ?? data.utilized_margin ?? data.utilizeddebit ?? data.utilised?.debits ?? 0) || 0;
  const accountValue = Math.max(net + utilized, availableCash, 0);
  const intradayLeverage = availableCash > 0 ? accountValue / Math.max(availableCash, 1) : 0;
  return { availableCash, net, utilized, accountValue, intradayLeverage };
}

export function createKiteClient({ fetchImpl = fetch } = {}) {
  async function call(path, { method = 'GET', apiKey, accessToken, form, failure }) {
    const response = await fetchImpl(`${KITE_API}${path}`, {
      method,
      headers: {
        'X-Kite-Version': '3',
        ...(accessToken ? { Authorization: `token ${apiKey}:${accessToken}` } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new KiteError(payload.message || failure, response.status, payload);
    return payload;
  }

  return {
    async createSession({ apiKey, apiSecret, requestToken }) {
      const checksum = await sha256Hex(apiKey + requestToken + apiSecret);
      const payload = await call('/session/token', {
        method: 'POST',
        form: new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }),
        failure: 'Kite session failed',
      });
      return payload.data;
    },
    /** Net positions (Kite returns { net, day }). */
    async positions({ apiKey, accessToken }) {
      const payload = await call('/portfolio/positions', { apiKey, accessToken, failure: 'Kite positions request failed' });
      const data = payload.data;
      return Array.isArray(data) ? data : Array.isArray(data?.net) ? data.net : [];
    },
    async accountSummary({ apiKey, accessToken }) {
      return summarizeMargins(await call('/user/margins/equity', { apiKey, accessToken, failure: 'Kite account summary failed' }));
    },
    async placeOrder({ apiKey, accessToken, order }) {
      const variety = encodeURIComponent(order.variety || 'regular');
      const payload = await call(`/orders/${variety}`, {
        method: 'POST', apiKey, accessToken, form: orderForm(order), failure: 'Kite order failed',
      });
      return payload.data ?? payload;
    },
  };
}
