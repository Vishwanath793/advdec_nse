import test from 'node:test';
import assert from 'node:assert/strict';
import { istInstant } from '../src/core/calendar.js';
import { KiteError } from '../src/core/kite.js';
import { createGapLiveExits } from '../src/core/gapLiveExits.js';
import { createGapFallback } from '../src/core/gapInputs.js';
import { createOrderScheduler, validateScheduledOrder } from '../src/core/orderScheduler.js';
import { gapExitPlan } from '../src/utils/gapExits.js';
import { readCalendar } from './tv/calendar.js';

const D = '2026-10-28'; // a Wednesday
const T = (hm, s = 0) => +istInstant(D, hm) + s * 1000;
const RISK = { capital: 100_000, riskPerTradePct: 0.25 };
const PLAN = gapExitPlan({ symbol: 'X', side: 'BUY', prevClose: 1000, open: 1012, atr: 30, tick: 0.05, upperCircuit: 1200, lowerCircuit: 800 }, {}, RISK);

/** A fake Kite order book (no network). `fail.place/modify/cancel/orders`: one-off errors; `onPlace(row)`: shape a new order. */
function fakeKite() {
  let n = 100;
  const k = {
    rows: [], calls: [], net: [], fail: {}, onPlace: null, market: 1012.6,
    async orders() { k.calls.push('orders'); if (k.fail.orders) { const e = k.fail.orders; k.fail.orders = null; throw e; } return k.rows.map((r) => ({ ...r })); },
    async positions() { return k.net; },
    async placeOrder({ order }) {
      k.calls.push(['place', order.order_type, order.quantity, order.trigger_price ?? order.price ?? null, order.tag]);
      const slm = order.order_type === 'SL-M';
      const row = {
        order_id: String(++n), tag: order.tag, tradingsymbol: order.tradingsymbol, transaction_type: order.transaction_type, order_type: order.order_type,
        quantity: order.quantity, trigger_price: order.trigger_price ?? 0, price: order.price ?? 0, validity: order.validity,
        status: slm ? 'TRIGGER PENDING' : 'COMPLETE', filled_quantity: slm ? 0 : order.quantity, average_price: slm ? 0 : order.price || k.market,
      };
      k.onPlace?.(row, order);
      const f = k.fail.place;
      if (f) { k.fail.place = f.next ?? null; if (f.created) k.rows.push(row); throw f.error; }
      k.rows.push(row);
      return { order_id: row.order_id };
    },
    async modifyOrder({ orderId, params }) {
      k.calls.push(['modify', params.quantity, params.trigger_price]);
      const r = k.rows.find((x) => x.order_id === orderId);
      if (!r || ['COMPLETE', 'CANCELLED', 'REJECTED'].includes(r.status)) throw new KiteError('Order cannot be modified as it is being processed or already complete.', 400, {});
      if (k.fail.modify) { const e = k.fail.modify; k.fail.modify = null; throw e; }
      Object.assign(r, { quantity: params.quantity, trigger_price: params.trigger_price });
      return { order_id: orderId };
    },
    async cancelOrder({ orderId }) {
      k.calls.push(['cancel', orderId]);
      const r = k.rows.find((x) => x.order_id === orderId);
      if (r && r.status === 'TRIGGER PENDING') r.status = 'CANCELLED';
      return { order_id: orderId };
    },
  };
  return k;
}

function memLog() {
  const days = new Map();
  return { append: (d, e) => { if (!days.has(d)) days.set(d, []); days.get(d).push(e); }, read: (d) => [...(days.get(d) ?? [])], days };
}

function setup({ kite = fakeKite(), log = memLog(), clock = T('09:15', 1), armedFor = D, enabled = true, plan = PLAN } = {}) {
  const c = { t: clock };
  const live = createGapLiveExits({
    kite, log, settings: () => ({ enabled, armedFor, gapExits: {}, risk: { squareOffAt: '15:10' } }),
    planFor: async () => plan, instruments: { load: async () => ({ equity: () => ({ token: 7, tick: 0.05, lot: 1 }) }) },
    now: () => new Date(c.t), setTimer: () => 0, clearTimer: () => {}, sleep: async () => {}, pollMs: 1e9,
  });
  live.setSession({ apiKey: 'k', accessToken: 't' });
  return { live, kite, log, c };
}

const entryRow = (filled, avg, status = filled ? 'COMPLETE' : 'OPEN') => ({ order_id: 'E1', tag: 'L28E1X', tradingsymbol: 'X', transaction_type: 'BUY', order_type: 'MARKET', quantity: 10, status, filled_quantity: filled, average_price: avg });
const scheduled = { id: 'S20', symbol: 'X', side: 'BUY', quantity: 10, tag: 'L28E1X', result: { orderId: 'E1' } };
const tick = (ltp, { bid = ltp - 0.05, low = 1009, high = 1020, vwap = 1012, open = 1012 } = {}) => ({
  token: 7, ltp, low, high, avgPrice: vwap, open, depth: { buy: [{ price: bid, qty: 500 }], sell: [{ price: bid + 0.1, qty: 500 }] },
});

async function filled(opts) {
  const s = setup(opts);
  s.kite.rows.push(entryRow(10, 1012.5));
  await s.live.track(scheduled);
  await s.live.syncNow();
  await s.live.idle();
  return { ...s, p: () => s.live.state.positions[0] };
}

test('partial entry fills: the SL-M rests for the filled quantity, then grows with the fill', async () => {
  const s = setup();
  s.kite.rows.push(entryRow(5, 1012.5, 'OPEN'));
  await s.live.track(scheduled);
  await s.live.syncNow();
  await s.live.idle();
  let p = s.live.state.positions[0];
  assert.equal(p.entry.filled, 5);
  assert.equal(p.stop.qty, 5);
  assert.equal(p.stop.trigger, 1002, 'from the fill: 1012.50 − 10.50');
  const slm = s.kite.rows.find((r) => r.order_type === 'SL-M');
  assert.deepEqual([slm.transaction_type, slm.quantity, slm.trigger_price], ['SELL', 5, 1002]);
  Object.assign(s.kite.rows[0], { filled_quantity: 10, status: 'COMPLETE', average_price: 1012.55 });
  await s.live.syncNow();
  await s.live.idle();
  p = s.live.state.positions[0];
  assert.equal(p.stop.qty, 10);
  assert.equal(slm.quantity, 10, 'resized at Kite');
  assert.equal(s.kite.rows.filter((r) => r.order_type === 'SL-M').length, 1, 'one SL-M only');
});

test('T1: the SL-M is shrunk first, then a LIMIT IOC for half, then the stop goes to breakeven plus costs', async () => {
  const s = await filled();
  s.kite.calls.length = 0;
  s.c.t = T('09:17');
  s.live.onTicks([tick(1023.2, { bid: 1023.1 })]);
  await s.live.idle();
  const p = s.p();
  const actions = s.kite.calls.filter((x) => Array.isArray(x)).map((x) => x.slice(0, 3));
  assert.deepEqual(actions, [['modify', 5, 1002], ['place', 'LIMIT', 5], ['modify', 5, p.stop.trigger]]);
  const ioc = s.kite.rows.find((r) => r.order_type === 'LIMIT');
  assert.equal(ioc.validity, 'IOC');
  assert.equal(p.t1Done, true);
  assert.equal(p.exits[0].code, 't1');
  assert.ok(p.stop.trigger > 1012.5 && p.stop.trigger < 1014, `breakeven plus costs ${p.stop.trigger}`);
  assert.equal(p.qty, 5);
});

test('a stop that fills while a target is being sent: no target order goes out', async () => {
  const s = await filled();
  const slm = s.kite.rows.find((r) => r.order_type === 'SL-M');
  Object.assign(slm, { status: 'COMPLETE', filled_quantity: 10, average_price: 1001.8 }); // filled at Kite a moment ago
  s.kite.calls.length = 0;
  s.c.t = T('09:17');
  s.live.onTicks([tick(1023.2, { bid: 1023.1 })]);
  await s.live.idle();
  const p = s.p();
  assert.ok(!s.kite.calls.some((x) => Array.isArray(x) && x[0] === 'place'), 'no LIMIT sent');
  assert.equal(p.status, 'CLOSED');
  assert.deepEqual([p.exits[0].code, p.exits[0].qty, p.exits[0].price], ['stop', 10, 1001.8]);
});

test('unknown outcome: the order book is searched by tag before anything is sent again', async () => {
  // The SL-M request times out but Kite created it: found by tag, never sent twice.
  const s = setup();
  s.kite.rows.push(entryRow(10, 1012.5));
  s.kite.fail.place = { error: new KiteError('Kite order failed: no response from Kite (timed out)', 0, null, { unknown: true }), created: true };
  await s.live.track(scheduled);
  await s.live.syncNow();
  await s.live.idle();
  assert.equal(s.kite.rows.filter((r) => r.order_type === 'SL-M').length, 1);
  assert.equal(s.kite.calls.filter((x) => Array.isArray(x) && x[0] === 'place').length, 1);
  assert.ok(s.live.state.positions[0].stop.orderId);

  // Timed out and NOT created: checked, then sent once more.
  const t = setup();
  t.kite.rows.push(entryRow(10, 1012.5));
  t.kite.fail.place = { error: new KiteError('Kite order failed: no response from Kite (timed out)', 0, null, { unknown: true }), created: false };
  await t.live.track(scheduled);
  await t.live.syncNow();
  await t.live.idle();
  assert.equal(t.kite.calls.filter((x) => Array.isArray(x) && x[0] === 'place').length, 2);
  assert.equal(t.kite.rows.filter((r) => r.order_type === 'SL-M').length, 1);
  const events = t.log.read(D).filter((e) => e.type === 'place-failed');
  assert.match(events[0].reason, /no order with this tag/);
});

test('a rejected SL-M: the position is exited at market instead of being left unprotected', async () => {
  const s = setup();
  s.kite.rows.push(entryRow(10, 1012.5));
  s.kite.onPlace = (row) => { if (row.order_type === 'SL-M') Object.assign(row, { status: 'REJECTED', status_message: 'Trigger price is higher than the last price' }); };
  await s.live.track(scheduled);
  await s.live.syncNow();
  await s.live.idle();
  await s.live.syncNow();
  await s.live.idle();
  const p = s.live.state.positions[0];
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exits[0].code, 'stop');
  assert.ok(p.flags.some((f) => /rejected the SL-M/.test(f.message)));
  assert.ok(s.kite.rows.some((r) => r.order_type === 'MARKET' && r.transaction_type === 'SELL'));
});

test('a static-IP refusal stops this position\'s management; nothing is retried', async () => {
  const s = setup();
  s.kite.rows.push(entryRow(10, 1012.5));
  s.kite.fail.place = { error: new KiteError('You are not allowed to place orders from this IP. Add your static IP in the developer console.', 400, {}) };
  await s.live.track(scheduled);
  await s.live.syncNow();
  await s.live.idle();
  await s.live.syncNow();
  await s.live.idle();
  const p = s.live.state.positions[0];
  assert.equal(p.status, 'HALTED');
  assert.match(p.flags.at(-1).message, /not the whitelisted static IP. Nothing is retried/);
  assert.equal(s.kite.calls.filter((x) => Array.isArray(x) && x[0] === 'place').length, 1);
});

test('session expiry: management stops with a log-in message; the SL-M already at Kite stays', async () => {
  const s = await filled();
  s.kite.fail.orders = new KiteError('Incorrect `api_key` or `access_token`.', 403, { error_type: 'TokenException' });
  await s.live.syncNow();
  const p = s.p();
  assert.equal(p.status, 'HALTED');
  assert.match(p.flags.at(-1).message, /session expired/);
  assert.equal(s.kite.rows.find((r) => r.order_type === 'SL-M').status, 'TRIGGER PENDING');
});

test('time stop: the SL-M is cancelled and confirmed before the MARKET exit; nothing more if it filled instead', async () => {
  const s = await filled();
  s.c.t = T('09:20', 1);
  s.live.onSeal({ stocks: [{ symbol: 'X', orLow: 1009, orHigh: 1016, vwap: 1012, ltp: 1014, open: 1012 }] });
  await s.live.idle();
  assert.equal(s.p().check0920.source, 'sealed 09:15–09:20 window');
  assert.equal(s.p().stop.trigger, 1007.5, 'tightened at Kite to the sealed range low − 0.05 ATR');
  s.kite.calls.length = 0;
  s.c.t = T('09:45', 1);
  s.live.onTicks([tick(1014, { bid: 1013.95 })]);
  await s.live.idle();
  const order = s.kite.calls.filter((x) => Array.isArray(x)).map((x) => x[0] === 'place' ? `${x[0]} ${x[1]}` : x[0]);
  assert.deepEqual(order, ['cancel', 'place MARKET']);
  const p = s.p();
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exits[0].code, 'time-stop');

  const t = await filled();
  Object.assign(t.kite.rows.find((r) => r.order_type === 'SL-M'), { status: 'COMPLETE', filled_quantity: 10, average_price: 1001.9 });
  t.c.t = T('15:10', 1);
  t.live.onTicks([tick(1001, { bid: 1000.95 })]);
  await t.live.idle();
  assert.ok(!t.kite.calls.some((x) => Array.isArray(x) && x[0] === 'place' && x[1] === 'MARKET'), 'the SL-M filled: no exit order');
  assert.equal(t.p().exits[0].code, 'stop');
});

test('the gap fails at 09:20 (sealed window below VWAP and the open): cancel, then exit at market', async () => {
  const s = await filled();
  s.c.t = T('09:20', 1);
  s.live.onSeal({ stocks: [{ symbol: 'X', orLow: 1004, orHigh: 1014, vwap: 1010, ltp: 1006, open: 1012 }] });
  await s.live.idle();
  const p = s.p();
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exits[0].code, 'gap-failed-0920');
});

test('restart: rebuilt from the log and reconciled with Kite (Kite wins, differences listed)', async () => {
  const s = await filled();
  // While the app was down: the SL-M was moved by hand in Kite, and the position at Kite differs.
  Object.assign(s.kite.rows.find((r) => r.order_type === 'SL-M'), { trigger_price: 1005 });
  s.kite.net = [{ tradingsymbol: 'X', exchange: 'NSE', product: 'MIS', quantity: 7 }];
  const again = setup({ kite: s.kite, log: s.log });
  await again.live.load();
  await again.live.idle();
  const p = again.live.state.positions[0];
  assert.equal(p.stop.trigger, 1005, "Kite's trigger used");
  const m = again.live.state.mismatches.map((x) => x.message).join(' | ');
  assert.match(m, /SL-M at Kite is 10 @ 1005, the log had 10 @ 1002/);
  assert.match(m, /Kite's MIS position is 7, the app expects 10/);
  assert.equal(s.kite.rows.filter((r) => r.order_type === 'SL-M').length, 1, 'nothing placed twice after the restart');
});

test('not armed: ticks change nothing', async () => {
  const s = await filled({ armedFor: '2026-10-27' });
  s.kite.calls.length = 0;
  s.c.t = T('09:17');
  s.live.onTicks([tick(1030)]);
  await s.live.idle();
  assert.equal(s.kite.calls.filter((x) => Array.isArray(x)).length, 0);
});

/* ---------- The scheduler side ---------- */

const NOW = new Date(T('08:00'));
const cal = readCalendar();
const input = (o = {}) => ({ symbol: 'INFY', side: 'BUY', quantity: 20, orderType: 'MARKET', product: 'MIS', triggerAt: new Date(T('09:15')).toISOString(), exits: 'gap', ...o });

test('scheduler: the opt-in needs a 09:15 MARKET MIS NSE order, and gets a findable tag', () => {
  const { order, warnings } = validateScheduledOrder(input(), NOW, cal);
  assert.equal(order.exits, 'gap');
  assert.equal(order.tag, 'L28E1INFY');
  assert.ok(warnings.some((w) => /armed/.test(w)));
  assert.throws(() => validateScheduledOrder(input({ orderType: 'LIMIT', price: 1500 }), NOW, cal), /MARKET, MIS, NSE/);
  assert.throws(() => validateScheduledOrder(input({ product: 'CNC' }), NOW, cal), /MARKET, MIS, NSE/);
  assert.throws(() => validateScheduledOrder(input({ triggerAt: new Date(T('09:16')).toISOString() }), NOW, cal), /09:15:00 and 09:15:59/);
  assert.equal(validateScheduledOrder(input({ exits: undefined }), NOW, cal).order.exits, undefined, 'off by default');
});

function scheduler({ armed = true, enabled = true, size = async () => ({ quantity: 12, reason: 'normal gap ×1' }) } = {}) {
  const files = new Map();
  const placed = [];
  const handed = [];
  const c = { t: +NOW };
  const sch = createOrderScheduler({
    store: { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, JSON.parse(JSON.stringify(v))); } },
    placeOrder: async () => assert.fail('the sender stub sends'),
    sender: { send: async ({ order }) => { placed.push(order); return { ok: true, orderId: 'K1', sentAt: c.t, confirmedAt: c.t, attempts: 1 }; } },
    calendar: cal, now: () => new Date(c.t), setTimer: () => 0, clearTimer: () => {},
    gapExits: { status: () => ({ enabled, armed }), size, onPlaced: (o) => handed.push(o.id) },
  });
  sch.setSession({ apiKey: 'k', accessToken: 't' });
  return { sch, placed, handed, c };
}

test('scheduler: an opted-in order is not sent unless live exits are armed that day', async () => {
  const { sch, placed, c } = scheduler({ armed: false });
  const { order } = await sch.add(input());
  c.t = T('09:15') - 1500;
  await sch.fire(order.id);
  const o = (await sch.list()).find((x) => x.id === order.id);
  assert.equal(o.status, 'failed');
  assert.match(o.result.error, /Not sent: live gap exits were switched on but not armed for 2026-10-28/);
  assert.equal(placed.length, 0, 'nothing reached Kite');
});

test('scheduler: auto-size sends min(entered, gap plan) and hands the placed order to the live exits', async () => {
  const { sch, placed, handed, c } = scheduler();
  const { order } = await sch.add(input({ gapAutoSize: true }));
  c.t = T('09:15') - 1500;
  await sch.fire(order.id);
  const o = (await sch.list()).find((x) => x.id === order.id);
  assert.equal(o.status, 'placed');
  assert.equal(placed[0].quantity, 12);
  assert.equal(placed[0].tag, 'L28E1INFY');
  assert.deepEqual([o.sizing.entered, o.sizing.plan, o.sizing.sent], [20, 12, 12]);
  assert.deepEqual(handed, [order.id]);
  // Never more than entered.
  const big = scheduler({ size: async () => ({ quantity: 500, reason: 'x' }) });
  const b = (await big.sch.add(input({ gapAutoSize: true }))).order;
  big.c.t = T('09:15') - 1500;
  await big.sch.fire(b.id);
  assert.equal(big.placed[0].quantity, 20);
});

test('scheduler: without live exits (the phone) the opt-in is refused; plain orders are unchanged', async () => {
  const files = new Map();
  const sch = createOrderScheduler({
    store: { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, v); } },
    placeOrder: async () => ({ order_id: 'K' }), calendar: cal, now: () => NOW, setTimer: () => 0, clearTimer: () => {},
  });
  await assert.rejects(sch.add(input()), /only available in the PC backend/);
  const { order } = await sch.add(input({ exits: undefined }));
  assert.equal(order.exits, undefined);
  assert.equal(order.tag, '');
});

test('scheduler: each opted-in order gets its own tag (never the shared default tag)', async () => {
  const { sch } = scheduler();
  const a = (await sch.add(input({ tag: 'ADVDC' }))).order;
  const b = (await sch.add(input({ tag: 'ADVDC', quantity: 21 }))).order;
  assert.equal(a.tag, `L28E${a.id.slice(1)}INFY`);
  assert.equal(b.tag, `L28E${b.id.slice(1)}INFY`);
  assert.notEqual(a.tag, b.tag);
  const plain = (await sch.add(input({ tag: 'ADVDC', exits: undefined, quantity: 22 }))).order;
  assert.equal(plain.tag, 'ADVDC', 'plain orders keep the default tag');
});

test('scheduler: a warning when scheduled while not armed for that day; none when armed', async () => {
  const off = scheduler({ enabled: false, armed: false });
  assert.ok((await off.sch.add(input())).warnings.some((w) => /switched off in Settings/.test(w)));
  const on = scheduler({ enabled: true, armed: false });
  assert.ok((await on.sch.add(input())).warnings.some((w) => /not armed for 2026-10-28: type the confirmation/.test(w)));
  const armed = scheduler({ enabled: true, armed: true });
  assert.ok(!(await armed.sch.add(input())).warnings.some((w) => /not armed|switched off/.test(w)));
});

test('live tags: two positions in the same stock on one day never share a tag', async () => {
  const s = setup();
  s.kite.rows.push(entryRow(10, 1012.5), { ...entryRow(10, 1013), order_id: 'E2', tag: 'L28E13X' });
  await s.live.track({ ...scheduled, id: 'S12' });
  await s.live.track({ ...scheduled, id: 'S13', tag: 'L28E13X', result: { orderId: 'E2' } });
  await s.live.syncNow();
  await s.live.idle();
  const tags = s.kite.rows.filter((r) => r.order_type === 'SL-M').map((r) => r.tag);
  assert.deepEqual(tags, ['L28S1201X', 'L28S1301X']);
});

test('a stock opted in after 09:10: Kite ATR, previous-day levels, tick and lot fetched for it', async () => {
  const preopenStocks = async () => ({ stocks: [{ symbol: 'SAIL', prevClose: 120, finalPrice: 122.5, upperCircuit: 132, lowerCircuit: 108 }] });
  const instruments = { load: async () => ({ equity: (s) => (s === 'SAIL' ? { token: 758529, tick: 0.01, lot: 1 } : null) }) };
  let asked = null;
  const history = { load: async (items) => { asked = items; return { history: { SAIL: { atr14: 3.4, prevDay: { date: '2026-10-27', high: 121.8, low: 118.9 } } }, errors: [] }; } };
  const withKite = createGapFallback({ preopenStocks, instruments, history, session: () => ({ apiKey: 'k', accessToken: 't' }) });
  const x = await withKite('SAIL', 'SELL');
  assert.deepEqual(asked, [{ symbol: 'SAIL', token: 758529 }]);
  assert.deepEqual([x.atr, x.tick, x.prevHigh, x.prevLow], [3.4, 0.01, 121.8, 118.9]);
  assert.equal(x.sources.atr, 'ATR(14) from Kite daily candles (fetched for this stock)');
  const plan = gapExitPlan(x, {}, RISK);
  assert.equal(plan.atrEstimated, false, 'no ×0.5 for an estimated ATR');
  // No Kite session: the estimate, saying why.
  const noKite = await createGapFallback({ preopenStocks, instruments, history, session: () => null })('SAIL', 'SELL');
  assert.equal(noKite.atr, null);
  assert.equal(noKite.sources.atr, 'missing (no Kite session): estimated');
  assert.equal(await withKite('NOPE', 'BUY'), null);
});
