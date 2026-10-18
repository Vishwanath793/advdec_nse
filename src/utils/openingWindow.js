import { istInstant } from '../core/calendar.js';
import { oiBuild } from './signals.js';

/**
 * The 09:15:00–09:19:59.999 IST opening window, built from Kite WebSocket ticks
 * (pure: no I/O, no clock of its own).
 *
 * Rules
 *  - A tick counts if its exchange timestamp is in [09:15:00, 09:20:00). Kite's
 *    timestamps are whole seconds, so in practice 09:19:59 counts, 09:20:00 does
 *    not. Ticks at or after 09:20:00 never change the window (counted as afterSeal).
 *  - Volume: Kite sends cumulative day volume. The pre-open auction quantity is
 *    excluded by taking as the baseline the last cumulative volume before 09:15
 *    (a pre-09:15 tick, else NSE's pre-open final quantity; if neither, the first
 *    window tick, flagged as estimated). Increments are differences between
 *    successive in-order readings; a duplicate packet adds nothing; an
 *    out-of-order (older) tick never adds volume; a fall in cumulative volume is a
 *    feed reset (restart counting from it). Volume that arrives after a gap is
 *    attributed to the minute of the tick that revealed it.
 *  - Opening range = Kite's day high/low as of the last tick before 09:20
 *    (official, includes trades between ticks). Minute candles are built from
 *    sampled LTPs, so their highs/lows are approximate (labelled).
 *  - VWAP = Kite's average traded price (day VWAP incl. the pre-open trade),
 *    labelled as such. Pending orders (depth, total buy/sell qty) are not trades.
 */

const MINUTES = 5;
export const STALE_TICK_SECONDS = 60;
/** Notional (₹) for the impact-cost estimate until risk sizing exists (milestone 2). */
export const DEFAULT_IMPACT_NOTIONAL = 100_000;

const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const stdev = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const imbalance = (bid, ask) => (bid + ask > 0 ? (bid - ask) / (bid + ask) : null);

/** Summary of one five-level depth snapshot. */
export function depthSummary(depth) {
  const bids = (depth?.buy ?? []).filter((l) => l.price > 0 && l.qty > 0);
  const asks = (depth?.sell ?? []).filter((l) => l.price > 0 && l.qty > 0);
  if (!bids.length || !asks.length) return { usable: false, bidLevels: bids.length, askLevels: asks.length };
  const sumQty = (ls, n) => ls.slice(0, n).reduce((s, l) => s + l.qty, 0);
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  return {
    usable: true,
    bestBid, bestAsk, bestBidQty: bids[0].qty, bestAskQty: asks[0].qty, bestBidOrders: bids[0].orders, bestAskOrders: asks[0].orders,
    spread: bestAsk - bestBid,
    spreadBps: ((bestAsk - bestBid) / mid) * 10_000,
    bidQty5: sumQty(bids, 5), askQty5: sumQty(asks, 5),
    imbalanceBest: imbalance(bids[0].qty, asks[0].qty),
    imbalance3: imbalance(sumQty(bids, 3), sumQty(asks, 3)),
    imbalance5: imbalance(sumQty(bids, 5), sumQty(asks, 5)),
    liquidity5: bids.slice(0, 5).reduce((s, l) => s + l.qty * l.price, 0) + asks.slice(0, 5).reduce((s, l) => s + l.qty * l.price, 0),
    levels: { buy: bids.slice(0, 5), sell: asks.slice(0, 5) },
  };
}

/**
 * Impact cost (bps vs the mid) of buying (side 1) or selling (side -1) `notional`
 * rupees through the visible five levels; null when the book is too thin.
 */
export function impactCost(depth, side, notional) {
  const s = depthSummary(depth);
  if (!s.usable) return null;
  const levels = side > 0 ? s.levels.sell : s.levels.buy;
  let remaining = notional;
  let qty = 0;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(l.qty, Math.ceil(remaining / l.price));
    qty += take;
    cost += take * l.price;
    remaining -= take * l.price;
    if (remaining <= 0) break;
  }
  if (remaining > 0 || !qty) return null;
  const mid = (s.bestBid + s.bestAsk) / 2;
  return ((side * (cost / qty - mid)) / mid) * 10_000;
}

/**
 * `instruments`: Map/obj token -> meta:
 *   { kind: 'stock'|'index'|'future', symbol, sector?, prevClose?, preOpenPrice?, preOpenVolume?,
 *     openVol5Avg?, atr14?, prevHigh?, prevLow?, upperCircuit?, lowerCircuit?, prevOi? (future),
 *     underlying? (future), sectorIndex? (stock: index symbol), status? (advance/decline) }
 */
export function createOpeningWindow({ date, instruments, impactNotional = DEFAULT_IMPACT_NOTIONAL, marketIndices = ['NIFTY 50', 'NIFTY BANK'] }) {
  const startAt = +istInstant(date, '09:15');
  const sealAt = +istInstant(date, '09:20');
  const meta = new Map(Object.entries(instruments instanceof Map ? Object.fromEntries(instruments) : instruments).map(([k, v]) => [Number(k), v]));
  const state = new Map();
  const counters = { counted: 0, beforeOpen: 0, afterSeal: 0, duplicates: 0, outOfOrder: 0, unknown: 0 };
  let sealed = null;

  const st = (token) => {
    if (!state.has(token)) {
      state.set(token, {
        ticks: 0, lastTime: 0, lastKey: null, baselineVolume: null, baselineSource: null, lastVolume: null,
        resets: 0, outOfOrder: 0, duplicates: 0, minutes: Array.from({ length: MINUTES }, () => null),
        minuteVolume: Array(MINUTES).fill(0), windowVolume: 0, last: null, firstInWindow: null, depth: [],
        vwapSides: [], oiFirst: null, preTick: null,
      });
    }
    return state.get(token);
  };

  /** Feed one parsed tick. Returns { counted, reason? }. */
  function ingest(tick, receivedAt) {
    const m = meta.get(tick.token);
    if (!m) { counters.unknown++; return { counted: false, reason: 'unknown token' }; }
    const t = tick.exchangeTime ?? receivedAt;
    const s = st(tick.token);
    if (sealed || t >= sealAt) { counters.afterSeal++; return { counted: false, reason: 'after 09:20:00' }; }
    if (t < startAt) {
      // Before the open: remember the cumulative volume (pre-open auction) as the baseline.
      counters.beforeOpen++;
      if (tick.volume != null) { s.baselineVolume = tick.volume; s.baselineSource = 'pre-09:15 tick'; s.lastVolume = tick.volume; }
      s.preTick = tick;
      return { counted: false, reason: 'before 09:15:00' };
    }
    const key = `${t}|${tick.ltp}|${tick.volume}|${tick.buyQty}|${tick.sellQty}|${tick.oi}`;
    if (key === s.lastKey) { s.duplicates++; counters.duplicates++; return { counted: false, reason: 'duplicate' }; }
    s.lastKey = key;
    const inOrder = t >= s.lastTime;
    if (!inOrder) { s.outOfOrder++; counters.outOfOrder++; }
    s.ticks++;
    counters.counted++;
    const minute = Math.min(MINUTES - 1, Math.floor((t - startAt) / 60_000));

    // Price candles (sampled LTP).
    if (tick.ltp > 0) {
      const c = s.minutes[minute];
      if (!c) s.minutes[minute] = { o: tick.ltp, h: tick.ltp, l: tick.ltp, c: tick.ltp, firstT: t, lastT: t };
      else {
        c.h = Math.max(c.h, tick.ltp);
        c.l = Math.min(c.l, tick.ltp);
        if (t < c.firstT) { c.o = tick.ltp; c.firstT = t; }
        if (t >= c.lastT) { c.c = tick.ltp; c.lastT = t; }
      }
    }

    // Volume increments (stocks and futures).
    if (tick.volume != null && m.kind !== 'index') {
      if (s.lastVolume == null) {
        if (m.preOpenVolume != null && tick.volume >= m.preOpenVolume) {
          s.baselineVolume = m.preOpenVolume;
          s.baselineSource = 'NSE pre-open quantity';
          s.lastVolume = m.preOpenVolume;
        } else {
          s.baselineVolume = tick.volume;
          s.baselineSource = 'first window tick (estimated)';
          s.lastVolume = tick.volume;
        }
      }
      if (inOrder) {
        if (tick.volume < s.lastVolume) { s.resets++; s.lastVolume = tick.volume; }
        else {
          const inc = tick.volume - s.lastVolume;
          s.minuteVolume[minute] += inc;
          s.windowVolume += inc;
          s.lastVolume = tick.volume;
        }
      }
    }

    if (inOrder) {
      s.lastTime = t;
      s.last = { ...tick, t, receivedAt };
      s.firstInWindow ??= s.last;
      if (m.kind === 'future' && tick.oi != null) s.oiFirst ??= tick.oi;
      if (m.kind === 'stock') {
        if (tick.avgPrice > 0 && tick.ltp > 0) s.vwapSides.push(Math.sign(tick.ltp - tick.avgPrice));
        if (tick.depth) {
          const d = depthSummary(tick.depth);
          if (d.usable) s.depth.push({ t, spreadBps: d.spreadBps, imb5: d.imbalance5, imb3: d.imbalance3, imbBest: d.imbalanceBest, qty5: d.bidQty5 + d.askQty5, liquidity5: d.liquidity5 });
        }
      }
    }
    return { counted: true };
  }

  const indexMove = (symbol) => {
    for (const [token, m] of meta) {
      if (m.kind === 'index' && m.symbol === symbol) {
        const s = state.get(token);
        const last = s?.last;
        const open = last?.open || s?.minutes.find(Boolean)?.o;
        return last && open ? { symbol, open, ltp: last.ltp, pct: pct(last.ltp, open) } : null;
      }
    }
    return null;
  };

  function stockFeatures(token, m, at, market) {
    const s = state.get(token);
    const last = s?.last;
    const quality = {
      ticks: s?.ticks ?? 0, duplicates: s?.duplicates ?? 0, outOfOrder: s?.outOfOrder ?? 0, resets: s?.resets ?? 0,
      lastTickAgeSec: last ? Math.round((at - last.t) / 1000) : null,
      volumeBaseline: s?.baselineSource ?? null,
      depthSamples: s?.depth.length ?? 0,
    };
    quality.stale = !last || quality.lastTickAgeSec > STALE_TICK_SECONDS;
    quality.noDepth = !s?.depth.length;
    if (!last) return { symbol: m.symbol, token, kind: 'stock', sector: m.sector ?? null, quality, missing: ['no ticks in the window'] };

    const open = last.open || s.minutes.find(Boolean)?.o;
    const prevClose = m.prevClose ?? last.close ?? null;
    const orHigh = last.high || Math.max(...s.minutes.filter(Boolean).map((c) => c.h));
    const orLow = last.low || Math.min(...s.minutes.filter(Boolean).map((c) => c.l));
    const range = orHigh - orLow;
    const ltp = last.ltp;
    const body = range > 0 ? (Math.abs(ltp - open) / range) * 100 : null;
    const minuteCloses = s.minutes.map((c) => c?.c ?? null);
    const minuteReturns = minuteCloses.map((c, i) => {
      const prev = i === 0 ? open : minuteCloses.slice(0, i).filter((x) => x != null).at(-1);
      return c != null && prev ? pct(c, prev) : null;
    });
    const firstRate = (s.minuteVolume[0] + s.minuteVolume[1] + s.minuteVolume[2]) / 3;
    const lastRate = (s.minuteVolume[3] + s.minuteVolume[4]) / 2;
    const close2Ago = minuteCloses.slice(0, 3).filter((x) => x != null).at(-1) ?? open;
    const depthNow = last.depth ? depthSummary(last.depth) : null;
    const d = s.depth;
    const vwap = last.avgPrice || null;
    const crosses = s.vwapSides.filter((x, i, a) => i > 0 && x !== 0 && a[i - 1] !== 0 && x !== a[i - 1]).length;

    // F&O: the near-month future of this stock, if subscribed.
    let fo = null;
    for (const [ftoken, fm] of meta) {
      if (fm.kind !== 'future' || fm.underlying !== m.symbol) continue;
      const fs = state.get(ftoken);
      const fl = fs?.last;
      if (!fl) { fo = { symbol: fm.symbol, missing: 'no future ticks' }; break; }
      const baseOi = fm.prevOi ?? fs.oiFirst;
      const oiChange = fl.oi != null && baseOi != null ? fl.oi - baseOi : null;
      const futRet = pct(fl.ltp, fl.open || fs.minutes.find(Boolean)?.o);
      const oiChangePct = oiChange != null && baseOi ? (oiChange / baseOi) * 100 : null;
      fo = {
        symbol: fm.symbol, ltp: fl.ltp, volume: fs.windowVolume, oi: fl.oi ?? null,
        oiBaseline: fm.prevOi != null ? 'previous close (historical)' : fs.oiFirst != null ? 'first tick of the day' : null,
        oiChange, oiChangePct,
        premiumPct: pct(fl.ltp, ltp),
        retPct: futRet,
        agrees: futRet != null && pct(ltp, open) != null ? Math.sign(futRet) === Math.sign(pct(ltp, open)) : null,
        build: oiBuild(futRet, oiChangePct),
      };
      break;
    }

    const sector = m.sectorIndex ? indexMove(m.sectorIndex) : null;
    const ret5 = pct(ltp, open);
    return {
      symbol: m.symbol, token, kind: 'stock', sector: m.sector ?? null, status: m.status ?? null,
      prevClose, preOpenPrice: m.preOpenPrice ?? null, open, ltp,
      gapPct: pct(open, prevClose), ret5Pct: ret5,
      orHigh, orLow, orRangePct: pct(orHigh, orLow) != null && open ? (range / open) * 100 : null,
      closePos: range > 0 ? (ltp - orLow) / range : null,
      candles: s.minutes.map((c, i) => (c ? { minute: i, o: c.o, h: c.h, l: c.l, c: c.c, volume: s.minuteVolume[i], approximate: true } : null)),
      candle5: { o: open, h: orHigh, l: orLow, c: ltp, volume: s.windowVolume },
      bodyPct: body,
      upperWickPct: range > 0 ? ((orHigh - Math.max(open, ltp)) / range) * 100 : null,
      lowerWickPct: range > 0 ? ((Math.min(open, ltp) - orLow) / range) * 100 : null,
      minuteReturns, last2MinPct: pct(ltp, close2Ago),
      windowVolume: s.windowVolume, minuteVolume: [...s.minuteVolume],
      volumePerMinute: s.windowVolume / Math.max(1, Math.min(MINUTES, (Math.min(at, sealAt) - startAt) / 60_000)),
      rvol: m.openVol5Avg ? s.windowVolume / m.openVol5Avg : null,
      volAccel: firstRate > 0 ? lastRate / firstRate : null,
      avgVolume20: m.avgVolume ?? null,
      vwap, vwapSource: vwap ? 'Kite average traded price (day VWAP, incl. pre-open trade)' : null,
      vwapDistPct: pct(ltp, vwap), vwapCrosses: crosses,
      vwapReclaim: s.vwapSides.length > 1 ? s.vwapSides.slice(0, -1).some((x) => x < 0) && s.vwapSides.at(-1) > 0 : null,
      vwapReject: s.vwapSides.length > 1 ? s.vwapSides.slice(0, -1).some((x) => x > 0) && s.vwapSides.at(-1) < 0 : null,
      distPrevHighPct: pct(ltp, m.prevHigh), distPrevLowPct: pct(ltp, m.prevLow),
      atr14: m.atr14 ?? null, orRangeAtr: m.atr14 ? range / m.atr14 : null,
      upperCircuit: m.upperCircuit ?? null, lowerCircuit: m.lowerCircuit ?? null,
      totalBuyQty: last.buyQty ?? null, totalSellQty: last.sellQty ?? null,
      depth: depthNow?.usable ? {
        bestBid: depthNow.bestBid, bestAsk: depthNow.bestAsk, spread: depthNow.spread, spreadBps: depthNow.spreadBps,
        imbalanceBest: depthNow.imbalanceBest, imbalance3: depthNow.imbalance3, imbalance5: depthNow.imbalance5,
        bidQty5: depthNow.bidQty5, askQty5: depthNow.askQty5, liquidity5: depthNow.liquidity5, levels: depthNow.levels,
        spreadBpsMean: mean(d.map((x) => x.spreadBps)), spreadBpsStd: stdev(d.map((x) => x.spreadBps)),
        imbalance5Mean: mean(d.map((x) => x.imb5)),
        imbalanceChange: d.length > 1 ? d.at(-1).imb5 - d[0].imb5 : null,
        stability: d.length > 2 && mean(d.map((x) => x.qty5)) ? 1 - Math.min(1, stdev(d.map((x) => x.qty5)) / mean(d.map((x) => x.qty5))) : null,
        liquidityDropPct: d.length > 2 && median(d.map((x) => x.liquidity5)) ? pct(d.at(-1).liquidity5, median(d.map((x) => x.liquidity5))) : null,
        spreadAdjustedLiquidity: depthNow.liquidity5 / (1 + depthNow.spreadBps / 10),
        impactBuyBps: impactCost(last.depth, 1, impactNotional), impactSellBps: impactCost(last.depth, -1, impactNotional),
        impactNotional,
      } : null,
      fo,
      market: {
        nifty: market.nifty, bankNifty: market.bankNifty, sector,
        relVsNiftyPct: ret5 != null && market.nifty ? ret5 - market.nifty.pct : null,
        relVsSectorPct: ret5 != null && sector ? ret5 - sector.pct : null,
      },
      quality,
    };
  }

  /** All features at instant `at` (live view before the seal). */
  function snapshot(at) {
    if (sealed) return sealed;
    const market = { nifty: indexMove(marketIndices[0]), bankNifty: indexMove(marketIndices[1]) };
    const stocks = [];
    for (const [token, m] of meta) if (m.kind === 'stock') stocks.push(stockFeatures(token, m, at, market));
    const live = stocks.filter((x) => x.ltp != null);
    const breadth = {
      label: 'Tracked universe (the stocks subscribed here), not exchange-wide advance/decline',
      tracked: stocks.length, withTicks: live.length,
      abovePrevClosePct: live.length ? (live.filter((x) => x.prevClose && x.ltp > x.prevClose).length / live.length) * 100 : null,
      aboveVwapPct: live.filter((x) => x.vwap).length ? (live.filter((x) => x.vwap && x.ltp > x.vwap).length / live.filter((x) => x.vwap).length) * 100 : null,
    };
    const indices = [];
    for (const m of meta.values()) if (m.kind === 'index') { const mv = indexMove(m.symbol); if (mv) indices.push(mv); }
    return { date, at, sealed: false, market, indices, breadth, stocks, counters: { ...counters } };
  }

  /** Freeze the window. Later ticks never change the result. */
  function seal(at = sealAt) {
    if (sealed) return sealed;
    const snap = snapshot(Math.min(at, sealAt));
    sealed = { ...snap, sealed: true, sealedAt: new Date(at).toISOString(), windowEnd: new Date(sealAt).toISOString() };
    return sealed;
  }

  return { ingest, snapshot, seal, isSealed: () => Boolean(sealed), startAt, sealAt, counters: () => ({ ...counters }) };
}
