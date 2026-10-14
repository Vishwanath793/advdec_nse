import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/utils/analysis.js';
import { normalizePreopen } from './preopen.js';

const master = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((Symbol) => ({ Symbol, Industry: 'Metals' }));
const row = (SYMBOL, pct, extra = {}) => ({
  SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5, ...extra,
});

test('scores follow the gap direction and every factor is explained', () => {
  const { stocks } = analyze([
    row('AAA', 3, { 'TOTAL BUY QTY': 900, 'TOTAL SELL QTY': 100, '52 WEEK HIGH': 103, '52 WEEK LOW': 50, 'VALUE (₹ Crores)': 50 }),
    row('BBB', 1),
    row('CCC', 2),
    row('DDD', -1, { 'TOTAL BUY QTY': 900, 'TOTAL SELL QTY': 100 }),
    row('EEE', 0),
  ], master);
  const [aaa, , , ddd, eee] = stocks;

  // AAA: full gap; only sector, so neutral rank (0.5) + 3 of 5 peers gapped 1%+ (0.6) -> 0.55;
  // 90% buy orders; market 3/5 advancing; opening at the 52-week high (breakout); top value.
  assert.equal(aaa.conviction.direction, 'up');
  assert.deepEqual(aaa.conviction.factors.map((f) => [f.key, Math.round(f.value * 100)]), [
    ['gap', 100], ['sector', 55], ['orders', 90], ['market', 60], ['range', 100], ['value', 100],
  ]);
  assert.equal(aaa.convictionScore, Math.round((20 * 1 + 20 * 0.55 + 20 * 0.9 + 15 * 0.6 + 15 * 1 + 10 * 1)));
  assert.match(aaa.conviction.factors.find((f) => f.key === 'range').detail, /52-week high \(breakout\)/);

  // DDD gapped down but buyers dominate: the order factor counts against it.
  assert.equal(ddd.conviction.direction, 'down');
  assert.equal(Math.round(ddd.conviction.factors.find((f) => f.key === 'orders').value * 100), 10);
  assert.ok(ddd.convictionScore < aaa.convictionScore);

  assert.equal(eee.convictionScore, null);
});

test('gaps under the minimum are not scored', () => {
  const { stocks } = analyze([row('AAA', 0.01, { 'TOTAL BUY QTY': 1000, 'TOTAL SELL QTY': 1 }), row('BBB', -0.49), row('CCC', 0.5)], master);
  assert.deepEqual(stocks.map((s) => s.convictionScore === null), [true, true, false]);
});

test('F&O stocks give pending buy/sell orders a low weight', () => {
  const secList = { bands: { AAA: 'none', BBB: 20 }, info: {} };
  const extra = { 'TOTAL BUY QTY': 100, 'TOTAL SELL QTY': 900 };
  const [fno, cash] = analyze([row('AAA', 2, extra), row('BBB', 2, extra)], master, secList).stocks;
  const orders = (s) => s.conviction.factors.find((f) => f.key === 'orders');
  assert.equal(orders(fno).weight, 5);
  assert.equal(orders(cash).weight, 20);
  assert.ok(fno.convictionScore > cash.convictionScore); // sell-heavy book hurts the F&O stock less
});

test('sector strength ranks sectors by average gap and counts same-direction gappers', () => {
  // Six 5-stock sectors: IT gaps up together, four are flat, one sells off.
  const sectors = { IT: [2, 1.5, 1.2, 1.1, 1], S1: [0.6, 0, 0, 0, 0], S2: [0, 0, 0, 0, 0.1], S3: [0, 0.2, 0, 0, 0], S4: [0, 0, 0.3, 0, 0], WEAK: [-2, -1.5, -1, -1, -0.6] };
  const mk = Object.entries(sectors).flatMap(([sec, gaps]) => gaps.map((g, i) => ({ sym: `${sec}${i}`, sec, g })));
  const r = analyze(mk.map((x) => row(x.sym, x.g)), mk.map((x) => ({ Symbol: x.sym, Industry: x.sec })));
  const sector = (sym) => r.stocks.find((s) => s.symbol === sym).conviction.factors.find((f) => f.key === 'sector');
  assert.equal(sector('IT0').value, 1); // strongest sector, 5 of 5 gapped 1%+
  assert.match(sector('IT0').detail, /#1 of 6 sectors .* 5 stocks gapped \+1% or more/);
  assert.equal(sector('S10').value, 0.5 * 0.8); // avg +0.12%, 2nd strongest (rank 4/5), no 1%+ cluster
  assert.equal(sector('WEAK0').value, 0.5 * 1 + 0.5 * (4 / 5)); // a gap-down wants the weakest sector
});

test('52-week factor rewards breakouts only and is neutral near the lows', () => {
  const r = analyze([
    row('AAA', 2, { '52 WEEK HIGH': 101, '52 WEEK LOW': 50 }), // opens 102: above the high
    row('BBB', 2, { '52 WEEK HIGH': 300, '52 WEEK LOW': 98 }), // near the low: not penalised
    row('CCC', -2, { '52 WEEK HIGH': 150, '52 WEEK LOW': 99 }), // opens 98: below the low
  ], master);
  assert.deepEqual(r.stocks.map((s) => s.conviction.factors.find((f) => f.key === 'range').value), [1, 0.5, 1]);
});

test('factors can be turned off or reweighted, and all-off means no score', () => {
  const rows = [row('AAA', 1.5, { 'TOTAL BUY QTY': 100, 'TOTAL SELL QTY': 900 })];
  // Only gap size and orders, equally weighted: (0.5 + 0.1) / 2.
  const only = { gap: { on: true, weight: 10 }, orders: { on: true, weight: 10 }, sector: { on: false, weight: 20 },
    market: { on: false, weight: 15 }, range: { on: false, weight: 15 }, value: { on: true, weight: 0 } };
  const [a] = analyze(rows, master, null, { convictionFactors: only }).stocks;
  assert.deepEqual(a.conviction.factors.map((f) => f.key), ['gap', 'orders']);
  assert.equal(a.convictionScore, 30);
  assert.deepEqual(a.conviction.excluded, ['Sector strength', 'Market A/D agrees', '52-week breakout', 'Pre-open value',
    'Results catalyst', 'Relative volume', "Gap vs yesterday's range"]); // last three are off by default
  assert.deepEqual(a.conviction.missing, []); // turned-off factors are not reported as missing data

  // Settings saved before a factor existed fall back to that factor's default.
  const [b] = analyze(rows, master, null, { convictionFactors: { gap: { on: false, weight: 20 } } }).stocks;
  assert.equal(b.conviction.factors.find((f) => f.key === 'sector').weight, 20);
  assert.ok(!b.conviction.factors.some((f) => f.key === 'gap'));

  const off = Object.fromEntries(Object.keys(only).map((k) => [k, { on: false, weight: 20 }]));
  assert.equal(analyze(rows, master, null, { convictionFactors: off }).stocks[0].convictionScore, null);
});

test('missing data drops the factor and rescales the weights', () => {
  const { stocks: [bbb] } = analyze([row('BBB', 1.5)], master);
  assert.deepEqual(bbb.conviction.missing, ['Buy/sell orders', '52-week breakout']);
  // gap 0.5; sector too small to rank (0.5) with 1 of 5 cluster -> 0.35; market 1; value 1.
  assert.equal(bbb.convictionScore, Math.round(((20 * 0.5 + 20 * 0.35 + 15 + 10) / 65) * 100));
});

test('NSE import carries the conviction inputs', () => {
  const { rows: [r] } = normalizePreopen({ data: [{
    symbol: 'AAA', prevClose: 100, finalPrice: 103, change: 3, perChange: 3, finalValue: 1e8,
    totalBuyQuantity: 900, totalSellQuantity: 100, finalQuantity: 5000, yearHigh: 120, yearLow: 80,
  }] });
  const { stocks: [aaa] } = analyze([r], master);
  assert.deepEqual([aaa.buyQty, aaa.sellQty, aaa.yearHigh, aaa.yearLow], [900, 100, 120, 80]);
  assert.equal(aaa.conviction.missing.length, 0);
});
