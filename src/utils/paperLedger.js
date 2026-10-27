import { istInstant } from '../core/calendar.js';
import { intradayCharges } from './charges.js';
import { breakevenStop, check0920, cleanGapExitSettings, ratchetStop, replanAfterFill, timeStopDue, trailCandidate, updateBar } from './gapExits.js';
import { cleanRiskSettings } from './risk.js';

/**
 * The paper-trading ledger, event-sourced and pure. Every change is an event;
 * the state is `events.reduce(applyEvent, emptyLedger(date))`, so the
 * append-only log alone can rebuild (and reconcile) the day after a restart.
 *
 * Simulated fills (stepTick), never at the last traded price:
 *  - Entry (stop-style): triggers when the last traded price crosses the trigger,
 *    as an exchange stop order would; it then fills against the opposite side of
 *    the five-level book (the asks for a buy) plus `slippageBps`, level by level,
 *    only at prices within `maxEntry`. Book quantity limits the fill: the rest
 *    stays open (a partial fill) until it fills or the entry window ends.
 *    Immediate entries (momentum) fill the same way on the first tick after 09:20.
 *    Like a stop-loss limit order, a triggered entry whose book is beyond
 *    `maxEntry` waits for the price to come back, until the entry window ends.
 *    The daily-loss and losing-streak limits are checked again at the trigger;
 *    if hit, the entry is rejected.
 *  - Stop: when the bid (ask, for a short) reaches the stop, the whole position
 *    exits at that bid minus slippage, which can be worse than the stop price.
 *  - Targets: resting limit orders, filled at the target when the bid (ask) reaches
 *    it. Half exits at target 1 and the stop moves to the entry price; the rest
 *    exits at target 2.
 *  - Square-off at `squareOffAt`, the kill switch, and "square off all" exit at
 *    the touch minus slippage.
 * None of this means a real stop or target would fill at that price.
 *
 * The 9:15 gap entry (strategy `gap915`, utils/gapExits.js) shares the ledger:
 *  - Entry: a market order active from 09:15:00, filled on the first tick at or after
 *    then against the opposite side of the book plus slippage, with no price limit and
 *    no score or risk-limit check (it always enters). Its levels are re-planned from the
 *    fill (a `levels` event).
 *  - Exits: the stop (bid minus slippage), half at T1 then the stop to breakeven plus
 *    costs, T2 or a trailing stop for the rest, the 09:20 check (tighten to the opening
 *    range; exit if below VWAP and the open), the time stop, square-off and kill switch.
 *  - It doesn't use the 09:20 slots (open positions, trades a day) or the losing streak;
 *    its P&L counts towards the daily loss (one capital), and is also totalled in `gap`.
 *  - The 5-minute bar and the adverse/favourable excursion are followed per tick on the
 *    position without events: after a restart they start again from the next tick.
 */

export const GAP_STRATEGY = 'gap915';
const emptyGap = () => ({ realised: 0, charges: 0, trades: 0, wins: 0, losses: 0 });

export const emptyLedger = (date, ledger = 'day') => ({
  date, ledger, mode: 'PAPER', killSwitch: false, closingAll: null, decidedAt: null, decision: null,
  orders: [], positions: [], realised: 0, charges: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, events: 0,
  gap: emptyGap(),
});

const r2 = (n) => Math.round(n * 100) / 100;
const time = (at) => (typeof at === 'number' ? at : Date.parse(at));

function closePosition(state, p, at) {
  const entrySide = p.direction > 0 ? 'BUY' : 'SELL';
  const exitSide = p.direction > 0 ? 'SELL' : 'BUY';
  const exitValue = p.exits.reduce((s, x) => s + x.qty * x.price, 0);
  const gross = p.direction * (exitValue - p.entryValue);
  const charges = intradayCharges([{ side: entrySide, value: p.entryValue }, ...p.exits.map((x) => ({ side: exitSide, value: x.qty * x.price }))]);
  p.status = 'CLOSED';
  p.closedAt = at;
  p.gross = r2(gross);
  p.charges = charges.total;
  p.net = r2(gross - charges.total);
  state.realised = r2(state.realised + p.net);
  state.charges = r2(state.charges + charges.total);
  if (p.strategy === GAP_STRATEGY) {
    const g = (state.gap ??= emptyGap());
    g.realised = r2(g.realised + p.net);
    g.charges = r2(g.charges + charges.total);
    if (p.net < 0) { g.losses += 1; state.losses += 1; } else { g.wins += 1; state.wins += 1; }
    return;
  }
  if (p.net < 0) { state.losses += 1; state.consecutiveLosses += 1; } else { state.wins += 1; state.consecutiveLosses = 0; }
}

/** Apply one event to the state (mutates and returns it). Unknown or duplicate events change nothing. */
export function applyEvent(state, e) {
  state.events += 1;
  const order = e.orderId ? state.orders.find((o) => o.id === e.orderId) : null;
  const pos = e.positionId ? state.positions.find((p) => p.id === e.positionId) : null;
  switch (e.type) {
    case 'decided':
      if (!state.decidedAt) { state.decidedAt = e.at; state.decision = { rows: e.rows ?? [], gapReport: e.gapReport ?? [], blockers: e.blockers ?? [], partial: Boolean(e.partial) }; }
      break;
    case 'order':
      if (!state.orders.some((o) => o.id === e.order.id)) state.orders.push({ ...e.order, status: 'PENDING', open: true, filledQty: 0, avgPrice: null, createdAt: e.at, reason: null });
      break;
    case 'triggered':
      if (order?.open && order.status === 'PENDING') { order.status = 'TRIGGERED'; order.triggeredAt = e.at; }
      break;
    case 'fill': {
      if (!order?.open) break;
      const qty = Math.min(e.qty, order.qty - order.filledQty);
      if (qty <= 0) break;
      order.avgPrice = r2(((order.avgPrice ?? 0) * order.filledQty + e.price * qty) / (order.filledQty + qty));
      order.filledQty += qty;
      order.status = order.filledQty >= order.qty ? 'FILLED' : 'PARTIAL';
      if (order.filledQty >= order.qty) order.open = false;
      let p = state.positions.find((x) => x.id === order.id);
      if (!p) {
        p = {
          id: order.id, symbol: order.symbol, token: order.token, side: order.side, direction: order.direction, strategy: order.strategy,
          qty: 0, entryQty: 0, avgEntry: null, entryValue: 0, stop: order.stop, target1: order.target1, target2: order.target2,
          t1Done: false, exits: [], status: 'OPEN', openedAt: e.at,
          ...(order.plan ? { plan: order.plan, levels: null } : {}),
        };
        state.positions.push(p);
        state.trades += 1;
        if (order.strategy === GAP_STRATEGY) (state.gap ??= emptyGap()).trades += 1;
      }
      p.entryValue = r2(p.entryValue + qty * e.price);
      p.entryQty += qty;
      p.qty += qty;
      p.avgEntry = r2(p.entryValue / p.entryQty);
      break;
    }
    case 'reject':
      if (order?.open) { order.open = false; order.status = order.filledQty ? 'PARTIAL' : 'REJECTED'; order.reason = e.reason; }
      break;
    case 'cancel':
      if (order?.open) { order.open = false; order.status = order.filledQty ? 'PARTIAL' : e.expired ? 'EXPIRED' : 'CANCELLED'; order.reason = e.reason; }
      break;
    case 'exit': {
      if (!pos || pos.status !== 'OPEN') break;
      const qty = Math.min(e.qty, pos.qty);
      if (qty <= 0) break;
      pos.exits.push({ qty, price: e.price, reason: e.reason, kind: e.kind, at: e.at });
      if (e.mae != null) pos.mae = e.mae;
      if (e.mfe != null) pos.mfe = e.mfe;
      pos.qty -= qty;
      if (e.kind === 'target1') pos.t1Done = true;
      if (pos.qty === 0) closePosition(state, pos, e.at);
      break;
    }
    case 'stop':
      if (pos?.status === 'OPEN') { pos.stop = e.stop; pos.stopReason = e.reason; }
      break;
    case 'levels': // a gap entry's levels re-planned from its fill (before any exit)
      if (pos?.status === 'OPEN' && !pos.exits.length) { pos.stop = e.levels.sl; pos.target1 = e.levels.t1; pos.target2 = e.levels.t2; pos.levels = e.levels; }
      break;
    case 'check0920':
      if (pos?.status === 'OPEN') pos.check0920 = { orLow: e.orLow, orHigh: e.orHigh, vwap: e.vwap, ltp: e.ltp, open: e.open, failed: e.failed };
      break;
    case 'timecheck':
      if (pos?.status === 'OPEN') pos.timeChecked = true;
      break;
    case 'kill':
      state.killSwitch = Boolean(e.on);
      state.closingAll = e.on ? e.reason ?? 'kill switch' : null;
      break;
    case 'close-all':
      state.closingAll = e.reason ?? 'square off all';
      break;
    default:
      break;
  }
  return state;
}

export const rebuildLedger = (date, events, ledger = 'day') => events.reduce(applyEvent, emptyLedger(date, ledger));

/**
 * Day figures for the risk checks (utils/risk.js tradeBlockers). Gap entries don't use the
 * 09:20 slots (open positions, trades a day); their P&L does count towards the daily loss.
 */
export const ledgerDay = (state) => {
  const slot = (x) => x.strategy !== GAP_STRATEGY;
  return {
    killSwitch: state.killSwitch, realised: state.realised, trades: state.trades - (state.gap?.trades ?? 0), consecutiveLosses: state.consecutiveLosses,
    open: state.positions.filter((p) => slot(p) && p.status === 'OPEN').length + state.orders.filter((o) => slot(o) && o.open && !state.positions.some((p) => p.id === o.id)).length,
  };
};

/**
 * Market orders for the 9:15 gap entries (plans from utils/gapExits.js), active from
 * `activeFrom` (09:15:00). Ids are per day and symbol, so a restart can't place one twice.
 */
export function gapOrderEvents(state, entries, { at, activeFrom, expiresAt, tagPrefix = 'P915' } = {}) {
  const events = [];
  for (const { symbol, token, plan, source = 'list' } of entries) {
    if (!plan?.ok || !(plan.qty > 0)) continue;
    const id = `${state.date}-${symbol}-${GAP_STRATEGY}`;
    if (state.orders.some((o) => o.id === id) || events.some((e) => e.order.id === id)) continue;
    events.push({
      type: 'order', at,
      order: {
        id, tag: `${tagPrefix}${symbol}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20), symbol, token,
        side: plan.side, direction: plan.direction, strategy: GAP_STRATEGY, product: 'MIS', qty: plan.qty, firstExitQty: plan.firstExitQty,
        market: true, immediate: true, activeFrom, trigger: null, maxEntry: null,
        stop: plan.sl, target1: plan.t1, target2: plan.t2, plan, source, expiresAt,
      },
    });
  }
  return events;
}

/** Orders for today's BUY/SELL decisions; ids are per day, symbol and strategy, so a restart can't place one twice. */
export function orderEvents(state, decision, { at, entryUntilAt, tagPrefix = 'P920' } = {}) {
  const events = [];
  for (const d of decision.decisions ?? []) {
    if (d.decision !== 'BUY' && d.decision !== 'SELL') continue;
    const id = `${state.date}-${d.symbol}-${d.strategy}`;
    if (state.orders.some((o) => o.id === id)) continue;
    const p = d.plan;
    events.push({
      type: 'order', at,
      order: {
        id, tag: `${tagPrefix}${d.symbol}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 20), symbol: d.symbol, token: d.token,
        side: p.side, direction: p.direction, strategy: d.strategy, product: 'MIS', qty: p.qty, firstExitQty: p.firstExitQty,
        trigger: p.trigger, maxEntry: p.maxEntry, stop: p.stop, target1: p.target1, target2: p.target2, immediate: p.immediate,
        score: d.score, expiresAt: entryUntilAt,
      },
    });
  }
  return events;
}

const levels = (tick, side) => (tick.depth?.[side] ?? []).filter((l) => l.price > 0 && l.qty > 0);

/**
 * The events one tick causes. They are applied to `state` as they happen (later
 * checks see earlier fills) and returned for the log. `at` is the tick's exchange
 * time (ms); `squareOffAt` the square-off instant (ms) for the ledger's day.
 */
export function stepTick(state, tick, at, risk, { squareOffAt = null, gap = {} } = {}) {
  const s = cleanRiskSettings(risk);
  const slip = s.slippageBps / 10_000;
  const events = [];
  const emit = (e) => { events.push({ at, ...e }); applyEvent(state, events.at(-1)); };
  const iso = new Date(at).toISOString();

  for (const o of state.orders.filter((x) => x.open && x.token === tick.token)) {
    if (o.market && o.activeFrom && at < time(o.activeFrom)) continue; // 9:15 market entry: not before 09:15:00
    if (state.killSwitch || state.closingAll) { emit({ type: 'cancel', orderId: o.id, reason: state.closingAll ?? 'kill switch', at: iso }); continue; }
    if (o.expiresAt && at >= time(o.expiresAt)) {
      const why = o.market ? (o.filledQty ? 'rest not filled by the end of the entry window' : 'not filled by the end of the entry window: no opposite side on the book (locked at a circuit?)')
        : o.filledQty ? 'rest not filled by the end of the entry window' : 'not triggered by the end of the entry window';
      emit({ type: 'cancel', orderId: o.id, expired: true, reason: why, at: iso });
      continue;
    }
    const up = o.direction > 0;
    if (o.market) {
      // Market entry: walk the opposite side of the book plus slippage, no price limit; the rest waits for the next book.
      const book = levels(tick, up ? 'sell' : 'buy');
      if (!book.length) continue;
      if (o.status === 'PENDING') emit({ type: 'triggered', orderId: o.id, at: iso });
      let remaining = o.qty - o.filledQty;
      let qty = 0;
      let value = 0;
      let used = 0;
      for (const l of book) {
        const take = Math.min(remaining, l.qty);
        qty += take; value += take * r2(up ? l.price * (1 + slip) : l.price * (1 - slip)); remaining -= take; used += 1;
        if (!remaining) break;
      }
      if (!qty) continue;
      emit({ type: 'fill', orderId: o.id, qty, price: r2(value / qty), levels: used, at: iso });
      const p = state.positions.find((x) => x.id === o.id);
      if (p?.plan && !p.exits.length) emit({ type: 'levels', positionId: p.id, levels: replanAfterFill(p.plan, p.avgEntry, gap.settings), at: iso });
      continue;
    }
    if (o.status === 'PENDING') {
      const crossed = o.immediate || (tick.ltp != null && (up ? tick.ltp >= o.trigger : tick.ltp <= o.trigger));
      if (!crossed) continue;
      // Risk limits are checked again when the entry triggers (an earlier trade may have hit them).
      const limitHit = state.realised <= -(s.capital * s.dailyLossPct) / 100 ? 'daily loss limit reached'
        : state.consecutiveLosses >= s.maxConsecutiveLosses ? `${state.consecutiveLosses} losses in a row` : null;
      if (limitHit) { emit({ type: 'reject', orderId: o.id, reason: `${limitHit}: entry not taken`, at: iso }); continue; }
      emit({ type: 'triggered', orderId: o.id, at: iso });
    }
    // Fill against the book: asks for a buy, bids for a sell, plus slippage, within maxEntry.
    const book = levels(tick, up ? 'sell' : 'buy');
    if (!book.length) continue; // no counterparty on this tick (e.g. locked at a circuit)
    let remaining = o.qty - o.filledQty;
    let qty = 0;
    let value = 0;
    let used = 0;
    for (const l of book) {
      const price = r2(up ? l.price * (1 + slip) : l.price * (1 - slip));
      if (up ? price > o.maxEntry : price < o.maxEntry) break;
      const take = Math.min(remaining, l.qty);
      qty += take; value += take * price; remaining -= take; used += 1;
      if (!remaining) break;
    }
    // Nothing within the limit: like a stop-loss limit order, it waits (until the entry window ends).
    if (qty) emit({ type: 'fill', orderId: o.id, qty, price: r2(value / qty), levels: used, at: iso });
  }

  for (const p of state.positions.filter((x) => x.status === 'OPEN' && x.token === tick.token)) {
    const up = p.direction > 0;
    const touch = levels(tick, up ? 'buy' : 'sell')[0]?.price;
    if (!touch) continue;
    const market = r2(up ? touch * (1 - slip) : touch * (1 + slip));
    const order = state.orders.find((o) => o.id === p.id);
    if (p.strategy === GAP_STRATEGY) {
      // Adverse / favourable excursion from the entry (per share, at the touch), followed without events.
      const move = p.direction * (touch - p.avgEntry);
      p.mae = r2(Math.max(p.mae ?? 0, -move));
      p.mfe = r2(Math.max(p.mfe ?? 0, move));
    }
    const exitAll = (kind, reason) => {
      if (order?.open) emit({ type: 'cancel', orderId: order.id, reason: `position closed (${reason})`, at: iso });
      emit({ type: 'exit', positionId: p.id, qty: p.qty, price: market, kind, reason, at: iso, ...(p.mae != null ? { mae: p.mae, mfe: p.mfe } : {}) });
    };
    if (state.killSwitch || state.closingAll) { exitAll(state.killSwitch ? 'kill' : 'close-all', state.closingAll ?? 'kill switch'); continue; }
    if (squareOffAt != null && at >= squareOffAt) { exitAll('squareoff', `square-off at ${s.squareOffAt}`); continue; }
    if (p.strategy === GAP_STRATEGY) { stepGap(state, p, tick, at, { touch, exitAll, emit, iso, gap }); continue; }
    if (up ? touch <= p.stop : touch >= p.stop) { exitAll('stop', p.t1Done ? 'breakeven stop' : 'stop loss'); continue; }
    if (!p.t1Done && (up ? touch >= p.target1 : touch <= p.target1)) {
      const half = p.qty > 1 ? Math.floor(p.qty / 2) : p.qty;
      emit({ type: 'exit', positionId: p.id, qty: half, price: p.target1, kind: 'target1', reason: 'target 1', at: iso });
      if (p.status === 'OPEN') emit({ type: 'stop', positionId: p.id, stop: p.avgEntry, reason: 'moved to the entry price after target 1', at: iso });
      continue;
    }
    if (p.t1Done && (up ? touch >= p.target2 : touch <= p.target2)) {
      if (order?.open) emit({ type: 'cancel', orderId: order.id, reason: 'position closed (target 2)', at: iso });
      emit({ type: 'exit', positionId: p.id, qty: p.qty, price: p.target2, kind: 'target2', reason: 'target 2', at: iso });
    }
  }
  return events;
}

/**
 * One tick for an open gap-entry position (after the kill switch and square-off checks).
 * `gap`: { settings, checkAt (09:20 instant, ms), timeStopAt (ms) }; both default from the ledger's date.
 */
function stepGap(state, p, tick, at, { touch, exitAll, emit, iso, gap }) {
  const cfg = cleanGapExitSettings(gap.settings);
  const d = p.direction;
  const lv = p.levels ?? p.plan ?? {};
  const atr = p.plan?.atr ?? 0;
  const ptick = p.plan?.tick ?? 0.05;
  const S = lv.stopDistance ?? lv.S ?? 0;
  const checkAt = gap.checkAt ?? +istInstant(state.date, '09:20');
  const timeStopAt = gap.timeStopAt ?? +istInstant(state.date, cfg.timeStopAt);
  const withExc = (e) => ({ ...e, mae: p.mae, mfe: p.mfe });

  // 1. The stop (initial, tightened, breakeven or trailing): exits at the bid minus slippage.
  if (d > 0 ? touch <= p.stop : touch >= p.stop) {
    const trailing = p.stopReason?.startsWith('trail');
    exitAll(trailing ? 'trail' : 'stop', trailing ? 'trailing stop' : p.t1Done ? 'breakeven stop' : 'stop loss');
    return;
  }

  // 2. The 09:20 check, once: tighten to the opening range; exit if below VWAP and the open.
  if (!p.check0920 && at >= checkAt && at < timeStopAt) {
    const c = check0920({ d, stop: p.stop, orLow: tick.low, orHigh: tick.high, vwap: tick.avgPrice, ltp: tick.ltp, open: tick.open || p.plan?.open, atr, tick: ptick }, cfg);
    emit({ type: 'check0920', positionId: p.id, orLow: tick.low ?? null, orHigh: tick.high ?? null, vwap: tick.avgPrice ?? null, ltp: tick.ltp ?? null, open: tick.open || p.plan?.open || null, failed: c.failed, at: iso });
    if (c.failed) { exitAll('gap-failed', c.reason); return; }
    if (c.stop !== p.stop) emit({ type: 'stop', positionId: p.id, stop: c.stop, reason: 'tightened to the opening range at 09:20', at: iso });
  }

  // 3. Target 1: half exits at the target; the stop goes to breakeven plus costs.
  if (!p.t1Done && (d > 0 ? touch >= p.target1 : touch <= p.target1)) {
    const half = p.qty > 1 ? Math.floor(p.qty / 2) : p.qty;
    emit(withExc({ type: 'exit', positionId: p.id, qty: half, price: p.target1, kind: 'target1', reason: 'target 1', at: iso }));
    if (p.status === 'OPEN') {
      const be = breakevenStop({ d, avgEntry: p.avgEntry, qty: p.qty, tick: ptick });
      const next = ratchetStop(d, p.stop, be, null);
      if (next !== p.stop) emit({ type: 'stop', positionId: p.id, stop: next, reason: 'breakeven plus costs after target 1', at: iso });
    }
    return;
  }

  // 4. Target 2 (fixed-target plans).
  if (p.t1Done && p.target2 != null && (d > 0 ? touch >= p.target2 : touch <= p.target2)) {
    emit(withExc({ type: 'exit', positionId: p.id, qty: p.qty, price: p.target2, kind: 'target2', reason: 'target 2', at: iso }));
    return;
  }

  // 5. The time stop, checked once at its time.
  if (!p.timeChecked && at >= timeStopAt) {
    emit({ type: 'timecheck', positionId: p.id, at: iso });
    if (timeStopDue({ d, avgEntry: p.avgEntry, touch, S, t1Done: p.t1Done }, cfg)) { exitAll('time-stop', `time stop at ${cfg.timeStopAt}: under ${cfg.timeStopR} R and target 1 not hit`); return; }
  }

  // 6. Trail the second half (no fixed target 2): ratchet only, never through the market.
  const price = tick.ltp > 0 ? tick.ltp : touch;
  const { bar, completed } = updateBar(p.bar, price, at);
  p.bar = bar;
  p.best = p.best == null ? price : d > 0 ? Math.max(p.best, price) : Math.min(p.best, price);
  if (p.t1Done && p.target2 == null) {
    const cand = trailCandidate({ d, completedBar: completed, best: p.best, atr, tick: ptick }, cfg);
    const next = cand == null ? p.stop : ratchetStop(d, p.stop, cand, touch);
    if (next !== p.stop) emit({ type: 'stop', positionId: p.id, stop: next, reason: `trail (${cfg.trail === 'atr' ? `${cfg.trailAtr} ATR from the best price` : 'last 5-minute bar, approximate: built from ticks'})`, at: iso });
  }
}

/** Unrealised P&L of the open positions at the latest bid/ask (not the last traded price). */
export function markToMarket(state, lastTicks) {
  let total = 0;
  const rows = state.positions.filter((p) => p.status === 'OPEN').map((p) => {
    const t = lastTicks.get(p.token);
    const touch = t ? levels(t, p.direction > 0 ? 'buy' : 'sell')[0]?.price ?? null : null;
    const pnl = touch != null ? r2(p.direction * (touch - p.avgEntry) * p.qty) : null;
    if (pnl != null) total += pnl;
    return { id: p.id, mark: touch, unrealised: pnl };
  });
  return { total: r2(total), rows };
}
