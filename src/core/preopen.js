/**
 * NSE pre-open data: request, validation and normalisation into pm.csv-style
 * rows. Shared by the Node backend (cron job) and the Android app.
 */

export const NSE_URL = 'https://www.nseindia.com/api/NextApi/apiClient/cmPreOpenApi?functionName=getPreOpenData&category=ALL&symbol=';
export const NSE_HEADERS = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nseindia.com/' };

export function validateSchedule(config) {
  if (typeof config?.enabled !== 'boolean' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config?.time ?? '')) {
    throw new Error('Provide enabled (true/false) and a valid time in HH:mm format.');
  }
  return { enabled: config.enabled, time: config.time };
}

const number = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const crores = (value) => {
  const parsed = number(value);
  return parsed == null ? null : parsed / 10_000_000;
};

export function normalizePreopen(payload) {
  if (!Array.isArray(payload?.data) || !payload.data.length) {
    throw new Error('NSE returned no pre-open data. The previous successful data is retained.');
  }
  const rows = payload.data.filter((item) => typeof item?.symbol === 'string' && item.symbol.trim())
    .map((item) => ({
      SYMBOL: item.symbol.trim().toUpperCase(),
      SERIES: typeof item.series === 'string' ? item.series.trim() : null,
      'PREV. CLOSE': number(item.prevClose),
      'BASE PRICE': number(item.basePrice),
      'FINAL PRICE': number(item.finalPrice),
      CHANGE: number(item.change),
      '%CHANGE': number(item.perChange),
      'VALUE (₹ Crores)': crores(item.finalValue),
      'FFM CAP (₹ Crores)': crores(item.ffmMarketCap),
      // Conviction-score inputs (same column names as pm.csv where it has them).
      'FINAL VOLUME': number(item.finalQuantity),
      'TOTAL BUY QTY': number(item.totalBuyQuantity),
      'TOTAL SELL QTY': number(item.totalSellQuantity),
      '52 WEEK HIGH': number(item.yearHigh),
      '52 WEEK LOW': number(item.yearLow),
    }));
  if (!rows.length || !rows.some((row) => row['FINAL PRICE'] != null)) {
    throw new Error('NSE response did not contain usable stock prices.');
  }
  return { rows, marketUpdatedAt: payload.data.find((item) => item?.lastUpdateTime)?.lastUpdateTime ?? null };
}

/**
 * Fetch and normalise one pre-open snapshot. `fetchImpl` is fetch-compatible
 * (returns { ok, status, headers.get, json() }).
 */
export async function fetchPreopenSnapshot(fetchImpl, now = () => new Date()) {
  const response = await fetchImpl(NSE_URL, { headers: NSE_HEADERS, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`NSE request failed (HTTP ${response.status}).`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) throw new Error('NSE returned a non-JSON response. Please try again later.');
  return { ...normalizePreopen(await response.json()), fetchedAt: now().toISOString() };
}
