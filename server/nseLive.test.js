import test from 'node:test';
import assert from 'node:assert/strict';
import { createNseLiveService, NSE_INDEX_KEYS, NSE_LIVE_CACHE_MS, quotesFromAllIndices, quotesFromMarketWatch } from '../src/core/nseLive.js';
import { confirmationReading, confirmFromQuotes, MARKET_INDEX, NSE_UNAVAILABLE, SECTOR_INDEX } from '../src/utils/confirmation.js';

// Shapes as NSE returned them on 16-17 Oct 2026.
const marketWatch = (rows) => ({ data: { data: [
  { priority: 1, symbol: 'NIFTY TOTAL MARKET', lastPrice: 15000, open: 14900, dayHigh: 15010, dayLow: 14880, previousClose: 14950 },
  ...rows,
] } });
const infy = {
  priority: 0, symbol: 'INFY', series: 'EQ', lastPrice: 1161.2, open: 1127.5, dayHigh: 1167.85, dayLow: 1122, previousClose: 1110,
  totalTradedVolume: 25566304, totalTradedValue: 29462353066.56, lastUpdateTime: '2026-10-16 16:00:28',
};
const allIndices = { timestamp: '16-Oct-2026 15:30', data: [
  { index: 'NIFTY 50', last: 23146.15, open: 23065.1, high: 23149.85, low: 22913.8, previousClose: 22997.35 },
  { index: 'NIFTY IT', last: 31924.1, open: 30983.15, high: 32000, low: 30900, previousClose: 30900 },
  { index: 'NIFTY INFRASTRUCTURE', last: 8725.6, open: 8706.15, high: 8730, low: 8690, previousClose: 8700 },
  { index: 'NIFTY 500', last: 22270, open: 22230, high: 22280, low: 22200, previousClose: 22200 }, // not used
] };

test('NSE market watch rows become Kite-shaped quotes (VWAP from value / volume)', () => {
  const q = quotesFromMarketWatch(marketWatch([infy, { ...infy, symbol: 'ZERO', totalTradedVolume: 0, totalTradedValue: 0 }, { symbol: 'NOPRICE', lastPrice: 0 }]));
  assert.deepEqual(Object.keys(q), ['NSE:INFY', 'NSE:ZERO']); // the index row and unpriced rows are left out
  assert.deepEqual(q['NSE:INFY'], {
    source: 'nse', last_price: 1161.2, ohlc: { open: 1127.5, high: 1167.85, low: 1122, close: 1110 },
    volume: 25566304, average_price: 1152.39, timestamp: '2026-10-16 16:00:28',
  });
  assert.equal(q['NSE:ZERO'].average_price, null); // no trades yet: no VWAP
  assert.deepEqual(quotesFromMarketWatch(null), {});
});

test('NSE indices map to the instrument keys the checks use', () => {
  const q = quotesFromAllIndices(allIndices);
  assert.deepEqual(Object.keys(q).sort(), ['NSE:NIFTY 50', 'NSE:NIFTY INFRA', 'NSE:NIFTY IT']);
  assert.equal(q['NSE:NIFTY 50'].ohlc.open, 23065.1);
  // Every sector index the checks use has an NSE name.
  const covered = new Set(Object.values(SECTOR_INDEX));
  const mapped = new Set(Object.keys(quotesFromAllIndices({ data: Object.keys(NSE_INDEX_KEYS).map((index) => ({ index, last: 1, open: 1 })) })));
  for (const key of covered) assert.ok(mapped.has(key), key);
});

/** A fake NSE: the page sets a cookie; the API wants it. */
function fakeNse({ refuseFirst = 0, indicesRefused = false } = {}) {
  const calls = [];
  let refusals = refuseFirst;
  let cookieN = 0;
  const res = (status, body, cookies = []) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json', getSetCookie: () => cookies },
    json: async () => body,
  });
  async function fetchImpl(url, init) {
    calls.push({ url, cookie: init?.headers?.Cookie ?? null });
    if (url.includes('live-equity-market')) { cookieN++; return res(200, '', [`nsit=abc${cookieN}; Path=/; HttpOnly`, `nseappid=xyz${cookieN}; Path=/`]); }
    if (url.includes('allIndices')) return indicesRefused ? res(401, {}) : res(200, allIndices);
    if (url.includes('marketWatchApi')) {
      if (!init?.headers?.Cookie) return res(401, {});
      if (refusals > 0) { refusals--; return res(403, {}); }
      return res(200, marketWatch([infy]));
    }
    return res(404, {});
  }
  return { fetchImpl, calls };
}

test('the cookie handshake, one retry when NSE refuses, and a clear error after that', async () => {
  let t = 1_000_000;
  const nse = fakeNse({ refuseFirst: 1 });
  const svc = createNseLiveService({ fetchImpl: nse.fetchImpl, now: () => t });
  const r = await svc.quote(['NSE:INFY', 'NSE:NIFTY 50', 'NSE:UNKNOWN']);
  assert.deepEqual(Object.keys(r.quotes), ['NSE:INFY', 'NSE:NIFTY 50']);
  assert.equal(r.source, 'nse');
  const pages = nse.calls.filter((c) => c.url.includes('live-equity-market')).length;
  assert.equal(pages, 2); // first handshake, then a fresh one after the refusal
  const mw = nse.calls.filter((c) => c.url.includes('marketWatchApi'));
  assert.equal(mw.at(-1).cookie, 'nsit=abc2; nseappid=xyz2');

  const blocked = fakeNse({ refuseFirst: 5 });
  const svc2 = createNseLiveService({ fetchImpl: blocked.fetchImpl, now: () => t });
  await assert.rejects(svc2.quote(), /NSE refused the live-price request/);
});

test('results are cached for a few seconds and concurrent requests share one fetch', async () => {
  let t = 1_000_000;
  const nse = fakeNse();
  const svc = createNseLiveService({ fetchImpl: nse.fetchImpl, now: () => t });
  await Promise.all([svc.quote(), svc.quote(['NSE:INFY']), svc.quote()]);
  const count = () => nse.calls.filter((c) => c.url.includes('marketWatchApi')).length;
  assert.equal(count(), 1);
  t += NSE_LIVE_CACHE_MS - 1;
  await svc.quote();
  assert.equal(count(), 1);
  t += 2;
  await svc.quote();
  assert.equal(count(), 2);
});

test('a hanging request (stale cookie) gets a fresh cookie and one retry', async () => {
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  let t = 1_000_000;
  let hangs = 1;
  let indicesHang = true;
  const base = fakeNse();
  const pages = () => calls.filter((u) => u.includes('live-equity-market')).length;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('marketWatchApi') && hangs > 0) { hangs--; throw timeout(); }
    if (url.includes('allIndices') && indicesHang) throw timeout();
    return base.fetchImpl(url, init);
  };
  const svc = createNseLiveService({ fetchImpl, now: () => t });
  const r = await svc.quote();
  assert.deepEqual(Object.keys(r.quotes), ['NSE:INFY']); // indices hung: stocks still delivered
  assert.equal(pages(), 2); // the hang led to a fresh cookie

  // Hanging twice: a clear error, and the next request starts with a fresh cookie.
  t += 10_000;
  hangs = 2;
  await assert.rejects(svc.quote(), /NSE did not answer within 8 s/);
  const before = pages();
  t += 10_000;
  indicesHang = false;
  const ok = await svc.quote();
  assert.equal(pages(), before + 1);
  assert.ok(ok.quotes['NSE:NIFTY 50']);
});

test('stocks still come through if the index feed is refused', async () => {
  const svc = createNseLiveService({ fetchImpl: fakeNse({ indicesRefused: true }).fetchImpl, now: () => 1 });
  const r = await svc.quote();
  assert.deepEqual(Object.keys(r.quotes), ['NSE:INFY']);
});

test('confirmation on NSE prices: no order-book checks, no false "No buyers" warning, app circuit limits', () => {
  const quotes = { ...quotesFromMarketWatch(marketWatch([{ ...infy, lastPrice: 1165, dayHigh: 1167.85 }])), ...quotesFromAllIndices(allIndices) };
  const stock = {
    symbol: 'INFY', status: 'advance', sector: 'Information Technology', prevClose: 1110, finalPrice: 1127.5,
    convictionScore: 80, avgVolume: 9_000_000, prevHigh: 1150, upperCircuit: 1332, lowerCircuit: 888,
  };
  const c = confirmFromQuotes(stock, quotes, { minutes: 5 });
  const keys = [...c.checks, ...c.safety].map((x) => x.key);
  for (const k of ['book', 'spread', 'fresh']) assert.ok(!keys.includes(k), `${k} must be skipped`);
  for (const k of ['open', 'range', 'vwap', 'gap', 'volume', 'pdhl', 'market', 'relative', 'sector', 'circuit', 'stop']) assert.ok(keys.includes(k), k);
  assert.deepEqual(c.unavailable, NSE_UNAVAILABLE);
  assert.match(c.safety.find((x) => x.key === 'circuit').detail, /to the upper circuit ₹1,332\.00/); // the app's own limit
  assert.match(c.checks.find((x) => x.key === 'vwap').detail, /VWAP ₹1,152\.39/);
  assert.ok(c.score != null);
  const reading = confirmationReading([stock], quotes, new Date('2026-10-19T09:20:04+05:30'), '2026-10-19');
  assert.deepEqual([reading.source, reading.readings.INFY.source], ['nse', 'nse']);
  assert.ok(quotes[MARKET_INDEX]);
});
