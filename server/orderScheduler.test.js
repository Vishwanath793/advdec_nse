import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrderScheduler, kiteOrderFor, MIN_LEAD_MS, ORDER_GRACE_MS, validateScheduledOrder,
} from '../src/core/orderScheduler.js';
import { readCalendar } from './tv/calendar.js';
import { nextCheckDelay, RATE_RETRY_MS, RESULT_CHECK_MS, SEND_SPACING_MS, SENDING_CHECK_MS } from '../src/core/orderScheduler.js';
import { createKiteClient, KiteError } from '../src/core/kite.js';

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
  assert.deepEqual([done.status, done.result.orderId, done.result.sendDelayMs, done.result.attempts], ['placed', '2510190001', 0, 1]);
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

// ---- When the Orders page reloads the list ----

test('the Orders page reloads only around trigger times, never on a fixed interval', () => {
  const t = +ist(MONDAY, '09:00:00');
  const o = (status, time) => ({ status, triggerAt: ist(MONDAY, time).toISOString() });
  assert.equal(nextCheckDelay([], t), null);
  assert.equal(nextCheckDelay([o('placed', '08:00:00'), o('cancelled', '10:00:00'), o('missed', '09:00:00')], t), null); // nothing pending: no reloads
  assert.equal(nextCheckDelay([o('scheduled', '09:15:00'), o('scheduled', '09:20:00')], t), 15 * 60_000 + RESULT_CHECK_MS); // just after the next one
  assert.equal(nextCheckDelay([o('placing', '09:00:00'), o('scheduled', '09:20:00')], t), SENDING_CHECK_MS);
  assert.equal(nextCheckDelay([o('scheduled', '08:59:59')], t), SENDING_CHECK_MS); // overdue: result due any moment
  assert.equal(nextCheckDelay([o('scheduled', '09:15:00')], +ist('2026-09-01', '09:00:00')), 2 ** 31 - 1); // over ~24 days ahead: capped
});

// ---- Bursts, Kite errors and edge cases ----

const kiteError = (status, message, data = {}) => new KiteError(message, status, data);

function scheduler(clock, placeOrder, store = memoryStore()) {
  const s = createOrderScheduler({ store, calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, placeOrder });
  s.setSession({ apiKey: 'k', accessToken: 't' });
  return s;
}

test('12 orders due the same second all go out, spaced within Kite\'s 10-a-second limit', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:00'));
  const sentAt = [];
  const sched = scheduler(clock, async (a) => { sentAt.push({ at: +clock.now(), sym: a.order.tradingsymbol }); return { order_id: a.order.tradingsymbol }; });
  const at = ist(MONDAY, '09:15:00').toISOString();
  for (let i = 0; i < 12; i++) await sched.add({ ...base, symbol: `S${i}`, triggerAt: at });
  await clock.advance(70_000);
  assert.equal(sentAt.length, 12);
  for (let i = 1; i < sentAt.length; i++) assert.ok(sentAt[i].at - sentAt[i - 1].at >= SEND_SPACING_MS, `gap ${i}`);
  // No more than 10 requests in any one-second window.
  for (const s of sentAt) assert.ok(sentAt.filter((x) => x.at >= s.at && x.at < s.at + 1000).length <= 10);
  const list = await sched.list();
  assert.ok(list.every((o) => o.status === 'placed'));
  assert.equal(Math.max(...list.map((o) => o.result.sendDelayMs)), 11 * SEND_SPACING_MS);
});

test('Kite rate limit (429) is retried once; other errors are never resent', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  const script = [];
  let calls = 0;
  const sched = scheduler(clock, async () => { calls++; const next = script.shift(); if (next) throw next; return { order_id: 'ok' }; });
  const run = async (symbol, errors) => {
    script.push(...errors);
    calls = 0;
    const { order } = await sched.add({ ...base, symbol, triggerAt: new Date(+clock.now() + 5_000).toISOString() });
    await clock.advance(5_000 + RATE_RETRY_MS + 1_000);
    return { calls, o: (await sched.list()).find((x) => x.id === order.id) };
  };
  let r = await run('A', [kiteError(429, 'Too many requests')]);
  assert.deepEqual([r.calls, r.o.status, r.o.result.attempts], [2, 'placed', 2]);
  r = await run('B', [kiteError(429, 'Too many requests'), kiteError(429, 'Too many requests')]);
  assert.deepEqual([r.calls, r.o.status, r.o.result.attempts], [2, 'failed', 2]);
  r = await run('C', [kiteError(500, 'Kite is having trouble')]);
  assert.deepEqual([r.calls, r.o.status], [1, 'failed']); // may have reached Kite: not resent
  r = await run('D', [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]);
  assert.deepEqual([r.calls, r.o.status], [1, 'failed']);
  r = await run('E', [kiteError(403, 'Incorrect api_key or access_token.', { error_type: 'TokenException' })]);
  assert.equal(r.o.status, 'failed');
  assert.match(r.o.result.error, /^Kite session expired or invalid: log in to Kite again/);
  r = await run('F', [kiteError(400, 'Insufficient funds.', { error_type: 'MarginException' })]);
  assert.equal(r.o.result.error, 'Insufficient funds.');
});

test('with the real Kite client, no response from Kite fails the order once, never resends, and says to check the order book', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  let calls = 0;
  const kite = createKiteClient({ fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); } });
  const sched = scheduler(clock, (a) => kite.placeOrder(a));
  const { order } = await sched.add({ ...base, symbol: 'NET', triggerAt: new Date(+clock.now() + 5_000).toISOString() });
  await clock.advance(5_000 + RATE_RETRY_MS + 1_000);
  const o = (await sched.list()).find((x) => x.id === order.id);
  assert.deepEqual([calls, o.status, o.result.attempts], [1, 'failed', 1]);
  assert.match(o.result.error, /no response from Kite.*check your Kite order book before placing it again/);
});

test('a session set after scheduling is used; cancelling while sending is refused', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:00'));
  let release;
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: () => new Promise((resolve) => { release = () => resolve({ order_id: 'late-ok' }); }),
  });
  const { order } = await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  sched.setSession({ apiKey: 'k', accessToken: 't' }); // logged in after scheduling
  const advancing = clock.advance(61_000);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await sched.list())[0].status, 'placing');
  await assert.rejects(sched.cancel(order.id), /already placing/);
  release();
  await advancing;
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await sched.list())[0].status, 'placed');
});

test('the list shows waiting orders soonest first, then history newest first; history is capped', async () => {
  const clock = fakeTime(ist(MONDAY, '09:00:00'));
  const sched = scheduler(clock, async () => ({ order_id: 'x' }));
  await sched.add({ ...base, symbol: 'LATE', triggerAt: ist(MONDAY, '15:00:00').toISOString() });
  await sched.add({ ...base, symbol: 'SOON', triggerAt: ist(MONDAY, '09:30:00').toISOString() });
  for (let i = 0; i < 105; i++) {
    const { order } = await sched.add({ ...base, symbol: `H${i}`, triggerAt: new Date(ist(MONDAY, '10:00:00').getTime() + i * 1000).toISOString() });
    await sched.cancel(order.id);
  }
  const list = await sched.list();
  assert.deepEqual(list.slice(0, 2).map((o) => o.symbol), ['SOON', 'LATE']);
  assert.equal(list.length, 2 + 100); // the 100 most recent in history
  assert.equal(list[2].symbol, 'H104');
  assert.ok(!list.some((o) => o.symbol === 'H0'));
});

test('the Kite request: POST /orders/regular with exactly the right form fields', async () => {
  const calls = [];
  const kite = createKiteClient({
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'success', data: { order_id: '251019000123' } }) }; },
  });
  const now = ist(MONDAY, '09:00:00');
  const market = validateScheduledOrder({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString(), tag: 'ADVDC' }, now, calendar).order;
  const res = await kite.placeOrder({ apiKey: 'key', accessToken: 'tok', order: kiteOrderFor(market) });
  assert.equal(res.order_id, '251019000123');
  assert.equal(calls[0].url, 'https://api.kite.trade/orders/regular');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'token key:tok');
  assert.equal(calls[0].init.headers['X-Kite-Version'], '3');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: '10', product: 'MIS',
    order_type: 'MARKET', validity: 'DAY', market_protection: '-1', tag: 'ADVDC', // no autoslice for NSE equity
  });
  const limit = validateScheduledOrder({ ...base, side: 'SELL', orderType: 'LIMIT', price: 1503.4, product: 'CNC', triggerAt: ist(MONDAY, '09:20:00').toISOString() }, now, calendar).order;
  await kite.placeOrder({ apiKey: 'key', accessToken: 'tok', order: kiteOrderFor(limit) });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].init.body)), {
    exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: '10', product: 'CNC',
    order_type: 'LIMIT', validity: 'DAY', price: '1503.4',
  });
  // Kite's errors keep their HTTP status, which the retry rule relies on.
  const failing = createKiteClient({ fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ message: 'Too many requests', error_type: 'NetworkException' }) }) });
  const err = await failing.placeOrder({ apiKey: 'k', accessToken: 't', order: kiteOrderFor(market) }).catch((e) => e);
  assert.ok(err instanceof KiteError);
  assert.deepEqual([err.status, err.message], [429, 'Too many requests']);
});

test('real timers: the order leaves within a few milliseconds of the chosen second', async () => {
  // A clock that reads as Monday 09:14:58.5 now and runs in real time.
  const offset = +ist(MONDAY, '09:14:58.500') - Date.now();
  const now = () => new Date(Date.now() + offset);
  const sent = [];
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now,
    placeOrder: async () => { sent.push(now()); return { order_id: 'rt' }; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  const due = ist(MONDAY, '09:15:02'); // validation needs 3 s of lead time
  await sched.add({ ...base, triggerAt: due.toISOString() });
  await new Promise((r) => setTimeout(r, +due - +now() + 400));
  assert.equal(sent.length, 1);
  const delay = sent[0] - due;
  assert.ok(delay >= 0 && delay < 100, `sent ${delay} ms after the time`);
  sched.stop();
});
