import { roundTripCharges } from './charges.js';
import { cleanRiskSettings, positionSize } from './risk.js';

/**
 * The 9:15 gap entry (PAPER): a market entry at 09:15 whose quantity, stop and
 * targets come from the gap. Pure functions only.
 *
 * There is no skip rule: the gap and the plan only make the quantity smaller.
 * The gap is measured in ATR (g = |open − previous close| ÷ ATR14):
 *   flat < 0.2 ≤ normal < 0.8 ≤ large < 1.5 ≤ extreme
 *
 * Stop distance S (long; mirrored for a short):
 *   flat / normal    max(0.35 ATR, entry − (PC + ½ gap − 0.1 ATR))   (just below the half-gap fill)
 *   large / extreme  0.5 ATR
 *   never more than 0.6 ATR
 * Targets: T1 = entry + 1 S (half exits, the stop goes to breakeven + costs).
 *   flat / normal    T2 = entry + min(2.5 S, 1.3 ATR − |gap|, previous high if the open is below it)
 *   large / extreme  no T2: the second half trails
 *   Both capped 3 ticks inside the circuit limit.
 * Size: risk budget × factor (gap type, near the circuit, weak reward/risk, ATR estimated),
 *   never below 0.25 of the budget and never under one share (or lot).
 *
 * Every number here is an untested starting point. Nothing promises that a
 * stop fills (a price can jump past it, or lock at a circuit) or that this makes money.
 */

export const GAP_TYPES = ['flat', 'normal', 'large', 'extreme'];

export const DEFAULT_GAP_EXIT_SETTINGS = {
  bands: { flat: 0.2, normal: 0.8, large: 1.5 }, // g thresholds (gap in ATR)
  sizeFactor: { flat: 1, normal: 1, large: 0.5, extreme: 0.25 },
  nearCircuitPct: 2, nearCircuitFactor: 0.5, // within 2% of the circuit on the trade's side
  weakRrFactor: 0.5, // fixed-target plan below risk.minRewardRisk
  minFactor: 0.25, // the combined factor never goes below this
  noiseAtr: 0.35, gapLineBufferAtr: 0.1, wideStopAtr: 0.5, maxStopAtr: 0.6,
  t1R: 1.0, t2R: 2.5, rangeAtr: 1.3, circuitTicks: 3,
  tightenBufferAtr: 0.05, timeStopAt: '09:45', timeStopR: 0.5,
  trail: '5min', // '5min': last completed 5-minute low − 1 tick; 'atr': best price − trailAtr × ATR
  trailAtr: 0.5,
  estimatedAtrPct: 2, // ATR used when there is none (labelled an estimate; size × 0.5)
};

const HHMM = /^(0\d|1[0-5]):[0-5]\d$/;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r2 = (n) => Math.round(n * 100) / 100;
const roundUp = (p, tick) => r2(Math.ceil(p / tick - 1e-9) * tick);
const roundDown = (p, tick) => r2(Math.floor(p / tick + 1e-9) * tick);

/** Settings merged over the defaults, every number clamped to a sane range. */
export function cleanGapExitSettings(input = {}) {
  const d = DEFAULT_GAP_EXIT_SETTINGS;
  const c = (v, dv, lo, hi) => Math.min(hi, Math.max(lo, num(v, dv)));
  const flat = c(input.bands?.flat, d.bands.flat, 0.01, 5);
  const normal = Math.max(flat, c(input.bands?.normal, d.bands.normal, 0.01, 10));
  const large = Math.max(normal, c(input.bands?.large, d.bands.large, 0.01, 20));
  return {
    bands: { flat, normal, large },
    sizeFactor: Object.fromEntries(GAP_TYPES.map((t) => [t, c(input.sizeFactor?.[t], d.sizeFactor[t], 0.05, 1)])),
    nearCircuitPct: c(input.nearCircuitPct, d.nearCircuitPct, 0, 20),
    nearCircuitFactor: c(input.nearCircuitFactor, d.nearCircuitFactor, 0.05, 1),
    weakRrFactor: c(input.weakRrFactor, d.weakRrFactor, 0.05, 1),
    minFactor: c(input.minFactor, d.minFactor, 0.05, 1),
    noiseAtr: c(input.noiseAtr, d.noiseAtr, 0.05, 3),
    gapLineBufferAtr: c(input.gapLineBufferAtr, d.gapLineBufferAtr, 0, 1),
    wideStopAtr: c(input.wideStopAtr, d.wideStopAtr, 0.05, 3),
    maxStopAtr: c(input.maxStopAtr, d.maxStopAtr, 0.05, 3),
    t1R: c(input.t1R, d.t1R, 0.25, 10),
    t2R: c(input.t2R, d.t2R, 0.5, 20),
    rangeAtr: c(input.rangeAtr, d.rangeAtr, 0.2, 5),
    circuitTicks: Math.round(c(input.circuitTicks, d.circuitTicks, 0, 50)),
    tightenBufferAtr: c(input.tightenBufferAtr, d.tightenBufferAtr, 0, 1),
    timeStopAt: HHMM.test(input.timeStopAt ?? '') && input.timeStopAt >= '09:21' && input.timeStopAt <= '15:00' ? input.timeStopAt : d.timeStopAt,
    timeStopR: c(input.timeStopR, d.timeStopR, 0, 5),
    trail: input.trail === 'atr' ? 'atr' : '5min',
    trailAtr: c(input.trailAtr, d.trailAtr, 0.05, 3),
    estimatedAtrPct: c(input.estimatedAtrPct, d.estimatedAtrPct, 0.2, 20),
  };
}

/** flat / normal / large / extreme for a gap of `g` ATR. */
export function gapType(g, bands = DEFAULT_GAP_EXIT_SETTINGS.bands) {
  if (g < bands.flat) return 'flat';
  if (g < bands.normal) return 'normal';
  if (g < bands.large) return 'large';
  return 'extreme';
}

const fmt = (n, d = 2) => Number(n).toFixed(d);

/**
 * Stop and targets for a direction `d` (1 long, −1 short) entered at `entry`.
 * Shared by the plan before the entry and the re-plan after the fill.
 */
function levelsFor({ d, entry, prevClose, open, atr, tick, upperCircuit, lowerCircuit, prevHigh, prevLow, type }, cfg) {
  const notes = [];
  const G = open - prevClose;
  const wide = type === 'large' || type === 'extreme';
  let gapLine = null;
  let S;
  if (wide) S = cfg.wideStopAtr * atr;
  else {
    gapLine = prevClose + 0.5 * G - d * cfg.gapLineBufferAtr * atr;
    S = Math.max(cfg.noiseAtr * atr, d * (entry - gapLine));
  }
  S = Math.min(S, cfg.maxStopAtr * atr);

  // Stop: rounded away from the entry, kept a tick inside the circuit.
  let sl = d > 0 ? roundDown(entry - S, tick) : roundUp(entry + S, tick);
  if (d > 0 && lowerCircuit > 0 && sl < lowerCircuit + tick) { sl = roundUp(lowerCircuit + tick, tick); notes.push(`stop clamped to one tick above the lower circuit ₹${lowerCircuit}`); }
  if (d < 0 && upperCircuit > 0 && sl > upperCircuit - tick) { sl = roundDown(upperCircuit - tick, tick); notes.push(`stop clamped to one tick below the upper circuit ₹${upperCircuit}`); }
  const stopDistance = r2(d * (entry - sl));

  // Targets: rounded towards the entry, capped inside the circuit on the trade's side.
  const limit = d > 0 ? upperCircuit : lowerCircuit;
  const cap = limit > 0 ? (d > 0 ? roundDown(limit - cfg.circuitTicks * tick, tick) : roundUp(limit + cfg.circuitTicks * tick, tick)) : null;
  const capped = (p) => (cap == null ? p : d > 0 ? Math.min(p, cap) : Math.max(p, cap));
  const toward = (p) => (d > 0 ? roundDown(p, tick) : roundUp(p, tick));
  let t1 = toward(capped(entry + d * cfg.t1R * S));
  if (cap != null && d * (entry + d * cfg.t1R * S - cap) > 0 && d * (t1 - entry) < 0.25 * S) notes.push(`upside capped by the ${d > 0 ? 'upper' : 'lower'} circuit ₹${limit}`);
  if (d * (t1 - entry) < tick) { t1 = r2(entry + d * tick); notes.push('no room before the circuit: target 1 is one tick away'); }

  let t2 = null;
  let room = null;
  if (!wide) {
    room = cfg.rangeAtr * atr - Math.abs(G);
    const candidates = [cfg.t2R * S, room];
    if (d > 0 && prevHigh > 0 && open < prevHigh && prevHigh > entry) candidates.push(prevHigh - entry);
    if (d < 0 && prevLow > 0 && open > prevLow && prevLow < entry) candidates.push(entry - prevLow);
    const t2Raw = toward(capped(entry + d * Math.min(...candidates)));
    if (d * (t2Raw - t1) > tick + 1e-9) t2 = t2Raw;
    else notes.push('no room for a fixed target 2: the second half trails');
  }
  return { S: r2(S), stopDistance, sl, t1, t2, trailSecondHalf: t2 == null, gapLine: gapLine != null ? r2(gapLine) : null, room: room != null ? r2(room) : null, notes };
}

/**
 * Reward/risk after costs for half at T1 and half at T2, the way `buildTradePlan` counts it
 * (utils/tradePlan.js): risk is the stop distance plus the round trip's charges at the stop.
 */
function rewardRiskOf({ d, entry, sl, t1, t2, qty }) {
  if (!(qty > 0) || t2 == null) return null;
  const side = d > 0 ? 'BUY' : 'SELL';
  const half = Math.floor(qty / 2);
  const gross = half * d * (t1 - entry) + (qty - half) * d * (t2 - entry);
  const avgExit = (half * t1 + (qty - half) * t2) / qty;
  const costs = roundTripCharges({ side, qty, entry, exit: avgExit, exitOrders: half ? 2 : 1 }).total;
  const stopCosts = roundTripCharges({ side, qty, entry, exit: sl }).total;
  const risk = qty * d * (entry - sl) + stopCosts;
  return risk > 0 ? r2((gross - costs) / risk) : null;
}

/**
 * The 9:15 plan for one stock, decided before the entry from the pre-open
 * (`entry` omitted: the open ± slippage as the estimate) or for a known fill.
 * `input`: { symbol, side: 'BUY'|'SELL', prevClose, open, entry?, atr, tick, lot,
 *            upperCircuit, lowerCircuit, prevHigh, prevLow, sources? }
 * Returns { ok, error?, side, direction, gapPct, g, type, factor, factorReasons, S, sl, t1, t2,
 *           trailSecondHalf, qty, firstExitQty, riskRs, rewardRisk, notes, sources, inputs }.
 */
export function gapExitPlan(input, settings = {}, riskSettings = {}, { availableMargin = null } = {}) {
  const cfg = cleanGapExitSettings(settings);
  const risk = cleanRiskSettings(riskSettings);
  const side = String(input.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const d = side === 'BUY' ? 1 : -1;
  const prevClose = Number(input.prevClose);
  const open = Number(input.open);
  if (!(prevClose > 0) || !(open > 0)) return { ok: false, symbol: input.symbol ?? null, side, error: 'no previous close or opening price for this stock' };
  const tick = input.tick > 0 ? Number(input.tick) : 0.05;
  const lot = input.lot > 1 ? Number(input.lot) : 1;
  const notes = [];
  const factorReasons = [];

  let atr = Number(input.atr);
  const atrEstimated = !(atr > 0);
  if (atrEstimated) atr = (prevClose * cfg.estimatedAtrPct) / 100;
  const slipRs = (open * risk.slippageBps) / 10_000;
  const estimatedEntry = !(input.entry > 0);
  const entry = estimatedEntry ? r2(open + d * slipRs) : Number(input.entry);

  const G = open - prevClose;
  const g = Math.abs(G) / atr;
  const type = gapType(g, cfg.bands);
  const lv = levelsFor({ d, entry, prevClose, open, atr, tick, upperCircuit: Number(input.upperCircuit) || 0, lowerCircuit: Number(input.lowerCircuit) || 0, prevHigh: Number(input.prevHigh) || 0, prevLow: Number(input.prevLow) || 0, type }, cfg);
  notes.push(...lv.notes);

  // Size factor: the gap type, then the cuts, never below the floor.
  let factor = cfg.sizeFactor[type];
  if (factor !== 1) factorReasons.push(`${type} gap ${fmt(g)} ATR: ×${cfg.sizeFactor[type]}`);
  const limit = d > 0 ? Number(input.upperCircuit) : Number(input.lowerCircuit);
  if (limit > 0) {
    const roomPct = (d * (limit - open) / open) * 100;
    if (roomPct < cfg.nearCircuitPct) { factor *= cfg.nearCircuitFactor; factorReasons.push(`within ${fmt(Math.max(0, roomPct), 1)}% of the ${d > 0 ? 'upper' : 'lower'} circuit: ×${cfg.nearCircuitFactor}`); }
  }
  if (atrEstimated) { factor *= 0.5; factorReasons.push(`ATR missing, estimated at ${cfg.estimatedAtrPct}% of the previous close: ×0.5`); }

  const sizeAt = (f) => {
    const s = positionSize({ entry, stop: entry - d * (lv.stopDistance + slipRs), lot, settings: { ...risk, riskPerTradePct: risk.riskPerTradePct * Math.max(f, cfg.minFactor) }, availableMargin });
    return s.qty;
  };
  // Weak reward/risk only cuts fixed-target plans; trailing plans already carry their gap factor.
  const rewardRisk = rewardRiskOf({ d, entry, sl: lv.sl, t1: lv.t1, t2: lv.t2, qty: Math.max(sizeAt(factor), lot) });
  if (rewardRisk != null && rewardRisk < risk.minRewardRisk) { factor *= cfg.weakRrFactor; factorReasons.push(`reward/risk after costs ${fmt(rewardRisk)} is below ${risk.minRewardRisk}: ×${cfg.weakRrFactor}`); }
  if (factor < cfg.minFactor) { factor = cfg.minFactor; factorReasons.push(`floor: ×${cfg.minFactor} of the risk budget`); }

  let qty = sizeAt(factor);
  if (qty < lot) { qty = lot; notes.push(lot > 1 ? 'minimum one lot' : 'minimum one share'); }
  const firstExitQty = qty > lot ? Math.floor(qty / 2 / lot) * lot || lot : qty;
  const riskRs = r2(qty * (lv.stopDistance + slipRs));
  if (estimatedEntry) notes.push(`entry estimated at the opening price ${d > 0 ? '+' : '−'} ${risk.slippageBps} bps slippage; levels are re-planned from the actual fill`);
  if (atrEstimated) notes.push('ATR is an estimate');

  return {
    ok: true, symbol: input.symbol ?? null, side, direction: d,
    prevClose, open, entry, estimatedEntry, atr: r2(atr), atrEstimated, tick, lot,
    gapPct: r2((G / prevClose) * 100), g: r2(g), type,
    factor: r2(factor), factorReasons, budgetRs: r2((risk.capital * risk.riskPerTradePct) / 100), riskRs,
    S: lv.S, stopDistance: lv.stopDistance, sl: lv.sl, t1: lv.t1, t2: lv.t2, trailSecondHalf: lv.trailSecondHalf,
    gapLine: lv.gapLine, room: lv.room, qty, firstExitQty, rewardRisk, notes,
    sources: input.sources ?? {},
    inputs: {
      symbol: input.symbol ?? null, side, prevClose, open, atr: r2(atr), atrEstimated, tick, lot,
      upperCircuit: Number(input.upperCircuit) || null, lowerCircuit: Number(input.lowerCircuit) || null,
      prevHigh: Number(input.prevHigh) || null, prevLow: Number(input.prevLow) || null,
    },
  };
}

/**
 * Levels again from the actual fill price; the quantity is already fixed.
 * Flags the trade when the actual risk is more than 1.5× the planned risk (it doesn't act on it).
 */
export function replanAfterFill(plan, fillPrice, settings = {}) {
  const cfg = cleanGapExitSettings(settings);
  const i = plan.inputs;
  const d = plan.direction;
  const lv = levelsFor({ d, entry: fillPrice, prevClose: i.prevClose, open: i.open, atr: i.atr, tick: i.tick, upperCircuit: i.upperCircuit || 0, lowerCircuit: i.lowerCircuit || 0, prevHigh: i.prevHigh || 0, prevLow: i.prevLow || 0, type: plan.type }, cfg);
  const riskRs = r2(plan.qty * lv.stopDistance);
  const riskFlag = plan.riskRs > 0 && riskRs > 1.5 * plan.riskRs;
  const notes = [...lv.notes];
  if (riskFlag) notes.push(`actual risk ₹${riskRs} is more than 1.5× the planned ₹${plan.riskRs} (the fill was away from the pre-open price)`);
  return {
    entry: fillPrice, S: lv.S, stopDistance: lv.stopDistance, sl: lv.sl, t1: lv.t1, t2: lv.t2, trailSecondHalf: lv.trailSecondHalf,
    riskRs, plannedRiskRs: plan.riskRs, riskFlag,
    rewardRisk: rewardRiskOf({ d, entry: fillPrice, sl: lv.sl, t1: lv.t1, t2: lv.t2, qty: plan.qty }),
    notes,
  };
}

/* ---------- Managing the trade after the entry (all ratchet: the stop never widens) ---------- */

/** `candidate` if it tightens the stop and stays on the right side of the market, else the current stop. */
export function ratchetStop(d, stop, candidate, touch) {
  if (!Number.isFinite(candidate)) return stop;
  const tighter = d > 0 ? candidate > stop : candidate < stop;
  const belowMarket = touch == null || (d > 0 ? candidate < touch : candidate > touch);
  return tighter && belowMarket ? candidate : stop;
}

/** Breakeven plus the round trip's per-share charges for the remaining quantity, rounded against the trade. */
export function breakevenStop({ d, avgEntry, qty, tick }) {
  const side = d > 0 ? 'BUY' : 'SELL';
  const perShare = qty > 0 ? roundTripCharges({ side, qty, entry: avgEntry, exit: avgEntry }).total / qty : 0;
  return d > 0 ? roundUp(avgEntry + perShare, tick) : roundDown(avgEntry - perShare, tick);
}

/**
 * The 09:20 check from the sealed opening range and VWAP (Kite's day low/high and
 * average traded price at the time). Returns { stop, failed, reason }.
 */
export function check0920({ d, stop, orLow, orHigh, vwap, ltp, open, atr, tick }, settings = {}) {
  const cfg = cleanGapExitSettings(settings);
  let next = stop;
  if (d > 0 && orLow > 0) next = ratchetStop(d, stop, roundDown(orLow - cfg.tightenBufferAtr * atr, tick), ltp);
  if (d < 0 && orHigh > 0) next = ratchetStop(d, stop, roundUp(orHigh + cfg.tightenBufferAtr * atr, tick), ltp);
  const failed = vwap > 0 && open > 0 && ltp > 0 && (d > 0 ? ltp < vwap && ltp < open : ltp > vwap && ltp > open);
  return { stop: next, failed, reason: failed ? `gap failed at 09:20: ${d > 0 ? 'below' : 'above'} VWAP ₹${vwap} and the open ₹${open}` : null };
}

/** At the time stop: exit when target 1 wasn't hit and the open profit is under timeStopR × S. */
export function timeStopDue({ d, avgEntry, touch, S, t1Done }, settings = {}) {
  const cfg = cleanGapExitSettings(settings);
  return !t1Done && d * (touch - avgEntry) < cfg.timeStopR * S;
}

export const BAR_MS = 5 * 60_000;

/**
 * Follow 5-minute bars from prices (IST 5-minute boundaries line up with UTC ones).
 * Returns the updated bar state and the bar that just completed, if any.
 */
export function updateBar(bar, price, at) {
  const start = Math.floor(at / BAR_MS) * BAR_MS;
  if (!bar || start > bar.start) return { bar: { start, high: price, low: price }, completed: bar ?? null };
  return { bar: { start: bar.start, high: Math.max(bar.high, price), low: Math.min(bar.low, price) }, completed: null };
}

/** Trailing-stop candidate for the second half: the completed 5-minute bar (− 1 tick), or best price − trailAtr × ATR. */
export function trailCandidate({ d, completedBar, best, atr, tick }, settings = {}) {
  const cfg = cleanGapExitSettings(settings);
  if (cfg.trail === 'atr') return best > 0 ? (d > 0 ? roundDown(best - cfg.trailAtr * atr, tick) : roundUp(best + cfg.trailAtr * atr, tick)) : null;
  if (!completedBar) return null;
  return d > 0 ? roundDown(completedBar.low - tick, tick) : roundUp(completedBar.high + tick, tick);
}

/* ---------- The gap list (which stocks get a 9:15 paper entry) ---------- */

export const MAX_GAP_LIST = 20;

/** { list: [{ symbol, side }], shadowScheduled } with valid NSE symbols, BUY/SELL, no repeats. */
export function cleanGapList(input = {}) {
  const seen = new Set();
  const list = (Array.isArray(input.list) ? input.list : [])
    .map((x) => ({ symbol: String(x?.symbol ?? '').trim().toUpperCase(), side: String(x?.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY' }))
    .filter((x) => /^[A-Z0-9&_-]{1,25}$/.test(x.symbol) && !seen.has(x.symbol) && seen.add(x.symbol))
    .slice(0, MAX_GAP_LIST);
  return { list, shadowScheduled: input.shadowScheduled === true };
}

/**
 * Today's gap entries: the saved list, plus (when on) a read-only paper shadow of each
 * scheduled MARKET order sent 09:15:00–09:15:59 on `date`. A shadow copies only the
 * symbol and side; the real order is never changed. `scheduled`: the scheduler's orders.
 */
export function gapEntriesFor(date, saved, scheduled = [], { from, to } = {}) {
  const { list, shadowScheduled } = cleanGapList(saved ?? {});
  const out = list.map((x) => ({ ...x, source: 'list' }));
  if (!shadowScheduled) return out;
  for (const o of scheduled) {
    const t = Date.parse(o.triggerAt);
    if (!(t >= from && t < to) || String(o.orderType).toUpperCase() !== 'MARKET' || ['cancelled', 'failed', 'missed'].includes(o.status)) continue;
    if (String(o.exchange ?? 'NSE').toUpperCase() !== 'NSE' || out.some((x) => x.symbol === o.symbol)) continue;
    out.push({ symbol: o.symbol, side: o.side === 'SELL' ? 'SELL' : 'BUY', source: `shadow of scheduled order ${o.id}` });
  }
  return out;
}

/* ---------- Report: gap-entry trades by gap type ---------- */

/** One row per closed gap-entry paper position (from the day ledgers). */
export function gapTradeRows(ledgers) {
  const rows = [];
  for (const l of ledgers) {
    for (const p of l.positions ?? []) {
      if (p.strategy !== 'gap915' || p.status !== 'CLOSED') continue;
      const plan = p.plan ?? {};
      const S = p.levels?.stopDistance ?? plan.stopDistance ?? null;
      const riskRs = S && p.entryQty ? S * p.entryQty : null;
      rows.push({
        date: l.date, symbol: p.symbol, side: p.side, type: plan.type ?? null, gapPct: plan.gapPct ?? null, g: plan.g ?? null,
        factor: plan.factor ?? null, qty: p.entryQty, entry: p.avgEntry,
        plannedEntry: plan.entry ?? null, sl: p.levels?.sl ?? plan.sl ?? null, t1: p.levels?.t1 ?? plan.t1 ?? null, t2: p.levels?.t2 ?? plan.t2 ?? null,
        exits: p.exits.map((x) => `${x.qty} @ ${x.price} (${x.reason})`).join('; '),
        lastExit: p.exits.at(-1)?.kind ?? null,
        gross: p.gross, charges: p.charges, net: p.net,
        r: riskRs ? r2(p.net / riskRs) : null,
        maeAtr: p.mae != null && plan.atr ? r2(p.mae / plan.atr) : null,
        mfeAtr: p.mfe != null && plan.atr ? r2(p.mfe / plan.atr) : null,
      });
    }
  }
  return rows;
}

/** Sheets for the Excel export (utils/exportStocks.js buildXlsx): the trades, and the summary by gap type. */
export function gapReportSheets(rows, summary) {
  const trades = [
    ['Date', 'Symbol', 'Side', 'Gap type', 'Gap %', 'Gap (ATR)', 'Size factor', 'Qty', 'Planned entry', 'Fill', 'Stop', 'T1', 'T2', 'Exits', 'Gross ₹', 'Charges ₹', 'Net ₹', 'R', 'Adverse (ATR)', 'Favourable (ATR)'],
    ...rows.map((r) => [r.date, r.symbol, r.side, r.type, r.gapPct, r.g, r.factor, r.qty, r.plannedEntry, r.entry, r.sl, r.t1, r.t2 ?? 'trail', r.exits, r.gross, r.charges, r.net, r.r, r.maeAtr, r.mfeAtr]),
  ];
  const byType = [
    ['Gap type', 'Trades', 'Wins', 'Win rate %', 'Average R', 'Net ₹', 'Average adverse (ATR)', 'Average favourable (ATR)'],
    ...summary.map((s) => [s.type, s.trades, s.wins, s.winRate, s.avgR, s.net, s.avgMaeAtr, s.avgMfeAtr]),
  ];
  return [{ name: 'Gap entries', rows: trades }, { name: 'By gap type', rows: byType }];
}

/** Trades, win rate, average R and average adverse/favourable excursion (in ATR) by gap type. */
export function gapSummary(rows) {
  const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return GAP_TYPES.map((type) => {
    const rs = rows.filter((r) => r.type === type);
    const val = (k) => rs.map((r) => r[k]).filter((v) => v != null);
    return {
      type, trades: rs.length, wins: rs.filter((r) => r.net > 0).length,
      winRate: rs.length ? r2((rs.filter((r) => r.net > 0).length / rs.length) * 100) : null,
      avgR: avg(val('r')), net: r2(rs.reduce((s, r) => s + (r.net ?? 0), 0)),
      avgMaeAtr: avg(val('maeAtr')), avgMfeAtr: avg(val('mfeAtr')),
    };
  });
}
