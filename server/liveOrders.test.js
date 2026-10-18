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

test('Kite client: a real timeout (AbortSignal) is unknown, says so, and never leaks the token', async () => {
  const hanging = createKiteClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const err = await hanging.placeOrder({ apiKey: 'key123456', accessToken: 'secrettoken99', order: { exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: 1 }, timeoutMs: 30 }).catch((e) => e);
  assert.ok(err instanceof KiteError);
  assert.equal(err.unknown, true);
  assert.match(err.message, /timed out/);
  assert.match(err.message, /check your Kite order book before placing it again/);
  assert.ok(!err.message.includes('secrettoken99') && !err.message.includes('key123456'));
  // Reads (no order hint) are also unknown but not order-specific.
  const readErr = await hanging.orders({ apiKey: 'k', accessToken: 'tok123456', timeoutMs: 30 }).catch((e) => e);
  assert.equal(readErr.unknown, true);
  assert.doesNotMatch(readErr.message, /order book before placing/);
});

test('Kite client: modify, cancel, orders and trades send the documented requests', async () => {
  const calls = [];
  const kite = createKiteClient({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'success', data: url.endsWith('/trades') || url.endsWith('/orders') ? [] : { order_id: '7' } }) }; } });
  const s = { apiKey: 'k', accessToken: 'tok123456' };
  await kite.modifyOrder({ ...s, orderId: '7', params: { quantity: 5, trigger_price: 99.5, price: undefined } });
  await kite.cancelOrder({ ...s, orderId: '7' });
  await kite.orders(s);
  await kite.trades(s);
  assert.deepEqual(calls.map((c) => [c.init.method ?? 'GET', c.url.replace('https://api.kite.trade', '')]), [
    ['PUT', '/orders/regular/7'], ['DELETE', '/orders/regular/7'], ['GET', '/orders'], ['GET', '/trades'],
  ]);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { quantity: '5', trigger_price: '99.5' });
  assert.equal(calls[1].init.body, undefined);
  assert.ok(calls.every((c) => c.init.headers.Authorization === 'token k:tok123456' && c.init.headers['X-Kite-Version'] === '3'));
});

test('live order bodies match Kite fields: SL entry, LIMIT immediate entry, SL-M stop with protection, IOC target, MARKET exit', async () => {
  const { entryOrderBody, stopOrderBody, targetOrderBody, exitOrderBody } = await import('../src/utils/liveOrders.js');
  const { orderForm } = await import('../src/core/kite.js');
  const pos = { symbol: 'INFY', side: 'BUY', qty: 10, trigger: 1500.05, maxEntry: 1502.3, immediate: false };
  const form = (b) => Object.fromEntries(orderForm(b));
  assert.deepEqual(form(entryOrderBody(pos, 'L19E1INFY')), {
    exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'BUY', quantity: '10', product: 'MIS', order_type: 'SL', validity: 'DAY',
    price: '1502.3', trigger_price: '1500.05', tag: 'L19E1INFY',
  });
  assert.equal(form(entryOrderBody({ ...pos, immediate: true }, 't')).order_type, 'LIMIT');
  const stop = form(stopOrderBody(pos, 10, 1490, 't'));
  assert.deepEqual([stop.transaction_type, stop.order_type, stop.trigger_price, stop.market_protection], ['SELL', 'SL-M', '1490', '-1']);
  const target = form(targetOrderBody({ ...pos, side: 'SELL' }, 5, 1480, 't'));
  assert.deepEqual([target.transaction_type, target.order_type, target.validity, target.price], ['BUY', 'LIMIT', 'IOC', '1480']);
  const exit = form(exitOrderBody(pos, 10, 't'));
  assert.deepEqual([exit.order_type, exit.market_protection], ['MARKET', '-1']);
});

test('the /api/kite routes: no response → 502 with unknown; Kite statuses pass through; missing fields → 400', async () => {
  const express = (await import('express')).default;
  const { kiteRoute, kiteHttpStatus } = await import('./kiteRoute.js');
  assert.equal(kiteHttpStatus(new KiteError('x', 0)), 502);
  assert.equal(kiteHttpStatus(new KiteError('x', 403)), 403);
  const app = express();
  app.use(express.json());
  let fail = null;
  app.post('/r', kiteRoute(['a'], async () => { if (fail) throw fail; return { ok: 1 }; }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const post = async (body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/r`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  try {
    assert.deepEqual(await post({}), [400, { error: 'a is required' }]);
    assert.deepEqual(await post({ a: 1 }), [200, { ok: 1 }]);
    fail = new KiteError('Kite order failed: no response from Kite (timed out)', 0, null, { unknown: true });
    const [s0, b0] = await post({ a: 1 });
    assert.deepEqual([s0, b0.unknown], [502, true]);
    fail = new KiteError('Incorrect api_key or access_token.', 403, { error_type: 'TokenException' });
    const [s1, b1] = await post({ a: 1 });
    assert.deepEqual([s1, b1.unknown], [403, undefined]);
    fail = new TypeError('boom');
    assert.deepEqual(await post({ a: 1 }), [502, { error: 'Could not reach Kite: boom' }]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
