import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpeningCollector, SEAL_GRACE_MS } from '../src/core/openingCollector.js';
import { compactInstruments, instrumentIndex } from '../src/core/instruments.js';
import { encodeTickerMessage } from '../src/core/kiteTicks.js';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';
import { readCalendar } from './tv/calendar.js';
import { createTradingDesk } from '../src/core/tradingDesk.js';

const calendar = readCalendar();
const DATE = '2026-10-19';
const ist = (time, date = DATE) => +new Date(`${date}T${time}+05:30`);

const NSE = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '11,1,AAA,AAA,0,,0,0.05,1,EQ,NSE,NSE',
  '12,1,BBB,BBB,0,,0,0.05,1,EQ,NSE,NSE',
  '256265,1,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE',
  '260105,1,NIFTY BANK,NIFTY BANK,0,,0,0,0,EQ,INDICES,NSE',
  '259849,1,NIFTY IT,NIFTY IT,0,,0,0,0,EQ,INDICES,NSE',
].join('\n');
const NFO = [
  'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange',
  '21,1,AAA26OCTFUT,AAA,0,2026-10-27,0,0.05,500,FUT,NFO-FUT,NFO',
].join('\n');

function harness({ start = ist('09:10:00'), candidatesDate = DATE, quoteError = null, trading = null } = {}) {
  let t = start;
  const timers = [];
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
    send(x) { this.sent.push(JSON.parse(x)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const files = new Map();
  const store = { files, read: async (n) => (files.has(n) ? structuredClone(files.get(n)) : null), write: async (n, v) => { files.set(n, structuredClone(v)); } };
  const logged = [];
  const updates = [];
  const stocks = [
    { symbol: 'AAA', sector: 'Information Technology', status: 'advance', pctChange: 1.5, convictionScore: 72, prevClose: 100, finalPrice: 101.5, finalVolume: 1000, band: 'none', upperCircuit: 120, lowerCircuit: 80 },
    { symbol: 'BBB', sector: 'Textiles', status: 'decline', pctChange: -0.8, convictionScore: 55, prevClose: 50, finalPrice: 49.6, finalVolume: 500, band: 20 },
    { symbol: 'CCC', sector: 'Textiles', status: 'advance', pctChange: 0.2, convictionScore: null, prevClose: 10, finalPrice: 10.02, band: 20 }, // under the minimum gap
  ];
  const collector = createOpeningCollector({
    store, calendar,
    kite: { quote: async () => { if (quoteError) throw quoteError; return { 'NSE:AAA': { upper_circuit_limit: 121.1, lower_circuit_limit: 81.1, ohlc: { close: 100.2 } } }; } },
    instruments: { load: async () => instrumentIndex(compactInstruments(NSE, NFO, DATE)) },
    history: { load: async (items) => ({ history: Object.fromEntries(items.map((i) => [i.symbol, { atr14: 2, openVol5Avg: 10_000, openVolDays: 10, prevOi: i.futureToken ? 900_000 : null }])), errors: [] }) },
    getCandidates: async () => ({ stocks, snapshotDate: candidatesDate }),
    tickLog: { open: () => {}, append: (ticks, r) => logged.push(...ticks.map((x) => ({ ...x, r }))), close: () => logged.push('closed') },
    WebSocketImpl: FakeWS,
    now: () => new Date(t),
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    onUpdate: (u) => updates.push(u),
    trading,
  });
  return {
    collector, store, files, sockets, logged, updates,
    now: () => t,
    async advanceTo(time) {
      const end = typeof time === 'number' ? time : ist(time);
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        await next.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

test('holidays and unknown calendar years fail closed; no Kite session asks for a login', async () => {
  let h = harness({ start: ist('09:10:00', '2026-10-20') });
  assert.equal((await h.collector.wake()).phase, 'closed'); // Dussehra
  h = harness({ start: ist('09:10:00', '2027-01-04') });
  const s = await h.collector.wake();
  assert.equal(s.phase, 'closed');
  assert.match(s.message, /Holiday calendar missing for 2027/);
  h = harness();
  assert.equal((await h.collector.prepare()).phase, 'needs-kite');
  h.collector.setSession({ apiKey: 'k', accessToken: 't' });
  h = harness({ candidatesDate: '2026-10-16' });
  h.collector.setSession({ apiKey: 'k', accessToken: 't' });
  assert.equal((await h.collector.prepare()).phase, 'waiting'); // yesterday's pre-open only
  h = harness({ quoteError: Object.assign(new Error('Token expired'), { status: 403 }) });
  h.collector.setSession({ apiKey: 'k', accessToken: 't' });
  assert.equal((await h.collector.prepare()).phase, 'needs-kite');
});

test('a full morning: prepare, connect at 09:14, collect, seal at 09:20, record to 09:25, stop at 09:30', async () => {
  const h = harness();
  h.collector.setSession({ apiKey: 'k12345', accessToken: 'tok12345' });
  const st = await h.collector.wake();
  assert.equal(st.phase, 'ready');
  assert.deepEqual([st.universe.stocks, st.universe.futures, st.universe.indices], [2, 1, 3]); // CCC under the min gap
  const uni = h.files.get(`opening/${DATE}-universe.json`);
  const aaa = Object.values(uni.meta).find((m) => m.symbol === 'AAA');
  assert.deepEqual([aaa.upperCircuit, aaa.prevClose, aaa.prevCloseMismatch.nse, aaa.atr14, aaa.sectorIndex], [121.1, 100.2, 100, 2, 'NIFTY IT']);
  assert.equal(Object.values(uni.meta).find((m) => m.kind === 'future').prevOi, 900_000);
  assert.ok(!JSON.stringify([...h.files.values()]).includes('tok12345')); // the token is never stored

  await h.advanceTo('09:13:59');
  assert.equal(h.sockets.length, 0);
  await h.advanceTo('09:14:00');
  assert.equal(h.sockets.length, 1);
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen();
  assert.deepEqual(ws.sent[0].v.sort(), [11, 12, 21, 256265, 259849, 260105].sort());
  assert.deepEqual(ws.sent[1].v[0], 'full');
  assert.equal(h.collector.status().phase, 'collecting');

  const send = async (time, ticks) => { await h.advanceTo(ist(time) + 50); ws.onmessage({ data: encodeTickerMessage(ticks).buffer }); };
  const tk = (token, time, ltp, volume) => ({ token, ltp, volume, avgPrice: ltp, buyQty: 1, sellQty: 1, open: 101.5, high: Math.max(ltp, 102), low: 101, close: 100.2, exchangeTime: ist(time), depth: { buy: [{ qty: 100, price: ltp - 0.05, orders: 1 }], sell: [{ qty: 100, price: ltp + 0.05, orders: 1 }] } });
  await send('09:14:30', [tk(11, '09:14:30', 101.5, 1000)]);
  await send('09:15:10', [tk(11, '09:15:10', 101.8, 3000), { token: 256265, index: true, ltp: 23010, open: 23000, high: 23010, low: 23000, close: 22950, change: 0, exchangeTime: ist('09:15:10') }]);
  await send('09:19:59', [tk(11, '09:19:59', 102.4, 9000)]);
  await send('09:20:00', [tk(11, '09:20:00', 105, 20_000)]); // must not count
  await h.advanceTo(ist('09:20:00') + SEAL_GRACE_MS);
  const sealed = h.files.get(`opening/${DATE}.json`);
  assert.ok(sealed, 'sealed features saved');
  const f = sealed.stocks.find((x) => x.symbol === 'AAA');
  assert.deepEqual([f.ltp, f.windowVolume], [102.4, 8000]);
  assert.equal(sealed.partialFrom, null);
  assert.equal(h.collector.status().phase, 'sealed');
  const lastUpdate = h.updates.at(-1);
  assert.equal(lastUpdate.sealed, true);
  assert.equal(lastUpdate.rows.find((r) => r.symbol === 'AAA').ret5Pct.toFixed(3), (((102.4 - 101.5) / 101.5) * 100).toFixed(3));

  await send('09:24:00', [tk(11, '09:24:00', 103, 30_000)]);
  await send('09:26:00', [tk(11, '09:26:00', 103, 31_000)]); // after the recording window
  assert.equal(h.logged.filter((x) => x !== 'closed').length, 6); // 09:14:30 … 09:24:00, not 09:26
  assert.ok(h.logged.every((x) => x === 'closed' || (x.r && x.exchangeTime))); // both clocks kept
  await h.advanceTo('09:30:00');
  assert.equal(ws.readyState, 3);
  assert.equal(h.logged.at(-1), 'closed');
});

test('restarts: after the seal the saved window is shown and nothing reconnects; a late start is partial', async () => {
  const h = harness();
  h.collector.setSession({ apiKey: 'k', accessToken: 't' });
  await h.collector.wake();
  await h.advanceTo('09:14:00');
  h.sockets[0].readyState = 1; h.sockets[0].onopen();
  await h.advanceTo(ist('09:20:00') + SEAL_GRACE_MS);
  // A new backend at 09:40 with the same files.
  const h2 = harness({ start: ist('09:40:00') });
  for (const [k, v] of h.files) h2.files.set(k, v);
  h2.collector.setSession({ apiKey: 'k', accessToken: 't' });
  const s = await h2.collector.wake();
  assert.equal(s.phase, 'sealed');
  await h2.advanceTo('10:00:00');
  assert.equal(h2.sockets.length, 0);
  // A backend started at 09:25 without a sealed window: missed.
  const h3 = harness({ start: ist('09:25:00') });
  h3.collector.setSession({ apiKey: 'k', accessToken: 't' });
  assert.equal((await h3.collector.wake()).phase, 'missed');
  // Started at 09:17: connects at once and is flagged partial.
  const h4 = harness({ start: ist('09:17:00') });
  h4.collector.setSession({ apiKey: 'k', accessToken: 't' });
  await h4.collector.wake();
  assert.equal(h4.sockets.length, 1);
  assert.equal(h4.collector.status().partialFrom, new Date(ist('09:17:00')).toISOString());
});

test('the Kite setup self-check: read-only steps, clear failures, no token in the result', async () => {
  const h = harness({ start: ist('08:45:00') });
  assert.equal((await h.collector.selfTest()).ok, false); // not logged in
  h.collector.setSession({ apiKey: 'k12345', accessToken: 'tok12345' });
  const pending = h.collector.selfTest({ symbol: 'AAA', waitMs: 8_000 });
  for (let i = 0; i < 20 && !h.sockets.length; i++) await new Promise((r) => setImmediate(r));
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen();
  ws.onmessage({ data: encodeTickerMessage([
    { token: 11, ltp: 101, volume: 5, avgPrice: 100, buyQty: 1, sellQty: 1, open: 100, high: 101, low: 99, close: 100, exchangeTime: ist('08:44:00') },
    { token: 256265, index: true, ltp: 23000, open: 1, high: 1, low: 1, close: 1, change: 0, exchangeTime: ist('08:44:00') },
  ]).buffer });
  // The fake kite client has no historical(): that step fails, the others pass.
  const r = await pending;
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['Instruments dump', true], ['Historical candles', false], ['Quote API', true], ['WebSocket (full mode)', true]]);
  assert.match(r.steps[3].detail, /AAA: full packet, last 101/);
  assert.ok(!JSON.stringify(r).includes('tok12345'));
  assert.equal(ws.readyState, 3); // closed again
});

test('replaying the simulated morning seals all 13 stocks without Kite and writes no day files', async () => {
  const h = harness({ start: ist('16:00:00') });
  const sim = simulatedMorning();
  h.collector.replay(sim, { speed: 50 });
  assert.equal(h.collector.status().source, 'replay');
  await h.advanceTo(ist('16:00:30')); // 30 s real × 50 = 25 virtual minutes
  const st = h.collector.status();
  assert.equal(st.phase, 'sealed');
  const last = h.updates.at(-1);
  assert.equal(last.rows.length, 13);
  assert.equal(last.sealed, true);
  assert.ok(!h.files.has(`opening/${sim.date}.json`));
  assert.equal(h.collector.stockDetail('GAPPULL').candles.length, 5);
});

test('a replay hands the seal and the later ticks to the trading desk (replay ledger only)', async () => {
  const files = new Map();
  const deskStore = { read: async (n) => files.get(n) ?? null, write: async (n, v) => { files.set(n, v); } };
  const desk = createTradingDesk({ store: deskStore, log: { append: () => assert.fail('the replay writes no log'), read: () => [] }, calendar });
  const h = harness({ start: ist('16:00:00'), trading: desk });
  h.collector.replay(simulatedMorning(), { speed: 50 });
  await h.advanceTo(ist('16:00:30'));
  const v = desk.view('replay');
  assert.equal(v.decisions.length, 13);
  assert.equal(v.ledgerState.trades, 2);
  assert.equal(v.ledgerState.positions.every((p) => p.status === 'CLOSED'), true, 'everything closed by the end of the replay');
  assert.equal(h.collector.status().message, 'Replay finished.');
  assert.equal(files.size, 0);
});

test('live day: the desk gets the seal and later ticks; open paper positions keep streaming after 09:30', async () => {
  const seen = { sealed: null, ticks: [] };
  const trading = {
    onSeal: async (s, o) => { seen.sealed = { date: s.date, ...o }; },
    onTicks: (ticks, r, o) => { if (!o.replay) seen.ticks.push(...ticks.map((t) => t.token)); },
    keepTokens: () => [11],
  };
  const h = harness({ trading });
  h.collector.setSession({ apiKey: 'k', accessToken: 't' });
  await h.collector.wake();
  await h.advanceTo('09:14:00');
  const ws = h.sockets[0];
  ws.readyState = 1; ws.onopen();
  await h.advanceTo(ist('09:20:00') + SEAL_GRACE_MS);
  assert.deepEqual(seen.sealed, { date: DATE, replay: false });
  await h.advanceTo(ist('09:21:00'));
  ws.onmessage({ data: encodeTickerMessage([{ token: 11, ltp: 103, volume: 5, avgPrice: 103, buyQty: 1, sellQty: 1, open: 101, high: 103, low: 101, close: 100, exchangeTime: ist('09:21:00') }]).buffer });
  assert.deepEqual(seen.ticks, [11]);
  await h.advanceTo(ist('09:30:00') - 1);
  const before = h.sockets.length; // the main ticker may have reconnected while the market was quiet
  await h.advanceTo('09:30:00');
  assert.ok(h.sockets.slice(0, before).every((x) => x.readyState === 3), 'the main connection is closed');
  assert.equal(h.sockets.length, before + 1, 'a new connection follows the open position');
  const follow = h.sockets.at(-1);
  follow.readyState = 1; follow.onopen();
  assert.deepEqual(follow.sent[0].v, [11]);
  h.collector.unfollow();
  assert.equal(follow.readyState, 3);
});
