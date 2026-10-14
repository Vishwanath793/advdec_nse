import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhonePreopen, NOTIFY_DAYS, RETRY_MS } from '../src/platform/phonePreopen.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const payload = { data: [{ symbol: 'TCS', prevClose: 2125, finalPrice: 2156.9, change: 31.9, perChange: 1.5, lastUpdateTime: '13-Oct-2026 09:09:48' }] };

function phone({ at, fail = false } = {}) {
  const files = new Map();
  const store = { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, structuredClone(v)); } };
  let clock = new Date(at);
  const calls = [];
  const fetchImpl = async () => {
    calls.push(clock.toISOString());
    if (fail) return { ok: false, status: 503, headers: { get: () => 'text/html' } };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload };
  };
  const scheduled = [];
  const notifier = { schedule: async (runs) => scheduled.push(runs.map((d) => d.toISOString())) };
  const svc = createPhonePreopen({ store, fetchImpl, calendar, now: () => clock, notifier });
  return { svc, calls, scheduled, files, setTime: (t) => { clock = new Date(t); } };
}

test('fetches once after 09:10 IST on a trading day, not before and not twice', async () => {
  const p = phone({ at: '2026-10-13T09:05:00+05:30' }); // Tuesday
  await p.svc.tick();
  assert.equal(p.calls.length, 0);
  p.setTime('2026-10-13T09:12:00+05:30');
  await p.svc.tick();
  assert.equal(p.calls.length, 1);
  const status = await p.svc.status();
  assert.equal(status.snapshot.rows[0].SYMBOL, 'TCS');
  assert.equal(status.nextRun, '2026-10-14T03:40:00.000Z'); // next day 09:10 IST
  p.setTime('2026-10-13T14:00:00+05:30');
  await p.svc.tick();
  assert.equal(p.calls.length, 1); // today's data already loaded
  assert.ok(p.files.get('nse-preopen.json').snapshot); // persisted to app storage
});

test('weekends and NSE holidays do not fetch', async () => {
  const sat = phone({ at: '2026-10-10T10:00:00+05:30' });
  await sat.svc.tick();
  const holiday = phone({ at: '2026-09-14T10:00:00+05:30' }); // Ganesh Chaturthi
  await holiday.svc.tick();
  assert.equal(sat.calls.length + holiday.calls.length, 0);
});

test('a failed fetch is kept as lastError and retried after the back-off', async () => {
  const p = phone({ at: '2026-10-13T09:11:00+05:30', fail: true });
  await p.svc.tick();
  assert.match((await p.svc.status()).lastError, /HTTP 503/);
  p.setTime(new Date(Date.parse('2026-10-13T09:11:00+05:30') + RETRY_MS - 1000));
  await p.svc.tick();
  assert.equal(p.calls.length, 1);
  p.setTime(new Date(Date.parse('2026-10-13T09:11:00+05:30') + RETRY_MS + 1000));
  await p.svc.tick();
  assert.equal(p.calls.length, 2);
});

test('schedule changes are validated, persisted and reschedule trading-day reminders', async () => {
  const p = phone({ at: '2026-09-10T20:00:00+05:30' });
  await p.svc.update({ enabled: true, time: '09:15' });
  const runs = p.scheduled.at(-1);
  assert.equal(runs.length, NOTIFY_DAYS);
  assert.equal(runs[0], '2026-09-11T03:45:00.000Z'); // Fri 09:15 IST
  assert.ok(!runs.some((r) => r.startsWith('2026-09-12') || r.startsWith('2026-09-13') || r.startsWith('2026-09-14'))); // weekend + holiday
  await p.svc.update({ enabled: false, time: '09:15' });
  assert.deepEqual(p.scheduled.at(-1), []);
  assert.equal((await p.svc.status()).nextRun, null);
  await assert.rejects(p.svc.update({ enabled: true, time: '9am' }), /HH:mm/);
});

test('subscribers get the status once, then snapshot updates', async () => {
  const p = phone({ at: '2026-10-13T09:30:00+05:30' });
  const seen = [];
  const off = await p.svc.subscribe((u) => seen.push(u));
  await p.svc.refresh();
  off();
  assert.equal(seen[0].snapshot, null);
  assert.ok(seen.some((u) => u.snapshot?.rows?.length === 1));
});
