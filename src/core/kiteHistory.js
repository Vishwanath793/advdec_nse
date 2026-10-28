import { indiaDate, previousTradingDays } from './calendar.js';

/**
 * Historical inputs for the opening window, from Kite's historical candles
 * (3 requests a second), cached per day in history/YYYY-MM-DD.json:
 *  - atr14: average true range of the 14 completed daily candles before today;
 *  - openVol5Avg: average 09:15–09:20 volume over the last OPENING_VOLUME_DAYS
 *    sessions (sum of the five 1-minute candles), the RVOL baseline;
 *  - openValueAvg: average 09:15–09:20 traded value (₹, each minute's volume ×
 *    its typical price (high + low + close) / 3) over the same sessions;
 *  - openRangePctAvg: average 09:15–09:20 high–low range as % of the 09:15 open;
 *  - prevOi (F&O): the near-month future's open interest at the previous close,
 *    the baseline for the OI change.
 */

export const HISTORY_RATE_PER_SECOND = 3;
export const ATR_PERIOD = 14;
/** 20 completed sessions, the same look-back as the other research comparisons. */
export const OPENING_VOLUME_DAYS = 20;
/** Bump when the cached fields change, so older cache entries are fetched again. */
const HISTORY_VERSION = 4; // 4: per-minute median volume baselines (strategy D)
const file = (date) => `history/${date}.json`;
// One formatter, reused: building an Intl.DateTimeFormat per call is slow in backtest loops.
const IST_HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const ist = (d) => IST_HHMM.format(d);

/** Wilder-free simple ATR over the last `period` completed day candles ([Date, o, h, l, c, v]). */
export function atrFromDayCandles(candles, today, period = ATR_PERIOD) {
  const done = candles.filter(([t]) => indiaDate(t) < today);
  if (done.length < period + 1) return null;
  const trs = [];
  for (let i = done.length - period; i < done.length; i++) {
    const [, , h, l] = done[i];
    const prevClose = done[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** The last completed daily candle before `today`: { date, high, low } (the 9:15 gap plan's previous-day levels), or null. */
export function previousDayFromCandles(candles, today) {
  const last = candles.filter(([t]) => indiaDate(t) < today).at(-1);
  return last && last[2] > 0 && last[3] > 0 ? { date: indiaDate(last[0]), high: last[2], low: last[3] } : null;
}

/** Per session before `today` with all five 09:15–09:19 1-minute candles: volume, value (₹) and range (% of the open). */
export function openingWindowDays(minuteCandles, today) {
  const byDay = new Map();
  for (const [t, o, h, l, c, v] of minuteCandles) {
    const d = indiaDate(t);
    const time = ist(t);
    if (d >= today || time < '09:15' || time >= '09:20') continue;
    const day = byDay.get(d) ?? byDay.set(d, { date: d, volume: 0, value: 0, candles: 0, minutes: [null, null, null, null, null], open: null, first: Infinity, high: -Infinity, low: Infinity }).get(d);
    const i = Number(time.slice(3)) - 15;
    if (day.minutes[i] != null) continue; // a duplicate minute counts once
    day.minutes[i] = v;
    day.volume += v;
    day.value += v * ((h + l + c) / 3);
    day.candles += 1;
    if (+t < day.first) { day.first = +t; day.open = o; }
    day.high = Math.max(day.high, h);
    day.low = Math.min(day.low, l);
  }
  return [...byDay.values()].filter((d) => d.candles === 5)
    .map((d) => ({ date: d.date, volume: d.volume, value: d.value, minutes: d.minutes, rangePct: d.open > 0 ? ((d.high - d.low) / d.open) * 100 : null }));
}

const avgOf = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Average 09:15–09:20 volume over days that have all five 1-minute candles. */
export function openingVolumeAverage(minuteCandles, today) {
  const days = openingWindowDays(minuteCandles, today);
  return days.length ? { avg: avgOf(days.map((d) => d.volume)), days: days.length } : null;
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Strategy D's baselines: over the latest `sessions` complete days before `today` (all five unique
 * 09:15–09:19 minutes), the median opening-window volume and the median volume of each clock minute,
 * each computed directly (the median of totals is not the sum of minute medians). { openingMedian,
 * minuteMedian: [5], sessions, dates } or null.
 */
export function openingMedians(minuteCandles, today, sessions = OPENING_VOLUME_DAYS) {
  const days = openingWindowDays(minuteCandles, today).sort((a, b) => a.date.localeCompare(b.date)).slice(-sessions);
  if (!days.length) return null;
  return {
    openingMedian: median(days.map((d) => d.volume)),
    minuteMedian: [0, 1, 2, 3, 4].map((i) => median(days.map((d) => d.minutes[i]))),
    sessions: days.length,
    dates: days.map((d) => d.date),
  };
}

/** Average 09:15–09:20 volume, value and range over complete days: the research baselines. */
export function openingWindowAverages(minuteCandles, today) {
  const days = openingWindowDays(minuteCandles, today);
  if (!days.length) return null;
  const ranges = days.map((d) => d.rangePct).filter((r) => r != null);
  return { volume: avgOf(days.map((d) => d.volume)), value: avgOf(days.map((d) => d.value)), rangePct: avgOf(ranges), days: days.length };
}

/** A pacer: `run(fn)` starts fn no sooner than 1/perSecond after the previous start. */
export function createRateLimiter(perSecond, { now = () => Date.now(), setTimer = setTimeout } = {}) {
  const spacing = Math.ceil(1000 / perSecond);
  let next = 0;
  let chain = Promise.resolve();
  return {
    run(fn) {
      const job = chain.then(async () => {
        const wait = next - now();
        if (wait > 0) await new Promise((r) => setTimer(r, wait));
        next = now() + spacing;
        return fn();
      });
      chain = job.catch(() => {});
      return job;
    },
  };
}

/**
 * `kite` is the shared Kite client. `load(items, session)` with items
 * [{ symbol, token, futureToken? }] returns { SYMBOL: { atr14, openVol5Avg, openValueAvg, openRangePctAvg, openVolDays, prevOi } }.
 */
export function createHistoryService({ store, kite, calendar, now = () => new Date(), limiter = createRateLimiter(HISTORY_RATE_PER_SECOND) }) {
  async function load(items, { apiKey, accessToken }, { onProgress = () => {} } = {}) {
    const today = indiaDate(now());
    const cached = (await store.read(file(today))) ?? {};
    const days = previousTradingDays(today, Math.max(ATR_PERIOD + 6, OPENING_VOLUME_DAYS), calendar).reverse();
    if (!days.length) throw new Error('No previous trading days in the holiday calendar.');
    const missing = items.filter((i) => cached[i.symbol]?.v !== HISTORY_VERSION);
    let done = 0;
    const errors = [];
    const call = (args) => limiter.run(() => kite.historical({ apiKey, accessToken, ...args }));
    for (const item of missing) {
      const out = { v: HISTORY_VERSION, atr14: null, openVol5Avg: null, openValueAvg: null, openRangePctAvg: null, openVolDays: 0, prevOi: null, prevDay: null, volumeMedians: null };
      try {
        const daily = await call({ token: item.token, interval: 'day', from: `${days[0]} 00:00:00`, to: `${days.at(-1)} 23:59:59` });
        out.atr14 = atrFromDayCandles(daily, today);
        out.prevDay = previousDayFromCandles(daily, today);
        const firstOpenDay = days.at(-OPENING_VOLUME_DAYS);
        const minutes = await call({ token: item.token, interval: 'minute', from: `${firstOpenDay} 09:15:00`, to: `${days.at(-1)} 09:20:00` });
        const ov = openingWindowAverages(minutes, today);
        if (ov) { out.openVol5Avg = ov.volume; out.openValueAvg = ov.value; out.openRangePctAvg = ov.rangePct; out.openVolDays = ov.days; }
        const md = openingMedians(minutes, today);
        if (md) out.volumeMedians = { openingMedian: md.openingMedian, minuteMedian: md.minuteMedian, sessions: md.sessions };
        if (item.futureToken) {
          const fut = await call({ token: item.futureToken, interval: 'day', from: `${days.at(-1)} 00:00:00`, to: `${days.at(-1)} 23:59:59`, oi: true });
          const last = fut.at(-1);
          if (last && last.length >= 7 && Number.isFinite(last[6])) out.prevOi = last[6];
        }
        cached[item.symbol] = out;
      } catch (error) {
        errors.push(`${item.symbol}: ${error.message}`);
        if (error.status === 403) throw error; // session expired: stop
      }
      done++;
      onProgress({ done, total: missing.length });
      if (done % 20 === 0) await store.write(file(today), cached); // keep progress if interrupted
    }
    await store.write(file(today), cached);
    return { history: cached, errors };
  }
  return { load, read: async () => (await store.read(file(indiaDate(now())))) ?? {} };
}
