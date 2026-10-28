import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { unzipSync, strFromU8 } from 'fflate';
import { simulatedMorning, SIMULATED_DATE } from '../src/utils/simulatedMorning.js';
import { ticksToCandles } from '../src/utils/ticksToCandles.js';
import { backtestSheets, replaySheets } from '../src/utils/researchExport.js';
import { readCalendar } from './tv/calendar.js';
import { createTickLog } from './tickLog.js';
import { addResearchRoutes, inResearchQuiet } from './researchRoutes.js';

// Milestone 3 part 2: the research routes run a candle backtest and a tick replay in a worker, save and export them.

const calendar = readCalendar();
const memStore = () => {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
};
const at = (time, date) => new Date(`${date}T${time}:00+05:30`);

/** The simulated morning as a candle day on `date` (as in backtest.test.js). */
function simulatedCandleDay(date) {
  const sim = simulatedMorning();
  const shift = +at('09:15', date) - +at('09:15', sim.date);
  const byToken = new Map();
  for (const { tick } of sim.ticks) {
    if (!byToken.has(tick.token)) byToken.set(tick.token, []);
    byToken.get(tick.token).push({ ...tick, exchangeTime: tick.exchangeTime + shift });
  }
  const stocks = [];
  const indices = {};
  for (const [token, m] of Object.entries(sim.instruments)) {
    const candles = ticksToCandles(byToken.get(Number(token)) ?? []);
    if (m.kind === 'index') indices[m.symbol] = candles;
    if (m.kind === 'stock') stocks.push({ meta: { ...m, token: Number(token) }, candles });
  }
  return { date, recorded: false, stocks, indices };
}
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21'];

async function serve({ session = { apiKey: 'k', accessToken: 't' }, now = () => new Date('2026-10-28T12:00:00+05:30'), loadDays } = {}) {
  const ticksDir = mkdtempSync(join(tmpdir(), 'ticks-'));
  // One recorded morning, written the way the collector writes it.
  const sim = simulatedMorning();
  const log = createTickLog(ticksDir);
  log.open(sim.date, { meta: sim.instruments });
  for (const { tick, receivedAt } of sim.ticks) log.append([tick], receivedAt);
  log.close();
  const store = memStore();
  const calls = [];
  const app = express();
  app.use(express.json());
  addResearchRoutes(app, {
    store, calendar, ticksDir, now, session: () => session, tradingSettings: () => ({}),
    data: {
      loadDays: loadDays ?? (async (a) => {
        calls.push(a);
        a.onProgress({ stage: 'Kite 1-minute candles (stocks)', done: 1, total: 2 });
        return { days: DAYS.map(simulatedCandleDay), skipped: { noToken: [] }, requests: 3 };
      }),
    },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const get = (path) => fetch(`${base}${path}`);
  const waitDone = async () => {
    for (let i = 0; i < 400; i++) {
      const s = await (await get('/api/research/status')).json();
      if (s.job && s.job.state !== 'running') return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the job did not finish');
  };
  return { base, post, get, waitDone, store, calls, close: () => { server.close(); rmSync(ticksDir, { recursive: true, force: true }); } };
}

test('candle backtest: runs in the background, saved, readable, exported to Excel; one job at a time', async () => {
  const s = await serve();
  try {
    const status0 = await (await s.get('/api/research/status')).json();
    assert.deepEqual(status0.recordedTickDays, [SIMULATED_DATE]);
    assert.equal(status0.kiteConnected, true);
    const bad = await s.post('/api/research/backtest', { from: '2026-10-20', to: '2026-10-01' });
    assert.equal(bad.status, 400);
    const started = await s.post('/api/research/backtest', { from: '2026-10-12', to: '2026-10-21', maxPerDay: 99, settings: { scoring: { minScore: 60 } } });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).state, 'running');
    const busy = await s.post('/api/research/replay', {});
    assert.ok([200, 409].includes(busy.status)); // 409 while the backtest still runs
    const done = await s.waitDone();
    assert.equal(done.job.state, 'done', done.job.error);
    assert.equal(s.calls[0].maxPerDay, 50); // clamped
    const r = await (await s.get('/api/research/result/backtest')).json();
    assert.equal(r.days, DAYS.length);
    assert.equal(r.settings.scoring.minScore, 60); // this run's override
    assert.equal(r.requests, 3);
    assert.ok(r.variants.find((v) => v.key === 'combined').summary.trades > 0);
    assert.ok(r.walkForward.steps.length > 0);
    const x = await s.get('/api/research/export/backtest.xlsx');
    assert.equal(x.status, 200);
    assert.match(x.headers.get('content-disposition'), /Backtest_.*\.xlsx/);
    const files = unzipSync(new Uint8Array(await x.arrayBuffer()));
    assert.match(strFromU8(files['xl/workbook.xml']), /Comparison.*Walk-forward.*Trades/s);
    assert.equal((await s.get('/api/research/export/nothing.xlsx')).status, 404);
  } finally { s.close(); }
});

test('tick replay of recorded mornings: the same decision and paper fills as live, saved and exported', async () => {
  const s = await serve();
  try {
    assert.equal((await s.post('/api/research/replay', {})).status, 200);
    const done = await s.waitDone();
    assert.equal(done.job.state, 'done', done.job.error);
    const r = await (await s.get('/api/research/result/replay')).json();
    assert.deepEqual(r.days.map((d) => d.date), [SIMULATED_DATE]);
    assert.ok(r.trades.some((t) => t.symbol === 'ORBUP'));
    assert.ok(r.limitations.some((l) => /09:25/.test(l)));
    const sheets = replaySheets(r);
    assert.deepEqual(sheets.map((x) => x.name), ['About', 'Summary', 'Breakdowns', 'Trades', 'Not filled', 'Settings']);
    assert.equal((await s.get('/api/research/export/replay.xlsx')).status, 200);
    // Asking for days that weren't recorded.
    assert.equal((await s.post('/api/research/replay', { dates: ['2026-10-01'] })).status, 400);
  } finally { s.close(); }
});

test('refused: no Kite session, the opening window, other origins; a failed load is reported; cancel stops a job', async () => {
  const noKite = await serve({ session: null });
  try {
    const r = await noKite.post('/api/research/backtest', { from: '2026-10-12', to: '2026-10-21' });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Connect to Kite/);
    const cross = await fetch(`${noKite.base}/api/research/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
  } finally { noKite.close(); }

  const morning = await serve({ now: () => new Date('2026-10-28T09:20:00+05:30') });
  try {
    assert.equal((await morning.post('/api/research/replay', {})).status, 503);
    assert.equal((await (await morning.get('/api/research/status')).json()).quietNow, true);
  } finally { morning.close(); }
  assert.equal(inResearchQuiet(new Date('2026-10-25T09:20:00+05:30'), calendar), false); // a Sunday
  assert.equal(inResearchQuiet(new Date('2026-10-28T09:40:00+05:30'), calendar), false);

  const failing = await serve({ loadDays: async () => { throw new Error('Kite: Too many requests'); } });
  try {
    await failing.post('/api/research/backtest', { from: '2026-10-12', to: '2026-10-21' });
    const done = await failing.waitDone();
    assert.equal(done.job.state, 'failed');
    assert.match(done.job.error, /Too many requests/);
    assert.equal((await failing.get('/api/research/result/backtest')).status, 404); // nothing saved
  } finally { failing.close(); }

  let release;
  const slow = await serve({ loadDays: (a) => new Promise((resolve, reject) => { release = resolve; a.signal.addEventListener('abort', () => reject(new Error('Cancelled.'))); }) });
  try {
    await slow.post('/api/research/backtest', { from: '2026-10-12', to: '2026-10-21' });
    const c = await (await slow.post('/api/research/cancel')).json();
    assert.ok(c.job);
    const done = await slow.waitDone();
    assert.equal(done.job.state, 'cancelled');
    release?.({ days: [] });
  } finally { slow.close(); }
});

test('the backtest workbook has every section, with the BACKTEST label and the limitations', () => {
  const summary = { trades: 1, days: 1, wins: 1, losses: 0, winRate: 1, avgWin: 10, avgLoss: null, profitFactor: Infinity, net: 10, charges: 1, maxDrawdown: 0, expectancy: 10, expectancyR: 0.5, avgRewardRisk: 2, longestLosingStreak: 0 };
  const sheets = backtestSheets({
    ranAt: '2026-10-28T12:00:00Z', first: '2026-10-12', last: '2026-10-21', days: 8, recordedDays: 0, stocksTested: 104, requests: 3,
    variants: [{ key: 'combined', label: 'Combined', summary }], breakdowns: { strategy: [{ key: 'orb', ...summary }] },
    slippage: [{ bps: 5, summary }], sweeps: [{ key: 'minScore', label: 'Minimum score', values: [{ value: 70, summary }] }],
    oos: { skipped: 'needs at least 4 days' }, walkForward: { skipped: 'needs at least 8 days' },
    trades: [{ date: '2026-10-12', symbol: 'ORBUP', strategy: 'orb', side: 'BUY', qty: 10, entry: 100, exits: [{ qty: 10, price: 101, kind: 'target2' }], net: 10 }],
    notFilled: [], limitations: ['Minute candles can\'t reproduce fills.'], settings: { risk: { capital: 100000 } },
  });
  assert.deepEqual(sheets.map((x) => x.name), ['About', 'Comparison', 'Breakdowns', 'Slippage', 'Sweeps', 'Out of sample', 'Walk-forward', 'Trades', 'Not filled', 'Settings']);
  assert.match(sheets[0].rows[0][0], /^BACKTEST/);
  assert.ok(sheets[0].rows.some((r) => /Minute candles/.test(r[0] ?? '')));
  assert.equal(sheets[1].rows[1][6], 'no losses'); // profit factor ∞
  assert.deepEqual(sheets.at(-1).rows[1], ['risk.capital', 100000]);
});
