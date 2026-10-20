import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryLayer, gapNormScore, HISTORY_FACTORS, historyLayerFactors } from '../src/utils/historyLayer.js';
import { analyze } from '../src/utils/analysis.js';
import { CONVICTION_FACTORS, DEFAULT_FACTOR_SETTINGS } from '../src/utils/conviction.js';
import { buildReportCard } from '../src/utils/reportCard.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const master = ['AAA', 'BBB', 'CCC', 'DDD'].map((Symbol) => ({ Symbol, Industry: 'Metals' }));
const row = (SYMBOL, pct) => ({ SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5 });

test('gap vs its usual gap: routine is neutral, 1.5–3× full marks, extreme gaps taper', () => {
  assert.equal(gapNormScore(0.5), 0.5);
  close(gapNormScore(1.125), 0.75);
  assert.equal(gapNormScore(1.5), 1);
  assert.equal(gapNormScore(3), 1);
  close(gapNormScore(4.5), 0.65);
  close(gapNormScore(6), 0.3);
  close(gapNormScore(20), 0.1);
});

test('each factor reads in the gap direction and is neutral without a clear signal', () => {
  const up = (s) => historyLayerFactors(s, 1);
  const down = (s) => historyLayerFactors(s, -1);
  // Delivery surge after an up day: supports a gap-up, against a gap-down; full marks at 3×.
  const accum = { delivQtyX: 3, prevMovePct: 2 };
  assert.equal(up(accum).hDelivQty.value, 1);
  assert.equal(down(accum).hDelivQty.value, 0);
  assert.equal(up({ delivQtyX: 0.5, prevMovePct: 2 }).hDelivQty.value, 0.5); // less than usual: neutral
  assert.equal(up({ delivQtyX: 3, prevMovePct: 0.1 }).hDelivQty.value, 0.5); // flat day: neutral
  // Yesterday's volume = delivered ÷ delivery %: 4,000 / 0.4 = 10,000 = 2× the 5,000 average.
  const vol = up({ delivQty: 4000, delivPct: 40, avgVolume: 5000, prevMovePct: -1.5 }).hVolume;
  assert.equal(vol.value, 0);
  assert.match(vol.detail, /2\.0× its 20-day average/);
  // OI: long build-up at the 90th percentile = full marks for a gap-up; short covering half.
  assert.equal(up({ foBuild: 'long build-up', oiRank: 0.9, foOiChangePct: 4 }).hOiRank.value, 1);
  assert.equal(up({ foBuild: 'short covering', oiRank: 0.9, foOiChangePct: -4 }).hOiRank.value, 0.75);
  assert.equal(up({ foBuild: 'long build-up', oiRank: 0.4, foOiChangePct: 1 }).hOiRank.value, 0.5); // ordinary change
  assert.equal(down({ foBuild: 'short build-up', oiRank: 1, foOiChangePct: 9 }).hOiRank.value, 1);
  // Relative strength: a leader gapping up, a laggard gapping down.
  assert.equal(up({ rsSectorPct: 10, ret20: 12, sectorRet20: 2 }).hRsSector.value, 1);
  assert.equal(down({ rsSectorPct: 10, ret20: 12, sectorRet20: 2 }).hRsSector.value, 0);
  close(down({ rsSectorPct: -5, ret20: -3, sectorRet20: 2 }).hRsSector.value, 0.75);
  // No inputs: no factors (left out, not guessed).
  assert.deepEqual(up({}), {});
});

test('separate History score: equal weights over the factors with data, only for scored gaps', () => {
  const stocks = [
    { symbol: 'A', conviction: { direction: 'up' }, delivQtyX: 3, prevMovePct: 2, rsSectorPct: 0, ret20: 1, sectorRet20: 1 },
    { symbol: 'B', conviction: { direction: 'up' }, rsSectorPct: 10 }, // one factor: too few
    { symbol: 'C', conviction: null, delivQtyX: 3, prevMovePct: 2, rsSectorPct: 10 },
  ];
  applyHistoryLayer(stocks);
  assert.equal(stocks[0].historyScore, 75); // (1 + 0.5) / 2
  assert.equal(stocks[0].historyLayer.coverage, `2/${HISTORY_FACTORS.length}`);
  assert.equal(stocks[1].historyScore, null);
  assert.equal(stocks[2].historyLayer, null);
});

const stats = {
  AAA: { prevClose: 110, close1: 105, close20: 100, avgAbsGap: 0.75, gapDays: 20, prevDelivery: 50, avgDelivery: 40, prevDelivQty: 3000, avgDelivQty: 1000, delivQtyDays: 20, avgVolume: 4000 },
  BBB: { prevClose: 100, close20: 100 },
  CCC: { prevClose: 95, close20: 100 },
};

test('the layer sits on top: default conviction scores are unchanged, and it joins only when turned on', () => {
  const rows = [row('AAA', 1.5), row('BBB', 0.8), row('CCC', -0.8)];
  const plain = analyze(rows, master, null, {}).stocks;
  const withHistory = analyze(rows, master, null, { context: { history: { stats } } }).stocks;
  const a = withHistory.find((s) => s.symbol === 'AAA');
  // Default settings: none of the history factors are in the conviction score.
  assert.ok(HISTORY_FACTORS.every((f) => DEFAULT_FACTOR_SETTINGS[f.key].on === false));
  assert.ok(!a.conviction.factors.some((f) => f.key.startsWith('h')));
  assert.equal(a.convictionScore, plain.find((s) => s.symbol === 'AAA').convictionScore);
  // …but the separate History score is there: gap 2× its usual (1), delivery 3× after an up day (1),
  // volume 3000/0.5 = 6000 = 1.5× (0.75), +10 vs a 0% sector median (1).
  assert.equal(a.historyLayer.factors.length, 4);
  assert.equal(a.historyScore, Math.round(((1 + 1 + 0.75 + 1) / 4) * 100));
  // Include them: they appear in the conviction breakdown and move the score.
  const on = { ...DEFAULT_FACTOR_SETTINGS, ...Object.fromEntries(HISTORY_FACTORS.map((f) => [f.key, { on: true, weight: 20 }])) };
  const included = analyze(rows, master, null, { convictionFactors: on, context: { history: { stats } } }).stocks.find((s) => s.symbol === 'AAA');
  assert.deepEqual(included.conviction.factors.filter((f) => f.group === 'history').map((f) => f.key), ['hGapNorm', 'hDelivQty', 'hVolume', 'hRsSector']);
  assert.notEqual(included.convictionScore, a.convictionScore);
  assert.ok(CONVICTION_FACTORS.filter((f) => f.group === 'history').length === HISTORY_FACTORS.length);
});

test('report card compares top picks by History score with top picks by conviction', () => {
  const trade = (symbol, score, history, ret) => ({ date: 'd', symbol, dir: 1, gap: 1, score, history, tradeable: true, factors: {}, ret, best: ret, worst: 0, filled: false });
  const days = [{ date: 'd', trades: [trade('A', 90, 20, -1), trade('B', 80, 90, 3), trade('C', 10, 80, 2)] }];
  const card = buildReportCard(days);
  assert.equal(card.picks.up.history.n, 3);
  assert.equal(card.picks.up.history.continued, 2 / 3);
});
