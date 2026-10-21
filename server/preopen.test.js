import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreopenService, normalizePreopen, validateSchedule } from './preopen.js';
import { analyze } from '../src/utils/analysis.js';

const payload = { data: [{
  symbol: 'HDFCBANK', prevClose: 693.8, finalPrice: 683.9, change: -9.9, perChange: -1.43,
  finalValue: 627059703.2, ffmMarketCap: 10452489461713.47, lastUpdateTime: '11-Sep-2026 09:08:47',
}] };

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nse-preopen-test-'));
  const file = join(directory, 'state.json');
  const services = [];
  const create = () => {
    const service = createPreopenService({ file, ...options });
    services.push(service);
    return service;
  };
  t.after(() => {
    services.forEach((service) => service.close());
    rmSync(directory, { recursive: true, force: true });
  });
  return { create, service: create() };
}

test('NSE mapping matches CSV units and feeds the analyzer', () => {
  const { rows, marketUpdatedAt } = normalizePreopen(payload);
  const result = analyze(rows, [{ Symbol: 'HDFCBANK', Industry: 'Financial Services', 'Company Name': 'HDFC Bank Ltd' }]);
  assert.equal(result.summary.declines, 1);
  assert.equal(result.stocks[0].prevClose, 693.8);
  assert.equal(result.stocks[0].finalPrice, 683.9);
  assert.equal(result.stocks[0].pctChange, -1.43);
  assert.equal(result.stocks[0].valueCr.toFixed(2), '62.71');
  assert.equal(result.stocks[0].ffmCap.toFixed(2), '1045248.95');
  // The master list here has no market cap, but the feed's free-float cap is there for the table and top movers.
  assert.equal(result.hasMarketCap, false);
  assert.equal(result.hasFreeFloatCap, true);
  assert.equal(marketUpdatedAt, '11-Sep-2026 09:08:47');
  assert.throws(() => normalizePreopen({ data: [] }), /no pre-open data/);
  assert.throws(() => normalizePreopen({ data: [{ symbol: 'X' }] }), /usable stock prices/);
  const missing = normalizePreopen({ data: [{ symbol: 'X', finalPrice: 0, change: 0, finalValue: 0 }] }).rows[0];
  assert.equal(missing.CHANGE, 0);
  assert.equal(missing['VALUE (₹ Crores)'], 0);
  assert.equal(missing['FFM CAP (₹ Crores)'], null);
});

test('real cron next execution is 09:10 IST and can change to midnight IST', (t) => {
  const { service } = fixture(t);
  const time = (value) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  assert.equal(time(service.status().nextRun), '09:10');
  service.update({ enabled: true, time: '00:00' });
  assert.equal(time(service.status().nextRun), '00:00');
  service.update({ enabled: false, time: '09:10' });
  assert.equal(service.status().nextRun, null);
});

test('schedule changes replace the previous job, persist, and scheduled callback fetches', async (t) => {
  const calls = [];
  const { service, create } = fixture(t, {
    fetchImpl: async () => Response.json(payload),
    schedule: (expression, callback, options) => {
      const entry = { expression, callback, options, destroyed: false };
      calls.push(entry);
      return { destroy() { entry.destroyed = true; }, getNextRun: () => new Date('2026-09-13T03:40:00Z') };
    },
  });
  assert.equal(calls[0].expression, '10 9 * * *');
  assert.equal(calls[0].options.timezone, 'Asia/Kolkata');
  service.update({ enabled: true, time: '09:12' });
  assert.equal(calls[0].destroyed, true);
  assert.equal(calls[1].expression, '12 9 * * *');
  await calls[1].callback();
  assert.equal(service.status().snapshot.rows.length, 1);
  service.update({ enabled: false, time: '09:12' });
  assert.equal(calls[1].destroyed, true);
  const restored = create();
  assert.deepEqual(restored.status().config, { enabled: false, time: '09:12' });
  assert.equal(restored.status().snapshot.rows[0].SYMBOL, 'HDFCBANK');
});

test('failures preserve the previous successful snapshot and report an error', async (t) => {
  let response = () => Response.json(payload);
  const { service } = fixture(t, { fetchImpl: async () => response() });
  await service.refresh();
  const successful = service.status().snapshot;
  for (const badResponse of [
    () => new Response('Denied', { status: 403 }),
    () => new Response('<html>Unavailable</html>', { headers: { 'content-type': 'text/html' } }),
    () => Response.json({ data: [] }),
    () => { throw new DOMException('timeout', 'TimeoutError'); },
  ]) {
    response = badResponse;
    await assert.rejects(service.refresh());
    assert.deepEqual(service.status().snapshot, successful);
    assert.ok(service.status().lastError);
    assert.equal(service.status().running, false);
  }
  response = () => Response.json(payload);
  await service.refresh();
  assert.equal(service.status().lastError, null);
});

test('overlapping imports share one request', async (t) => {
  let resolve;
  let count = 0;
  const { service } = fixture(t, { fetchImpl: () => {
    count++;
    return new Promise((done) => { resolve = done; });
  } });
  const first = service.refresh();
  const second = service.refresh();
  assert.equal(first, second);
  assert.equal(count, 1);
  assert.equal(service.status().running, true);
  resolve(Response.json(payload));
  await first;
  assert.equal(service.status().running, false);
});

test('reject invalid schedule values', () => {
  for (const time of ['9:10', '24:00', '09:60', '', '* * * * *']) {
    assert.throws(() => validateSchedule({ enabled: true, time }));
  }
  assert.throws(() => validateSchedule({ enabled: 'true', time: '09:10' }));
});

test('subscriptions send cached data once and only push changes without polling NSE', async (t) => {
  let requests = 0;
  const { service } = fixture(t, { fetchImpl: async () => {
    requests++;
    return Response.json(payload);
  } });
  const updates = [];
  const unsubscribe = service.subscribe((update) => updates.push(update));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].snapshot, null);
  assert.equal(requests, 0);
  service.status();
  service.update({ enabled: true, time: '09:12' });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].config.time, '09:12');
  assert.equal('snapshot' in updates[1], false);
  assert.equal(requests, 0);
  await service.refresh();
  assert.equal(requests, 1);
  assert.equal(updates[2].running, true);
  assert.equal('snapshot' in updates[2], false);
  assert.equal(updates[3].running, false);
  assert.equal(updates[3].snapshot.rows[0].SYMBOL, 'HDFCBANK');
  unsubscribe();
  service.update({ enabled: false, time: '09:12' });
  assert.equal(updates.length, 4);
  const reconnect = [];
  service.subscribe((update) => reconnect.push(update))();
  assert.equal(reconnect[0].snapshot.rows[0].SYMBOL, 'HDFCBANK');
  assert.equal(requests, 1);
});
