import test from 'node:test';
import assert from 'node:assert/strict';
import { breakAndHold, DEFAULT_STRATEGY_SETTINGS } from '../src/utils/strategies.js';
import { decideOpening } from '../src/utils/decision.js';
import { emptyLedger, orderEvents } from '../src/utils/paperLedger.js';
import { openingMedians } from '../src/core/kiteHistory.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { cleanTradingSettings } from '../src/core/tradingDesk.js';
import { runVariant, dayFeatures } from '../src/utils/backtestRunner.js';

// Strategy D, the 3-minute break and hold (docs/plan-920-volume-breakout-confirmation.md).
// The reference: C1–C3 high 1010, low 995 (range 15), so the buffer b = max(2 ticks, spread 0.5, 5% of 15) = 0.75
// and the long level is 1010.75 (short 994.25).

const DATE = '2026-10-19';
const cdl = (o, h, l, c, volume = 500) => ({ o, h, l, c, volume, approximate: true });
const PAPER = { ...DEFAULT_STRATEGY_SETTINGS.breakHold, mode: 'paper', volumeMatched: true }; // as if the volume check had matched

function longFeatures(over = {}) {
  return {
    symbol: 'BRK', token: 1, kind: 'stock', source: undefined, sector: 'IT', tick: 0.05, lot: 1,
    prevClose: 1000, open: 1000, ltp: 1011.5, vwap: 1004, vwapSource: 'Kite average traded price',
    candles: [cdl(1000, 1010, 995, 1005), cdl(1005, 1008, 1000, 1006), cdl(1006, 1009, 1002, 1009.5), cdl(1009.5, 1014, 1009, 1013.5, 1000), cdl(1013, 1013.5, 1010.5, 1011.5, 700)],
    windowVolume: 3200, volumeBaselines: { openingMedian: 2000, minuteMedian: [500, 500, 500, 500, 500], sessions: 20 },
    minuteVwap: [1002, 1003, 1003.5, 1004, 1004.5], spreadRef: { rupees: 0.5, samples: 6 },
    depth: { bestBid: 1011.45, bestAsk: 1011.5, spreadBps: 0.5, imbalance5: 0.1, stability: 0.9 },
    prevHigh: 1030, prevLow: 980, upperCircuit: 1100, lowerCircuit: 900,
    quality: { ticks: 200, stale: false, lastTickAgeSec: 1, lastTradeAgeSec: 1, resets: 0, volumeBaseline: 'NSE pre-open quantity' }, flags: [],
    minuteQuality: Array.from({ length: 5 }, () => ({ samples: 50, endGapSec: 1, maxGapSec: 2 })), gapPct: 0, ret5Pct: 1.15, closePos: 0.87, orHigh: 1014, orLow: 995,
    ...over,
  };
}
/** The same morning upside down (prices mirrored around 1000): a short. */
function mirror(f) {
  const m = (p) => (p == null ? p : Math.round((2000 - p) * 100) / 100);
  return {
    ...f, ltp: m(f.ltp), vwap: m(f.vwap), open: m(f.open), prevClose: m(f.prevClose),
    candles: f.candles.map((c) => (c ? { ...c, o: m(c.o), h: m(c.l), l: m(c.h), c: m(c.c) } : c)),
    minuteVwap: f.minuteVwap.map(m), depth: { ...f.depth, bestBid: m(f.depth.bestAsk), bestAsk: m(f.depth.bestBid) },
    prevHigh: m(f.prevLow), prevLow: m(f.prevHigh), upperCircuit: m(f.lowerCircuit), lowerCircuit: m(f.upperCircuit),
  };
}
const withCandle = (i, c) => (f) => ({ ...f, candles: f.candles.map((x, j) => (j === i ? c : x)) });
const failedKeys = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);

test('long confirmed at 09:20: frozen 3-minute level, strong 09:18 break on volume, 09:19 hold, VWAP side', () => {
  const r = breakAndHold(longFeatures(), PAPER);
  assert.equal(r.applies, true);
  assert.deepEqual(failedKeys(r), []);
  assert.equal(r.pass, true);
  assert.equal(r.code, 'CONFIRMED');
  assert.equal(r.shadow, undefined);
  assert.equal(r.direction, 1);
  assert.equal(r.metrics.b, 0.75);
  assert.equal(r.metrics.threshold, 1010.75);
  assert.equal(r.metrics.breakoutRvol, 2);
  assert.equal(r.metrics.openingRvol, 1.6);
  assert.equal(r.signal.stop, 1008.25); // min(C4, C5 lows) − b
  assert.equal(r.signal.trigger, 1011.5); // the ask
  assert.equal(r.signal.target1, 1018); // 2R from the entry (R = 3.25)
  assert.equal(r.signal.entryDeadline, '09:21');
  assert.equal(r.metrics.largestVolumeMinute, 1); // context only
});

test('short is the exact mirror', () => {
  const r = breakAndHold(mirror(longFeatures()), PAPER);
  assert.deepEqual(failedKeys(r), []);
  assert.equal(r.direction, -1);
  assert.equal(r.metrics.threshold, 989.25);
  assert.equal(r.signal.stop, 991.75);
  assert.equal(r.signal.target1, 982);
  const noShorts = breakAndHold(mirror(longFeatures()), { ...PAPER, allowShorts: false });
  assert.equal(noShorts.code, 'SHORTS_OFF');
});

test('what does not qualify, each with its reason code', () => {
  const code = (f) => breakAndHold(f, PAPER).code;
  // C4 only wicks across the level.
  assert.equal(code(withCandle(3, cdl(1009.5, 1012, 1009, 1010.5, 1000))(longFeatures())), 'NO_BREAKOUT_CLOSE');
  // Weak breakout volume (1.2× the usual 09:18 minute), even with a strong opening.
  assert.equal(code(withCandle(3, cdl(1009.5, 1014, 1009, 1013.5, 600))(longFeatures({ windowVolume: 5000 }))), 'WEAK_BREAKOUT_VOLUME');
  // Weak breakout candle: closes low in its range.
  assert.equal(code(withCandle(3, cdl(1009.5, 1014, 1009, 1011, 1000))(longFeatures())), 'WEAK_BREAKOUT_CANDLE');
  // A zero-range breakout bar fails the candle checks.
  assert.equal(code(withCandle(3, cdl(1011, 1011, 1011, 1011, 1000))(longFeatures())), 'OUTSIDE_PRIMARY'); // opens above the level
  // 09:19 closes back inside, or retests deeper than the buffer.
  assert.equal(code(withCandle(4, cdl(1013, 1013.5, 1010, 1010.5, 700))(longFeatures())), 'HOLD_NOT_CONFIRMED');
  assert.equal(code(withCandle(4, cdl(1013, 1013.5, 1008, 1011.5, 700))(longFeatures())), 'HOLD_TOO_DEEP');
  // Too little history, or none.
  assert.equal(code(longFeatures({ volumeBaselines: { openingMedian: 2000, minuteMedian: [500, 500, 500, 500, 500], sessions: 10 } })), 'INSUFFICIENT_VOLUME_HISTORY');
  assert.equal(code(longFeatures({ volumeBaselines: null })), 'INSUFFICIENT_VOLUME_HISTORY');
  // The sequence first starts in 09:19: wait.
  assert.equal(code(withCandle(4, cdl(1009, 1013, 1009, 1012, 900))(withCandle(3, cdl(1009, 1010.5, 1008.5, 1010, 900))(longFeatures()))), 'WAIT');
  // Already above the level when 09:18 opened: outside the strategy.
  assert.equal(code(withCandle(3, cdl(1011, 1014, 1010.9, 1013.5, 1000))(longFeatures())), 'OUTSIDE_PRIMARY');
  // The pattern passes but the entry is too far beyond the level.
  assert.equal(code(longFeatures({ depth: { ...longFeatures().depth, bestBid: 1012.95, bestAsk: 1013 }, ltp: 1013 })), 'EXTENDED_ENTRY');
  // Weak opening volume (RVOL 1.25).
  assert.equal(code(longFeatures({ windowVolume: 2500 })), 'WEAK_OPENING_VOLUME');
  // A missing minute, or no range.
  assert.equal(code(longFeatures({ candles: [...longFeatures().candles.slice(0, 4), null] })), 'DATA_INSUFFICIENT');
  // Too few spread samples before 09:18 (live data): data quality.
  assert.equal(code(longFeatures({ spreadRef: { rupees: 0.5, samples: 1 } })), 'DATA_INSUFFICIENT');
});

test('equality at the level passes; equality at VWAP does not', () => {
  const atLevel = withCandle(4, cdl(1013, 1013.5, 1010.5, 1010.75, 700))(longFeatures({ ltp: 1010.75, depth: { ...longFeatures().depth, bestBid: 1010.75, bestAsk: 1010.8 } }));
  const r = breakAndHold(atLevel, PAPER);
  assert.ok(!failedKeys(r).includes('hold'));
  assert.equal(r.code, 'CONFIRMED');
  const atVwap = longFeatures({ minuteVwap: [1002, 1003, 1003.5, 1004, 1011.5] });
  assert.equal(breakAndHold(atVwap, PAPER).code, 'WRONG_SIDE_OF_VWAP');
});

test('target 1 stops before the previous-day high; an obstacle inside the entry area rejects', () => {
  const capped = breakAndHold(longFeatures({ prevHigh: 1015 }), PAPER);
  assert.equal(capped.signal.target1, 1014.25); // 1015 less the 0.75 buffer, not 2R (1018)
  assert.equal(capped.signal.target2, 1014.25);
  assert.equal(breakAndHold(longFeatures({ prevHigh: 1012 }), PAPER).code, 'OBSTACLE_TOO_CLOSE');
});

test('candle data: the buffer is a proxy and the spread checks are "not tested"', () => {
  const f = longFeatures({ source: 'candles', depth: null, spreadRef: null });
  const r = breakAndHold(f, PAPER);
  assert.equal(r.metrics.bufferSource, 'proxy (no spread in candle data)');
  assert.equal(r.metrics.b, 0.75);
  assert.ok(r.checks.find((c) => c.key === 'spreadRef').untested);
  assert.equal(r.code, 'CONFIRMED');
  assert.equal(r.signal.trigger, 1011.5); // the last price: there is no book
});

test('decision: shadow mode shows D but never trades it; paper mode trades it until 09:21, with a net first-target check', () => {
  const sealed = { date: DATE, sealedAt: `${DATE}T03:50:01.500Z`, stocks: [longFeatures()] };
  const onlyD = (mode) => ({
    orb: { enabled: false }, gapPullback: { enabled: false }, momentum: { enabled: false },
    breakHold: { ...DEFAULT_STRATEGY_SETTINGS.breakHold, mode, volumeMatched: true },
  });
  const risk = { capital: 1_000_000, slippageBps: 0 };
  const shadow = decideOpening(sealed, { strategies: onlyD('shadow'), risk }).decisions[0];
  assert.equal(shadow.decision, 'NO TRADE');
  const d = shadow.strategies.find((s) => s.strategy === 'breakHold');
  assert.equal(d.pass, true);
  assert.equal(d.shadow, true);
  assert.match(shadow.reasons.join(), /shadow mode/);

  const paper = decideOpening(sealed, { strategies: onlyD('paper'), risk }).decisions[0];
  assert.equal(paper.decision, 'BUY', paper.reasons.join('; '));
  assert.equal(paper.strategy, 'breakHold');
  assert.equal(paper.plan.entryDeadline, '09:21');
  assert.ok(paper.plan.firstTargetRR >= 1.5);
  const events = orderEvents(emptyLedger(DATE), { decisions: [paper] }, { at: sealed.sealedAt, entryUntilAt: `${DATE}T04:00:00.000Z` });
  assert.equal(events[0].order.expiresAt, `${DATE}T03:51:00.000Z`); // 09:21 IST, before the global 09:30

  // With the default ₹1 lakh and 5 bps slippage the costs eat the first target: rejected, with the reason.
  const small = decideOpening(sealed, { strategies: onlyD('paper') }).decisions[0];
  assert.equal(small.decision, 'NO TRADE');
  assert.match(small.reasons.join(), /reward\/risk to target 1 after costs/);
});

test('settings: D\'s mode and entry deadline are cleaned; unknown values fall back', () => {
  const s = cleanTradingSettings({ strategies: { breakHold: { mode: 'paper', entryDeadline: '09:22', minBreakoutRvol: '2' } } }).strategies.breakHold;
  assert.deepEqual([s.mode, s.entryDeadline, s.minBreakoutRvol], ['paper', '09:22', 2]);
  const bad = cleanTradingSettings({ strategies: { breakHold: { mode: 'live', entryDeadline: '08:00' } } }).strategies.breakHold;
  assert.deepEqual([bad.mode, bad.entryDeadline], ['shadow', '09:21']);
});

test('median baselines: each clock minute and the opening total directly, unique minutes, complete days before today only', () => {
  const at = (d, m) => new Date(`${d}T09:${m}:00+05:30`);
  const day = (d, vols) => vols.map((v, i) => [at(d, String(15 + i)), 100, 101, 99, 100, v]);
  const candles = [
    ...day('2026-10-13', [100, 200, 300, 400, 500]),
    ...day('2026-10-14', [300, 100, 100, 100, 100]),
    ...day('2026-10-15', [200, 300, 200, 200, 200]),
    [at('2026-10-15', '15'), 100, 101, 99, 100, 9999], // a duplicate minute: counted once
    ...day('2026-10-16', [100, 100, 100, 100]), // incomplete: left out
    ...day('2026-10-19', [5000, 5000, 5000, 5000, 5000]), // today: never in the baseline
  ];
  const m = openingMedians(candles, '2026-10-19');
  assert.equal(m.sessions, 3);
  assert.deepEqual(m.minuteMedian.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.deepEqual(m.minuteMedian.slice(5), [null, null, null, null, null]); // no 09:20–09:24 bars here: missing, not zero
  assert.equal(m.openingMean, 1100); // (1500 + 700 + 1100) / 3: the mean is kept apart from the median
  assert.equal(m.openingMedian, 1100); // totals 1500, 700, 1100: not the sum of the minute medians (1000)
  assert.deepEqual(m.dates, ['2026-10-13', '2026-10-14', '2026-10-15']);
  assert.equal(openingMedians(candles, '2026-10-19', 2).sessions, 2);
});

test('the live window gives D its inputs: each minute\'s VWAP, the reference spread before 09:18, the median baselines', () => {
  const vm = { openingMedian: 2000, minuteMedian: [500, 500, 500, 500, 500], sessions: 20 };
  const w = createOpeningWindow({ date: DATE, instruments: { 7: { kind: 'stock', symbol: 'X', volumeMedians: vm, preOpenVolume: 0 } } });
  const t = (hhmmss) => +new Date(`${DATE}T${hhmmss}+05:30`);
  const depth = (bid, ask) => ({ buy: [{ price: bid, qty: 100, orders: 1 }], sell: [{ price: ask, qty: 100, orders: 1 }] });
  let vol = 0;
  const tick = (time, ltp, avgPrice, d) => { vol += 100; w.ingest({ token: 7, ltp, volume: vol, avgPrice, exchangeTime: t(time), depth: d }, t(time)); };
  tick('09:15:05', 100, 100, depth(99.9, 100.1));
  tick('09:16:30', 101, 100.4, depth(100.9, 101.1));
  tick('09:17:35', 101, 100.6, depth(100.8, 101.2)); // spread 0.4
  tick('09:17:45', 101, 100.7, depth(100.9, 101.1)); // 0.2
  tick('09:17:55', 101, 100.7, depth(100.95, 101.05)); // 0.1
  tick('09:18:10', 102, 101, depth(101.9, 102.1)); // after 09:18: not in the reference
  tick('09:19:50', 103, 101.5, depth(102.9, 103.1));
  tick('09:20:00', 110, 105, depth(109, 111)); // 09:20:00 never counts
  const f = w.seal(t('09:20:01')).stocks.find((s) => s.symbol === 'X');
  assert.deepEqual(f.minuteVwap, [100, 100.4, 100.7, 101, 101.5]);
  assert.equal(f.spreadRef.samples, 3);
  assert.ok(Math.abs(f.spreadRef.rupees - 0.2) < 1e-9);
  assert.equal(f.volumeBaselines.openingMedian, 2000);
  assert.equal(f.candles[4].c, 103);
});

test('backtests: D alone always trades it (a backtest trades nothing); the combined row respects shadow mode', () => {
  const t = (time) => new Date(`${DATE}T${time}:00+05:30`);
  const row = (time, o, h, l, c, v) => [t(time), o, h, l, c, v];
  const candles = [
    row('09:15', 1000, 1010, 995, 1005, 500), row('09:16', 1005, 1008, 1000, 1006, 500), row('09:17', 1006, 1009, 1002, 1009.5, 500),
    row('09:18', 1009.5, 1014, 1009, 1013.5, 1000), row('09:19', 1013, 1013.5, 1010.5, 1011.5, 700),
    row('09:20', 1011.5, 1019, 1011, 1018.5, 800), row('09:21', 1018.5, 1023, 1018, 1022.5, 800),
  ];
  const day = {
    date: DATE, recorded: false, indices: {},
    stocks: [{ meta: { symbol: 'BRK', token: 1, sector: 'IT', prevClose: 1000, prevHigh: 1030, prevLow: 980, tick: 0.05, lot: 1, volumeMedians: { openingMedian: 2000, minuteMedian: [500, 500, 500, 500, 500], sessions: 20 } }, candles }],
  };
  const prepared = [dayFeatures(day)];
  const settings = { risk: { capital: 1_000_000, slippageBps: 0 }, strategies: { orb: { enabled: false }, gapPullback: { enabled: false }, momentum: { enabled: false } } };
  const alone = runVariant(prepared, 'breakHold', settings);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].strategy, 'breakHold');
  assert.equal(alone[0].status, 'CLOSED');
  assert.ok(alone[0].net > 0);
  assert.equal(runVariant(prepared, 'combined', settings).length, 0); // shadow by default
});
