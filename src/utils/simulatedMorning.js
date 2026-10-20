import { istInstant } from '../core/calendar.js';

/**
 * A deterministic simulated opening (09:14:30–09:25:00 IST) for tests and for
 * replaying the scanner without a Kite login. Same seed, same ticks.
 *
 * Every stock is a scenario for the milestone-2 strategies, valid or invalid:
 *   ORBUP    clean opening-range breakout up (valid A)
 *   ORBDN    clean breakdown (valid A, short)
 *   FAKEOUT  spikes up, reverses to the low (false breakout: invalid A)
 *   GAPPULL  +4.5% gap, pulls back, recovers above VWAP on rising volume (valid B)
 *   DEADCAT  +4.2% gap, falls, weak bounce below VWAP (invalid B)
 *   MOMO     steady climb every minute, strong RVOL, small wicks (valid C)
 *   OVEREXT  runs 4% in five minutes, far above VWAP (invalid C: overextended)
 *   ILLIQ    wide spread, thin book (liquidity reject)
 *   STALE    ticks stop at 09:16:30 (stale data: no trade)
 *   LOCKED   sits at the upper circuit with no sellers (circuit reject)
 *   FNOSHORT F&O gap-down, future falls with OI rising (short build-up)
 *   NOFUT    F&O stock whose future never ticks (cash-only scoring)
 *   FLAT     small gap, chop, weak volume (no trade)
 * Also included: duplicate packets, an out-of-order tick and a tick stamped
 * exactly 09:20:00 (which must not count).
 *
 * After 09:20 (`after`, for the paper-trading replay): ORBUP breaks out and runs
 * through both targets; MOMO triggers, then falls back through its stop. The
 * others drift near their 09:20 price. Uses no extra random draws, so the
 * 09:15–09:20 window is unchanged.
 */

export const SIMULATED_DATE = '2026-10-19'; // a Monday in the 2026 NSE calendar

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const SCENARIOS = [
  // symbol, sector, prevClose, gap%, keyframes [sec from 09:15, % from open], vol/min (×avg opening rate), spread bps, depth size, fno
  { symbol: 'ORBUP', sector: 'Information Technology', prev: 1000, gap: 1.5, path: [[0, 0], [60, 0.3], [120, 0.2], [180, 0.6], [240, 0.9], [299, 1.2]], vol: 2.2, spread: 4, size: 4000, buyBias: 0.62, after: [[340, 1.6], [420, 2.6], [480, 3.4], [560, 4.4], [600, 5.6]] },
  { symbol: 'ORBDN', sector: 'Metals & Mining', prev: 500, gap: -1.8, path: [[0, 0], [60, -0.4], [120, -0.3], [180, -0.8], [240, -1.1], [299, -1.4]], vol: 2.0, spread: 5, size: 6000, buyBias: 0.38 },
  { symbol: 'FAKEOUT', sector: 'Information Technology', prev: 800, gap: 1.2, path: [[0, 0], [60, 0.8], [100, 1.1], [160, 0.2], [240, -0.4], [299, -0.5]], vol: 1.6, spread: 6, size: 3000, buyBias: 0.45 },
  { symbol: 'GAPPULL', sector: 'Capital Goods', prev: 200, gap: 4.5, path: [[0, 0], [40, 0.6], [110, -1.6], [170, -1.2], [230, 0.1], [299, 0.9]], vol: 2.6, spread: 6, size: 8000, buyBias: 0.58 },
  { symbol: 'DEADCAT', sector: 'Capital Goods', prev: 300, gap: 4.2, path: [[0, 0], [50, -1.5], [120, -2.6], [190, -2.1], [250, -2.4], [299, -2.5]], vol: 0.9, spread: 8, size: 5000, buyBias: 0.4 },
  { symbol: 'MOMO', sector: 'Automobile and Auto Components', prev: 1500, gap: 0.9, path: [[0, 0], [60, 0.3], [120, 0.6], [180, 0.9], [240, 1.2], [299, 1.45]], vol: 3.1, spread: 3, size: 3500, buyBias: 0.64, after: [[330, 1.7], [400, 1.0], [480, 0.3], [540, -0.4], [600, -0.6]] },
  { symbol: 'OVEREXT', sector: 'Information Technology', prev: 600, gap: 2.0, path: [[0, 0], [60, 1.2], [120, 2.3], [180, 3.1], [240, 3.7], [299, 4.0]], vol: 3.5, spread: 5, size: 3000, buyBias: 0.6 },
  { symbol: 'ILLIQ', sector: 'Realty', prev: 90, gap: 1.6, path: [[0, 0], [90, 0.5], [180, 0.9], [299, 1.0]], vol: 0.4, spread: 80, size: 150, buyBias: 0.55, sparse: 8 },
  { symbol: 'STALE', sector: 'Fast Moving Consumer Goods', prev: 400, gap: 1.1, path: [[0, 0], [60, 0.4], [90, 0.5]], vol: 1.2, spread: 6, size: 3000, buyBias: 0.55, stopAt: 90 },
  { symbol: 'LOCKED', sector: 'Realty', prev: 100, gap: 5.0, path: [[0, 0], [299, 0]], vol: 1.0, spread: 0, size: 0, buyBias: 1, locked: true, band: 5 },
  { symbol: 'FNOSHORT', sector: 'Financial Services', prev: 700, gap: -1.2, path: [[0, 0], [60, -0.3], [120, -0.5], [180, -0.7], [240, -0.9], [299, -1.1]], vol: 2.0, spread: 3, size: 9000, buyBias: 0.4, fut: { oiStart: 2_000_000, oiEnd: 2_180_000, premium: 0.25 } },
  { symbol: 'NOFUT', sector: 'Financial Services', prev: 350, gap: 1.0, path: [[0, 0], [120, 0.5], [299, 0.8]], vol: 1.5, spread: 4, size: 6000, buyBias: 0.56, fut: { silent: true } },
  { symbol: 'FLAT', sector: 'Fast Moving Consumer Goods', prev: 250, gap: 0.6, path: [[0, 0], [60, 0.1], [120, -0.1], [180, 0.1], [240, 0], [299, 0.05]], vol: 0.5, spread: 10, size: 2000, buyBias: 0.5 },
];

const INDICES = [
  { symbol: 'NIFTY 50', open: 23000, path: [[0, 0], [120, 0.15], [299, 0.25]] },
  { symbol: 'NIFTY BANK', open: 51000, path: [[0, 0], [120, -0.1], [299, -0.2]] },
  { symbol: 'NIFTY IT', open: 35000, path: [[0, 0], [150, 0.5], [299, 0.7]] },
  { symbol: 'NIFTY METAL', open: 9000, path: [[0, 0], [150, -0.4], [299, -0.6]] },
  { symbol: 'NIFTY FIN SERVICE', open: 24000, path: [[0, 0], [299, -0.3]] },
  { symbol: 'NIFTY INFRA', open: 8700, path: [[0, 0], [299, 0.2]] },
  { symbol: 'NIFTY AUTO', open: 25000, path: [[0, 0], [299, 0.4]] },
];

const SECTOR_INDEX = {
  'Information Technology': 'NIFTY IT', 'Metals & Mining': 'NIFTY METAL', 'Capital Goods': 'NIFTY INFRA',
  'Financial Services': 'NIFTY FIN SERVICE', 'Automobile and Auto Components': 'NIFTY AUTO',
};

const interp = (path, sec) => {
  if (sec <= path[0][0]) return path[0][1];
  for (let i = 1; i < path.length; i++) {
    if (sec <= path[i][0]) {
      const [s0, v0] = path[i - 1];
      const [s1, v1] = path[i];
      return v0 + ((v1 - v0) * (sec - s0)) / (s1 - s0);
    }
  }
  return path.at(-1)[1];
};
const tick2 = (p) => Math.round(p * 20) / 20; // ₹0.05 ticks

/** Build the simulated morning: { date, instruments, candidates, ticks: [{ tick, receivedAt }] }. */
export function simulatedMorning({ date = SIMULATED_DATE, seed = 920 } = {}) {
  const r = rng(seed);
  const open = +istInstant(date, '09:15');
  const instruments = {};
  const candidates = [];
  const ticks = [];
  let token = 1000;

  INDICES.forEach((ix) => {
    const t = ++token;
    instruments[t] = { kind: 'index', symbol: ix.symbol };
    for (let sec = -30; sec <= 600; sec += 2) {
      const at = open + sec * 1000;
      const p = ix.open * (1 + interp(ix.path, Math.min(Math.max(sec, 0), 299)) / 100);
      ticks.push({ tick: { token: t, index: true, mode: 'full', ltp: Math.round(p * 100) / 100, open: ix.open, high: ix.open * 1.01, low: ix.open * 0.99, close: ix.open * 0.998, change: 0, exchangeTime: at }, receivedAt: at + 40 });
    }
  });

  for (const sc of SCENARIOS) {
    const stockToken = ++token;
    const openPrice = tick2(sc.prev * (1 + sc.gap / 100));
    const avgOpenVol = 50_000; // historical 09:15–09:20 volume
    const preOpenVolume = 20_000;
    const band = sc.band ?? 20;
    const upper = tick2(sc.prev * (1 + band / 100));
    instruments[stockToken] = {
      kind: 'stock', symbol: sc.symbol, sector: sc.sector, sectorIndex: SECTOR_INDEX[sc.sector] ?? null,
      prevClose: sc.prev, preOpenPrice: openPrice, preOpenVolume, openVol5Avg: avgOpenVol, avgVolume: avgOpenVol * 12,
      // Research baselines (20 sessions): value at the previous close, a 1.2% usual opening range, a 1% usual gap.
      openValueAvg: avgOpenVol * sc.prev, openRangePctAvg: 1.2, openVolDays: 20, avgAbsGap: 1,
      atr14: sc.prev * 0.022, prevHigh: sc.prev * 1.01, prevLow: sc.prev * 0.99,
      upperCircuit: upper, lowerCircuit: tick2(sc.prev * (1 - band / 100)), status: sc.gap > 0 ? 'advance' : 'decline',
    };
    candidates.push({ symbol: sc.symbol, gapPct: sc.gap, convictionScore: 50 + Math.round(r() * 40), sector: sc.sector });

    let volume = preOpenVolume;
    let value = preOpenVolume * openPrice; // the pre-open trade is part of Kite's average price
    let high = openPrice;
    let low = openPrice;
    const step = sc.sparse ?? 1;
    const end = sc.stopAt ?? 600;
    // One tick before the open (pre-open state), then the session.
    const preTick = { token: stockToken, mode: 'full', index: false, ltp: openPrice, lastQty: 0, avgPrice: openPrice, volume, buyQty: 10000, sellQty: 10000, open: openPrice, high, low, close: sc.prev, lastTradeTime: open - 400_000, oi: 0, oiDayHigh: 0, oiDayLow: 0, exchangeTime: open - 20_000, depth: null };
    ticks.push({ tick: preTick, receivedAt: open - 19_950 });
    for (let sec = 0; sec <= end; sec += step) {
      const at = open + sec * 1000;
      const base = sec > 299 && sc.after ? interp([[299, sc.path.at(-1)[1]], ...sc.after], sec) : interp(sc.path, Math.min(sec, 299));
      const drift = base + (sec > 299 ? (r() - 0.5) * (sc.after ? 0.04 : 0.2) : 0);
      let ltp = sc.locked ? upper : tick2(openPrice * (1 + (drift + (r() - 0.5) * 0.08) / 100));
      if (!sc.locked && ltp > upper) ltp = upper;
      high = Math.max(high, ltp);
      low = Math.min(low, ltp);
      const minuteBoost = sc.symbol === 'GAPPULL' && sec >= 170 && sec < 300 ? 1.8 : sc.symbol === 'DEADCAT' && sec >= 120 ? 0.6 : 1;
      const traded = sc.locked ? (sec % 30 === 0 ? 200 : 0) : Math.round(((avgOpenVol / 300) * sc.vol * minuteBoost * step) * (0.6 + r() * 0.8));
      volume += traded;
      value += traded * ltp;
      const spreadRs = sc.locked ? 0 : Math.max(0.05, tick2((ltp * sc.spread) / 10_000));
      const bid = sc.locked ? upper : tick2(ltp - spreadRs / 2);
      const ask = sc.locked ? 0 : tick2(bid + spreadRs);
      const lvl = (base, i, price) => ({ qty: Math.max(1, Math.round(base * (1 + i * 0.3) * (0.7 + r() * 0.6))), price, orders: 1 + Math.round(r() * 12) });
      const bidSize = sc.size * sc.buyBias * 2;
      const askSize = sc.size * (1 - sc.buyBias) * 2;
      const depth = {
        buy: [0, 1, 2, 3, 4].map((i) => lvl(sc.locked ? 50_000 : bidSize, i, tick2(bid - i * 0.05))),
        sell: sc.locked ? Array(5).fill({ qty: 0, price: 0, orders: 0 }) : [0, 1, 2, 3, 4].map((i) => lvl(askSize, i, tick2(ask + i * 0.05))),
      };
      const tick = {
        token: stockToken, mode: 'full', index: false, ltp, lastQty: Math.max(1, Math.round(traded / 5)),
        avgPrice: Math.round((value / volume) * 100) / 100, volume, buyQty: Math.round(bidSize * 40), sellQty: Math.round(askSize * 40),
        open: openPrice, high, low, close: sc.prev, lastTradeTime: at - 300, oi: 0, oiDayHigh: 0, oiDayLow: 0, exchangeTime: at, depth,
      };
      ticks.push({ tick, receivedAt: at + 30 + Math.round(r() * 60) });
      if (sc.symbol === 'ORBUP' && sec === 30) ticks.push({ tick: { ...tick }, receivedAt: at + 120 }); // duplicate packet
    }
    // An out-of-order tick (arrives late, older timestamp) and one stamped exactly 09:20:00.
    if (sc.symbol === 'MOMO') {
      const late = ticks.filter((x) => x.tick.token === stockToken && x.tick.exchangeTime === open + 100_000)[0];
      if (late) ticks.push({ tick: { ...late.tick, ltp: late.tick.ltp - 1, volume: late.tick.volume - 500 }, receivedAt: open + 103_000 });
    }

    if (sc.fut) {
      const futToken = ++token;
      instruments[futToken] = { kind: 'future', symbol: `${sc.symbol}26OCTFUT`, underlying: sc.symbol, prevOi: sc.fut.oiStart ?? null, lot: 500 };
      instruments[stockToken].fno = true;
      if (!sc.fut.silent) {
        let fvol = 0;
        for (let sec = 0; sec <= 600; sec += 2) {
          const at = open + sec * 1000;
          const spot = openPrice * (1 + interp(sc.path, Math.min(sec, 299)) / 100);
          const fltp = tick2(spot * (1 + sc.fut.premium / 100));
          fvol += 2000;
          const oi = Math.round(sc.fut.oiStart + ((sc.fut.oiEnd - sc.fut.oiStart) * Math.min(sec, 299)) / 299);
          ticks.push({ tick: { token: futToken, mode: 'full', index: false, ltp: fltp, lastQty: 500, avgPrice: fltp, volume: fvol, buyQty: 50_000, sellQty: 60_000, open: tick2(openPrice * (1 + sc.fut.premium / 100)), high: fltp, low: fltp, close: sc.prev, lastTradeTime: at, oi, oiDayHigh: oi, oiDayLow: sc.fut.oiStart, exchangeTime: at, depth: null }, receivedAt: at + 50 });
        }
      }
    }
  }
  ticks.sort((a, b) => a.receivedAt - b.receivedAt);
  return { date, instruments, candidates, ticks };
}
