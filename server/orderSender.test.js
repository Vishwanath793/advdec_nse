import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import {
  createOrderScheduler, createOrderSender, KITE_CHECK_MS, kiteTimeline, PREARM_MS,
} from '../src/core/orderScheduler.js';
import { createThreadSender, SENDER_STOPPED_MESSAGE } from './orderSender.js';
import { createKiteClient } from '../src/core/kite.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const ist = (iso, time) => new Date(`${iso}T${time}+05:30`);
const MONDAY = '2026-10-19';
const base = { symbol: 'JUSTDIAL', side: 'SELL', quantity: 1000, orderType: 'MARKET', product: 'MIS' };

function memoryStore() {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
}
function fakeTime(start) {
  let t = +start;
  const timers = new Map();
  let id = 0;
  return {
    now: () => new Date(t),
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
    clearTimer: (h) => timers.delete(h),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at).find(([, x]) => x.at <= end);
        if (!next) break;
        timers.delete(next[0]);
        t = Math.max(t, next[1].at);
        await next[1].fn();
        for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test('armed 2 s early: "placing" is saved and the session checked before the time; sent on the second', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  const store = memoryStore();
  const sent = [];
  const sched = createOrderScheduler({
    store, calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: async () => { sent.push(+clock.now()); return { order_id: '261019000001' }; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await clock.advance(10_000 - PREARM_MS + 1); // 09:14:58.001
  const saved = JSON.parse(store.files.get('scheduled-orders.json')).orders[0];
  assert.equal(saved.status, 'placing');
  assert.equal(saved.result.armedAt, new Date(+ist(MONDAY, '09:15:00') - PREARM_MS).toISOString());
  assert.equal(sent.length, 0);
  await clock.advance(PREARM_MS);
  assert.deepEqual(sent, [+ist(MONDAY, '09:15:00')]);
  const [o] = await sched.list();
  assert.deepEqual([o.status, o.result.sendDelayMs], ['placed', 0]);
});

test('a crash between arming and the time never sends the order (it may already be on its way)', async () => {
  const store = memoryStore();
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  const first = createOrderScheduler({
    store, calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: () => new Promise(() => {}), // the process "dies" before an answer
  });
  first.setSession({ apiKey: 'k', accessToken: 't' });
  await first.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await clock.advance(9_000); // armed at 09:14:58
  first.stop();
  const restarted = fakeTime(ist(MONDAY, '09:14:59'));
  const second = createOrderScheduler({ store, calendar, now: restarted.now, setTimer: restarted.setTimer, clearTimer: restarted.clearTimer, placeOrder: async () => assert.fail('must not send') });
  second.setSession({ apiKey: 'k', accessToken: 't' });
  const [o] = await second.list();
  assert.equal(o.status, 'failed');
  assert.match(o.result.error, /Check the Kite order book/);
  await restarted.advance(60_000);
});

test('sender: opens the connection before the time, keeps the spacing, never resends unknown outcomes', async () => {
  let t = 1_000_000;
  const events = [];
  const sender = createOrderSender({
    now: () => t,
    sleep: async (ms) => { t += ms; },
    warm: async () => { events.push(['warm', t]); },
    placeOrder: async ({ order }) => {
      events.push(['send', t, order.tradingsymbol]);
      if (order.tradingsymbol === 'LOST') throw Object.assign(new Error('Kite order failed: no response from Kite'), { status: 0, unknown: true });
      return { order_id: order.tradingsymbol };
    },
  });
  const due = t + PREARM_MS;
  const [a, b, lost] = await Promise.all(['A', 'B', 'LOST'].map((s) => sender.send({ order: { tradingsymbol: s }, session: { apiKey: 'k', accessToken: 't' }, due, grace: 20_000 })));
  assert.deepEqual(events[0], ['warm', 1_000_000]); // before the time
  assert.deepEqual(events.filter((e) => e[0] === 'send').map((e) => e[1] - due), [0, 120, 240]);
  assert.deepEqual([a.ok, a.orderId, b.ok], [true, 'A', true]);
  assert.deepEqual([lost.ok, lost.unknown, lost.attempts], [false, true, 1]);
});

test('sender with spin on real time: leaves within a couple of milliseconds of the time', async () => {
  const sent = [];
  const sender = createOrderSender({ placeOrder: async () => { sent.push(Date.now()); return { order_id: 'x' }; }, spin: true });
  const due = Date.now() + 300;
  const r = await sender.send({ order: {}, session: {}, due, grace: 20_000 });
  const late = sent[0] - due;
  assert.ok(late >= 0 && late <= 3, `sent ${late} ms after the time`);
  assert.equal(r.sentAt, sent[0]);
});

test('worker-thread sender: results come back from the thread; a dying worker fails its orders without resending', async () => {
  const sender = createThreadSender({ workerUrl: new URL('./fixtures/fakeOrderWorker.js', import.meta.url) });
  const keepAlive = setInterval(() => {}, 1000); // Node 22 (CI): keep the loop alive while waiting
  try {
    const due = Date.now() + 200;
    const ok = await sender.send({ order: { tradingsymbol: 'INFY' }, session: { apiKey: 'k', accessToken: 't' }, due, grace: 20_000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.orderId, 'fake-INFY');
    assert.ok(ok.sentAt - due >= 0 && ok.sentAt - due <= 5, `sent ${ok.sentAt - due} ms late`);
    // The main thread is blocked across the time (like the 09:15 tick flood): the worker still sends on time.
    const blockedDue = Date.now() + 300;
    const pendingResult = sender.send({ order: { tradingsymbol: 'HDFCBANK' }, session: {}, due: blockedDue, grace: 20_000 });
    const until = Date.now() + 600;
    while (Date.now() < until) { /* main thread busy */ }
    const blocked = await pendingResult;
    assert.ok(blocked.sentAt - blockedDue >= 0 && blocked.sentAt - blockedDue <= 5, `sent ${blocked.sentAt - blockedDue} ms late with the main thread blocked`);
    const crashed = await sender.send({ order: { tradingsymbol: 'CRASH' }, session: {}, due: Date.now(), grace: 20_000 });
    assert.deepEqual([crashed.ok, crashed.unknown, crashed.message], [false, true, SENDER_STOPPED_MESSAGE]);
    // The next order starts a new worker.
    const again = await sender.send({ order: { tradingsymbol: 'TCS' }, session: {}, due: Date.now(), grace: 20_000 });
    assert.equal(again.orderId, 'fake-TCS');
    // Closing with an order still in flight fails it the same way.
    const slow = sender.send({ order: { tradingsymbol: 'SLOW' }, session: {}, due: Date.now(), grace: 20_000 });
    await new Promise((r) => setTimeout(r, 50));
    await sender.close();
    assert.equal((await slow).message, SENDER_STOPPED_MESSAGE);
  } finally {
    clearInterval(keepAlive);
    await sender.close();
  }
});

test('the real sender worker starts (imports resolve) without contacting Kite', async () => {
  const w = new Worker(new URL('./orderSenderWorker.js', import.meta.url));
  await new Promise((resolve, reject) => { w.once('online', resolve); w.once('error', reject); });
  await new Promise((r) => setTimeout(r, 100)); // module evaluated; no job sent, so no request
  await w.terminate();
});

// ---- Network time: a timed order leaves at the chosen second of real time, not of this PC's clock ----

/** The PC clock reads `offset` ms behind network time: the PC is `-offset` ms ahead when offset is negative. */
function pcClockTest({ offset, startAt = '09:14:50' }) {
  // PC clock = network time − offset (offset = network − PC). Start 10 s before the chosen second.
  const clock = fakeTime(new Date(+ist(MONDAY, startAt) - offset));
  const sent = [];
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    clockOffsetMs: () => offset,
    placeOrder: async () => { sent.push(+clock.now()); return { order_id: 'net-time' }; },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  return { clock, sent, sched };
}

test('a PC clock 30 ms ahead: the order leaves at network 09:15:00.000, which is 09:15:00.030 on the PC', async () => {
  const due = ist(MONDAY, '09:15:00');
  const { clock, sent, sched } = pcClockTest({ offset: -30 });
  await sched.add({ ...base, triggerAt: due.toISOString() });
  await clock.advance(15_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0] - 30, +due); // the PC reads 30 ms later than network time at the moment of sending
  const [o] = await sched.list();
  assert.deepEqual([o.result.sentAt, o.result.sendDelayMs, o.result.clockOffsetMs], [due.toISOString(), 0, -30]);
});

test('a PC clock 2 s behind is corrected the same way', async () => {
  const due = ist(MONDAY, '09:15:00');
  const { clock, sent, sched } = pcClockTest({ offset: 2000, startAt: '09:14:50' });
  await sched.add({ ...base, triggerAt: due.toISOString() });
  await clock.advance(20_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0] + 2000, +due);
  const [o] = await sched.list();
  assert.equal(o.result.sendDelayMs, 0);
});

test('the scheduler exposes the network-clock status for the Orders page', () => {
  const status = { synced: true, offsetMs: -30, syncedAt: '2026-10-24T04:00:00.000Z', server: 'time.windows.com', rttMs: 17, error: null };
  const sched = createOrderScheduler({ store: memoryStore(), calendar, clockStatus: () => status, placeOrder: async () => ({}) });
  assert.deepEqual(sched.clock(), status);
  assert.equal(createOrderScheduler({ store: memoryStore(), calendar, placeOrder: async () => ({}) }).clock(), null);
});

// ---- Kite's own record of the order ----

/** Kite's history and trades for a market order like JUSTDIAL on 21 Oct 2026 (shape per the Kite Connect docs). */
const history = [
  { status: 'PUT ORDER REQ RECEIVED', order_timestamp: '2026-10-21 09:15:00', exchange_timestamp: null, exchange_update_timestamp: null, filled_quantity: 0, quantity: 1000, average_price: 0 },
  { status: 'VALIDATION PENDING', order_timestamp: '2026-10-21 09:15:00', exchange_timestamp: null, exchange_update_timestamp: null, filled_quantity: 0, quantity: 1000, average_price: 0 },
  { status: 'OPEN', order_timestamp: '2026-10-21 09:15:01', exchange_timestamp: '2026-10-21 09:15:01', exchange_update_timestamp: '2026-10-21 09:15:01', filled_quantity: 0, quantity: 1000, average_price: 0 },
  { status: 'COMPLETE', order_timestamp: '2026-10-21 09:15:02', exchange_timestamp: '2026-10-21 09:15:01', exchange_update_timestamp: '2026-10-21 09:15:02', filled_quantity: 1000, quantity: 1000, average_price: 698.6 },
];
const trades = [
  { trade_id: '2', fill_timestamp: '2026-10-21 09:15:02', exchange_timestamp: '2026-10-21 09:15:02', quantity: 400, average_price: 698.5 },
  { trade_id: '1', fill_timestamp: '2026-10-21 09:15:02', exchange_timestamp: '2026-10-21 09:15:02', quantity: 600, average_price: 698.67 },
];

test('Kite timeline: received by Kite, at the exchange, fills', () => {
  const k = kiteTimeline(history, trades);
  assert.deepEqual([k.status, k.receivedAt, k.exchangeAt, k.updatedAt], ['COMPLETE', '2026-10-21 09:15:00', '2026-10-21 09:15:01', '2026-10-21 09:15:02']);
  assert.deepEqual([k.filledQuantity, k.averagePrice, k.final], [1000, 698.6, true]);
  assert.deepEqual(k.fills.map((f) => f.quantity), [400, 600]);
  const open = kiteTimeline(history.slice(0, 3), []);
  assert.deepEqual([open.status, open.final, open.fills.length], ['OPEN', false, 0]);
  assert.equal(kiteTimeline([], []).status, null);
});

test('after placing, Kite\'s record is read at +5 s and again until final; a manual refresh reads it now', async () => {
  const clock = fakeTime(ist(MONDAY, '09:14:50'));
  const calls = [];
  let answer = { history: history.slice(0, 3), trades: [] }; // still open at the first look
  const sched = createOrderScheduler({
    store: memoryStore(), calendar, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    placeOrder: async () => ({ order_id: '261019000002' }),
    orderDetails: async (args) => {
      calls.push({ ...args, at: +clock.now() });
      if (!answer) throw new Error('Kite order history request failed');
      return answer;
    },
  });
  sched.setSession({ apiKey: 'k', accessToken: 't' });
  await sched.add({ ...base, triggerAt: ist(MONDAY, '09:15:00').toISOString() });
  await clock.advance(10_000 + KITE_CHECK_MS[0]);
  await settle();
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].orderId, calls[0].accessToken, calls[0].at - +ist(MONDAY, '09:15:00')], ['261019000002', 't', KITE_CHECK_MS[0]]);
  let [o] = await sched.list();
  assert.deepEqual([o.result.kite.status, o.result.kite.final], ['OPEN', false]);
  answer = { history, trades };
  await clock.advance(KITE_CHECK_MS[1]);
  await settle();
  [o] = await sched.list();
  assert.deepEqual([calls.length, o.result.kite.status, o.result.kite.exchangeAt], [2, 'COMPLETE', '2026-10-21 09:15:01']);
  assert.equal(o.result.sendDelayMs, 0); // the send result is kept alongside
  await clock.advance(KITE_CHECK_MS[2]); // final: no more looks
  assert.equal(calls.length, 2);
  // Manual refresh, and a Kite error is shown rather than thrown.
  answer = null;
  await sched.refreshKite(o.id);
  [o] = await sched.list();
  // A failed check keeps the last good record and says when it failed; it never replaces the record with an error.
  assert.equal(o.result.kite.error, undefined);
  assert.equal(o.result.kite.status, 'COMPLETE');
  assert.equal(o.result.kite.checkError, 'Kite order history request failed');
  await assert.rejects(sched.refreshKite('S99'), /No such/);
  sched.setSession(null);
  await sched.refreshKite(o.id);
  [o] = await sched.list();
  assert.match(o.result.kite.checkError, /not connected/);
  assert.equal(o.result.kite.status, 'COMPLETE');
});

test('the Kite client reads an order\'s history and trades from the documented endpoints', async () => {
  const urls = [];
  const kite = createKiteClient({ fetchImpl: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: url.endsWith('/trades') ? trades : history }) }; } });
  const h = await kite.orderHistory({ apiKey: 'k', accessToken: 't', orderId: '261021150040097' });
  const tr = await kite.orderTrades({ apiKey: 'k', accessToken: 't', orderId: '261021150040097' });
  await kite.profile({ apiKey: 'k', accessToken: 't' });
  assert.deepEqual(urls, [
    'https://api.kite.trade/orders/261021150040097',
    'https://api.kite.trade/orders/261021150040097/trades',
    'https://api.kite.trade/user/profile',
  ]);
  assert.equal(h.length, 4);
  assert.equal(tr.length, 2);
});
