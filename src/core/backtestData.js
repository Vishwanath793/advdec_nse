import { indiaDate, previousTradingDays } from './calendar.js';
import { createRateLimiter, openingVolumeAverage } from './kiteHistory.js';
import { sectorIndexKey } from '../utils/confirmation.js';

/**
 * Data for the candle backtest (milestone 3, part 2). Read-only: Kite's
 * historical candles and NSE's end-of-day files, nothing else.
 *
 *  - Which stocks to test each day comes from the end-of-day files kept in
 *    `bhav/` (no Kite calls): a stock "gapped" when that day's open differed from
 *    the previous close by MIN_GAP..MAX_GAP %. The biggest gaps are kept, up to a
 *    maximum per day. Previous high/low/close and ATR(14) use only earlier days.
 *  - Kite 1-minute candles are downloaded once per stock and cached in
 *    `candles/<SYMBOL>.json` (by day), so repeated runs cost nothing. Today's
 *    incomplete day is never cached. A request covers at most SPAN_DAYS.
 *  - The RVOL baseline is the average 09:15–09:20 volume of the ten trading days
 *    before the tested day, from the same candles: never from the tested day or later.
 *
 * Known biases (shown on the Research page): only stocks in the current master
 * list and the current instruments dump, so delisted or renamed stocks are
 * missing (survivorship); instrument tokens are today's.
 */

export const MIN_GAP_PCT = 0.5;
export const MAX_GAP_PCT = 20; // above this, assume a corporate action rather than a real gap
export const DEFAULT_MAX_PER_DAY = 15;
export const MAX_DAYS = 60;
export const SPAN_DAYS = 55; // Kite allows 60 days of 1-minute data per request
export const BASELINE_DAYS = 10;
const ATR_PERIOD = 14;
const MARKET_INDICES = ['NIFTY 50', 'NIFTY BANK'];
const cacheFile = (name) => `candles/${name}.json`;

/** Simple ATR over the last `period` completed days (oldest first): [{ high, low, close }]. */
export function atrFromBhavDays(days, period = ATR_PERIOD) {
  if (days.length < period + 1) return null;
  const trs = [];
  for (let i = days.length - period; i < days.length; i++) {
    const prevClose = days[i - 1].close;
    trs.push(Math.max(days[i].high - days[i].low, Math.abs(days[i].high - prevClose), Math.abs(days[i].low - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/**
 * Which stocks to test on each day.
 * `dates`: trading days to test (oldest first). `bhav`: Map date → { SYMBOL: { open, high, low, close, volume } }
 * for those days and the ~20 trading days before them. `sectors`: Map SYMBOL → sector name.
 * `scores`: optional Map date → { SYMBOL: { score, flags } } (recorded days: the 09:10 conviction).
 */
export function planBacktest({ dates, bhav, sectors, scores = new Map(), minGapPct = MIN_GAP_PCT, maxGapPct = MAX_GAP_PCT, maxPerDay = DEFAULT_MAX_PER_DAY }) {
  const known = [...bhav.keys()].sort();
  const skipped = { noPreviousDay: [], noStocks: [] };
  const days = [];
  for (const date of dates) {
    const today = bhav.get(date);
    const before = known.filter((d) => d < date);
    const prevDate = before.at(-1);
    if (!today || !prevDate) { skipped.noPreviousDay.push(date); continue; }
    const prev = bhav.get(prevDate);
    const history = (sym) => before.map((d) => bhav.get(d)[sym]).filter(Boolean);
    const gapped = [];
    for (const [symbol, d] of Object.entries(today)) {
      const p = prev[symbol];
      if (!p || !sectors.has(symbol) || !(d.open > 0) || !(p.close > 0)) continue;
      const gap = ((d.open - p.close) / p.close) * 100;
      if (Math.abs(gap) >= minGapPct && Math.abs(gap) <= maxGapPct) gapped.push({ symbol, gap });
    }
    gapped.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.symbol.localeCompare(b.symbol));
    const recorded = scores.get(date) ?? null;
    const stocks = gapped.slice(0, maxPerDay).map(({ symbol, gap }) => {
      const sector = sectors.get(symbol);
      const sc = recorded?.[symbol];
      return {
        symbol,
        meta: {
          symbol, sector, sectorIndex: sectorIndexKey(sector)?.replace(/^NSE:/, '') ?? null, status: gap > 0 ? 'advance' : 'decline',
          prevClose: prev[symbol].close, prevHigh: prev[symbol].high, prevLow: prev[symbol].low,
          atr14: atrFromBhavDays(history(symbol)),
          convictionScore: sc?.score ?? null, flags: sc?.flags ?? [],
        },
      };
    });
    if (!stocks.length) { skipped.noStocks.push(date); continue; }
    days.push({ date, recorded: Boolean(recorded), prevDate, stocks });
  }
  return { days, skipped, symbols: [...new Set(days.flatMap((d) => d.stocks.map((s) => s.symbol)))].sort() };
}

const addDays = (iso, n) => indiaDate(new Date(Date.parse(`${iso}T12:00:00+05:30`) + n * 86_400_000));
const asDate = (rows) => rows.map(([ms, ...rest]) => [new Date(ms), ...rest]);

/**
 * `kite` is the shared Kite client (historical()); `instruments.load(session)` gives the token lookup.
 * Nothing here can place an order.
 */
export function createBacktestData({ store, kite, instruments, calendar, now = () => new Date(), limiter = createRateLimiter(3) }) {
  /** 1-minute candles for `name` on each of `needed` days, downloading only the days not cached. Returns { date: rows }. */
  async function minuteCandles(name, token, needed, session, onCall = () => {}) {
    const today = indiaDate(now());
    const cache = (await store.read(cacheFile(name))) ?? { days: {} };
    const missing = needed.filter((d) => d < today && cache.days[d] === undefined).sort();
    let from = 0;
    while (from < missing.length) {
      // One request per stretch of at most SPAN_DAYS calendar days.
      const first = missing[from];
      let to = from;
      while (to + 1 < missing.length && Date.parse(missing[to + 1]) - Date.parse(first) <= SPAN_DAYS * 86_400_000) to++;
      const last = missing[to];
      onCall();
      const candles = await limiter.run(() => kite.historical({ ...session, token, interval: 'minute', from: `${first} 09:15:00`, to: `${last} 15:30:00` }));
      const byDay = {};
      for (const c of candles) (byDay[indiaDate(c[0])] ??= []).push([+c[0], ...c.slice(1, 6)]);
      for (let i = from; i <= to; i++) cache.days[missing[i]] = byDay[missing[i]] ?? []; // no candles: a holiday or no trades, not refetched
      from = to + 1;
    }
    if (missing.length) await store.write(cacheFile(name), cache);
    return Object.fromEntries(needed.map((d) => [d, cache.days[d] ?? null]));
  }

  return { minuteCandles };
}

/**
 * For each stock in a plan, the days of 1-minute candles it needs: every day it is tested,
 * plus the BASELINE_DAYS trading days before each (the RVOL baseline). Returns Map SYMBOL → sorted dates.
 */
export function neededDays(plan, calendar) {
  const out = new Map();
  for (const d of plan.days) {
    const baseline = previousTradingDays(d.date, BASELINE_DAYS, calendar);
    for (const s of d.stocks) {
      if (!out.has(s.symbol)) out.set(s.symbol, new Set());
      out.get(s.symbol).add(d.date);
      for (const b of baseline) out.get(s.symbol).add(b);
    }
  }
  return new Map([...out].map(([sym, set]) => [sym, [...set].sort()]));
}
