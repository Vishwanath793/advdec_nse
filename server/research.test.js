import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyResearch, applySectorResearch, flowAgreement, flowHistoryStats, MIN_RESEARCH_DAYS, percentileRank,
  preopenBaseline, preopenDaySummary, ratioToAverage, zScore,
} from '../src/utils/research.js';
import {
  foHistoryStats, historyStats, indexHistoryStats, marketSignalsFor, parseIndexCloses, previousTradingDays,
} from '../src/core/marketContext.js';
import { openingWindowAverages } from '../src/core/kiteHistory.js';
import { createRecorder } from '../src/core/recorder.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { analyze } from '../src/utils/analysis.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function memoryStore() {
  const files = new Map();
  return {
    read: async (name) => (files.has(name) ? JSON.parse(files.get(name)) : null),
    write: async (name, value) => { files.set(name, JSON.stringify(value)); },
  };
}

test('ratios, percentiles and z-scores need enough history and never guess', () => {
  assert.deepEqual(ratioToAverage(30, [10, 10, 10, 10, 10]), { x: 3, avg: 10, days: 5 });
  assert.equal(ratioToAverage(30, [10, 10, 10, 10]), null); // fewer than MIN_RESEARCH_DAYS
  assert.equal(ratioToAverage(30, [0, 0, 0, 0, 0]), null); // no usual level to compare with
  assert.equal(ratioToAverage(null, [10, 10, 10, 10, 10]), null);
  assert.equal(ratioToAverage(30, [10, null, 10, NaN, 10, 10, 10]).days, 5); // missing sessions don't count
  assert.equal(percentileRank(5, [1, 2, 3, 4, 5, 6, 7, 8]), 4.5 / 8); // ties count half
  assert.equal(percentileRank(100, [1, 2, 3, 4, 5]), 1);
  const z = zScore(14, [10, 12, 10, 12, 10, 12]);
  close(z.mean, 11);
  close(z.z, 3 / Math.sqrt(1.2));
  assert.equal(zScore(5, [5, 5, 5, 5, 5]), null); // no spread: undefined, not infinite
});

test('FII/DII: latest amount, z vs the 20 sessions before, 5/20-day sums, buying days, agreement', () => {
  const sessions = previousTradingDays('2026-10-20', 21, calendar).reverse(); // ends 19 Oct
  const flows = {};
  sessions.slice(0, 20).forEach((d, i) => { flows[d] = { fii: i % 2 ? -1000 : -500, dii: 800 }; });
  flows[sessions.at(-1)] = { fii: 2000, dii: -300 };
  const s = flowHistoryStats(flows, sessions);
  assert.equal(s.date, '2026-10-19');
  assert.equal(s.fii.latest, 2000);
  assert.equal(s.fii.days, 20);
  close(s.fii.mean, -750);
  assert.ok(s.fii.z > 10); // far more buying than in any recent session
  const last4 = sessions.slice(-5, -1).map((d) => flows[d].fii);
  assert.equal(s.fii.sum5, 2000 + last4.reduce((a, b) => a + b, 0));
  assert.equal(s.fii.days20, 20);
  assert.equal(s.fii.buyDays, 1);
  assert.equal(s.dii.z, null); // DII was flat at 800 for 20 sessions: no spread
  assert.equal(s.dii.buyDays, 19);
  assert.equal(s.agreement, 'FII buying, DII selling');
  assert.match(s.scope, /combined NSE \+ BSE \+ MSEI/);

  // Only a few stored days: coverage shows it and there is no z-score yet.
  const few = flowHistoryStats({ [sessions.at(-1)]: { fii: 100, dii: 100 }, [sessions.at(-2)]: { fii: -50, dii: 20 } }, sessions);
  assert.equal(few.fii.days, 1);
  assert.equal(few.fii.z, null);
  assert.equal(few.fii.sum5, 50);
  assert.equal(few.agreement, 'both buying');
  assert.equal(flowAgreement(-1, -2), 'both selling');
  assert.equal(flowAgreement(null, 2), null);

  // marketSignalsFor carries the history for the previous session.
  const m = marketSignalsFor({ flows }, '2026-10-20', calendar);
  assert.equal(m.flowHistory.date, '2026-10-19');
  assert.equal(m.flowHistory.fii.latest, 2000);
});

test('end-of-day history: delivered quantity excludes the day judged; average gap uses open vs previous close', () => {
  const days = [];
  // 21 sessions: delivery 1,000 shares a day, then 5,000 yesterday; every open 1% above the previous close.
  let prev = 100;
  for (let i = 0; i < 21; i++) {
    const open = prev * 1.01;
    const last = i === 20;
    days.push({ date: `d${i}`, rows: { AAA: { high: open, low: open, close: open, volume: 10000, open, delivery: last ? 50 : 10 } } });
    prev = open;
  }
  const s = historyStats(days).AAA;
  assert.equal(s.prevDelivQty, 5000);
  assert.equal(s.avgDelivQty, 1000);
  assert.equal(s.delivQtyDays, 20);
  close(s.avgAbsGap, 1);
  assert.equal(s.gapDays, 20);
});

test('F&O history: how unusual the last OI change is among the 20 before', () => {
  const day = (oiChange) => ({ AAA: { oi: 1000 + oiChange, oiChange, close: 1, prevClose: 1 } });
  const days = [...Array.from({ length: 20 }, (_, i) => day(i % 2 ? 10 : -20)), day(150)]; // 1–2% usual, 15% last
  const s = foHistoryStats(days).AAA;
  assert.equal(s.foOiRank, 1);
  assert.equal(s.foOiDays, 20);
  close(s.foOiAvgAbsPct, 1.5);
  assert.equal(foHistoryStats([null, null, day(10)]).AAA.foOiRank, null); // not enough history
});

test('index file: Nifty 20-session return, VIX vs its 20-session average and percentile', () => {
  const csv = 'Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield\n'
    + 'Nifty 50,16-10-2026,23065.1,23149.85,22913.8,23146.15,148.8,.65,391557143,38621.86,19.77,2.84,1.49\n'
    + 'India VIX,16-10-2026,14.025,14.5175,12.79,14.06,0.04,.27,-,-,-,-,-\n'
    + 'Nifty 50 Futures Index,16-10-2026,-,-,-,5624.04,32.69,.58,-,-,-,-,-\n';
  const rows = parseIndexCloses(csv);
  assert.deepEqual(rows['NIFTY 50'], [23065.1, 23149.85, 22913.8, 23146.15]);
  assert.deepEqual(rows['INDIA VIX'], [14.025, 14.5175, 12.79, 14.06]);
  assert.deepEqual(rows['NIFTY 50 FUTURES INDEX'], [null, null, null, 5624.04]);
  assert.throws(() => parseIndexCloses('A,B\n1,2'), /Unexpected index file format/);

  const days = Array.from({ length: 21 }, (_, i) => ({ date: `d${i}`, rows: { 'NIFTY 50': [0, 0, 0, 20000 + i * 100], 'INDIA VIX': [0, 0, 0, i < 20 ? 10 + (i % 5) : 18] } }));
  const s = indexHistoryStats(days);
  close(s.nifty.ret20, (22000 / 20000 - 1) * 100);
  close(s.vix.avg, 12);
  close(s.vix.x, 1.5);
  assert.equal(s.vix.percentile, 1);
  assert.equal(s.vix.days, 20);
  assert.equal(indexHistoryStats(days.slice(-3)).nifty.ret20, null); // needs 21 closes
});

test('Kite 1-minute history: 09:15–09:20 volume, value and range per session', () => {
  const minute = (date, time, o, h, l, c, v) => [new Date(`${date}T${time}:00+05:30`), o, h, l, c, v];
  const day = (date, base) => ['09:15', '09:16', '09:17', '09:18', '09:19'].map((t, i) => minute(date, t, base, base + 1 + i, base - 1, base, 100));
  const avg = openingWindowAverages([...day('2026-10-15', 100), ...day('2026-10-16', 200), minute('2026-10-16', '09:20', 1, 999, 1, 1, 9999)], '2026-10-19');
  assert.equal(avg.days, 2);
  assert.equal(avg.volume, 500);
  close(avg.rangePct, ((6 / 100) * 100 + (6 / 200) * 100) / 2); // high base+5, low base−1, vs the 09:15 open
  // Value: Σ v × (h + l + c) / 3.
  const value = (base) => [1, 2, 3, 4, 5].reduce((s, k) => s + 100 * ((base + k + base - 1 + base) / 3), 0);
  close(avg.value, (value(100) + value(200)) / 2, 1e-6);
});

test('opening window research: value, range and gap against the 20-session baselines', () => {
  const date = '2026-10-19';
  const at = (t) => +new Date(`${date}T${t}+05:30`);
  const w = createOpeningWindow({
    date,
    instruments: { 1: { kind: 'stock', symbol: 'AAA', prevClose: 100, preOpenVolume: 0, openVol5Avg: 1000, openValueAvg: 100_000, openRangePctAvg: 1, openVolDays: 18, avgAbsGap: 1 } },
  });
  const tick = (t, ltp, volume, high, low) => ({ token: 1, ltp, volume, open: 102, high, low, avgPrice: 102, exchangeTime: at(t) });
  w.ingest(tick('09:15:01', 102, 0, 102, 102), at('09:15:01'));
  w.ingest(tick('09:17:00', 103, 1000, 103, 101), at('09:17:00'));
  w.ingest(tick('09:19:30', 104, 2000, 104, 101), at('09:19:30'));
  const f = w.seal().stocks[0];
  assert.equal(f.research.baselineDays, 18);
  close(f.research.gapX, 2); // 2% gap vs a usual 1%
  close(f.research.rangeX, (3 / 102) * 100); // 3-point range on a 102 open vs a usual 1%
  assert.ok(f.research.rvalue > 2 && f.research.rvalue < 2.2); // ~2,000 shares near ₹103
});

const master = [
  { Symbol: 'AAA', Industry: 'Metals' }, { Symbol: 'BBB', Industry: 'Metals' }, { Symbol: 'CCC', Industry: 'Metals' }, { Symbol: 'DDD', Industry: 'IT' },
];
const row = (SYMBOL, change, qty, value) => ({
  SYMBOL, SERIES: 'EQ', 'PREV. CLOSE': 100, 'BASE PRICE': 100, 'FINAL PRICE': 100 + change, CHANGE: change, '%CHANGE': change,
  'VALUE (₹ Crores)': value, 'FINAL VOLUME': qty,
});

test('pre-open baseline from recorded days: average quantity, value and sector advancing %', () => {
  const s1 = preopenDaySummary([row('AAA', 1, 1000, 1), row('BBB', -1, 500, 0.5), row('ZZZ', 1, 1, 1)], master);
  assert.deepEqual(s1.symbols.AAA, [1000, 1]);
  assert.deepEqual(s1.sectors, { Metals: [1, 2] }); // ZZZ is not in the master list
  const summaries = Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, ...preopenDaySummary([row('AAA', i % 2 ? 1 : -1, 1000 + i, 1), row('BBB', -1, 500, 0.5)], master) }));
  const b = preopenBaseline(summaries);
  assert.equal(b.days, 20); // the last 20 only
  assert.equal(b.from, '2026-09-06');
  assert.equal(b.stocks.AAA[0], Math.round((1005 + 1024) / 2));
  assert.equal(b.stocks.AAA[2], 20);
  assert.equal(b.sectors.Metals[0], 25); // AAA advanced on half the days, BBB never
});

test('analysis research columns: pre-open RVOL, gap, delivery, relative strength, OI rank, sector breadth', () => {
  const stats = {
    AAA: { prevClose: 110, close20: 100, avgAbsGap: 0.5, gapDays: 20, prevDelivQty: 3000, avgDelivQty: 1000, delivQtyDays: 20, foOiRank: 0.95, foOiDays: 20 },
    BBB: { prevClose: 100, close20: 100, avgAbsGap: 0.5, gapDays: 3 },
    CCC: { prevClose: 95, close20: 100 },
  };
  const context = {
    history: { stats, indices: { nifty: { ret20: 2 } } },
    preopen: { days: 20, stocks: { AAA: [500, 0.5, 20], BBB: [500, 0.5, MIN_RESEARCH_DAYS - 1] }, sectors: { Metals: [40, 20], IT: [50, 2] } },
  };
  const { stocks, sectors } = analyze([row('AAA', 1, 2000, 2), row('BBB', -1, 500, 0.5), row('CCC', 1, 100, 0.1), row('DDD', 1, 100, 0.1)], master, null, { context });
  const a = stocks.find((s) => s.symbol === 'AAA');
  assert.equal(a.preRvolX, 4);
  assert.equal(a.preValueX, 4);
  assert.equal(a.gapX, 2);
  assert.equal(a.delivQtyX, 3);
  close(a.rsNiftyPct, 8);
  close(a.rsSectorPct, 10); // Metals median 20-session return is 0% (AAA +10, BBB 0, CCC −5)
  assert.equal(a.oiRank, 0.95);
  assert.deepEqual(a.researchDays, { preopen: 20, gap: 20, deliv: 20, oi: 20 });
  const b = stocks.find((s) => s.symbol === 'BBB');
  assert.equal(b.preRvolX, null); // too few recorded days
  assert.equal(b.gapX, null); // too few gaps
  assert.equal(stocks.find((s) => s.symbol === 'DDD').rsSectorPct, null); // one IT stock: no sector median
  const metals = sectors.find((s) => s.sector === 'Metals');
  close(metals.advVsUsualPp, (2 / 3) * 100 - 40);
  assert.equal(sectors.find((s) => s.sector === 'IT').advVsUsualPp, null); // 2 days of history
  // Research columns don't move the score.
  const plain = analyze([row('AAA', 1, 2000, 2)], master, null, { context: { history: { stats } } }).stocks[0];
  assert.equal(plain.convictionScore, analyze([row('AAA', 1, 2000, 2)], master, null, { context }).stocks[0].convictionScore);
  assert.equal(applySectorResearch([{ sector: 'X', advances: 1, total: 2 }], null)[0].advVsUsualPp, null);
  assert.equal(applyResearch([{ symbol: 'Q' }], null)[0].preRvolX, null);
});

test('recorder builds the pre-open baseline from days before the one judged', async () => {
  const store = memoryStore();
  const recorder = createRecorder({ store, calendar, context: { day: async () => null, statsBefore: async () => ({}) }, inputs: async () => ({ masterRows: master }) });
  await recorder.record({ marketUpdatedAt: '15-Oct-2026 09:09:34', rows: [row('AAA', 1, 1000, 1), row('BBB', -1, 300, 0.3)] });
  await recorder.record({ marketUpdatedAt: '16-Oct-2026 09:09:34', rows: [row('AAA', -1, 3000, 3), row('BBB', 1, 500, 0.5)] });
  await recorder.record({ marketUpdatedAt: '19-Oct-2026 09:09:34', rows: [row('AAA', 1, 99999, 99), row('BBB', 1, 1, 1)] });
  const b = await recorder.preopenBaseline('2026-10-19');
  assert.equal(b.days, 2); // 19 Oct itself is left out
  assert.deepEqual(b.stocks.AAA, [2000, 2, 2]);
  assert.deepEqual(b.sectors.Metals, [50, 2]);
});
