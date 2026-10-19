import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKiteClient, KiteError, orderForm, sha256Hex, summarizeMargins } from '../src/core/kite.js';

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init });
    const path = new URL(url).pathname;
    const [status, body] = routes[path] ?? [404, { message: 'not found' }];
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('checksum matches Node crypto (Kite session token exchange)', async () => {
  const text = 'apikey' + 'requesttoken' + 'secret';
  assert.equal(await sha256Hex(text), createHash('sha256').update(text).digest('hex'));
});

test('session exchange posts the checksum form', async () => {
  const { calls, fetchImpl } = mockFetch({ '/session/token': [200, { data: { user_id: 'AB1234', access_token: 'tok' } }] });
  const session = await createKiteClient({ fetchImpl }).createSession({ apiKey: 'k', apiSecret: 's', requestToken: 'r' });
  assert.equal(session.access_token, 'tok');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('checksum'), createHash('sha256').update('krs').digest('hex'));
  assert.equal(calls[0].method, 'POST');
});

test('positions come from data.net (Kite returns { net, day })', async () => {
  const { fetchImpl } = mockFetch({ '/portfolio/positions': [200, { data: { net: [{ tradingsymbol: 'TCS' }], day: [] } }] });
  assert.deepEqual(await createKiteClient({ fetchImpl }).positions({ apiKey: 'k', accessToken: 't' }), [{ tradingsymbol: 'TCS' }]);
});

test('autoslice: sent only for F&O exchanges, whatever the order type; never for NSE/BSE shares', () => {
  const o = { exchange: 'NSE', tradingsymbol: 'URBANCO', transaction_type: 'SELL', quantity: 1, product: 'MIS', order_type: 'MARKET', market_protection: -1, autoslice: true };
  for (const exchange of ['NSE', 'BSE']) assert.equal(orderForm({ ...o, exchange }).has('autoslice'), false, exchange);
  for (const exchange of ['NFO', 'BFO', 'MCX', 'CDS', 'BCD']) assert.equal(orderForm({ ...o, exchange }).get('autoslice'), 'true', exchange);
  assert.equal(orderForm({ ...o, exchange: 'NFO', autoslice: false }).get('autoslice'), 'false');
  assert.equal(orderForm({ ...o, exchange: 'NFO', autoslice: undefined }).has('autoslice'), false);
  // Nothing else in the form changes.
  const form = Object.fromEntries(orderForm(o));
  assert.deepEqual(form, { exchange: 'NSE', tradingsymbol: 'URBANCO', transaction_type: 'SELL', quantity: '1', product: 'MIS', order_type: 'MARKET', validity: 'DAY', market_protection: '-1' });
  assert.equal(Object.fromEntries(orderForm({ ...o, order_type: 'LIMIT', price: 101.5, market_protection: undefined })).price, '101.5');
});

test('the Analyzer BUY/SELL path (POST /api/kite/order) sends no autoslice for an NSE share', async () => {
  const express = (await import('express')).default;
  const { kiteRoute } = await import('./kiteRoute.js');
  const { calls, fetchImpl } = mockFetch({ '/orders/regular': [200, { data: { order_id: '9' } }] });
  const kite = createKiteClient({ fetchImpl });
  const app = express();
  app.use(express.json());
  app.post('/api/kite/order', kiteRoute(['apiKey', 'accessToken', 'order'], async (b) => ({ order: await kite.placeOrder(b) })));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    // The params App.jsx builds for a MARKET order with the default settings.
    const order = { exchange: 'NSE', tradingsymbol: 'URBANCO', transaction_type: 'SELL', quantity: 1, product: 'MIS', order_type: 'MARKET', validity: 'DAY', variety: 'regular', market_protection: -1, autoslice: true, tag: 'ADVDC' };
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/kite/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: 'k', accessToken: 'tok123456', order }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { order: { order_id: '9' } });
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.has('autoslice'), false);
    assert.equal(form.get('market_protection'), '-1');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('orders go to /orders/<variety> with the auth header', async () => {
  const { calls, fetchImpl } = mockFetch({ '/orders/amo': [200, { data: { order_id: '1' } }] });
  const order = { variety: 'amo', exchange: 'NSE', tradingsymbol: 'TCS', transaction_type: 'BUY', quantity: 2, autoslice: true };
  assert.deepEqual(await createKiteClient({ fetchImpl }).placeOrder({ apiKey: 'k', accessToken: 't', order }), { order_id: '1' });
  assert.equal(calls[0].headers.Authorization, 'token k:t');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('quantity'), '2');
  // NSE equity: Kite rejects autoslice ("Cannot autoslice this instrument"), so it isn't sent.
  assert.equal(form.has('autoslice'), false);
  assert.equal(form.has('variety'), false);
  // F&O contracts have freeze quantities: there it is sent.
  assert.equal(orderForm({ ...order, exchange: 'NFO', tradingsymbol: 'NIFTY26OCTFUT' }).get('autoslice'), 'true');
});

test('account summary reads /user/margins/equity fields', async () => {
  const { calls, fetchImpl } = mockFetch({ '/user/margins/equity': [200, { data: { net: 50000, available: { cash: 60000 }, utilised: { debits: 10000 } } }] });
  const account = await createKiteClient({ fetchImpl }).accountSummary({ apiKey: 'k', accessToken: 't' });
  assert.match(calls[0].url, /\/user\/margins\/equity$/);
  assert.deepEqual(account, { availableCash: 60000, net: 50000, utilized: 10000, accountValue: 60000, intradayLeverage: 1 });
  assert.equal(summarizeMargins({}).availableCash, 0);
});

test('Kite errors keep their status and message', async () => {
  const { fetchImpl } = mockFetch({ '/portfolio/positions': [403, { message: 'Incorrect `api_key` or `access_token`.' }] });
  await assert.rejects(createKiteClient({ fetchImpl }).positions({ apiKey: 'k', accessToken: 't' }),
    (e) => e instanceof KiteError && e.status === 403 && /access_token/.test(e.message));
});
