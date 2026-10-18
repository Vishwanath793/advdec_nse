import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiteClient, redactSecrets } from '../src/core/kite.js';
import { createKiteTicker, MAX_FAILED_OPENS, MAX_TOKENS_PER_CONNECTION, SILENCE_LIMIT_MS } from '../src/core/kiteTicker.js';
import { encodeTickerMessage } from '../src/core/kiteTicks.js';
import { compactInstruments, createInstrumentService, instrumentIndex } from '../src/core/instruments.js';
import { atrFromDayCandles, createHistoryService, createRateLimiter, openingVolumeAverage } from '../src/core/kiteHistory.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();

/** A controllable fake WebSocket and clock. */
function fakeSockets() {
  const sockets = [];
  let t = 0;
  const timers = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(x) { this.sent.push(JSON.parse(x)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
    open() { this.readyState = 1; this.onopen?.(); }
    fail() { this.readyState = 3; this.onclose?.({ code: 1006, reason: '' }); }
    message(data) { this.onmessage?.({ data }); }
  }
  return {
    FakeWS, sockets,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

test('ticker: subscribes in full mode, delivers ticks and order updates, ignores heartbeats', () => {
  const f = fakeSockets();
  const got = { ticks: [], orders: [], status: [] };
  const ticker = createKiteTicker({
    apiKey: 'key1234', accessToken: 'SECRETTOKEN123', WebSocketImpl: f.FakeWS, now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer,
    onTicks: (t, r) => got.ticks.push(...t.map((x) => ({ ...x, r }))), onOrder: (o) => got.orders.push(o), onStatus: (s) => got.status.push(s),
  });
  ticker.subscribe([408065, 884737]);
  ticker.connect();
  const ws = f.sockets[0];
  assert.equal(ws.url, 'wss://ws.kite.trade?api_key=key1234&access_token=SECRETTOKEN123');
  ws.open();
  assert.deepEqual(ws.sent, [{ a: 'subscribe', v: [408065, 884737] }, { a: 'mode', v: ['full', [408065, 884737]] }]);
  ws.message(encodeTickerMessage([{ token: 408065, mode: 'ltp', ltp: 1500 }]).buffer);
  ws.message(new Uint8Array([0]).buffer); // heartbeat
  ws.message(JSON.stringify({ type: 'order', data: { order_id: '1', status: 'COMPLETE' } }));
  ws.message(JSON.stringify({ type: 'error', data: 'bad token SECRETTOKEN123' }));
  assert.equal(got.ticks.length, 1);
  assert.equal(got.ticks[0].ltp, 1500);
  assert.deepEqual(got.orders, [{ order_id: '1', status: 'COMPLETE' }]);
  // The token never leaves through status messages.
  assert.ok(got.status.every((s) => !JSON.stringify(s).includes('SECRETTOKEN123')));
  assert.ok(got.status.some((s) => /bad token \*\*\*/.test(s.message ?? '')));
});

test('ticker: reconnects with backoff, re-subscribes, and treats a silent connection as dead', () => {
  const f = fakeSockets();
  const ticker = createKiteTicker({ apiKey: 'k12345', accessToken: 't12345', WebSocketImpl: f.FakeWS, now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  ticker.subscribe([1, 2]);
  ticker.connect();
  f.sockets[0].open();
  f.sockets[0].fail(); // dropped
  assert.equal(ticker.status().state, 'reconnecting');
  f.advance(1_000);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open();
  assert.deepEqual(f.sockets[1].sent[0], { a: 'subscribe', v: [1, 2] }); // re-subscribed
  // No messages for longer than the silence limit: closed and reopened.
  f.advance(SILENCE_LIMIT_MS + 1);
  assert.equal(f.sockets[1].readyState, 3);
  f.advance(1_000);
  assert.equal(f.sockets.length, 3);
  ticker.close();
  assert.equal(ticker.status().state, 'closed');
});

test('ticker: gives up after repeated failed connections (expired login) and caps subscriptions', () => {
  const f = fakeSockets();
  const statuses = [];
  const ticker = createKiteTicker({ apiKey: 'k12345', accessToken: 't12345', WebSocketImpl: f.FakeWS, now: f.now, setTimer: f.setTimer, clearTimer: f.clearTimer, onStatus: (s) => statuses.push(s) });
  const refused = ticker.subscribe(Array.from({ length: MAX_TOKENS_PER_CONNECTION + 5 }, (_, i) => i + 1));
  assert.equal(refused.length, 5);
  ticker.connect();
  for (let i = 0; i < MAX_FAILED_OPENS; i++) { f.sockets.at(-1).fail(); f.advance(60_000); }
  assert.equal(ticker.status().state, 'closed');
  assert.match(statuses.at(-1).message, /log in again/);
  assert.equal(f.sockets.length, MAX_FAILED_OPENS);
});

test('redaction and the gzipped instruments download', async () => {
  assert.equal(redactSecrets('token abc:SECRET123 failed', 'SECRET123'), 'token abc:*** failed');
  const { gzipSync, strToU8 } = await import('fflate');
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n408065,1594,INFY,INFOSYS,0,,0,0.05,1,EQ,NSE,NSE\n';
  const kite = createKiteClient({
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.kite.trade/instruments/NSE');
      assert.equal(init.headers.Authorization, 'token k:t');
      return { ok: true, status: 200, arrayBuffer: async () => gzipSync(strToU8(csv)).buffer };
    },
  });
  assert.equal(await kite.instrumentsCsv({ apiKey: 'k', accessToken: 't', exchange: 'NSE' }), csv);
});

const NSE = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '408065,1594,INFY,"INFOSYS, LTD",0,,0,0.1,1,EQ,NSE,NSE',
  '256265,1001,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE',
  '260105,1016,NIFTY BANK,NIFTY BANK,0,,0,0,0,EQ,INDICES,NSE',
  '999,9,INFY-BE,INFOSYS,0,,0,0.05,1,EQ,NSE,NSE',
].join('\n');
const NFO = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '111,1,INFY26NOVFUT,INFY,0,2026-11-24,0,0.1,400,FUT,NFO-FUT,NFO',
  '110,1,INFY26OCTFUT,INFY,0,2026-10-27,0,0.1,400,FUT,NFO-FUT,NFO',
  '100,1,INFY26SEPFUT,INFY,0,2026-09-29,0,0.1,400,FUT,NFO-FUT,NFO',
  '120,1,INFY26OCT1500CE,INFY,0,2026-10-27,1500,0.05,400,CE,NFO-OPT,NFO',
].join('\n');

test('instruments: equities, indices and the near-month future; a new day downloads again', async () => {
  const c = compactInstruments(NSE, NFO, '2026-10-19');
  const ix = instrumentIndex(c);
  assert.deepEqual(ix.equity('INFY'), { token: 408065, tick: 0.1, lot: 1 });
  assert.equal(ix.index('NSE:NIFTY 50'), 256265);
  assert.deepEqual(ix.future('INFY'), { token: 110, tradingsymbol: 'INFY26OCTFUT', expiry: '2026-10-27', lot: 400 }); // expired Sep skipped
  assert.equal(ix.byToken(110).underlying, 'INFY');
  assert.equal(ix.equity('NOPE'), null);

  const files = new Map();
  const store = { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, v); } };
  let downloads = 0;
  let day = '2026-10-19';
  const kite = { instrumentsCsv: async ({ exchange }) => { downloads++; return exchange === 'NSE' ? NSE.replace('408065', day === '2026-10-19' ? '408065' : '408099') : NFO; } };
  const svc = createInstrumentService({ store, kite, now: () => new Date(`${day}T08:30:00+05:30`) });
  await assert.rejects(svc.load({}), /Kite login needed/);
  let i = await svc.load({ apiKey: 'k', accessToken: 't' });
  await svc.load({ apiKey: 'k', accessToken: 't' });
  assert.equal(downloads, 2); // NSE + NFO once
  day = '2026-10-21'; // tokens can change: the next day's dump is downloaded fresh
  i = await svc.load({ apiKey: 'k', accessToken: 't' });
  assert.equal(downloads, 4);
  assert.equal(i.equity('INFY').token, 408099);
});

test('history: ATR from completed days only, opening-volume average, pacing at 3 a second', async () => {
  const d = (date, h, l, c) => [new Date(`${date}T09:15:00+05:30`), c, h, l, c, 1000];
  const days = Array.from({ length: 16 }, (_, i) => d(`2026-09-${String(10 + i).padStart(2, '0')}`, 102 + (i % 2), 98, 100));
  const today = '2026-10-19';
  const withToday = [...days, d(today, 500, 1, 250)]; // today's candle must be ignored
  const atr = atrFromDayCandles(withToday, today);
  assert.ok(Math.abs(atr - atrFromDayCandles(days, today)) < 1e-9);
  assert.ok(atr > 4 && atr < 5);
  assert.equal(atrFromDayCandles(days.slice(0, 5), today), null); // too few

  const minute = (date, time, v) => [new Date(`${date}T${time}:00+05:30`), 1, 1, 1, 1, v];
  const candles = [
    ...['09:15', '09:16', '09:17', '09:18', '09:19'].map((t) => minute('2026-10-15', t, 100)),
    ...['09:15', '09:16', '09:17', '09:18', '09:19'].map((t) => minute('2026-10-16', t, 300)),
    minute('2026-10-16', '09:20', 99999), // outside the window
    ...['09:15', '09:16'].map((t) => minute('2026-10-14', t, 5000)), // incomplete day: skipped
  ];
  assert.deepEqual(openingVolumeAverage(candles, today), { avg: 1000, days: 2 });

  // Pacing: requests start at least 334 ms apart.
  let t = 0;
  const starts = [];
  const limiter = createRateLimiter(3, { now: () => t, setTimer: (fn, ms) => { t += ms; fn(); } });
  await Promise.all([1, 2, 3, 4].map(() => limiter.run(async () => starts.push(t))));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 334);

  // The service caches per day and stops on an expired session.
  const files = new Map();
  const store = { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, v); } };
  let calls = 0;
  const kite = { historical: async ({ interval, oi }) => { calls++; return interval === 'day' ? (oi ? [[new Date(), 1, 1, 1, 1, 1, 1_234_000]] : days) : candles; } };
  const svc = createHistoryService({ store, kite, calendar, now: () => new Date(`${today}T09:11:00+05:30`), limiter: { run: (fn) => fn() } });
  const r = await svc.load([{ symbol: 'INFY', token: 1, futureToken: 2 }, { symbol: 'TCS', token: 3 }], { apiKey: 'k', accessToken: 't' });
  assert.equal(r.history.INFY.prevOi, 1_234_000);
  assert.equal(r.history.INFY.openVol5Avg, 1000);
  assert.equal(r.history.TCS.prevOi, null);
  assert.equal(calls, 5);
  await svc.load([{ symbol: 'INFY', token: 1 }], { apiKey: 'k', accessToken: 't' });
  assert.equal(calls, 5); // cached
  const expired = createHistoryService({ store: { read: async () => null, write: async () => {} }, kite: { historical: async () => { throw Object.assign(new Error('TokenException'), { status: 403 }); } }, calendar, now: () => new Date(`${today}T09:11:00+05:30`), limiter: { run: (fn) => fn() } });
  await assert.rejects(expired.load([{ symbol: 'INFY', token: 1 }], { apiKey: 'k', accessToken: 't' }), /TokenException/);
});
