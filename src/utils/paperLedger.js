import { intradayCharges } from './charges.js';
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
 */

export const emptyLedger = (date, ledger = 'day') => ({
  date, ledger, mode: 'PAPER', killSwitch: false, closingAll: null, decidedAt: null, decision: null,
  orders: [], positions: [], realised: 0, charges: 0, trades: 0, wins: 0, losses: 0, consecutiveLosses: 0, events: 0,
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
        };
        state.positions.push(p);
        state.trades += 1;
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
      pos.qty -= qty;
      if (e.kind === 'target1') pos.t1Done = true;
      if (pos.qty === 0) closePosition(state, pos, e.at);
      break;
    }
    case 'stop':
      if (pos?.status === 'OPEN') { pos.stop = e.stop; pos.stopReason = e.reason; }
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

/** Day figures for the risk checks (utils/risk.js tradeBlockers). */
export const ledgerDay = (state) => ({
  killSwitch: state.killSwitch, realised: state.realised, trades: state.trades, consecutiveLosses: state.consecutiveLosses,
  open: state.positions.filter((p) => p.status === 'OPEN').length + state.orders.filter((o) => o.open && !state.positions.some((p) => p.id === o.id)).length,
});

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
export function stepTick(state, tick, at, risk, { squareOffAt = null } = {}) {
  const s = cleanRiskSettings(risk);
  const slip = s.slippageBps / 10_000;
  const events = [];
  const emit = (e) => { events.push({ at, ...e }); applyEvent(state, events.at(-1)); };
  const iso = new Date(at).toISOString();

  for (const o of state.orders.filter((x) => x.open && x.token === tick.token)) {
    if (state.killSwitch || state.closingAll) { emit({ type: 'cancel', orderId: o.id, reason: state.closingAll ?? 'kill switch', at: iso }); continue; }
    if (o.expiresAt && at >= time(o.expiresAt)) {
      emit({ type: 'cancel', orderId: o.id, expired: true, reason: o.filledQty ? 'rest not filled by the end of the entry window' : 'not triggered by the end of the entry window', at: iso });
      continue;
    }
    const up = o.direction > 0;
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
    const exitAll = (kind, reason) => {
      if (order?.open) emit({ type: 'cancel', orderId: order.id, reason: `position closed (${reason})`, at: iso });
      emit({ type: 'exit', positionId: p.id, qty: p.qty, price: market, kind, reason, at: iso });
    };
    if (state.killSwitch || state.closingAll) { exitAll(state.killSwitch ? 'kill' : 'close-all', state.closingAll ?? 'kill switch'); continue; }
    if (squareOffAt != null && at >= squareOffAt) { exitAll('squareoff', `square-off at ${s.squareOffAt}`); continue; }
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
