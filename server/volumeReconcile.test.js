import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDay, reconcileSummary, RECONCILE_RULE } from '../src/utils/volumeReconcile.js';
import { breakAndHold, DEFAULT_STRATEGY_SETTINGS } from '../src/utils/strategies.js';
import { reconcileSheets } from '../src/utils/researchExport.js';

// Strategy D's release prerequisite (§5.2): recorded tick volumes per minute vs Kite's 1-minute bars.

const bar = (date, minute, v) => [+new Date(`${date}T${minute}:00+05:30`), 100, 101, 99, 100, v];
const MIN = ['09:15', '09:16', '09:17', '09:18', '09:19'];

/** `mornings` × `stocks` with Kite bars of 1,000 a minute and tick volumes = 1,000 × factor (09:15 has its own factor). */
function rows({ mornings = 3, stocks = 12, factor = 1, first = factor, baseline = 'NSE pre-open quantity' } = {}) {
  const out = [];
  for (let d = 0; d < mornings; d++) {
    const date = `2026-10-${String(20 + d).padStart(2, '0')}`;
    const list = Array.from({ length: stocks }, (_, i) => ({
      symbol: `S${i}`, volumeBaseline: baseline,
      minuteVolume: MIN.map((_, m) => 1000 * (m === 0 ? first : factor)), minuteVolumeLow: MIN.map(() => 900),
    }));
    const candles = Object.fromEntries(list.map((s) => [s.symbol, MIN.map((m) => bar(date, m, 1000))]));
    out.push(...reconcileDay(date, list, candles));
  }
  return out;
}

test('matched: every minute within ±5% on enough stock-days and mornings', () => {
  const s = reconcileSummary(rows({ factor: 1.02 }));
  assert.equal(s.verdict.matched, true, s.verdict.text);
  assert.equal(s.window.stockDays, 36);
  assert.equal(s.minutes[3].medianRatio, 1.02);
});

test('not matched: only 09:15 differs (the auction convention); too few days; estimated baselines are left out', () => {
  const auction = reconcileSummary(rows({ first: 0.6 }));
  assert.equal(auction.verdict.matched, false);
  assert.match(auction.verdict.text, /09:15: ticks count 60%/);
  assert.match(auction.hint, /includes volume the app leaves out/);
  assert.match(reconcileSummary(rows({ mornings: 2 })).verdict.text, /only 2 recorded morning/);
  assert.match(reconcileSummary(rows({ stocks: 5 })).verdict.text, /only 15 complete stock-days/);
  const estimated = reconcileSummary(rows({ baseline: 'first window tick (estimated)' }));
  assert.equal(estimated.window.stockDays, 0);
  assert.equal(RECONCILE_RULE.tolerance, 0.05);
  // A missing Kite bar is a missing comparison, not a zero.
  const r = reconcileDay('2026-10-20', [{ symbol: 'X', minuteVolume: [1, 2, 3, 4, 5] }], { X: [bar('2026-10-20', '09:15', 1)] });
  assert.equal(r.length, 1);
  const sheets = reconcileSheets({ ranAt: '2026-10-28T12:00:00Z', dates: ['2026-10-20'], ...auction, rows: rows({ mornings: 1, stocks: 1 }) });
  assert.deepEqual(sheets.map((x) => x.name), ['Verdict', 'By minute', 'Rows']);
});

test('D in paper mode is DATA_INSUFFICIENT until the volume check matched, unless that requirement is switched off; shadow and candles are not blocked', () => {
  const f = {
    symbol: 'X', tick: 0.05, ltp: 101.6, vwap: 100.95, windowVolume: 285_000,
    candles: [[100, 101, 99.8, 100.5, 100_000], [100.5, 101.2, 100.3, 100.9, 55_000], [100.9, 101.1, 100.5, 100.8, 45_000], [100.8, 101.85, 100.75, 101.75, 50_000], [101.75, 101.9, 101.35, 101.6, 35_000]]
      .map(([o, h, l, c, volume]) => ({ o, h, l, c, volume })),
    volumeBaselines: { openingMedian: 160_000, minuteMedian: [60_000, 35_000, 25_000, 25_000, 20_000], sessions: 20 },
    minuteVwap: [100.4, 100.6, 100.7, 100.85, 100.95], spreadRef: { rupees: 0.1, samples: 8 },
    depth: { bestBid: 101.55, bestAsk: 101.6, spreadBps: 4.9 }, prevHigh: 110, upperCircuit: 120,
    quality: { lastTickAgeSec: 1, lastTradeAgeSec: 1, resets: 0, volumeBaseline: 'NSE pre-open quantity' },
    minuteQuality: Array.from({ length: 5 }, () => ({ samples: 60, endGapSec: 1, maxGapSec: 2 })),
  };
  const D = DEFAULT_STRATEGY_SETTINGS.breakHold;
  const unverified = breakAndHold(f, { ...D, mode: 'paper' });
  assert.deepEqual([unverified.pattern.state, unverified.code, unverified.pass], ['DATA_INSUFFICIENT', 'DATA_INSUFFICIENT', false]);
  assert.equal(breakAndHold(f, { ...D, mode: 'paper', volumeMatched: true }).code, 'CONFIRMED');
  assert.equal(breakAndHold(f, { ...D, mode: 'paper', requireVolumeMatch: false }).code, 'CONFIRMED');
  assert.equal(breakAndHold(f, D).code, 'CONFIRMED'); // shadow: provisional evidence is still shown
  assert.equal(breakAndHold({ ...f, source: 'candles', depth: null }, { ...D, mode: 'paper' }).code, 'CONFIRMED'); // research on candles
});
