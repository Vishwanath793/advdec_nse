import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiteClient, KiteError } from '../src/core/kite.js';
import { classifyOrderError, liveConfirmText, liveTag, readKiteOrder, roundToTick } from '../src/utils/liveOrders.js';

test('live order tags are Kite-valid (alphanumeric, at most 20) and unique per role and sequence', () => {
  const a = liveTag('2026-10-19', 'M&M', 'entry', 1);
  const b = liveTag('2026-10-19', 'M&M', 'stop', 1);
  assert.match(a, /^[A-Za-z0-9]{1,20}$/);
  assert.notEqual(a, b);
  assert.ok(liveTag('2026-10-19', 'VERYLONGSYMBOLNAME123', 'exit', 12).length <= 20);
  assert.equal(liveConfirmText('2026-10-19'), 'LIVE 2026-10-19');
});

test('order errors: unknown outcomes are never treated as rejected', () => {
  assert.equal(classifyOrderError(new KiteError('x', 0, null, { unknown: true })), 'unknown');
  assert.equal(classifyOrderError(new KiteError('x', 503, null, { unknown: true })), 'unknown');
  assert.equal(classifyOrderError(new KiteError('IP (1.2.3.4) is not allowed to place orders for this app.', 400)), 'ip');
  assert.equal(classifyOrderError(new KiteError('x', 403, { error_type: 'TokenException' })), 'session');
  assert.equal(classifyOrderError(new KiteError('x', 429)), 'rate');
  assert.equal(classifyOrderError(new KiteError('Insufficient funds', 400)), 'rejected');
});

test('order-book rows are read as final or open; prices round to the tick', () => {
  const o = readKiteOrder({ order_id: '1', tag: 't', status: 'COMPLETE', filled_quantity: 10, pending_quantity: 0, average_price: 100.05 });
  assert.deepEqual([o.final, o.filled, o.avgPrice], [true, 10, 100.05]);
  assert.equal(readKiteOrder({ status: 'TRIGGER PENDING' }).open, true);
  assert.equal(roundToTick(100.03, 0.05, 1), 100.05);
  assert.equal(roundToTick(100.03, 0.05, -1), 100);
});

test('Kite client: no response is an unknown outcome; a 5xx is unknown; a 4xx is a known rejection', async () => {
  const session = { apiKey: 'k', accessToken: 'tok123456' };
  const order = { exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: 1 };
  const failing = createKiteClient({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(failing.placeOrder({ ...session, order }), (e) => e.unknown === true && e.status === 0);
  const respond = (status, body) => createKiteClient({ fetchImpl: async () => ({ ok: status < 400, status, json: async () => body }) });
  await assert.rejects(respond(502, {}).placeOrder({ ...session, order }), (e) => e.unknown === true);
  await assert.rejects(respond(400, { message: 'Insufficient funds' }).placeOrder({ ...session, order }), (e) => e.unknown === false && e.status === 400);
  const book = await respond(200, { data: [{ order_id: '9', status: 'OPEN' }] }).orders(session);
  assert.equal(book[0].order_id, '9');
});
