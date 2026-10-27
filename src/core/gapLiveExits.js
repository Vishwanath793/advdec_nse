import { indiaDate, istInstant } from './calendar.js';
import { GAP_CHECK_FALLBACK_MS } from '../utils/paperLedger.js';
import { replanAfterFill } from '../utils/gapExits.js';
import {
  applyLive, expectedNet, indexBook, nextLiveAction, nextTag, rebuildLive, ROLES, sealedLiveCheck, stopAfterT1,
} from '../utils/gapLive.js';
import { classifyOrderError, exitOrderBody, FINAL_STATUSES, liveConfirmText, stopOrderBody, targetOrderBody } from '../utils/liveOrders.js';

/**
 * LIVE exits for opted-in scheduled 09:15 market orders (phase 2 of the 9:15 gap entry).
 * Real orders at Kite; the pure rules are in utils/gapLive.js.
 *
 * Only when armed: the Settings switch is on AND today's typed confirmation was given
 * (`settings()` → { enabled, armedFor, gapExits, risk }). The scheduler refuses to send an
 * opted-in order that isn't armed, so there's never a live entry without its exits.
 * Kite accepts orders only from the whitelisted static IP: a refusal for that stops this
 * position's management with a message, and nothing is retried or worked around.
 *
 * Files: <log>/YYYY-MM-DD.ndjson (append-only events; rebuilt and reconciled with Kite's
 * order book and positions on start-up: Kite wins, differences are listed).
 */

export const POLL_MS = 1_500;
export const TARGET_COOLDOWN_MS = 2_000;
export const UNKNOWN_PLACING_MS = 10_000;

export function createGapLiveExits({
  kite, log, settings, planFor, instruments, now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onUpdate = () => {}, follow = () => {}, pollMs = POLL_MS,
}) {
  let state = null;
  let session = null;
  let pollTimer = null;
  let squareTimer = null;
  let polling = null;
  const busy = new Set();
  const tracks = new Map(); // id → { bar, best, lastTargetAt } (in memory)

  const today = () => indiaDate(now());
  const cfg = () => settings() ?? {};
  const changed = () => { try { onUpdate(); } catch { /* ignore */ } };
  const s = () => ({ apiKey: session?.apiKey, accessToken: session?.accessToken });
  const instant = (time) => +istInstant(state.date, time);
  const emit = (e) => {
    const ev = { at: now().toISOString(), ...e };
    log.append(state.date, ev);
    applyLive(state, ev);
    changed();
    return ev;
  };
  const pos = (id) => state.positions.find((p) => p.id === id);
  const active = () => (state?.positions ?? []).filter((p) => p.status === 'ENTRY' || p.status === 'OPEN');
  const armed = () => { const c = cfg(); return Boolean(c.enabled) && c.armedFor === today(); };
  const times = () => ({
    checkAt: instant('09:20') + GAP_CHECK_FALLBACK_MS,
    timeStopAt: instant(cfg().gapExits?.timeStopAt ?? '09:45'),
    squareOffAt: instant(cfg().risk?.squareOffAt ?? '15:10'),
  });

  async function ensureDay() {
    const date = today();
    if (state?.date === date) return;
    state = rebuildLive(date, (await log.read(date)) ?? []);
    tracks.clear();
  }

  /* ---------- Kite calls ---------- */

  async function book() { return indexBook(await kite.orders(s())); }
  async function readOrder(orderId) { return (await book()).byId.get(String(orderId)) ?? null; }
  /** Read an order until it is final (an IOC or a market order is final within moments). */
  async function waitFinal(orderId, tries = 6) {
    let row = null;
    for (let i = 0; i < tries; i++) {
      row = await readOrder(orderId);
      if (row && FINAL_STATUSES.includes(String(row.status).toUpperCase())) return row;
      await sleep(300);
    }
    return row;
  }

  /** Stop managing this position after an error that can't be fixed by retrying (static IP, session). */
  function fail(p, error, what) {
    const kind = classifyOrderError(error);
    const msg = kind === 'ip'
      ? `Kite refused ${what}: this PC's IP is not the whitelisted static IP. Nothing is retried; manage ${p.symbol} in Kite now.`
      : kind === 'session'
        ? `Kite session expired while ${what}: log in to Kite again. Orders already at Kite stay there; check ${p.symbol} in Kite.`
        : `${what} failed: ${error.message}`;
    emit({ type: 'flag', id: p.id, message: msg, halt: kind === 'ip' || kind === 'session' });
    return kind;
  }

  /**
   * Place one order. The tag is logged first; after an unknown outcome the order book is searched
   * by that tag, and the order is sent again (once) only when Kite has no order with it.
   */
  async function place(p, role, { qty, trigger = null, price = null, kind = null, make, reason = null }, retried = false) {
    const tag = nextTag(state, p, role);
    emit({ type: 'placing', id: p.id, role, tag, qty, trigger, price, kind });
    try {
      const r = await kite.placeOrder({ ...s(), order: make(tag) });
      const orderId = String(r?.order_id ?? r?.orderId ?? '');
      emit({ type: 'placed', id: p.id, role, tag, orderId, qty, trigger, reason });
      return orderId;
    } catch (error) {
      const k = classifyOrderError(error);
      if (k === 'unknown') {
        for (let i = 0; i < 3; i++) {
          const row = (await book().catch(() => null))?.byTag.get(tag);
          if (row) { emit({ type: 'placed', id: p.id, role, tag, orderId: String(row.order_id), qty, trigger, reason, found: 'by tag after an unknown outcome' }); return String(row.order_id); }
          await sleep(1_000);
        }
        emit({ type: 'place-failed', id: p.id, role, tag, reason: 'unknown outcome; Kite has no order with this tag, so it was not created' });
        if (!retried) return place(p, role, { qty, trigger, price, kind, make, reason }, true);
      } else if (k === 'rate' && !retried) {
        emit({ type: 'place-failed', id: p.id, role, tag, reason: 'refused for speed (not placed)' });
        await sleep(1_000);
        return place(p, role, { qty, trigger, price, kind, make, reason }, true);
      } else emit({ type: 'place-failed', id: p.id, role, tag, reason: error.message });
      throw error;
    }
  }

  const placeStop = (p, qty, trigger, reason) => place(p, ROLES.stop, { qty, trigger, reason, make: (tag) => stopOrderBody(p, qty, trigger, tag) });

  /** Record a stop that Kite says is final (filled, rejected, cancelled outside the app). */
  async function stopFinal(p, row) {
    const status = String(row.status).toUpperCase();
    if (p.stop.status === status) return;
    emit({ type: 'stop', id: p.id, status });
    if (status === 'COMPLETE') {
      const trailing = p.stop.reason?.startsWith('trail');
      emit({ type: 'exit', id: p.id, qty: Number(row.filled_quantity) || p.qty, price: Number(row.average_price) || p.stop.trigger, code: trailing ? 'trail' : 'stop', reason: trailing ? 'trailing stop (SL-M at Kite)' : p.t1Done ? 'breakeven stop (SL-M at Kite)' : 'stop loss (SL-M at Kite)', orderId: p.stop.orderId });
    } else if (status === 'REJECTED') {
      emit({ type: 'flag', id: p.id, message: `Kite rejected the SL-M (${row.status_message ?? 'no reason given'}): exiting at market so the position isn't left unprotected.` });
      await exitAll(p, 'stop', 'SL-M rejected by Kite');
    } else if (status === 'CANCELLED' && p.qty > 0) {
      emit({ type: 'flag', id: p.id, message: 'The SL-M was cancelled outside this app: placing it again.' });
      await placeStop(p, p.qty, p.stop.trigger, 'placed again after an outside cancellation');
    }
  }

  /** Modify the resting SL-M. Returns false when it is no longer open (it filled), true when changed. */
  async function modifyStop(p, { qty = p.stop.qty, trigger = p.stop.trigger, reason }, retried = false) {
    try {
      await kite.modifyOrder({ ...s(), orderId: p.stop.orderId, params: { order_type: 'SL-M', quantity: qty, trigger_price: trigger } });
      emit({ type: 'stop', id: p.id, qty, trigger, reason });
      return true;
    } catch (error) {
      const row = await readOrder(p.stop.orderId).catch(() => null);
      if (row && FINAL_STATUSES.includes(String(row.status).toUpperCase())) { await stopFinal(p, row); return false; }
      if (classifyOrderError(error) === 'unknown') {
        // Check first: a modification that went through needs nothing more.
        if (row && Number(row.quantity) === qty && Number(row.trigger_price) === trigger) { emit({ type: 'stop', id: p.id, qty, trigger, reason }); return true; }
        if (!retried) return modifyStop(p, { qty, trigger, reason }, true);
      }
      throw error;
    }
  }

  /** Cancel the SL-M and confirm it in the order book. False when it filled instead (then nothing more is sent). */
  async function cancelStop(p) {
    try { await kite.cancelOrder({ ...s(), orderId: p.stop.orderId }); } catch (error) {
      if (['ip', 'session'].includes(classifyOrderError(error))) throw error;
    }
    for (let i = 0; i < 6; i++) {
      const row = await readOrder(p.stop.orderId);
      const status = String(row?.status ?? '').toUpperCase();
      if (status === 'CANCELLED') { emit({ type: 'stop', id: p.id, status: 'CANCELLED', reason: 'cancelled by the app' }); return true; }
      if (status === 'COMPLETE') { await stopFinal(p, row); return false; }
      await sleep(300);
    }
    emit({ type: 'flag', id: p.id, message: 'Could not confirm the SL-M cancellation in Kite\'s order book: no exit order sent. Check the position in Kite.' });
    return false;
  }

  /** T1 (half) or T2 (the rest): shrink or cancel the SL-M first, then a LIMIT IOC, then the stop back for what's left. */
  async function takeTarget(p, { code, qty, price }) {
    const all = qty >= p.qty;
    const trigger = p.stop.trigger;
    if (all) { if (!(await cancelStop(p))) return; } else if (!(await modifyStop(p, { qty: p.qty - qty, reason: `shrunk before the ${code.toUpperCase()} order` }))) return;
    let orderId = null;
    try {
      orderId = await place(p, ROLES.target, { qty, price, kind: code, make: (tag) => targetOrderBody(p, qty, price, tag) });
    } catch (error) {
      fail(p, error, `the ${code.toUpperCase()} order`);
      if (p.status === 'HALTED') return;
    }
    const row = orderId ? await waitFinal(orderId) : null;
    const filled = Math.min(qty, Number(row?.filled_quantity) || 0);
    if (filled > 0) emit({ type: 'exit', id: p.id, qty: filled, price: Number(row.average_price) || price, code, reason: code === 't1' ? 'target 1 (LIMIT IOC)' : 'target 2 (LIMIT IOC)', orderId });
    if (p.qty <= 0) return;
    const next = code === 't1' && filled > 0 ? stopAfterT1(p) : trigger;
    const why = code === 't1' && filled > 0 ? 'breakeven plus costs after target 1' : `${code.toUpperCase()} IOC not (fully) filled: stop restored`;
    if (all) await placeStop(p, p.qty, next, why);
    else await modifyStop(p, { qty: p.qty, trigger: next, reason: why });
  }

  /** Exit everything: cancel the SL-M (confirmed), then a MARKET order; nothing if the SL-M filled meanwhile. */
  async function exitAll(p, code, reason) {
    if (p.stop && p.stop.status === 'TRIGGER PENDING' && !(await cancelStop(p))) return;
    if (p.qty <= 0) return;
    const qty = p.qty;
    let orderId = null;
    try { orderId = await place(p, ROLES.exit, { qty, kind: code, make: (tag) => exitOrderBody(p, qty, tag) }); } catch (error) {
      fail(p, error, `the ${code} exit order`);
      if (p.status === 'HALTED') return;
    }
    const row = orderId ? await waitFinal(orderId) : null;
    const filled = Math.min(qty, Number(row?.filled_quantity) || 0);
    if (filled > 0) emit({ type: 'exit', id: p.id, qty: filled, price: Number(row.average_price) || null, code, reason, orderId });
    if (p.qty > 0 && p.status !== 'HALTED') {
      emit({ type: 'flag', id: p.id, message: `The ${code} exit filled ${filled} of ${qty}: the stop is placed again for the rest.` });
      await placeStop(p, p.qty, p.stop?.trigger ?? p.levels.sl, 'placed again after a partial exit');
    }
  }

  /** One action at a time per position; errors become flags. */
  async function run(p, what, fn) {
    if (busy.has(p.id) || p.status === 'HALTED' || p.status === 'CLOSED') return;
    busy.add(p.id);
    try { await fn(); } catch (error) { fail(p, error, what); } finally { busy.delete(p.id); }
  }

  /* ---------- Following Kite's order book ---------- */

  async function syncPosition(p, ix) {
    // Placements logged but never confirmed (a restart or an unknown outcome): find them by tag first.
    for (const pl of [...p.placing]) {
      const row = ix.byTag.get(pl.tag);
      if (row) {
        emit({ type: 'placed', id: p.id, role: pl.role, tag: pl.tag, orderId: String(row.order_id), qty: pl.qty, trigger: pl.trigger, found: 'by tag in the order book' });
        if (pl.role !== ROLES.stop && Number(row.filled_quantity) > 0) {
          emit({ type: 'exit', id: p.id, qty: Number(row.filled_quantity), price: Number(row.average_price) || pl.price, code: pl.kind ?? 'exit', reason: `${pl.kind ?? 'exit'} (found in Kite's order book)`, orderId: String(row.order_id) });
        }
      } else if (+now() - Date.parse(pl.at) > UNKNOWN_PLACING_MS) {
        emit({ type: 'place-failed', id: p.id, role: pl.role, tag: pl.tag, reason: 'not in Kite\'s order book: it was not created' });
      }
    }
    const e = ix.byId.get(String(p.entry.orderId)) ?? (p.entry.tag ? ix.byTag.get(p.entry.tag) : null);
    if (e) {
      const filled = Number(e.filled_quantity) || 0;
      const avg = Number(e.average_price) || null;
      const status = String(e.status).toUpperCase();
      if (filled !== p.entry.filled || status !== p.entry.status || avg !== p.entry.avg) emit({ type: 'entry', id: p.id, filled, avg, status, orderId: String(e.order_id) });
      if (FINAL_STATUSES.includes(status) && filled === 0 && p.status === 'ENTRY') { emit({ type: 'closed', id: p.id, reason: `entry ${status.toLowerCase()}${e.status_message ? `: ${e.status_message}` : ''}` }); return; }
    }
    if (p.entry.filled > 0 && !p.levels) {
      const plan = { ...p.plan, qty: p.entry.filled };
      emit({ type: 'levels', id: p.id, levels: replanAfterFill(plan, p.entry.avg, cfg().gapExits) });
    }
    if (p.stop?.orderId) {
      const row = ix.byId.get(String(p.stop.orderId));
      if (row && FINAL_STATUSES.includes(String(row.status).toUpperCase()) && p.stop.status === 'TRIGGER PENDING') { await run(p, 'following the SL-M', () => stopFinal(p, row)); return; }
    }
    if (p.qty > 0 && p.levels && !p.stop && !p.placing.some((x) => x.role === ROLES.stop)) {
      await run(p, 'placing the SL-M', () => placeStop(p, p.qty, p.levels.sl, 'initial stop from the fill'));
    } else if (p.stop?.status === 'TRIGGER PENDING' && p.qty > 0 && p.stop.qty !== p.qty) {
      await run(p, 'resizing the SL-M', () => modifyStop(p, { qty: p.qty, reason: 'entry filled further' }));
    }
  }

  async function pollOnce() {
    if (!state || !session?.accessToken) return;
    let ix;
    try { ix = await book(); } catch (error) {
      if (classifyOrderError(error) === 'session') for (const p of active()) if (!p.flags.some((f) => /session expired/.test(f.message))) fail(p, error, 'reading the order book');
      return;
    }
    for (const p of active()) if (!busy.has(p.id)) await syncPosition(p, ix);
  }

  function schedulePoll() {
    if (pollTimer || !active().length) return;
    pollTimer = setTimer(async () => {
      pollTimer = null;
      polling = pollOnce().catch(() => {}).finally(() => { polling = null; schedulePoll(); });
    }, pollMs);
  }

  function armSquareOff() {
    if (squareTimer) clearTimer(squareTimer);
    const t = times().squareOffAt - +now();
    if (t <= 0 || !active().length) return;
    squareTimer = setTimer(() => { squareTimer = null; for (const p of active()) run(p, 'the square-off', () => exitAll(p, 'square-off', `square-off at ${cfg().risk?.squareOffAt ?? '15:10'}`)); }, t);
  }

  /** Start-up and each morning: today's log, reconciled with Kite (Kite wins). */
  async function load() {
    await ensureDay();
    if (session?.accessToken && state.positions.length) await reconcile().catch((error) => emit({ type: 'mismatch', message: `Reconciling with Kite failed: ${error.message}` }));
    if (active().length) { follow(active().map((p) => p.token).filter(Boolean)); schedulePoll(); armSquareOff(); }
    changed();
  }

  async function reconcile() {
    const ix = await book();
    for (const p of state.positions) {
      if (p.stop?.orderId && p.stop.status === 'TRIGGER PENDING') {
        const row = ix.byId.get(String(p.stop.orderId));
        if (row && (Number(row.trigger_price) !== p.stop.trigger || Number(row.quantity) !== p.stop.qty)) {
          emit({ type: 'mismatch', id: p.id, message: `${p.symbol}: the SL-M at Kite is ${row.quantity} @ ${row.trigger_price}, the log had ${p.stop.qty} @ ${p.stop.trigger}; Kite's used.` });
          emit({ type: 'stop', id: p.id, qty: Number(row.quantity), trigger: Number(row.trigger_price) });
        }
      }
      const known = new Set([p.entry.tag, p.stop?.tag, ...p.placing.map((x) => x.tag)].filter(Boolean));
      for (const [tag, row] of ix.byTag) {
        if (tag.startsWith(`L${state.date.slice(8, 10)}`) && row.tradingsymbol === p.symbol && !known.has(tag)
          && !state.positions.some((x) => x.exits.some((y) => y.orderId === String(row.order_id)))) {
          emit({ type: 'mismatch', id: p.id, message: `${p.symbol}: Kite has order ${tag} (${row.status}) that the log doesn't know.` });
        }
      }
      await syncPosition(p, ix);
    }
    const net = await kite.positions(s()).catch(() => null);
    if (net) {
      for (const symbol of [...new Set(state.positions.map((p) => p.symbol))]) {
        const row = net.find((x) => x.tradingsymbol === symbol && x.product === 'MIS' && x.exchange === 'NSE');
        const kiteQty = Number(row?.quantity) || 0;
        const ours = expectedNet(state, symbol);
        if (kiteQty !== ours) emit({ type: 'mismatch', message: `${symbol}: Kite's MIS position is ${kiteQty}, the app expects ${ours}. Kite's is the truth; check it in Kite.` });
      }
    }
  }

  function dispatch(p, a) {
    if (a.type === 'exit') return run(p, `the ${a.code} exit`, () => exitAll(p, a.code, a.reason));
    if (a.type === 'check0920') {
      emit({ type: 'check0920', id: p.id, ...a.values, failed: a.check.failed, source: a.source });
      if (a.check.failed) return run(p, 'the 09:20 exit', () => exitAll(p, 'gap-failed-0920', a.check.reason));
      if (a.check.stop !== p.stop.trigger) return run(p, 'tightening the SL-M', () => modifyStop(p, { trigger: a.check.stop, reason: 'tightened to the opening range at 09:20' }));
      return null;
    }
    if (a.type === 'timecheck') {
      emit({ type: 'timecheck', id: p.id });
      return a.due ? run(p, 'the time stop', () => exitAll(p, 'time-stop', `time stop at ${cfg().gapExits?.timeStopAt ?? '09:45'}`)) : null;
    }
    if (a.type === 'target') {
      const t = tracks.get(p.id) ?? {};
      if (t.lastTargetAt && +now() - t.lastTargetAt < TARGET_COOLDOWN_MS) return null;
      t.lastTargetAt = +now();
      tracks.set(p.id, t);
      return run(p, `the ${a.code.toUpperCase()} order`, () => takeTarget(p, a));
    }
    if (a.type === 'move-stop') return run(p, 'trailing the SL-M', () => modifyStop(p, { trigger: a.trigger, reason: a.reason }));
    return null;
  }

  return {
    setSession(x) { session = x?.accessToken && x?.apiKey ? { apiKey: x.apiKey, accessToken: x.accessToken } : null; if (session) load().catch(() => {}); },
    armed,
    load,
    /** The scheduler placed an opted-in order: follow it (its fill, then the SL-M and the exits). */
    async track(o) {
      await ensureDay();
      if (pos(o.id)) return;
      let ix = null;
      try { ix = await instruments.load(session); } catch { /* the token only matters for ticks */ }
      const inst = ix?.equity?.(o.symbol) ?? null;
      const plan = await planFor(o.symbol, o.side).catch(() => null);
      emit({
        type: 'track',
        position: {
          id: o.id, symbol: o.symbol, side: o.side, d: o.side === 'SELL' ? -1 : 1, token: inst?.token ?? null, tick: inst?.tick ?? plan?.tick ?? 0.05, lot: inst?.lot ?? 1,
          entry: { orderId: o.result?.orderId ?? null, tag: o.tag || null, qty: o.sendQuantity ?? o.quantity }, plan: plan?.ok ? plan : null,
        },
      });
      const p = pos(o.id);
      if (!p.plan) emit({ type: 'flag', id: p.id, message: `No gap plan for ${o.symbol} (no pre-open data): the app can't set the stop. Set one in Kite now.`, halt: true });
      if (p.token) follow([p.token]);
      schedulePoll();
      armSquareOff();
    },
    onTicks(ticks) {
      if (!state || !armed()) return;
      for (const t of ticks) {
        if (t.index) continue;
        for (const p of active().filter((x) => x.token === t.token && !busy.has(x.id))) {
          const track = tracks.get(p.id) ?? {};
          tracks.set(p.id, track);
          const a = nextLiveAction(p, t, t.exchangeTime ?? +now(), cfg().gapExits, times(), track);
          if (a) dispatch(p, a);
        }
      }
    },
    onSeal(sealed) {
      if (!state || !armed()) return;
      for (const p of active().filter((x) => x.status === 'OPEN' && x.stop?.status === 'TRIGGER PENDING' && !x.check0920 && !busy.has(x.id))) {
        const st = sealed.stocks?.find((x) => x.symbol === p.symbol);
        if (st?.orLow > 0) dispatch(p, sealedLiveCheck(p, st, cfg().gapExits));
      }
    },
    /** Exit every live gap position now (cancel the SL-M, then market). */
    async kill() {
      await Promise.all(active().map((p) => run(p, 'the kill switch', () => exitAll(p, 'kill', 'kill switch'))));
      return this.view();
    },
    tokens: () => active().map((p) => p.token).filter(Boolean),
    syncNow: () => pollOnce(),
    idle: async () => { while (busy.size || polling) await sleep(10); },
    get state() { return state; },
    view() {
      const c = cfg();
      return {
        enabled: Boolean(c.enabled), armedFor: c.armedFor ?? null, armed: armed(), confirmText: liveConfirmText(today()),
        session: Boolean(session?.accessToken), date: state?.date ?? today(), positions: state?.positions ?? [], mismatches: state?.mismatches ?? [],
      };
    },
  };
}
