import { breakevenStop, check0920, cleanGapExitSettings, ratchetStop, timeStopDue, trailCandidate, updateBar } from './gapExits.js';
import { liveTag } from './liveOrders.js';

/**
 * LIVE exits for the user's own scheduled 09:15 market orders that opted in to them
 * (phase 2 of the 9:15 gap entry). Pure: the state and the decisions. The Kite calls,
 * timers and files are in core/gapLiveExits.js.
 *
 * Per position, after the entry fills (Kite's average price):
 *  - an SL-M rests at Kite for the filled quantity (so the position is protected even if
 *    this app stops); its trigger and quantity are modified as the trade goes on;
 *  - targets are not resting orders: when the touch reaches T1 (half) or T2 (the rest) the
 *    app first shrinks (or cancels) the SL-M, then sends a LIMIT IOC, then puts the stop
 *    back for whatever is left, so two exit orders can never both fill;
 *  - other exits (09:20 failure, time stop, square-off, kill) cancel the SL-M, confirm the
 *    cancellation in Kite's order book, then send a MARKET order; if the SL-M filled meanwhile,
 *    nothing more is sent.
 * Every order's tag is logged before it is sent ('placing'), so after an unknown outcome or a
 * restart the order book is searched by tag before anything is sent again.
 * Nothing here promises that a stop fills (an SL-M can fill below its trigger, or not at all at a circuit).
 */

export const ROLES = { entry: 'entry', stop: 'stop', target: 'target', exit: 'exit' };
const r2 = (n) => Math.round(n * 100) / 100;

export const liveEmpty = (date) => ({ date, positions: [], mismatches: [], events: 0 });

/** Apply one event (mutates and returns the state). */
export function applyLive(state, e) {
  state.events += 1;
  const p = e.id ? state.positions.find((x) => x.id === e.id) : null;
  switch (e.type) {
    case 'track':
      if (!state.positions.some((x) => x.id === e.position.id)) {
        state.positions.push({
          ...e.position, entry: { ...e.position.entry, filled: 0, avg: null, status: 'OPEN' }, levels: null, stop: null,
          qty: 0, exitedQty: 0, t1Done: false, exits: [], status: 'ENTRY', flags: [], seq: e.position.seq ?? 1, placing: [], check0920: null, timeChecked: false, trackedAt: e.at,
        });
      }
      break;
    case 'entry':
      if (p) { Object.assign(p.entry, { filled: e.filled, avg: e.avg, status: e.status, orderId: e.orderId ?? p.entry.orderId }); p.qty = Math.max(0, e.filled - p.exitedQty); if (p.status === 'ENTRY' && e.filled > 0) p.status = 'OPEN'; }
      break;
    case 'levels':
      if (p) p.levels = e.levels;
      break;
    case 'placing': // logged before the request leaves: the tag is what the order book is searched by afterwards
      if (p) { p.placing.push({ role: e.role, tag: e.tag, qty: e.qty, price: e.price ?? null, trigger: e.trigger ?? null, kind: e.kind ?? null, at: e.at }); p.seq += 1; }
      break;
    case 'placed':
      if (p) {
        p.placing = p.placing.filter((x) => x.tag !== e.tag);
        if (e.role === ROLES.stop) p.stop = { orderId: e.orderId, tag: e.tag, trigger: e.trigger, qty: e.qty, status: 'TRIGGER PENDING', reason: e.reason ?? null };
      }
      break;
    case 'place-failed':
      if (p) p.placing = p.placing.filter((x) => x.tag !== e.tag);
      break;
    case 'stop':
      if (p && p.stop) Object.assign(p.stop, Object.fromEntries(['trigger', 'qty', 'status', 'reason'].filter((k) => e[k] !== undefined).map((k) => [k, e[k]])));
      break;
    case 'exit':
      if (p && e.qty > 0) {
        p.exits.push({ qty: e.qty, price: e.price, code: e.code, reason: e.reason, orderId: e.orderId ?? null, at: e.at });
        p.exitedQty += e.qty;
        p.qty = Math.max(0, p.entry.filled - p.exitedQty);
        if (e.code === 't1') p.t1Done = true;
        if (p.qty === 0 && p.entry.status !== 'OPEN') { p.status = 'CLOSED'; p.closedAt = e.at; }
      }
      break;
    case 'check0920':
      if (p) p.check0920 = { orLow: e.orLow, orHigh: e.orHigh, vwap: e.vwap, ltp: e.ltp, open: e.open, failed: e.failed, source: e.source };
      break;
    case 'timecheck':
      if (p) p.timeChecked = true;
      break;
    case 'flag':
      if (p) { p.flags.push({ message: e.message, at: e.at }); if (e.halt) p.status = 'HALTED'; }
      break;
    case 'closed':
      if (p) { p.status = 'CLOSED'; p.closedAt = e.at; p.closeReason = e.reason; }
      break;
    case 'mismatch':
      state.mismatches.push({ id: e.id ?? null, message: e.message, at: e.at });
      break;
    default:
      break;
  }
  return state;
}

export const rebuildLive = (date, events) => events.reduce(applyLive, liveEmpty(date));

/**
 * The next unique tag for a role of this position (alphanumeric, ≤ 20 characters). The sequence starts at the
 * scheduled order's number × 100 + 1, so two positions in the same stock on one day never share a tag.
 */
export const nextTag = (state, p, role) => liveTag(state.date, p.symbol, role, p.seq);

/** Order-book rows by order id and by tag. */
export function indexBook(book) {
  const byId = new Map();
  const byTag = new Map();
  for (const o of book ?? []) {
    if (o.order_id) byId.set(String(o.order_id), o);
    if (o.tag) byTag.set(o.tag, o);
  }
  return { byId, byTag };
}

const touchOf = (p, tick) => {
  const side = p.d > 0 ? 'buy' : 'sell';
  const lvl = (tick.depth?.[side] ?? []).find((l) => l.price > 0 && l.qty > 0);
  return lvl?.price ?? (tick.ltp > 0 ? tick.ltp : null);
};

/**
 * What to do on this tick, or null. Only for an OPEN position whose SL-M is resting and with
 * nothing in flight. `times`: { checkAt, timeStopAt, squareOffAt } (ms). `track`: the
 * position's in-memory bar/best (updated here).
 */
export function nextLiveAction(p, tick, at, settings, times, track = {}) {
  if (p.status !== 'OPEN' || !p.stop || p.stop.status !== 'TRIGGER PENDING' || p.qty <= 0 || p.placing.length) return null;
  const cfg = cleanGapExitSettings(settings);
  const lv = p.levels;
  if (!lv) return null;
  const touch = touchOf(p, tick);
  if (touch == null) return null;
  const d = p.d;
  if (times.squareOffAt != null && at >= times.squareOffAt) return { type: 'exit', code: 'square-off', reason: 'square-off time' };
  if (!p.check0920 && at >= times.checkAt && at < times.timeStopAt) {
    const c = check0920({ d, stop: p.stop.trigger, orLow: tick.low, orHigh: tick.high, vwap: tick.avgPrice, ltp: tick.ltp, open: tick.open || p.plan?.open, atr: p.plan.atr, tick: p.tick }, cfg);
    return { type: 'check0920', check: c, values: { orLow: tick.low ?? null, orHigh: tick.high ?? null, vwap: tick.avgPrice ?? null, ltp: tick.ltp ?? null, open: tick.open || p.plan?.open || null }, source: 'Kite day high/low and average price, first tick after 09:20' };
  }
  if (!p.t1Done && (d > 0 ? touch >= lv.t1 : touch <= lv.t1)) {
    const half = p.qty > p.lot ? Math.floor(p.qty / 2 / p.lot) * p.lot || p.lot : p.qty;
    return { type: 'target', code: 't1', qty: half, price: lv.t1 };
  }
  if (p.t1Done && lv.t2 != null && (d > 0 ? touch >= lv.t2 : touch <= lv.t2)) return { type: 'target', code: 't2', qty: p.qty, price: lv.t2 };
  if (!p.timeChecked && at >= times.timeStopAt) {
    const due = timeStopDue({ d, avgEntry: p.entry.avg, touch, S: lv.stopDistance, t1Done: p.t1Done }, cfg);
    return { type: 'timecheck', due };
  }
  const price = tick.ltp > 0 ? tick.ltp : touch;
  const { bar, completed } = updateBar(track.bar, price, at);
  track.bar = bar;
  track.best = track.best == null ? price : d > 0 ? Math.max(track.best, price) : Math.min(track.best, price);
  if (p.t1Done && lv.t2 == null) {
    const cand = trailCandidate({ d, completedBar: completed, best: track.best, atr: p.plan.atr, tick: p.tick }, cfg);
    const next = cand == null ? p.stop.trigger : ratchetStop(d, p.stop.trigger, cand, touch);
    if (next !== p.stop.trigger) return { type: 'move-stop', trigger: next, reason: `trail (${cfg.trail === 'atr' ? `${cfg.trailAtr} ATR from the best price` : 'last 5-minute bar, approximate: built from ticks'})` };
  }
  return null;
}

/** The 09:20 check from the sealed window for one live position. */
export function sealedLiveCheck(p, s, settings) {
  const cfg = cleanGapExitSettings(settings);
  const c = check0920({ d: p.d, stop: p.stop.trigger, orLow: s.orLow, orHigh: s.orHigh, vwap: s.vwap, ltp: s.ltp, open: s.open || p.plan?.open, atr: p.plan.atr, tick: p.tick }, cfg);
  return { type: 'check0920', check: c, values: { orLow: s.orLow, orHigh: s.orHigh, vwap: s.vwap, ltp: s.ltp, open: s.open }, source: 'sealed 09:15–09:20 window' };
}

/** The SL-M trigger after target 1: breakeven plus the round trip's costs, never looser than the current stop. */
export const stopAfterT1 = (p) => ratchetStop(p.d, p.stop?.trigger ?? p.levels.sl, breakevenStop({ d: p.d, avgEntry: p.entry.avg, qty: p.qty, tick: p.tick }), null);

/** Net quantity the app expects in Kite's MIS position for a symbol (open positions only). */
export const expectedNet = (state, symbol) => state.positions.filter((p) => p.symbol === symbol && p.status !== 'CLOSED').reduce((s, p) => s + p.d * p.qty, 0)
  + state.positions.filter((p) => p.symbol === symbol && p.status === 'CLOSED').reduce((s, p) => s + p.d * Math.max(0, p.entry.filled - p.exitedQty), 0);

export { r2 };
