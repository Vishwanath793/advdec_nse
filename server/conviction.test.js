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

  // AAA: full gap, sector & market 3/5 advancing, 90% buy orders, at 52w high, top value.
  assert.equal(aaa.conviction.direction, 'up');
  assert.deepEqual(aaa.conviction.factors.map((f) => [f.key, Math.round(f.value * 100)]), [
    ['gap', 100], ['sector', 60], ['orders', 90], ['market', 60], ['range', 100], ['value', 100],
  ]);
  assert.equal(aaa.convictionScore, Math.round((20 * 1 + 20 * 0.6 + 20 * 0.9 + 15 * 0.6 + 15 * 1 + 10 * 1)));
  assert.match(aaa.conviction.factors.find((f) => f.key === 'range').detail, /52-week high/);

  // DDD gapped down but buyers dominate: the order factor counts against it.
  assert.equal(ddd.conviction.direction, 'down');
  assert.equal(Math.round(ddd.conviction.factors.find((f) => f.key === 'orders').value * 100), 10);
  assert.ok(ddd.convictionScore < aaa.convictionScore);

  assert.equal(eee.convictionScore, null);
});

test('missing data drops the factor and rescales the weights', () => {
  const { stocks: [bbb] } = analyze([row('BBB', 1.5)], master);
  assert.deepEqual(bbb.conviction.missing, ['Buy/sell orders', '52-week position']);
  // gap 0.5, sector 1, market 1, value 1 (only stock) over weights 20+20+15+10.
  assert.equal(bbb.convictionScore, Math.round(((20 * 0.5 + 20 + 15 + 10) / 65) * 100));
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
