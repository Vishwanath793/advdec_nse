import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrderScheduler, kiteOrderFor, MIN_LEAD_MS, ORDER_GRACE_MS, validateScheduledOrder,
} from '../src/core/orderScheduler.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const ist = (iso, time) => new Date(`${iso}T${time}+05:30`);
const MONDAY = '2026-10-19';

function memoryStore() {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
}

/** A controllable clock and timer queue. */
function fakeTime(start) {
  let t = +start;
  const timers = new Map();
  let id = 0;
  return {
    now: () => new Date(t),
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (h) => timers.delete(h),
    /** Move the clock forward, running due timers in order. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at).find(([, x]) => x.at <= end);
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        await next[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

const base = { symbol: 'infy', side: 'BUY', quantity: 10, orderType: 'MARKET', product: 'MIS' };

test('validation: symbol, side, quantity, type, price tick, time window and trading days', () => {
  const now = ist(MONDAY, '08:30:00');
  const at = (time, day = MONDAY) => ist(day, time).toISOString();
  const ok = validateScheduledOrder({ ...base, triggerAt: at('09:15:00') }, now, calendar);
  assert.equal(ok.order.symbol, 'INFY');
  assert.deepEqual(ok.warnings, []);
  const limit = validateScheduledOrder({ ...base, orderType: 'LIMIT', price: 1503.37, triggerAt: at('09:20:00') }, now, calendar);
  assert.equal(limit.order.price, 1503.4); // ₹0.10 tick above ₹1000
  assert.match(limit.warnings[0], /rounded to the ₹0.1 tick/);
  assert.equal(validateScheduledOrder({ ...base, orderType: 'LIMIT', price: 99.995, triggerAt: at('09:20:00') }, now, calendar).order.price, 100);

  const bad = (patch, re) => assert.throws(() => validateScheduledOrder({ ...base, triggerAt: at('09:15:00'), ...patch }, now, calendar), re);
  bad({ symbol: 'bad symbol!' }, /valid NSE symbol/);
  bad({ side: 'HOLD' }, /Buy or Sell/);
  bad({ quantity: 0 }, /whole number/);
  bad({ quantity: 2.5 }, /whole number/);
  bad({ orderType: 'SL' }, /Market or Limit/);
  bad({ orderType: 'LIMIT', price: 0 }, /limit price/);
  bad({ product: 'XYZ' }, /MIS, CNC or NRML/);
  bad({ triggerAt: 'soon' }, /valid date/);
  bad({ triggerAt: at('08:30:01') }, /seconds in the future/);
  bad({ triggerAt: at('08:59:59') }, /between 09:00 and 15:30/);
  bad({ triggerAt: at('15:30:01') }, /between 09:00 and 15:30/);
  bad({ triggerAt: at('09:15:00', '2026-10-20') }, /not a trading day \(Dussehra\)/);
  bad({ triggerAt: at('09:15:00', '2026-10-24') }, /not a trading day \(Weekend\)/);
  bad({ triggerAt: at('09:15:00', '2026-10-30') }, /up to 7 days ahead/);

  assert.match(validateScheduledOrder({ ...base, triggerAt: at('09:10:00') }, now, calendar).warnings[0], /Between 09:08 and 09:15/);
  assert.match(validateScheduledOrder({ ...base, triggerAt: at('15:25:00') }, now, calendar).warnings[0], /MIS positions are squared off/);
  assert.deepEqual(validateScheduledOrder({ ...base, product: 'CNC', triggerAt: at('15:25:00') }, now, calendar).warnings, []);
});

test('Kite order form: market orders carry market protection, limit orders the price', () => {
  const { order } = validateScheduledOrder({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString(), tag: 'AD-VDC 1' }, ist(MONDAY, '08:00:00'), calendar);
  assert.deepEqual(kiteOrderFor(order), {
    exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: 10, product: 'MIS', order_type: 'MARKET',
    validity: 'DAY', variety: 'regular', market_protection: -1, autoslice: true, tag: 'ADVDC1',
  });
  const lim = kiteOrderFor({ ...order, orderType: 'LIMIT', price: 1503.4, tag: '' });
  assert.equal(lim.price, 1503.4);
  assert.ok(!('market_protection' in lim));
});

test('an order is sent once, on the second, with the stored session', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:00'));
  const sent = [];
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: async (args) => { sent.push({ ...args, at: clock.now().toISOString() }); return { order_id: '2510190001' }; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't', userId: 'AB1234' });
  const { order } = await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  assert.equal(order.status, 'scheduled');
  await clock.advance(59_000);
  assert.equal(sent.length, 0);
  await clock.advance(2_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].at, ist(MONDAY, '09:15:00').toISOString());
  assert.deepEqual([sent[0].apiKey, sent[0].accessToken, sent[0].order.tradingsymbol], ['k', 't', 'INFY']);
  const [done] = await sched.list();
  assert.deepEqual([done.status, done.result.orderId, done.result.latencyMs], ['placed', '2510190001', 0]);
  await sched.fire(order.id); // a second trigger does nothing
  assert.equal(sent.length, 1);
});

test('duplicates are refused; cancelled orders never send', async () => {
  const clock = fakeTime(ist(MONDAY, '09:00:00'));
  const sent = [];
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: async (a) => { sent.push(a); return { order_id: '1' }; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  const at = ist(MONDAY, '09:20:00').toISOString();
  const { order } = await sched.add({ ...base, triggerAt: at });
  await assert.rejects(sched.add({ ...base, triggerAt: at }), /already scheduled/);
  await sched.add({ ...base, quantity: 11, triggerAt: at }); // different quantity: a separate order
  await sched.cancel(order.id);
  await assert.rejects(sched.cancel(order.id), /already cancelled/);
  await assert.rejects(sched.cancel('S999'), /No such/);
  await clock.advance(30 * 60_000);
  assert.deepEqual(sent.map((s) => s.order.quantity), [11]);
});

test('no Kite session at the trigger time fails clearly; Kite errors are kept', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  let reject = null;
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: async () => { if (reject) throw new Error(reject); return { order_id: '9' }; },
  });
  await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await clock.advance(15_000);
  let [o] = await sched.list();
  assert.equal(o.status, 'failed');
  assert.match(o.result.error, /Kite was not connected/);

  sched.setSession({ apiKey: 'k', accessToken: 't' });
  reject = 'Insufficient funds. Required margin is 95000.00 but available margin is 1000.00.';
  await sched.add({ ...base, triggerAt: ist(MONDAY, '09:16:00').toISOString() });
  await clock.advance(60_000);
  [o] = await sched.list();
  assert.deepEqual([o.status, o.result.error.slice(0, 18)], ['failed', 'Insufficient funds']);
  assert.deepEqual(sched.setSession(null), { connected: false, userId: null });
});

test('after a restart: pending orders are re-armed, late ones are missed, never sent late', async () => {
  const store = memoryStore();
  const clock = fakeTime(ist(MONDAY, '09:00:00'));
  const first = createOrderScheduler({ store, calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, placeOrder: async () => ({}) });
  await first.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await first.add({ ...base, symbol: 'TCS', triggerAt: ist(MONDAY, '09:30:00').toISOString() });
  first.stop();
  // Nothing in the store holds the Kite token.
  assert.doesNotMatch(store.files.get('scheduled-orders.json'), /accessToken|token/i);

  // The backend comes back at 09:20: the 09:15 order is missed, the 09:30 one is re-armed.
  const later = fakeTime(ist(MONDAY, '09:20:00'));
  const sent = [];
  const second = createOrderScheduler({
    store, calendar, now: later.now, setTimer: later.setTimer, clearTimer: later.clearTimer,
    placeOrder: async (a) => { sent.push(a.order.tradingsymbol); return { order_id: '2' }; },
  });
  second.setSession({ apiKey: 'k', accessToken: 't' });
  const list = await second.list();
  assert.equal(list.find((o) => o.symbol === 'INFY').status, 'missed');
  assert.equal(list.find((o) => o.symbol === 'TCS').status, 'scheduled');
  await later.advance(11 * 60_000);
  assert.deepEqual(sent, ['TCS']);
  // New ids continue after the stored ones.
  const { order } = await second.add({ ...base, symbol: 'HDFCBANK', triggerAt: ist(MONDAY, '10:00:00').toISOString() });
  assert.equal(order.id, 'S3');
});

test('a timer that fires late (machine asleep) beyond the grace period does not send', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:00'));
  const sent = [];
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now,
    setTimer: () => 1, clearTimer: () => {}, // the timer never fires on its own
    placeOrder: async (a) => { sent.push(a); return {}; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  const { order } = await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await clock.advance(60_000 + ORDER_GRACE_MS + 1_000);
  await sched.fire(order.id);
  assert.equal(sent.length, 0);
  assert.equal((await sched.list())[0].status, 'missed');
  // Within the grace period it would still be sent.
  const { order: o2 } = await sched.add({ ...base, symbol: 'TCS', triggerAt: new Date(+clock.now() + MIN_LEAD_MS + 1_000).toISOString() });
  await clock.advance(MIN_LEAD_MS + 1_000 + ORDER_GRACE_MS - 5_000);
  await sched.fire(o2.id);
  assert.equal(sent.length, 1);
});

test('an order interrupted while sending is not resent after a restart', async () => {
  const store = memoryStore();
  await store.write('scheduled-orders.json', { orders: [{ id: 'S1', ...base, symbol: 'INFY', triggerAt: ist(MONDAY, '09:15:00').toISOString(), status: 'placing', result: null }] });
  const clock = fakeTime(ist(MONDAY, '09:15:05'));
  const sched = createOrderScheduler({ store, calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, placeOrder: async () => assert.fail('must not send') });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  const [o] = await sched.list();
  assert.equal(o.status, 'failed');
  assert.match(o.result.error, /Check the Kite order book/);
  await clock.advance(60_000);
});
