import test from 'node:test';
import assert from 'node:assert/strict';
import { readCalendar } from './tv/calendar.js';
import { DEFAULT_STRATEGY_SETTINGS } from '../src/utils/strategies.js';
import { evaluateVariants, fullRangeVariant, laterBarsFromCandles, laterBarsFromTicks, retestVariant } from '../src/utils/breakoutConfirmation.js';
import { breakHoldResearch, D_SWEEPS, studyOutcome, studyTable } from '../src/utils/breakoutResearch.js';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { createTradingDesk } from '../src/core/tradingDesk.js';
import { runBacktest } from '../src/utils/backtestRunner.js';
import { ticksToCandles } from '../src/utils/ticksToCandles.js';

// Strategy D's later variants (§9, shadow only), the desk judging them, and the §15 study.

const DATE = '2026-10-19';
const D = DEFAULT_STRATEGY_SETTINGS.breakHold;
const cdl = (o, h, l, c, volume = 1000) => ({ o, h, l, c, volume, approximate: true });
const bar = (o, h, l, c, volume, vwap) => ({ o, h, l, c, volume, vwap, approximate: true });
const baselines = { openingMedian: 5000, minuteMedian: Array(10).fill(1000), sessions: 20 };

/** Example B (§10): five-minute range 200–202, buffer 0.10, opening RVOL 1.8. */
function exampleB() {
  return {
    symbol: 'EXB', tick: 0.05, windowVolume: 9000, volumeBaselines: { ...baselines, minuteMedian: [1000, 1000, 1000, 1000, 1000, 10_000, 10_000, 10_000, 10_000, 10_000] },
    candles: [cdl(201, 202, 200.5, 201.5), cdl(201.5, 201.8, 200, 200.4), cdl(200.4, 201, 200.2, 200.9), cdl(200.9, 201.6, 200.8, 201.5), cdl(201.5, 201.95, 201.3, 201.9)],
    spreadRef5: { rupees: 0.1, samples: 6 }, minuteVwap: [201, 201, 201, 201, 201.2],
  };
}

test('Example B: the full five-minute range is WAIT at 09:20 and can confirm only after the 09:21 hold bar (09:22)', () => {
  const f = exampleB();
  // At 09:20 there are no later bars: no confirmation can exist yet.
  assert.equal(fullRangeVariant(f, [null, null, null, null, null], D).state, 'DATA_INSUFFICIENT');
  const later = [bar(201.9, 202.55, 201.85, 202.5, 18_000, 201.5), bar(202.5, 202.6, 202.15, 202.35, 12_000, 201.6), null, null, null];
  const r = fullRangeVariant(f, later, D);
  assert.equal(r.state, 'CONFIRMED');
  assert.equal(r.reference.longThreshold, 202.1);
  assert.equal(r.confirmedAt, '09:22');
  assert.equal(r.entryAt, '09:22'); // never before the confirmation is available
  assert.equal(r.shadow, true);
  assert.equal(r.stop, 201.75); // min(201.85, 202.15) − 0.10
  // The break at 09:23 would need the 09:24 hold, completing at the 09:25 deadline: expired.
  const late = [bar(201, 201.5, 200.9, 201.2, 9000, 201), bar(201.2, 201.6, 201, 201.4, 9000, 201), bar(201.4, 201.9, 201.3, 201.8, 9000, 201.1), bar(201.9, 202.55, 201.85, 202.5, 18_000, 201.5), bar(202.5, 202.6, 202.15, 202.35, 12_000, 201.6)];
  const e = fullRangeVariant(f, late, D);
  assert.deepEqual([e.state, e.code], ['EXPIRED', 'DEADLINE']);
  // Weak breakout volume, and a hold back inside.
  assert.equal(fullRangeVariant(f, [bar(201.9, 202.55, 201.85, 202.5, 9000, 201.5), later[1], null, null, null], D).code, 'WEAK_BREAKOUT_VOLUME');
  assert.equal(fullRangeVariant(f, [later[0], bar(202.5, 202.6, 201.95, 202, 12_000, 201.6), null, null, null], D).code, 'HOLD_NOT_CONFIRMED');
});

/** Example E (§10): reference high 300, buffer 0.15; a valid 09:18 breakout (RVOL 2), a quiet pullback, a recovery. */
function exampleE(c5 = cdl(300.5, 300.55, 300.05, 300.2, 900)) {
  return {
    symbol: 'EXE', tick: 0.05, ltp: 300.2, vwap: 299, vwapSource: 'Kite average traded price', windowVolume: 9000, volumeBaselines: baselines,
    candles: [cdl(298, 300, 297, 299), cdl(299, 299.8, 298.5, 299.5), cdl(299.5, 299.9, 299, 299.8), cdl(299.9, 300.9, 299.85, 300.8, 2000), c5],
    minuteVwap: [298.5, 298.8, 299, 299.2, 299.4], spreadRef: { rupees: 0.05, samples: 6 },
    depth: { bestBid: 300.15, bestAsk: 300.2, spreadBps: 1.7 },
    quality: { lastTickAgeSec: 1, lastTradeAgeSec: 1, resets: 0, volumeBaseline: 'NSE pre-open quantity' },
    minuteQuality: Array.from({ length: 5 }, () => ({ samples: 60, endGapSec: 1, maxGapSec: 2 })),
  };
}

test('Example E: a quiet retest succeeds in the separate experiment, labelled RETEST; going back into the range fails it', () => {
  const recovery = bar(300.2, 300.8, 300.15, 300.7, 1400, 299.6);
  const r = retestVariant(exampleE(), [recovery, null, null, null, null], D);
  assert.deepEqual([r.state, r.code, r.confirmedAt], ['CONFIRMED', 'RETEST', '09:21']);
  assert.deepEqual(r.reference.zone, [299.85, 300.15]);
  assert.equal(r.evidence.participationRatio, 0.45);
  assert.equal(r.stop, 299.9);
  // A pullback that closes back under the unbuffered reference high is a failed attempt, not a retest.
  assert.equal(retestVariant(exampleE(cdl(300.5, 300.55, 299.9, 299.95, 900)), [recovery, null, null, null, null], D).code, 'RETURNED_INTO_RANGE');
  // A busy pullback (participation above 0.7 of the breakout's).
  const busy = retestVariant(exampleE(cdl(300.5, 300.55, 300.05, 300.2, 1600)), [bar(300.2, 300.8, 300.15, 300.7, 1700, 299.6), null, null, null, null], D);
  assert.equal(busy.code, 'PULLBACK_TOO_ACTIVE');
  // Three pullbacks: too many.
  const pb = bar(300.3, 300.4, 300.05, 300.2, 800, 299.6);
  assert.equal(retestVariant(exampleE(), [pb, pb, pb, null, null], D).code, 'TOO_MANY_PULLBACKS');
});

test('all variants for one stock, including the other references, are shadow and separately identified', () => {
  const v = evaluateVariants(exampleE(), [bar(300.2, 300.8, 300.15, 300.7, 1400, 299.6), null, null, null, null], D);
  assert.deepEqual(Object.keys(v), ['symbol', 'fullRange', 'retest', 'c1', 'rvolLeader']);
  for (const k of ['fullRange', 'retest', 'c1', 'rvolLeader']) {
    assert.equal(v[k].variant, k);
    assert.equal(v[k].shadow, true);
  }
});

test('later bars: from ticks (sampled, Kite\'s average price) and from candles (VWAP from 09:15)', () => {
  const t = (hms) => +new Date(`${DATE}T${hms}+05:30`);
  const bars = laterBarsFromTicks([
    { exchangeTime: t('09:19:58'), ltp: 100, volume: 1000, avgPrice: 99 },
    { exchangeTime: t('09:20:05'), ltp: 101, volume: 1200, avgPrice: 99.5 },
    { exchangeTime: t('09:20:50'), ltp: 100.5, volume: 1500, avgPrice: 99.6 },
    { exchangeTime: t('09:21:10'), ltp: 102, volume: 1600, avgPrice: 99.8 },
  ]);
  assert.deepEqual(bars[0], { o: 101, h: 101, l: 100.5, c: 100.5, volume: 500, vwap: 99.6, approximate: true });
  assert.equal(bars[1].volume, 100);
  assert.equal(bars[2], null);
  const at = (m) => +new Date(`${DATE}T${m}:00+05:30`);
  const fromCandles = laterBarsFromCandles([[at('09:15'), 100, 101, 99, 100, 1000], [at('09:20'), 100, 102, 100, 101, 1000]]);
  assert.equal(fromCandles[0].approximate, false);
  assert.ok(Math.abs(fromCandles[0].vwap - 100.5) < 1e-9);
});

test('the study: +1R before −1R within 15 minutes from the first executable price; ambiguity and return-to-range disclosed', () => {
  const at = (m) => +new Date(`${DATE}T${m}:00+05:30`);
  const s = { direction: 1, entryAt: '09:20', confirmedAt: '09:20', stop: 99, rangeHigh: 99.5, rangeLow: 98 };
  const win = studyOutcome(s, [[at('09:20'), 100, 100.5, 99.6, 100.4, 1], [at('09:21'), 100.4, 101.2, 100.3, 101, 1]]);
  assert.deepEqual([win.outcome, win.entry, win.R, win.returnedToRange], ['win', 100, 1, false]);
  assert.equal(studyOutcome(s, [[at('09:20'), 100, 100.2, 98.9, 99, 1]]).outcome, 'loss');
  assert.equal(studyOutcome(s, [[at('09:20'), 100, 101.1, 98.9, 100, 1]]).outcome, 'ambiguous');
  const flat = studyOutcome(s, [[at('09:20'), 100, 100.5, 99.4, 100, 1]]);
  assert.deepEqual([flat.outcome, flat.returnedToRange], ['expired', true]);
  assert.equal(studyOutcome(s, []).outcome, 'no entry bar');
  const table = studyTable([{ key: 'primary', direction: 1, ...win }, { key: 'primary', direction: -1, outcome: 'ambiguous', mfeR: 1, maeR: 1 }]);
  const p = table.find((x) => x.key === 'primary');
  assert.deepEqual([p.signals, p.wins, p.ambiguous, p.winShare], [2, 1, 1, 1]);
  assert.equal(D_SWEEPS.find((x) => x.key === 'rvol').values.join(), '1.2,1.5,2');
});

/** The simulated morning as a candle day, as in backtest.test.js. */
function simulatedCandleDay(date) {
  const sim = simulatedMorning();
  const shift = +new Date(`${date}T09:15:00+05:30`) - +new Date(`${sim.date}T09:15:00+05:30`);
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
    if (m.kind === 'stock') stocks.push({ meta: { ...m, token: Number(token), volumeMedians: baselines }, candles });
  }
  return { date, recorded: false, stocks, indices };
}

test('research: every backtest carries the D study (pattern table, predeclared sensitivities, the development/test split)', () => {
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].map(simulatedCandleDay);
  const r = runBacktest(days, {});
  const d = r.dResearch;
  assert.ok(d.table.length === 9 && d.table.every((x) => x.signals >= 0));
  assert.deepEqual(d.sweeps.map((x) => x.key), ['rvol', 'body', 'closeLocation', 'buffer', 'firstTarget']);
  assert.match(d.split.rule, /3 development sessions, then 2 untouched/);
  assert.equal(breakHoldResearch([], {}, () => []).split.skipped, 'needs at least 4 days');
});

test('the desk judges the later variants at 09:25:30 from the recording, saves them, and reloads them after a restart', async () => {
  const sim = simulatedMorning();
  const w = createOpeningWindow({ date: sim.date, instruments: sim.instruments });
  for (const t of sim.ticks) if (t.receivedAt < w.sealAt + 1500) w.ingest(t.tick, t.receivedAt);
  const sealed = w.seal(w.sealAt + 1500);
  const files = new Map();
  const store = { read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
  const log = { append: () => {}, read: () => [], text: () => null };
  let clock = +new Date(`${sim.date}T09:20:02+05:30`);
  const timers = [];
  const desk = createTradingDesk({
    store, log, calendar: readCalendar(), settings: () => ({}), now: () => new Date(clock),
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimer: () => {},
    readTicks: async () => ({ meta: sim.instruments, ticks: sim.ticks }),
  });
  await desk.onSeal(sealed);
  assert.equal(desk.view('day').variants, null); // not before the 09:20–09:24 bars are complete
  const due = timers.find((t) => t.at === +new Date(`${sim.date}T09:25:30+05:30`));
  assert.ok(due, 'a timer at 09:25:30');
  clock = due.at;
  await due.fn();
  await new Promise((r) => setTimeout(r, 10));
  const v = desk.view('day').variants;
  assert.ok(v.rows.length > 0);
  assert.ok(v.rows.every((x) => x.fullRange.shadow && x.retest.shadow));
  assert.ok(files.has(`paper/${sim.date}-variants.json`));
  // A restart after 09:25: the saved variants are loaded, not judged again.
  const again = createTradingDesk({
    store, log, calendar: readCalendar(), settings: () => ({}), now: () => new Date(clock),
    setTimer: () => 0, clearTimer: () => {}, readTicks: async () => { throw new Error('should not read'); },
  });
  await again.wake({ sealedFor: async () => sealed });
  assert.equal(again.view('day').variants.rows.length, v.rows.length);
});
