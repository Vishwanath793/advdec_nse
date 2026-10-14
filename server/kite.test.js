import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKiteClient, KiteError, sha256Hex, summarizeMargins } from '../src/core/kite.js';

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

test('orders go to /orders/<variety> with the auth header', async () => {
  const { calls, fetchImpl } = mockFetch({ '/orders/amo': [200, { data: { order_id: '1' } }] });
  const order = { variety: 'amo', exchange: 'NSE', tradingsymbol: 'TCS', transaction_type: 'BUY', quantity: 2, autoslice: true };
  assert.deepEqual(await createKiteClient({ fetchImpl }).placeOrder({ apiKey: 'k', accessToken: 't', order }), { order_id: '1' });
  assert.equal(calls[0].headers.Authorization, 'token k:t');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('quantity'), '2');
  assert.equal(form.get('autoslice'), 'true');
  assert.equal(form.has('variety'), false);
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
