import test from 'node:test';
import assert from 'node:assert/strict';
import { breakAndHold, breakReference, BREAK_HOLD_VERSION, DEFAULT_STRATEGY_SETTINGS, settingsHash } from '../src/utils/strategies.js';
import { decideOpening, D_RANK_RULE } from '../src/utils/decision.js';
import { buildTradePlan } from '../src/utils/tradePlan.js';
import { applyEvent, emptyLedger, orderEvents, stepTick } from '../src/utils/paperLedger.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';

// Strategy D, part 2 of the brief: pattern states, quality gates, ranking, revalidation; the brief's worked examples.

const DATE = '2026-10-19';
const PAPER = { ...DEFAULT_STRATEGY_SETTINGS.breakHold, mode: 'paper', volumeMatched: true }; // as if the volume check had matched
const cdl = (o, h, l, c, volume) => ({ o, h, l, c, volume, approximate: true });
const goodQuality = {
  quality: { ticks: 300, stale: false, lastTickAgeSec: 1, lastTradeAgeSec: 1, resets: 0, volumeBaseline: 'NSE pre-open quantity' },
  minuteQuality: Array.from({ length: 5 }, () => ({ samples: 60, endGapSec: 1, maxGapSec: 2 })),
};

/** Example A of the brief (§10): long confirmed at 09:20. */
function exampleA(over = {}) {
  return {
    symbol: 'EXA', token: 1, kind: 'stock', sector: 'IT', tick: 0.05, lot: 1, prevClose: 100, open: 100, ltp: 101.6,
    candles: [cdl(100, 101, 99.8, 100.5, 100_000), cdl(100.5, 101.2, 100.3, 100.9, 55_000), cdl(100.9, 101.1, 100.5, 100.8, 45_000), cdl(100.8, 101.85, 100.75, 101.75, 50_000), cdl(101.75, 101.9, 101.35, 101.6, 35_000)],
    windowVolume: 285_000, volumeBaselines: { openingMedian: 160_000, minuteMedian: [60_000, 35_000, 25_000, 25_000, 20_000], sessions: 20 },
    minuteVwap: [100.4, 100.6, 100.7, 100.85, 100.95], vwap: 100.95, vwapSource: 'Kite average traded price',
    spreadRef: { rupees: 0.1, samples: 8 }, depth: { bestBid: 101.55, bestAsk: 101.6, spreadBps: 4.9, imbalance5: 0.1, stability: 0.9 },
    prevHigh: 110, prevLow: 95, upperCircuit: 120, lowerCircuit: 80, flags: [], gapPct: 0, ret5Pct: 1.6, closePos: 0.86, orHigh: 101.9, orLow: 99.8,
    ...goodQuality, ...over,
  };
}
/** Example G (§10): short confirmed at 09:20. */
function exampleG(over = {}) {
  return {
    symbol: 'EXG', token: 2, kind: 'stock', sector: 'IT', tick: 0.05, lot: 1, prevClose: 501, open: 501, ltp: 499.65,
    candles: [cdl(501, 502, 500.5, 501.5, 100_000), cdl(501.5, 501.8, 500.6, 500.8, 80_000), cdl(500.8, 501, 500, 500.4, 60_000), cdl(500.3, 500.4, 499.4, 499.5, 75_000), cdl(499.5, 499.85, 499.3, 499.6, 45_000)],
    windowVolume: 360_000, volumeBaselines: { openingMedian: 220_000, minuteMedian: [60_000, 50_000, 40_000, 40_000, 30_000], sessions: 20 },
    minuteVwap: [501, 500.8, 500.6, 500.4, 500.2], vwap: 500.1, vwapSource: 'Kite average traded price',
    spreadRef: { rupees: 0.1, samples: 8 }, depth: { bestBid: 499.65, bestAsk: 499.7, spreadBps: 1, imbalance5: -0.1, stability: 0.9 },
    prevHigh: 510, prevLow: 490, upperCircuit: 550, lowerCircuit: 450, flags: [], gapPct: 0, ret5Pct: -0.3, closePos: 0.1, orHigh: 502, orLow: 499.3,
    ...goodQuality, ...over,
  };
}

test('Example A: long confirmed; the red, quieter 09:19 hold is accepted; the numbers match the brief', () => {
  const r = breakAndHold(exampleA(), PAPER);
  assert.equal(r.code, 'CONFIRMED');
  assert.equal(r.pattern.state, 'CONFIRMED');
  assert.equal(r.pattern.label, 'pattern confirmed on sampled prices');
  assert.equal(r.metrics.threshold, 101.3);
  assert.equal(r.metrics.b, 0.1);
  assert.equal(r.metrics.stop, 100.65);
  assert.equal(r.metrics.breakoutRvol, 2);
  assert.equal(r.metrics.openingRvol, 1.78125);
  assert.equal(r.metrics.maxEntryPrice, 101.6); // 101.30 + 0.325 on the 0.05 grid
  assert.ok(Math.abs(r.signal.target1 - 103.5) < 1e-9); // the gross 2R target
  assert.equal(r.evidence.highVolumeReference.rawLeader, '09:15');
  assert.equal(r.evidence.highVolumeReference.normalizedLeader, '09:17');
  assert.equal(r.evidence.strategyVersion, BREAK_HOLD_VERSION);
  assert.equal(r.evidence.settingsHash, settingsHash(PAPER));
  assert.equal(r.evidence.hold.accepted, true);
  assert.equal(r.evidence.breakout.approximate, true); // sampled bars keep their qualifier
});

test('Example G: the short mirrors the long arithmetic', () => {
  const r = breakAndHold(exampleG(), PAPER);
  assert.equal(r.code, 'CONFIRMED', r.checks.filter((c) => !c.ok).map((c) => c.key).join());
  assert.equal(r.direction, -1);
  assert.equal(r.metrics.threshold, 499.9);
  assert.equal(r.metrics.stop, 500.5);
  assert.equal(r.metrics.breakoutRvol, 1.875);
  assert.ok(Math.abs(r.metrics.openingRvol - 1.636) < 0.001);
  assert.ok(Math.abs(r.signal.target1 - 497.95) < 1e-9);
});

test('Example F: the pattern passes but the entry has become too expensive', () => {
  const r = breakAndHold(exampleA({ ltp: 102, depth: { ...exampleA().depth, bestBid: 101.95, bestAsk: 102 } }), PAPER);
  assert.equal(r.pattern.state, 'CONFIRMED'); // the confirmation isn't erased
  assert.equal(r.code, 'EXTENDED_ENTRY');
  assert.equal(r.pattern.blocker, 'EXTENDED_ENTRY');
  assert.equal(r.pass, false);
  // The chase limit is frozen in the plan: a later, higher ask can't move it.
  const plan = buildTradePlan(breakAndHold(exampleA(), PAPER).signal, exampleA(), { slippageBps: 0 });
  assert.equal(plan.maxEntry, 101.6);
  const late = buildTradePlan(breakAndHold(exampleA(), PAPER).signal, exampleA({ depth: { ...exampleA().depth, bestBid: 101.7, bestAsk: 101.75 } }), { slippageBps: 0 });
  assert.match(late.reasons.join(), /EXTENDED_ENTRY/);
});

test('states: building, waiting (the break started at 09:19), invalidated, data insufficient', () => {
  const missing = exampleA({ candles: [exampleA().candles[0], exampleA().candles[1], null, null, null] });
  assert.equal(breakAndHold(missing, PAPER).pattern.state, 'BUILDING');
  const wait = exampleA({ candles: [...exampleA().candles.slice(0, 3), cdl(100.8, 101.2, 100.7, 101.1, 30_000), cdl(101.1, 101.6, 101, 101.5, 40_000)] });
  const w = breakAndHold(wait, PAPER);
  assert.deepEqual([w.code, w.pattern.state, w.pattern.execution], ['WAIT', 'BREAK_OBSERVED', 'WAIT']);
  assert.match(w.pattern.nextEvent, /09:22/);
  const rejected = exampleA({ candles: [...exampleA().candles.slice(0, 4), cdl(101.75, 101.8, 101.1, 101.2, 35_000)] });
  assert.deepEqual([breakAndHold(rejected, PAPER).code, breakAndHold(rejected, PAPER).pattern.state], ['HOLD_NOT_CONFIRMED', 'INVALIDATED']);
  const noHistory = breakAndHold(exampleA({ volumeBaselines: { openingMedian: 160_000, minuteMedian: [0, 0, 0, 0, 0], sessions: 20 } }), PAPER);
  assert.deepEqual([noHistory.code, noHistory.pattern.state], ['INSUFFICIENT_VOLUME_HISTORY', 'DATA_INSUFFICIENT']);
  const nonFinite = breakAndHold(exampleA({ windowVolume: NaN }), PAPER);
  assert.equal(nonFinite.code, 'WEAK_OPENING_VOLUME');
});

test('quality gates on live ticks: an estimated baseline, a reset, a gap at a minute\'s end, a stale quote', () => {
  const state = (over) => breakAndHold(exampleA(over), PAPER).pattern;
  const q = exampleA().quality;
  assert.equal(state({ quality: { ...q, volumeBaseline: 'first window tick (estimated)' } }).state, 'DATA_INSUFFICIENT');
  assert.equal(state({ quality: { ...q, resets: 1 } }).state, 'DATA_INSUFFICIENT');
  const mq = exampleA().minuteQuality.map((x, i) => (i === 3 ? { ...x, endGapSec: 6 } : x));
  assert.equal(state({ minuteQuality: mq }).state, 'DATA_INSUFFICIENT');
  const gap = exampleA().minuteQuality.map((x, i) => (i === 1 ? { ...x, maxGapSec: 12 } : x));
  assert.equal(state({ minuteQuality: gap }).state, 'DATA_INSUFFICIENT');
  assert.equal(state({ quality: { ...q, lastTickAgeSec: 7 } }).code, 'STALE_QUOTE');
  // Breakout volume uses its conservative lower bound: 20,000 of the 50,000 may belong to 09:17 → RVOL 1.2.
  const low = breakAndHold(exampleA({ minuteVolumeLow: [100_000, 55_000, 45_000, 30_000, 35_000] }), PAPER);
  assert.equal(low.code, 'WEAK_BREAKOUT_VOLUME');
  // Candle data has no sampling: the quality gates are "not tested", never a green tick on missing data.
  const candles = breakAndHold(exampleA({ source: 'candles', quality: { ticks: 5, candles: 5 }, minuteQuality: null, spreadRef: null, depth: null }), PAPER);
  assert.ok(candles.checks.filter((c) => ['baseline', 'resets', 'bars', 'freshness', 'spreadRef'].includes(c.key)).every((c) => c.untested));
});

test('references: frozen before the break; C1-only and RVOL-leader are separate comparisons; an internal level is not the breakout', () => {
  const a = exampleA();
  const before = breakReference(a.candles, 'c1c3');
  const moved = breakReference([...a.candles.slice(0, 3), cdl(1, 999, 0.5, 2, 1), cdl(1, 999, 0.5, 2, 1)], 'c1c3');
  assert.deepEqual([moved.high, moved.low], [before.high, before.low]); // 09:18 and 09:19 never change it
  assert.equal(breakReference(a.candles, 'c1').high, 101);
  assert.equal(breakReference(a.candles, 'rvolLeader', a.volumeBaselines.minuteMedian).startAt, '09:17');
  const c1 = breakAndHold(a, PAPER, { reference: 'c1' });
  assert.equal(c1.metrics.reference, 'C1');
  assert.equal(c1.pattern.reference, 'c1');
  // 09:18 closes above the 09:17 (RVOL leader) high but inside the 09:15–09:18 range.
  const internal = exampleA({ candles: [cdl(100, 102, 99.8, 100.5, 100_000), cdl(100.5, 101.2, 100.3, 100.9, 55_000), cdl(100.9, 101.1, 100.5, 100.8, 45_000), cdl(100.8, 101.6, 100.75, 101.5, 50_000), cdl(101.5, 101.6, 101.2, 101.4, 35_000)] });
  assert.equal(breakAndHold(internal, PAPER).code, 'INTERNAL_LEVEL_BROKEN');
});

test('decision: D is gated, not scored (no legacy minimum score), ranked by its own rule, and selected over the others for its stock', () => {
  const sealed = { date: DATE, sealedAt: `${DATE}T03:50:01.500Z`, stocks: [exampleA({ prevHigh: 200 }), exampleG({ symbol: 'EXG' })] };
  const strategies = { breakHold: PAPER };
  const free = { brokeragePct: 0, sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0 };
  const risk = { capital: 1_000_000, slippageBps: 0, maxOpenPositions: 2, maxTradesPerDay: 2, charges: free };
  const d = decideOpening(sealed, { strategies, risk, scoring: { minScore: 100 } });
  const trades = d.decisions.filter((x) => x.decision !== 'NO TRADE');
  assert.equal(trades.length, 2, d.decisions.map((x) => x.reasons.join('; ')).join(' | '));
  assert.ok(trades.every((x) => x.strategy === 'breakHold' && x.rankRule === D_RANK_RULE));
  // Higher first-target reward/risk ranks first.
  const [first, second] = [...trades].sort((x, y) => x.rank - y.rank);
  assert.ok(first.plan.firstTargetRR >= second.plan.firstTargetRR);
  // The scanner line for D.
  const row = d.decisions.find((x) => x.symbol === 'EXA').pattern;
  assert.equal(row.state, 'CONFIRMED');
  assert.equal(row.evidence.reference.longThreshold, 101.3);
  // A known obstacle at 102.50 caps target 1 at 102.40: the first-target check blocks the trade (brief Example A).
  const blocked = decideOpening({ ...sealed, stocks: [exampleA({ prevHigh: 102.5 })] }, { strategies, risk }).decisions[0];
  assert.equal(blocked.decision, 'NO TRADE');
  assert.match(blocked.reasons.join(), /reward\/risk to target 1/);
});

test('paper fills are revalidated: back inside the level cancels; a crossed or wide book or the wrong side of VWAP waits', () => {
  const sealed = { date: DATE, sealedAt: `${DATE}T03:50:01.500Z`, stocks: [exampleA({ prevHigh: 200 })] };
  const decision = decideOpening(sealed, { strategies: { breakHold: PAPER }, risk: { capital: 1_000_000, slippageBps: 0 } });
  const start = () => {
    const s = emptyLedger(DATE);
    for (const e of orderEvents(s, decision, { at: sealed.sealedAt, entryUntilAt: `${DATE}T04:00:00.000Z` })) applyEvent(s, e);
    return s;
  };
  const book = (bid, ask) => ({ buy: [{ price: bid, qty: 100_000 }], sell: [{ price: ask, qty: 100_000 }] });
  const at = +new Date(`${DATE}T09:20:02+05:30`);
  const NO_SLIP = { slippageBps: 0 };
  const tick = (over) => ({ token: 1, ltp: 101.6, avgPrice: 100.95, lastTradeTime: at - 1000, depth: book(101.55, 101.6), ...over });
  let s = start();
  assert.equal(s.orders[0].revalidate.level, 101.3);
  stepTick(s, tick({ depth: book(101.6, 101.55) }), at, NO_SLIP); // crossed
  stepTick(s, tick({ depth: book(101, 101.6) }), at, NO_SLIP); // 59 bps wide
  stepTick(s, tick({ avgPrice: 101.7 }), at, NO_SLIP); // below VWAP now
  stepTick(s, tick({ lastTradeTime: at - 9000 }), at, NO_SLIP); // last trade 9 s old
  assert.equal(s.orders[0].filledQty, 0);
  stepTick(s, tick(), at, NO_SLIP);
  assert.ok(s.orders[0].filledQty > 0);
  s = start();
  stepTick(s, tick({ ltp: 101.25, depth: book(101.2, 101.25) }), at, NO_SLIP);
  assert.equal(s.orders[0].status, 'CANCELLED');
  assert.match(s.orders[0].reason, /PRICE_BACK_INSIDE/);
  // A duplicate seal (the same decision again) creates no second order.
  const again = orderEvents(s, decision, { at: sealed.sealedAt, entryUntilAt: `${DATE}T04:00:00.000Z` });
  assert.equal(again.length, 0);
});

test('the window: volume straddling a minute boundary is a range; observation gaps and the last trade age are measured', () => {
  const w = createOpeningWindow({ date: DATE, instruments: { 7: { kind: 'stock', symbol: 'X', preOpenVolume: 0 } } });
  const t = (hms) => +new Date(`${DATE}T${hms}+05:30`);
  let vol = 0;
  const tick = (hms, add) => { vol += add; w.ingest({ token: 7, ltp: 100, volume: vol, avgPrice: 100, exchangeTime: t(hms), lastTradeTime: t(hms) }, t(hms)); };
  for (const hms of ['09:15:01', '09:15:30', '09:15:59', '09:16:01', '09:16:58', '09:17:02', '09:17:59', '09:18:01', '09:18:30', '09:18:59', '09:19:20', '09:19:58']) tick(hms, 100);
  const f = w.seal(t('09:20:01')).stocks[0];
  assert.deepEqual(f.minuteVolume, [300, 200, 200, 300, 200]);
  assert.deepEqual(f.minuteVolumeLow, [200, 100, 100, 200, 100]); // each minute's first increment may belong to the minute before
  assert.equal(f.minuteQuality[0].samples, 3);
  assert.equal(f.minuteQuality[2].maxGapSec, 57); // 09:17:02 → 09:17:59
  assert.equal(f.minuteQuality[4].endGapSec, 2);
  assert.equal(f.quality.lastTradeAgeSec, 2);
});
