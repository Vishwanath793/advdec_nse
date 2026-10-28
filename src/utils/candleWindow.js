/**
 * The 09:15–09:20 features from Kite 1-minute candles (milestone 3, candle
 * backtests), in the same shape as utils/openingWindow.js so the same
 * strategies, score and decision run on them.
 *
 * What candles can't give is left out, never made up:
 *  - no order book: `depth` is null and the book/spread checks are marked
 *    "not tested" (strategies, score and plan see `source: 'candles'`);
 *  - no F&O: futures history isn't used (`fo.missing`);
 *  - no circuit limits: the circuit checks are skipped;
 *  - VWAP is computed from the candles' typical price × volume (Kite's average
 *    traded price isn't in historical data), labelled as such;
 *  - the opening range, close position and minute structure come from the five
 *    candles 09:15–09:19 (exact highs/lows, unlike the live window's sampled ticks).
 * The RVOL baseline is the same as live: the 09:15–09:20 volume of earlier days.
 */

const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
// One formatter, reused: building an Intl.DateTimeFormat per call is slow in backtest loops.
const IST_HHMM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const ist = (d) => IST_HHMM.format(d);

/** The five 1-minute candles 09:15–09:19 (index 0–4) from a day's candles ([Date, o, h, l, c, v]). */
export function windowCandles(candles) {
  const out = [null, null, null, null, null];
  for (const c of candles ?? []) {
    const m = ist(c[0]);
    if (m >= '09:15' && m < '09:20') out[Number(m.slice(3)) - 15] = c;
  }
  return out;
}

/** Index move 09:15 → 09:20 from its opening 5-minute candle (or 1-minute candles). */
export function indexMove(symbol, candles) {
  const w = (candles ?? []).filter((c) => { const m = ist(c[0]); return m >= '09:15' && m < '09:20'; });
  if (!w.length) return null;
  const open = w[0][1];
  const close = w.at(-1)[4];
  return open ? { symbol, open, ltp: close, pct: pct(close, open) } : null;
}

/**
 * `meta`: { symbol, token, sector, sectorIndex, prevClose, prevHigh, prevLow, atr14,
 *           openVol5Avg, tick, lot, flags, convictionScore, status }
 * `market`: { nifty, bankNifty, sector } index moves (indexMove) or null.
 */
export function candleFeatures(meta, candles, market = {}) {
  const w = windowCandles(candles);
  const have = w.filter(Boolean);
  const quality = {
    source: 'candles', ticks: have.length, candles: have.length, duplicates: 0, outOfOrder: 0, resets: 0,
    lastTickAgeSec: null, volumeBaseline: meta.openVol5Avg ? 'earlier days\' 09:15–09:20 volume (Kite 5-minute candles)' : null,
    depthSamples: 0, noDepth: true,
  };
  quality.stale = have.length < 5 || !w[4]; // a missing minute (no trades, or no data) counts against the stock
  const base = { symbol: meta.symbol, token: meta.token ?? null, kind: 'stock', source: 'candles', sector: meta.sector ?? null, status: meta.status ?? null };
  if (!have.length) return { ...base, quality, missing: ['no candles in the window'] };

  const open = have[0][1];
  const orHigh = Math.max(...have.map((c) => c[2]));
  const orLow = Math.min(...have.map((c) => c[3]));
  const ltp = have.at(-1)[4];
  const range = orHigh - orLow;
  const prevClose = meta.prevClose ?? null;
  const minuteVolume = w.map((c) => (c ? c[5] : 0));
  const windowVolume = minuteVolume.reduce((a, b) => a + b, 0);
  const minuteCloses = w.map((c) => (c ? c[4] : null));
  const minuteReturns = minuteCloses.map((c, i) => {
    const prev = i === 0 ? open : minuteCloses.slice(0, i).filter((x) => x != null).at(-1);
    return c != null && prev ? pct(c, prev) : null;
  });
  // VWAP from the candles (typical price × volume), and which side of it each minute closed.
  let pv = 0;
  let vol = 0;
  const vwapSides = [];
  for (const c of w) {
    if (!c) continue;
    pv += ((c[2] + c[3] + c[4]) / 3) * c[5];
    vol += c[5];
    if (vol) vwapSides.push(Math.sign(c[4] - pv / vol));
  }
  const vwap = vol ? pv / vol : null;
  const crosses = vwapSides.filter((x, i, a) => i > 0 && x !== 0 && a[i - 1] !== 0 && x !== a[i - 1]).length;
  const firstRate = (minuteVolume[0] + minuteVolume[1] + minuteVolume[2]) / 3;
  const lastRate = (minuteVolume[3] + minuteVolume[4]) / 2;
  const close2Ago = minuteCloses.slice(0, 3).filter((x) => x != null).at(-1) ?? open;
  const ret5 = pct(ltp, open);
  const nifty = market.nifty ?? null;
  const sector = market.sector ?? null;

  return {
    ...base,
    tick: meta.tick ?? 0.05, lot: meta.lot ?? 1, fno: Boolean(meta.fno), flags: meta.flags ?? [], convictionScore: meta.convictionScore ?? null,
    prevClose, preOpenPrice: null, open, ltp,
    gapPct: pct(open, prevClose), ret5Pct: ret5,
    orHigh, orLow, orRangePct: open ? (range / open) * 100 : null,
    closePos: range > 0 ? (ltp - orLow) / range : null,
    candles: w.map((c, i) => (c ? { minute: i, o: c[1], h: c[2], l: c[3], c: c[4], volume: c[5], approximate: false } : null)),
    candle5: { o: open, h: orHigh, l: orLow, c: ltp, volume: windowVolume },
    bodyPct: range > 0 ? (Math.abs(ltp - open) / range) * 100 : null,
    upperWickPct: range > 0 ? ((orHigh - Math.max(open, ltp)) / range) * 100 : null,
    lowerWickPct: range > 0 ? ((Math.min(open, ltp) - orLow) / range) * 100 : null,
    minuteReturns, last2MinPct: pct(ltp, close2Ago),
    windowVolume, minuteVolume, volumePerMinute: windowVolume / 5,
    rvol: meta.openVol5Avg ? windowVolume / meta.openVol5Avg : null,
    volAccel: firstRate > 0 ? lastRate / firstRate : null,
    avgVolume20: null,
    vwap, vwapSource: vwap ? 'computed from 1-minute candles (typical price × volume; Kite\'s average price is not in historical data)' : null,
    vwapDistPct: pct(ltp, vwap), vwapCrosses: crosses,
    vwapReclaim: vwapSides.length > 1 ? vwapSides.slice(0, -1).some((x) => x < 0) && vwapSides.at(-1) > 0 : null,
    vwapReject: vwapSides.length > 1 ? vwapSides.slice(0, -1).some((x) => x > 0) && vwapSides.at(-1) < 0 : null,
    distPrevHighPct: pct(ltp, meta.prevHigh), distPrevLowPct: pct(ltp, meta.prevLow),
    atr14: meta.atr14 ?? null, orRangeAtr: meta.atr14 ? range / meta.atr14 : null,
    upperCircuit: null, lowerCircuit: null, // not in historical data
    totalBuyQty: null, totalSellQty: null,
    depth: null,
    fo: { symbol: null, missing: 'F&O history is not used in candle backtests' },
    market: {
      nifty, bankNifty: market.bankNifty ?? null, sector,
      relVsNiftyPct: ret5 != null && nifty ? ret5 - nifty.pct : null,
      relVsSectorPct: ret5 != null && sector ? ret5 - sector.pct : null,
    },
    quality,
  };
}
