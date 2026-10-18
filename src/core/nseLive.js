/**
 * Live prices from NSE's website, as a fallback when Kite has no market-data
 * permission. One market-watch call covers the Nifty Total Market stocks;
 * allIndices covers Nifty 50 and the sector indices. Results are returned in
 * Kite's quote shape ({ "NSE:INFY": { last_price, ohlc, volume, ... } }) so the
 * confirmation checks work unchanged. NSE has no order book, bid/ask or
 * last-trade time here, so those fields are absent (and their checks skipped).
 */

const BASE = 'https://www.nseindia.com';
const PAGE = `${BASE}/market-data/live-equity-market`;
const MARKET_WATCH = `${BASE}/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=${encodeURIComponent('NIFTY TOTAL MKT')}`;
const ALL_INDICES = `${BASE}/api/allIndices`;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json,text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' };
/** Repeated requests within this window reuse the last result. */
export const NSE_LIVE_CACHE_MS = 3_000;
/** A live price older than this is no use, so give up on a request after it. */
export const NSE_LIVE_TIMEOUT_MS = 8_000;
/** NSE's cookies are refreshed after this long, or when a request is refused or hangs. */
const COOKIE_MAX_AGE_MS = 10 * 60_000;

/** NSE index name -> the Kite instrument key the confirmation checks use. */
export const NSE_INDEX_KEYS = {
  'NIFTY 50': 'NSE:NIFTY 50',
  'NIFTY FINANCIAL SERVICES': 'NSE:NIFTY FIN SERVICE',
  'NIFTY IT': 'NSE:NIFTY IT',
  'NIFTY AUTO': 'NSE:NIFTY AUTO',
  'NIFTY PHARMA': 'NSE:NIFTY PHARMA',
  'NIFTY FMCG': 'NSE:NIFTY FMCG',
  'NIFTY METAL': 'NSE:NIFTY METAL',
  'NIFTY REALTY': 'NSE:NIFTY REALTY',
  'NIFTY ENERGY': 'NSE:NIFTY ENERGY',
  'NIFTY MEDIA': 'NSE:NIFTY MEDIA',
  'NIFTY INFRASTRUCTURE': 'NSE:NIFTY INFRA',
  'NIFTY CONSUMER DURABLES': 'NSE:NIFTY CONSR DURBL',
};

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
};

/** NSE's "2026-10-16 16:00:28" / "16-Oct-2026 15:30" (IST) as Kite's "YYYY-MM-DD HH:MM:SS". */
function kiteTimestamp(text) {
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(text ?? ''));
  if (iso) return `${iso[1]} ${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}`;
  return null;
}

/** Market-watch rows -> Kite-shaped quotes. VWAP = traded value / traded volume. */
export function quotesFromMarketWatch(payload) {
  const rows = payload?.data?.data ?? payload?.data ?? [];
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const symbol = typeof r?.symbol === 'string' ? r.symbol.trim() : '';
    const ltp = num(r.lastPrice);
    // The first row is the index itself (priority 1); stocks only.
    if (!symbol || r.priority === 1 || !(ltp > 0)) continue;
    const volume = num(r.totalTradedVolume) ?? 0;
    const value = num(r.totalTradedValue);
    out[`NSE:${symbol}`] = {
      source: 'nse',
      last_price: ltp,
      ohlc: { open: num(r.open), high: num(r.dayHigh), low: num(r.dayLow), close: num(r.previousClose) },
      volume,
      average_price: volume > 0 && value != null ? Math.round((value / volume) * 100) / 100 : null,
      timestamp: kiteTimestamp(r.lastUpdateTime),
    };
  }
  return out;
}

/** allIndices -> Kite-shaped quotes for Nifty 50 and the mapped sector indices. */
export function quotesFromAllIndices(payload) {
  const out = {};
  for (const d of payload?.data ?? []) {
    const key = NSE_INDEX_KEYS[d?.index];
    const ltp = num(d?.last);
    if (!key || !(ltp > 0)) continue;
    out[key] = { source: 'nse', last_price: ltp, ohlc: { open: num(d.open), high: num(d.high), low: num(d.low), close: num(d.previousClose) } };
  }
  return out;
}

/** Cookie pairs from a response's Set-Cookie headers (Node's fetch; the phone keeps its own jar). */
function cookiesFrom(response) {
  const list = typeof response?.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

export function createNseLiveService({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cookie = '';
  let cookieAt = 0;
  let cache = null; // { at, quotes, fetchedAt }
  let running = null;

  async function handshake() {
    const response = await fetchImpl(PAGE, { headers: HEADERS, signal: AbortSignal.timeout(NSE_LIVE_TIMEOUT_MS) });
    cookie = cookiesFrom(response);
    cookieAt = now();
  }

  /**
   * { json } or { refused: true }. NSE answers a stale or flagged cookie either
   * with 401/403 or by never answering, so a timeout or network error counts as
   * a refusal too (and leads to a fresh cookie).
   */
  async function getJson(url, { withCookie }) {
    const headers = { ...HEADERS, Referer: PAGE, ...(withCookie && cookie ? { Cookie: cookie } : {}) };
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(NSE_LIVE_TIMEOUT_MS) });
    } catch (error) {
      return { refused: true, error };
    }
    if (response.status === 401 || response.status === 403) return { refused: true };
    if (!response.ok) throw new Error(`NSE live prices failed (HTTP ${response.status}).`);
    return { json: await response.json() };
  }

  /** Market watch, with one cookie refresh if NSE refuses or doesn't answer. */
  async function marketWatch() {
    if (!cookieAt || now() - cookieAt > COOKIE_MAX_AGE_MS) await handshake();
    let r = await getJson(MARKET_WATCH, { withCookie: true });
    if (r.refused) {
      await handshake();
      r = await getJson(MARKET_WATCH, { withCookie: true });
      if (r.refused) {
        cookieAt = 0; // start with a fresh cookie next time
        throw new Error(r.error?.name === 'TimeoutError'
          ? `NSE did not answer within ${NSE_LIVE_TIMEOUT_MS / 1000} s. Retrying on the next refresh.`
          : 'NSE refused the live-price request. Retrying on the next refresh.');
      }
    }
    return r.json;
  }

  /**
   * Quotes for `instruments` (["NSE:INFY", "NSE:NIFTY 50", ...]); all of them
   * when omitted. Instruments NSE doesn't cover are simply missing.
   */
  async function quote(instruments = null) {
    if (!cache || now() - cache.at > NSE_LIVE_CACHE_MS) {
      running ??= (async () => {
        const [stocks, indices] = await Promise.all([
          marketWatch(),
          // Indices are optional: if they fail, the stock prices still come through.
          getJson(ALL_INDICES, { withCookie: true }).then((r) => (r.refused ? null : r.json)).catch(() => null),
        ]);
        cache = { at: now(), fetchedAt: new Date(now()).toISOString(), quotes: { ...quotesFromMarketWatch(stocks), ...quotesFromAllIndices(indices) } };
      })().finally(() => { running = null; });
      await running;
    }
    const quotes = instruments
      ? Object.fromEntries(instruments.filter((i) => cache.quotes[i]).map((i) => [i, cache.quotes[i]]))
      : cache.quotes;
    return { quotes, fetchedAt: cache.fetchedAt, source: 'nse' };
  }

  return { quote };
}
