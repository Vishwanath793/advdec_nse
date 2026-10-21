import { gunzipSync, strFromU8 } from 'fflate';

/**
 * Kite Connect v3 calls, shared by the Node backend (proxy) and the Android app
 * (direct). `fetchImpl` is fetch-compatible.
 */

export const KITE_API = 'https://api.kite.trade';
/** Kite's /quote takes up to 500 instruments per request, one request a second. */
export const QUOTE_BATCH = 500;
export const QUOTE_MAX = 1000;
export const QUOTE_SPACING_MS = 1100;
export const kiteLoginUrl = (apiKey) => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

export class KiteError extends Error {
  constructor(message, status, data, { unknown = false } = {}) {
    super(message);
    this.status = status;
    this.data = data;
    /** True when the request may or may not have reached Kite (network error, timeout, 5xx): never resend blindly. */
    this.unknown = unknown;
  }
}

/** Kite rejects order calls from an IP that isn't whitelisted for the app (static-IP rule). */
export const isIpRejection = (error) => /not allowed to place orders|static ip|allowed ips/i.test(String(error?.message ?? ''));

/** Hex SHA-256 (Web Crypto: available in Node 20+ and the Android WebView). */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Exchanges whose contracts have freeze quantities, where Kite's `autoslice` applies.
 * For NSE/BSE equity Kite rejects it ("Cannot autoslice this instrument"), so it isn't sent.
 */
export const AUTOSLICE_EXCHANGES = ['NFO', 'BFO', 'MCX', 'CDS', 'BCD'];

/** Kite's order form fields (the variety goes in the URL path). */
export function orderForm(order) {
  const autoslice = order.autoslice !== undefined && AUTOSLICE_EXCHANGES.includes(order.exchange);
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
    ...(autoslice ? { autoslice: String(!!order.autoslice) } : {}),
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

/** Replace any of `secrets` (access token, API secret) found in `text` with "***". */
export function redactSecrets(text, ...secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('***');
  return out;
}

/** Kite's "2026-10-19T09:15:00+0530" candle time -> Date. */
export const kiteCandleTime = (text) => new Date(String(text).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

export function createKiteClient({ fetchImpl = fetch } = {}) {
  const headersFor = (apiKey, accessToken, form) => ({
    'X-Kite-Version': '3',
    ...(accessToken ? { Authorization: `token ${apiKey}:${accessToken}` } : {}),
    ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
  });

  async function call(path, { method = 'GET', apiKey, accessToken, form, failure, timeoutMs = 25_000 }) {
    let response;
    try {
      response = await fetchImpl(`${KITE_API}${path}`, {
        method,
        headers: headersFor(apiKey, accessToken, form),
        body: form ? form.toString() : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // No response: the request may or may not have reached Kite.
      throw new KiteError(redactSecrets(`${failure}: no response from Kite (${error.name === 'TimeoutError' ? 'timed out' : error.message})`, accessToken, apiKey), 0, null, { unknown: true });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new KiteError(redactSecrets(payload.message || failure, accessToken, apiKey), response.status, payload, { unknown: response.status >= 500 });
    }
    return payload;
  }

  /** A non-JSON response (the instruments CSV), gunzipped when Kite sends a gzip file. */
  async function callText(path, { apiKey, accessToken, failure }) {
    const response = await fetchImpl(`${KITE_API}${path}`, {
      headers: headersFor(apiKey, accessToken), signal: AbortSignal.timeout(60_000), binary: true,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new KiteError(redactSecrets(payload.message || failure, accessToken, apiKey), response.status, payload);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return strFromU8(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
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
    /**
     * Live quotes ({ "NSE:INFY": { last_price, ohlc, volume, average_price, ... } })
     * for up to QUOTE_MAX instruments, in batches of QUOTE_BATCH (Kite's limit),
     * spaced to stay within Kite's one-request-a-second rate limit.
     */
    async quote({ apiKey, accessToken, instruments }) {
      const list = [...new Set((instruments ?? []).filter((i) => typeof i === 'string' && i.includes(':')))].slice(0, QUOTE_MAX);
      const out = {};
      for (let i = 0; i < list.length; i += QUOTE_BATCH) {
        if (i) await new Promise((resolve) => setTimeout(resolve, QUOTE_SPACING_MS));
        const query = list.slice(i, i + QUOTE_BATCH).map((id) => `i=${encodeURIComponent(id)}`).join('&');
        const payload = await call(`/quote?${query}`, { apiKey, accessToken, failure: 'Kite quote request failed' });
        Object.assign(out, payload.data ?? {});
      }
      return out;
    },
    /** The day's instruments dump for one exchange (CSV text; generated once a day by Kite). */
    instrumentsCsv: ({ apiKey, accessToken, exchange }) => callText(`/instruments/${encodeURIComponent(exchange)}`, {
      apiKey, accessToken, failure: `Kite instruments download failed (${exchange})`,
    }),
    /**
     * Historical candles [[Date, open, high, low, close, volume, oi?], ...]. `from`/`to` are
     * "yyyy-mm-dd hh:mm:ss" (IST). Kite allows 3 requests a second: callers pace themselves.
     */
    async historical({ apiKey, accessToken, token, interval, from, to, oi = false }) {
      const q = new URLSearchParams({ from, to, ...(oi ? { oi: '1' } : {}) });
      const payload = await call(`/instruments/historical/${encodeURIComponent(token)}/${encodeURIComponent(interval)}?${q}`, {
        apiKey, accessToken, failure: 'Kite historical data request failed',
      });
      return (payload.data?.candles ?? []).map(([t, ...rest]) => [kiteCandleTime(t), ...rest]);
    },
    async placeOrder({ apiKey, accessToken, order, timeoutMs }) {
      const variety = encodeURIComponent(order.variety || 'regular');
      try {
        const payload = await call(`/orders/${variety}`, {
          method: 'POST', apiKey, accessToken, form: orderForm(order), failure: 'Kite order failed', timeoutMs,
        });
        return payload.data ?? payload;
      } catch (error) {
        if (error.unknown) error.message += ' The order may or may not have reached Kite: check your Kite order book before placing it again.';
        throw error;
      }
    },
    /** Modify an open/pending order: `params` from order_type, quantity, price, trigger_price, validity. */
    async modifyOrder({ apiKey, accessToken, variety = 'regular', orderId, params, timeoutMs }) {
      const form = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])));
      const payload = await call(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`, {
        method: 'PUT', apiKey, accessToken, form, failure: 'Kite order modification failed', timeoutMs,
      });
      return payload.data ?? payload;
    },
    /** Cancel an open/pending order. */
    async cancelOrder({ apiKey, accessToken, variety = 'regular', orderId, timeoutMs }) {
      const payload = await call(`/orders/${encodeURIComponent(variety)}/${encodeURIComponent(orderId)}`, {
        method: 'DELETE', apiKey, accessToken, failure: 'Kite order cancellation failed', timeoutMs,
      });
      return payload.data ?? payload;
    },
    /** The day's order book (every order with its latest status, filled_quantity, average_price, tag). */
    async orders({ apiKey, accessToken, timeoutMs = 10_000 }) {
      const payload = await call('/orders', { apiKey, accessToken, failure: 'Kite order book request failed', timeoutMs });
      return Array.isArray(payload.data) ? payload.data : [];
    },
    /** The day's executions. */
    async trades({ apiKey, accessToken, timeoutMs = 10_000 }) {
      const payload = await call('/trades', { apiKey, accessToken, failure: 'Kite trades request failed', timeoutMs });
      return Array.isArray(payload.data) ? payload.data : [];
    },
    /** Every state an order went through, oldest first (GET /orders/:order_id). */
    async orderHistory({ apiKey, accessToken, orderId, timeoutMs = 10_000 }) {
      const payload = await call(`/orders/${encodeURIComponent(orderId)}`, { apiKey, accessToken, failure: 'Kite order history request failed', timeoutMs });
      return Array.isArray(payload.data) ? payload.data : [];
    },
    /** The executions of one order (GET /orders/:order_id/trades). */
    async orderTrades({ apiKey, accessToken, orderId, timeoutMs = 10_000 }) {
      const payload = await call(`/orders/${encodeURIComponent(orderId)}/trades`, { apiKey, accessToken, failure: 'Kite order trades request failed', timeoutMs });
      return Array.isArray(payload.data) ? payload.data : [];
    },
    /** The user's profile (GET /user/profile): a light call, used to open the connection before a timed order. */
    async profile({ apiKey, accessToken, timeoutMs = 5_000 }) {
      const payload = await call('/user/profile', { apiKey, accessToken, failure: 'Kite profile request failed', timeoutMs });
      return payload.data ?? payload;
    },
  };
}
