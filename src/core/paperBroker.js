import { decisionRow } from '../utils/decision.js';
import { applyEvent, emptyLedger, gapOrderEvents, markToMarket, orderEvents, rebuildLedger, stepTick } from '../utils/paperLedger.js';

/**
 * The paper broker: the ledger (utils/paperLedger.js) plus its files.
 *   .data/paper/YYYY-MM-DD.ndjson   append-only event log (the source of truth)
 *   .data/paper/YYYY-MM-DD.json     state snapshot (a cache, rebuilt from the log)
 * Without `store`/`log` (the simulated replay) nothing is written.
 *
 * On load the state is rebuilt from the log and compared with the snapshot
 * (reconciliation); a mismatch is reported, logged, and the log wins. Order ids
 * are per day, stock and strategy, and a day is decided only once, so a restart
 * can't place the same order twice.
 */
export function createPaperBroker({ store = null, log = null, ledger = 'day', risk = () => ({}), gap = () => ({}), onChange = () => {}, now = () => new Date() }) {
  const persist = Boolean(store && log);
  const lastTicks = new Map();
  let state = null;
  let saving = Promise.resolve();

  function commit(events) {
    if (!events.length) return;
    if (persist) {
      for (const e of events) log.append(state.date, e);
      const snapshot = JSON.parse(JSON.stringify(state));
      saving = saving.then(() => store.write(`paper/${snapshot.date}.json`, snapshot)).catch(() => {});
    }
    try { onChange(); } catch { /* listener errors don't matter */ }
  }
  const record = (events) => { for (const e of events) applyEvent(state, e); commit(events); };

  /** Differences between the saved snapshot and the state rebuilt from the log. */
  function compare(saved, rebuilt) {
    const out = [];
    for (const o of rebuilt.orders) {
      const s = saved.orders?.find((x) => x.id === o.id);
      if (!s) out.push(`order ${o.id} is in the log but not in the snapshot`);
      else if (s.status !== o.status || s.filledQty !== o.filledQty) out.push(`order ${o.id}: snapshot ${s.status} ${s.filledQty}, log ${o.status} ${o.filledQty}`);
    }
    for (const s of saved.orders ?? []) if (!rebuilt.orders.some((o) => o.id === s.id)) out.push(`order ${s.id} is in the snapshot but not in the log`);
    for (const p of rebuilt.positions) {
      const s = saved.positions?.find((x) => x.id === p.id);
      if (!s || s.qty !== p.qty || s.status !== p.status) out.push(`position ${p.id}: snapshot ${s ? `${s.status} ${s.qty}` : 'missing'}, log ${p.status} ${p.qty}`);
    }
    if (Math.abs((saved.realised ?? 0) - rebuilt.realised) > 0.01) out.push(`realised P&L: snapshot ${saved.realised}, log ${rebuilt.realised}`);
    return out;
  }

  /** Exit what can exit now at the last known bid/ask; the rest exits on its next tick. */
  function flushOpen(at) {
    for (const p of state.positions.filter((x) => x.status === 'OPEN')) {
      const t = lastTicks.get(p.token);
      if (t) commit(stepTick(state, t, at, risk(), { gap: gap(state.date) }));
    }
    for (const o of state.orders.filter((x) => x.open)) {
      record([{ type: 'cancel', orderId: o.id, reason: state.closingAll ?? 'cancelled', at: new Date(at).toISOString() }]);
    }
  }

  return {
    ledger,
    get state() { return state; },
    /** Today's ledger from the log, reconciled with the snapshot. */
    async load(date) {
      if (state?.date === date) return { date, mismatches: [] };
      lastTicks.clear();
      if (!persist) { state = emptyLedger(date, ledger); return { date, mismatches: [] }; }
      const events = (await log.read(date)) ?? [];
      const rebuilt = rebuildLedger(date, events, ledger);
      const saved = await store.read(`paper/${date}.json`);
      const mismatches = saved ? compare(saved, rebuilt) : [];
      state = rebuilt;
      if (mismatches.length) record([{ type: 'reconciled', at: now().toISOString(), mismatches }]);
      else if (events.length && !saved) commit([]);
      return { date, events: events.length, mismatches };
    },
    /** A fresh in-memory ledger (the simulated replay). */
    reset(date) { state = emptyLedger(date, ledger); lastTicks.clear(); try { onChange(); } catch { /* ignore */ } },
    /** Record the 09:20 decision and place its paper orders, once a day. */
    decide(decision, { at, entryUntilAt }) {
      if (!state) throw new Error('ledger not loaded');
      if (state.decidedAt) return { skipped: `already decided at ${state.decidedAt}`, orders: 0 };
      const orders = orderEvents(state, decision, { at, entryUntilAt });
      record([{ type: 'decided', at, rows: decision.decisions.map(decisionRow), gapReport: decision.gapReport, blockers: decision.blockers, partial: decision.partial }, ...orders]);
      return { orders: orders.length };
    },
    /** Place the 9:15 gap entries' market orders (once per stock a day). */
    placeGap(entries, { at, activeFrom, expiresAt }) {
      if (!state) throw new Error('ledger not loaded');
      const orders = gapOrderEvents(state, entries, { at, activeFrom, expiresAt });
      record(orders);
      return { orders: orders.length };
    },
    /** Live (or replayed) ticks drive the simulated fills and exits once there are orders (9:15 gap entries, then the 09:20 decision). */
    onTicks(ticks, receivedAt, { squareOffAt = null } = {}) {
      for (const t of ticks) {
        if (t.index) continue;
        lastTicks.set(t.token, t);
        if (!state?.orders.length) continue;
        commit(stepTick(state, t, t.exchangeTime ?? receivedAt, risk(), { squareOffAt, gap: gap(state.date) }));
      }
    },
    kill(on, at = +now()) {
      if (!state) return;
      record([{ type: 'kill', on: Boolean(on), reason: on ? 'kill switch' : null, at: new Date(at).toISOString() }]);
      if (on) flushOpen(at);
    },
    closeAll(reason, at = +now()) {
      if (!state) return;
      record([{ type: 'close-all', reason, at: new Date(at).toISOString() }]);
      flushOpen(at);
    },
    /** Instrument tokens with an open order or position (kept streaming after 09:30). */
    openTokens() {
      if (!state) return [];
      return [...new Set([...state.orders.filter((o) => o.open), ...state.positions.filter((p) => p.status === 'OPEN')].map((x) => x.token))];
    },
    view() {
      if (!state) return null;
      const mtm = markToMarket(state, lastTicks);
      return { ...state, unrealised: mtm.total, marks: mtm.rows };
    },
    flushed: () => saving,
  };
}
