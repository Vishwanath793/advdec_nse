import { indiaDate, previousTradingDays } from './calendar.js';

/**
 * Historical inputs for the opening window, from Kite's historical candles
 * (3 requests a second), cached per day in history/YYYY-MM-DD.json:
 *  - atr14: average true range of the 14 completed daily candles before today;
 *  - openVol5Avg: average 09:15–09:20 volume over the last OPENING_VOLUME_DAYS
 *    sessions (sum of the five 1-minute candles), the RVOL baseline;
 *  - prevOi (F&O): the near-month future's open interest at the previous close,
 *    the baseline for the OI change.
 */

export const HISTORY_RATE_PER_SECOND = 3;
export const ATR_PERIOD = 14;
export const OPENING_VOLUME_DAYS = 10;
const file = (date) => `history/${date}.json`;
const ist = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

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

/** Average 09:15–09:20 volume over days that have all five 1-minute candles. */
export function openingVolumeAverage(minuteCandles, today) {
  const byDay = new Map();
  for (const [t, , , , , v] of minuteCandles) {
    const d = indiaDate(t);
    const time = ist(t);
    if (d >= today || time < '09:15' || time >= '09:20') continue;
    const day = byDay.get(d) ?? byDay.set(d, { volume: 0, candles: 0 }).get(d);
    day.volume += v;
    day.candles += 1;
  }
  const complete = [...byDay.values()].filter((d) => d.candles === 5);
  return complete.length ? { avg: complete.reduce((s, d) => s + d.volume, 0) / complete.length, days: complete.length } : null;
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
 * [{ symbol, token, futureToken? }] returns { SYMBOL: { atr14, openVol5Avg, openVolDays, prevOi } }.
 */
export function createHistoryService({ store, kite, calendar, now = () => new Date(), limiter = createRateLimiter(HISTORY_RATE_PER_SECOND) }) {
  async function load(items, { apiKey, accessToken }, { onProgress = () => {} } = {}) {
    const today = indiaDate(now());
    const cached = (await store.read(file(today))) ?? {};
    const days = previousTradingDays(today, Math.max(ATR_PERIOD + 6, OPENING_VOLUME_DAYS), calendar).reverse();
    if (!days.length) throw new Error('No previous trading days in the holiday calendar.');
    const missing = items.filter((i) => !cached[i.symbol]);
    let done = 0;
    const errors = [];
    const call = (args) => limiter.run(() => kite.historical({ apiKey, accessToken, ...args }));
    for (const item of missing) {
      const out = { atr14: null, openVol5Avg: null, openVolDays: 0, prevOi: null };
      try {
        const daily = await call({ token: item.token, interval: 'day', from: `${days[0]} 00:00:00`, to: `${days.at(-1)} 23:59:59` });
        out.atr14 = atrFromDayCandles(daily, today);
        const firstOpenDay = days.at(-OPENING_VOLUME_DAYS);
        const minutes = await call({ token: item.token, interval: 'minute', from: `${firstOpenDay} 09:15:00`, to: `${days.at(-1)} 09:20:00` });
        const ov = openingVolumeAverage(minutes, today);
        if (ov) { out.openVol5Avg = ov.avg; out.openVolDays = ov.days; }
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
