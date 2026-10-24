import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOrderScheduler } from '../src/core/orderScheduler.js';
import { addOrderRoutes } from './orderRoutes.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const ist = (iso, time) => new Date(`${iso}T${time}+05:30`);
const MONDAY = '2026-10-19';

/** A real HTTP server with the order routes, a scheduler clock on Monday 08:30 and no real Kite. */
async function startServer() {
  const files = new Map();
  const store = { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
  const timers = [];
  const scheduler = createOrderScheduler({
    store, calendar, now: () => ist(MONDAY, '08:30:00'),
    setTimer: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimer: () => {}, // nothing fires here
    placeOrder: async () => assert.fail('no order may be sent in these tests'),
  });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  addOrderRoutes(app, scheduler);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  return { call, files, close: () => new Promise((r) => server.close(r)), host: `127.0.0.1:${server.address().port}` };
}

const order = (patch = {}) => ({ symbol: 'INFY', side: 'BUY', quantity: 5, orderType: 'MARKET', product: 'MIS', triggerAt: ist(MONDAY, '09:15:00').toISOString(), ...patch });

test('routes: list, create, validate, cancel', async () => {
  const srv = await startServer();
  try {
    let r = await srv.call('GET', '/api/orders/scheduled');
    assert.deepEqual([r.status, r.json], [200, { orders: [], session: { connected: false, userId: null }, clock: null }]);

    r = await srv.call('POST', '/api/orders/scheduled', { order: order({ orderType: 'LIMIT', price: 1503.37 }) });
    assert.equal(r.status, 201);
    assert.deepEqual([r.json.order.id, r.json.order.price, r.json.orders.length], ['S1', 1503.4, 1]);
    assert.match(r.json.warnings[0], /rounded/);

    for (const [patch, re] of [
      [{ symbol: '' }, /valid NSE symbol/],
      [{ quantity: -1 }, /whole number/],
      [{ orderType: 'LIMIT' }, /limit price/],
      [{ triggerAt: ist(MONDAY, '16:00:00').toISOString() }, /between 09:00 and 15:30/],
      [{ triggerAt: ist('2026-10-20', '09:15:00').toISOString() }, /Dussehra/],
    ]) {
      r = await srv.call('POST', '/api/orders/scheduled', { order: order(patch) });
      assert.equal(r.status, 400);
      assert.match(r.json.error, re);
    }
    r = await srv.call('POST', '/api/orders/scheduled', {});
    assert.equal(r.status, 400);
    r = await srv.call('POST', '/api/orders/scheduled', '{not json');
    assert.equal(r.status, 400);

    r = await srv.call('DELETE', '/api/orders/scheduled/S1');
    assert.deepEqual([r.status, r.json.orders[0].status], [200, 'cancelled']);
    r = await srv.call('DELETE', '/api/orders/scheduled/S1');
    assert.equal(r.status, 400);
    r = await srv.call('DELETE', '/api/orders/scheduled/NOPE');
    assert.match(r.json.error, /No such/);
  } finally { await srv.close(); }
});

test('two identical requests at once schedule one order', async () => {
  const srv = await startServer();
  try {
    const [a, b] = await Promise.all([
      srv.call('POST', '/api/orders/scheduled', { order: order() }),
      srv.call('POST', '/api/orders/scheduled', { order: order() }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 400]);
    const list = await srv.call('GET', '/api/orders/scheduled');
    assert.equal(list.json.orders.length, 1);
  } finally { await srv.close(); }
});

test('the Kite session is accepted but never echoed back or saved', async () => {
  const srv = await startServer();
  try {
    let r = await srv.call('PUT', '/api/orders/session', { apiKey: 'key123', accessToken: 'SECRET-TOKEN', userId: 'AB1234' });
    assert.deepEqual(r.json, { connected: true, userId: 'AB1234' });
    await srv.call('POST', '/api/orders/scheduled', { order: order() });
    r = await srv.call('GET', '/api/orders/scheduled');
    assert.doesNotMatch(r.text, /SECRET-TOKEN|key123/);
    assert.ok(![...srv.files.values()].some((v) => v.includes('SECRET-TOKEN')));
    // Wrong types or an empty body clear it.
    r = await srv.call('PUT', '/api/orders/session', { apiKey: 1, accessToken: ['x'] });
    assert.equal(r.json.connected, false);
    await srv.call('PUT', '/api/orders/session', { apiKey: 'k', accessToken: 't' });
    r = await srv.call('PUT', '/api/orders/session', {});
    assert.equal(r.json.connected, false);
  } finally { await srv.close(); }
});

test('other websites are blocked; same-origin, proxied and tool requests are allowed', async () => {
  const srv = await startServer();
  try {
    for (const [method, path, body] of [
      ['GET', '/api/orders/scheduled'], ['POST', '/api/orders/scheduled', { order: order() }],
      ['PUT', '/api/orders/session', { apiKey: 'k', accessToken: 't' }], ['DELETE', '/api/orders/scheduled/S1'],
    ]) {
      const r = await srv.call(method, path, body, { Origin: 'https://evil.example' });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.match(r.json.error, /other sites/);
    }
    assert.equal((await srv.call('GET', '/api/orders/scheduled')).json.orders.length, 0); // nothing got through
    assert.equal((await srv.call('GET', '/api/orders/scheduled', undefined, { Origin: 'null' })).status, 403);
    // Same origin (the app served by the backend), through the Vite proxy or a tunnel, or no Origin (curl).
    assert.equal((await srv.call('GET', '/api/orders/scheduled', undefined, { Origin: `http://${srv.host}` })).status, 200);
    assert.equal((await srv.call('GET', '/api/orders/scheduled', undefined, { Origin: 'https://abc.ngrok.app', 'X-Forwarded-Host': 'abc.ngrok.app' })).status, 200);
    assert.equal((await srv.call('POST', '/api/orders/scheduled', { order: order() }, { Origin: `http://${srv.host}` })).status, 201);
  } finally { await srv.close(); }
});
