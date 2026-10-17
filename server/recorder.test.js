import test from 'node:test';
import assert from 'node:assert/strict';
import { contentId, createRecorder, fromColumns, snapshotDate, toColumns } from '../src/core/recorder.js';
import { packDay, parseBhavcopy, unpackDay } from '../src/core/marketContext.js';
import { buildReportCard, dayTrades, factorVerdict, MIN_RHOS_FOR_VERDICT, spearman } from '../src/utils/reportCard.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();

function memoryStore() {
  const files = new Map();
  return {
    files,
    read: async (name) => (files.has(name) ? JSON.parse(files.get(name)) : null),
    write: async (name, value) => { files.set(name, JSON.stringify(value)); },
  };
}

const master = [
  { Symbol: 'AAA', Industry: 'Metals', 'Company Name': 'A Ltd' },
  { Symbol: 'BBB', Industry: 'Metals', 'Company Name': 'B Ltd' },
  { Symbol: 'CCC', Industry: 'IT', 'Company Name': 'C Ltd' },
];
const row = (SYMBOL, pct, extra = {}) => ({
  SYMBOL, SERIES: 'EQ', 'PREV. CLOSE': 100, 'BASE PRICE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct,
  'VALUE (₹ Crores)': 5, ...extra,
});
const snapshot = (updatedAt, rows = [row('AAA', 2), row('BBB', -1.5), row('CCC', 0.1)]) => ({
  marketUpdatedAt: updatedAt, fetchedAt: '2026-10-15T03:40:00.000Z', rows,
});

/** Market-context stand-in: end-of-day files by date. */
function fakeContext(days = {}) {
  const calls = [];
  return {
    calls,
    async day(iso, { cachedOnly = false } = {}) { calls.push([iso, cachedOnly]); return days[iso] ?? null; },
    async statsBefore() { return {}; },
  };
}

test('snapshots are dated by NSE update time and only on trading days', () => {
  assert.equal(snapshotDate({ marketUpdatedAt: '15-Oct-2026 09:09:34' }, calendar), '2026-10-15');
  assert.equal(snapshotDate({ marketUpdatedAt: '17-Oct-2026 09:09:34' }, calendar), null); // Saturday
  assert.equal(snapshotDate({ marketUpdatedAt: null }, calendar), null);
  assert.equal(snapshotDate(null, calendar), null);
});

test('columnar rows round-trip and master ids follow content', () => {
  const rows = [row('AAA', 2), { SYMBOL: 'ZZZ', EXTRA: 1 }];
  const packed = toColumns(rows);
  assert.deepEqual(fromColumns(packed), [{ ...rows[0], EXTRA: null }, { ...Object.fromEntries(packed.columns.map((c) => [c, null])), SYMBOL: 'ZZZ', EXTRA: 1 }]);
  assert.equal(contentId('abc'), contentId('abc'));
  assert.notEqual(contentId('abc'), contentId('abd'));
});

test('end-of-day files keep the open; files saved before that still load', () => {
  const csv = 'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY\n'
    + 'AAA, EQ, 15-Oct-2026, 100, 102.5, 105, 101, 104, 104.2, 103, 5000\n';
  const rows = parseBhavcopy(csv);
  assert.deepEqual(rows.AAA, { series: 'EQ', high: 105, low: 101, close: 104.2, volume: 5000, open: 102.5 });
  assert.deepEqual(unpackDay(packDay(rows)).AAA, { high: 105, low: 101, close: 104.2, volume: 5000, open: 102.5, delivery: null });
  assert.deepEqual(unpackDay({ OLD: [5, 4, 4.5, 100] }).OLD, { high: 5, low: 4, close: 4.5, volume: 100, open: null, delivery: null });
});

test('a day is recorded once with its morning inputs; a later snapshot replaces it', async () => {
  const store = memoryStore();
  let inputsCalls = 0;
  const recorder = createRecorder({
    store, calendar, context: fakeContext(),
    inputs: async () => {
      inputsCalls++;
      return {
        masterRows: master,
        secList: { bands: { AAA: 20, BBB: 'none', OTHER: 5 }, info: { AAA: { series: 'EQ', remarks: 'GSM STAGE - 1' }, OTHER: { series: 'EQ' } } },
        events: { date: '2026-10-15', results: { AAA: [{ at: 'x', text: 'results' }] }, resultsDue: {}, exDates: {} },
      };
    },
  });
  assert.deepEqual(await recorder.record(snapshot('15-Oct-2026 09:07:58')), { recorded: true, date: '2026-10-15' });
  assert.equal((await recorder.record(snapshot('15-Oct-2026 09:07:58'))).recorded, false);
  assert.equal(inputsCalls, 1); // an already-recorded snapshot doesn't refetch inputs
  assert.equal((await recorder.record(snapshot('15-Oct-2026 09:09:34'))).recorded, true);
  assert.equal((await recorder.record(snapshot('15-Oct-2026 09:08:00'))).recorded, false); // older than the one kept

  const saved = await store.read('recorded/2026-10-15.json');
  assert.equal(saved.marketUpdatedAt, '15-Oct-2026 09:09:34');
  assert.deepEqual(saved.secList, { bands: { AAA: 20, BBB: 'none' }, info: { AAA: { series: 'EQ', remarks: 'GSM STAGE - 1' } } });
  assert.deepEqual(saved.events.results.AAA[0].text, 'results');
  assert.deepEqual(await store.read(`recorded/master-${saved.masterId}.json`), master);
  assert.deepEqual(await recorder.status(), { days: 1, first: '2026-10-15', latest: '2026-10-15' });

  // Another day with the same master list stores the list only once; the index stays sorted.
  await recorder.record(snapshot('14-Oct-2026 09:08:00'));
  assert.equal([...store.files.keys()].filter((k) => k.startsWith('recorded/master-')).length, 1);
  assert.deepEqual((await store.read('recorded/index.json')).days.map((d) => d.date), ['2026-10-14', '2026-10-15']);
  // Events from another day are not attached.
  assert.equal((await store.read('recorded/2026-10-14.json')).events, null);

  assert.equal((await recorder.record(snapshot('17-Oct-2026 09:08:00'))).recorded, false); // Saturday
  assert.equal((await recorder.record({ marketUpdatedAt: '16-Oct-2026 09:08:00', rows: [] })).recorded, false);
});

test('a failing input source does not stop the day being recorded', async () => {
  const store = memoryStore();
  const recorder = createRecorder({ store, calendar, context: fakeContext(), inputs: async () => { throw new Error('offline'); } });
  assert.equal((await recorder.record(snapshot('15-Oct-2026 09:09:34'))).recorded, true);
  const saved = await store.read('recorded/2026-10-15.json');
  assert.equal(saved.masterId, null);
  assert.equal(saved.secList, null);
  // Without a master list the day can't be scored, and the report says why.
  const report = await recorder.report();
  assert.deepEqual(report.skipped, [{ date: '2026-10-15', reason: 'No master list was recorded.' }]);
});

test('trades are measured from the pre-open price in the gap direction', async () => {
  const store = memoryStore();
  const outcome = {
    AAA: { high: 105, low: 101, close: 104, open: 102.5 }, // bought at 102
    BBB: { high: 100.2, low: 97, close: 99, open: 98.4 }, // shorted at 98.5, came back above prev close 100
  };
  const context = fakeContext({ '2026-10-15': outcome });
  const recorder = createRecorder({ store, calendar, context, inputs: async () => ({ masterRows: master }), now: () => new Date('2026-10-15T14:00:00Z') });
  await recorder.record(snapshot('15-Oct-2026 09:09:34'));
  const report = await recorder.report();
  assert.equal(report.recorded, 1);
  assert.deepEqual(report.pending, []);
  assert.equal(report.totals.trades, 2); // CCC's 0.1% gap is not scored
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const up = report.days[0].up;
  near(up.avgRet, ((104 - 102) / 102) * 100);
  near(up.avgBest, ((105 - 102) / 102) * 100);
  near(up.avgWorst, ((101 - 102) / 102) * 100);
  assert.equal(up.filled, 0);
  const down = report.days[0].down;
  near(down.avgRet, (-(99 - 98.5) / 98.5) * 100);
  near(down.avgBest, (-(97 - 98.5) / 98.5) * 100);
  assert.equal(down.continued, 0);
  assert.equal(down.filled, 1);
  assert.deepEqual(down.topPicks.map((p) => p.symbol), ['BBB']);
});

test('today\'s outcome is pending until the end-of-day file is out', async () => {
  const store = memoryStore();
  const context = fakeContext({});
  const at = { now: new Date('2026-10-15T08:00:00Z') }; // 13:30 IST
  const recorder = createRecorder({ store, calendar, context, inputs: async () => ({ masterRows: master }), now: () => at.now });
  await recorder.record(snapshot('15-Oct-2026 09:09:34'));
  let report = await recorder.report();
  assert.deepEqual(report.pending, [{ date: '2026-10-15', reason: 'Results after 18:30 IST.' }]);
  assert.deepEqual(context.calls.at(-1), ['2026-10-15', true]); // didn't ask NSE during the day

  at.now = new Date('2026-10-15T14:00:00Z'); // 19:30 IST, but NSE is late
  report = await recorder.report();
  assert.match(report.pending[0].reason, /not published/);
  assert.deepEqual(context.calls.at(-1), ['2026-10-15', false]);
});

test('spearman handles ties and constant inputs', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), null);
  assert.equal(spearman([1, 2], [1, 2]), null);
  assert.ok(Math.abs(spearman([1, 1, 2, 3], [1, 2, 3, 4]) - 0.9486832980505138) < 1e-12);
});

test('report card bands, picks and factor verdicts', () => {
  // 12 days; each day 12 gap-ups whose sector factor perfectly predicts the return
  // and whose order factor predicts it backwards.
  const days = Array.from({ length: 12 }, (_, d) => ({
    date: `2026-11-${String(d + 1).padStart(2, '0')}`,
    trades: Array.from({ length: 12 }, (_, i) => ({
      date: 'x', symbol: `S${i}`, dir: 1, gap: 0.5 + i * 0.3, score: 40 + i * 5, tradeable: i !== 11,
      factors: { sector: i / 11, orders: 1 - i / 11, market: 0.5 },
      ret: i - 5, best: i, worst: -1, filled: i < 3,
    })),
  }));
  const r = buildReportCard(days);
  assert.equal(r.totals.days, 12);
  assert.equal(r.totals.trades, 144);
  assert.equal(r.totals.scoreRho, 1);
  const sector = r.factors.find((f) => f.key === 'sector');
  const orders = r.factors.find((f) => f.key === 'orders');
  const market = r.factors.find((f) => f.key === 'market');
  assert.deepEqual([sector.verdict, sector.up.rho, sector.up.days, sector.up.positiveDays], ['helps', 1, 12, 12]);
  assert.deepEqual([orders.verdict, orders.up.rho], ['hurts', -1]);
  // Market-wide factors are judged across days; this one never changes, so no verdict.
  assert.deepEqual([market.verdict, market.up.days, market.rho], ['unclear', 12, null]);
  assert.equal(sector.down.days, 0);
  // Scores 40..95: 70-100 holds i = 6..11.
  assert.equal(r.bands.up[0].n, 6 * 12);
  assert.equal(r.bands.down[0].n, 0);
  // Top 5 tradeable by conviction skips S11 (untradeable): i = 6..10.
  assert.equal(r.picks.up.conviction.n, 5 * 12);
  assert.equal(r.picks.up.conviction.avgRet, 3);
  assert.equal(r.picks.up.gap.avgRet, 4); // top 5 by gap: i = 7..11
  assert.deepEqual(r.days[0].up.topPicks.map((p) => p.symbol), ['S10', 'S9', 'S8', 'S7', 'S6']);
  assert.equal(factorVerdict(Array(MIN_RHOS_FOR_VERDICT - 1).fill(0.5)), 'too few days');
  assert.equal(factorVerdict(Array(MIN_RHOS_FOR_VERDICT).fill(0.01)), 'unclear');
});

test('dayTrades scores with the given settings but measures every factor', () => {
  const only = Object.fromEntries(['gap', 'sector', 'orders', 'market', 'range', 'value', 'catalyst', 'rvol', 'prevRange']
    .map((k) => [k, { on: k === 'gap', weight: 20 }]));
  const trades = dayTrades({
    date: '2026-10-15', rows: [row('AAA', 2)], masterRows: master, secList: null, context: null,
    outcome: { AAA: { high: 103, low: 101, close: 102 } }, factorSettings: only,
  });
  assert.equal(trades[0].score, 100); // gap alone: 2% is in the sweet spot
  assert.deepEqual(Object.keys(trades[0].factors).sort(), ['gap', 'market', 'sector', 'value']);
  assert.equal(trades[0].ret, 0);
});

test('market-wide factors are judged across days, not within a day', () => {
  // 12 days of gap-ups: on days with a higher GIFT Nifty reading, gap-ups did better.
  const days = Array.from({ length: 12 }, (_, d) => ({
    date: `2026-11-${String(d + 1).padStart(2, '0')}`,
    trades: Array.from({ length: 10 }, (_, i) => ({
      date: 'x', symbol: `S${i}`, dir: 1, gap: 1, score: 50 + i, tradeable: true,
      factors: { gift: d / 11, sector: i / 9 },
      ret: d - 6 + (i % 2), best: 1, worst: -1, filled: false,
    })),
  }));
  const gift = buildReportCard(days).factors.find((f) => f.key === 'gift');
  assert.equal(gift.marketWide, true);
  assert.equal(gift.rho, 1);
  assert.equal(gift.verdict, 'helps');
  assert.equal(gift.up.days, 12);
  assert.equal(buildReportCard(days.slice(0, 9)).factors.find((f) => f.key === 'gift').verdict, 'too few days');
});
