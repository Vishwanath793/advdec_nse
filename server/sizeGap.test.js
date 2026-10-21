import test from 'node:test';
import assert from 'node:assert/strict';
import { applySizeGap, MIN_POOL, SIZE_PEERS, sizePeerPool, typicalGapForSize } from '../src/utils/sizeGap.js';
import { analyze } from '../src/utils/analysis.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

/** 400 stocks from ₹500 Cr to ₹10 L Cr (log-spaced): small ones usually gap 1%, big ones 0.4%. */
function universe() {
  const rows = [];
  const stats = {};
  for (let i = 0; i < 400; i++) {
    const cap = 500 * (1_000_000 / 500) ** (i / 399);
    const symbol = `S${i}`;
    rows.push({ SYMBOL: symbol, 'FFM CAP (₹ Crores)': cap, '%CHANGE': 0.5 });
    stats[symbol] = { avgAbsGap: cap < 5000 ? 1 : 0.4, gapDays: 20 };
  }
  return { rows, stats };
}

test('the typical gap comes from the 100 stocks nearest in free-float size (log scale)', () => {
  const { rows, stats } = universe();
  const pool = sizePeerPool(rows, stats);
  assert.equal(pool.source, 'history');
  assert.equal(pool.points.length, 400);
  const small = typicalGapForSize(pool, 700, 'S5');
  assert.equal(small.gap, 1);
  assert.equal(small.peers, SIZE_PEERS);
  assert.ok(small.fromCap > 499 && small.toCap < 5000, `${small.fromCap}–${small.toCap}`);
  assert.equal(typicalGapForSize(pool, 500_000).gap, 0.4); // a ₹5 L Cr company: peers are large caps
  assert.equal(typicalGapForSize(pool, 0), null);
  // The stock itself is not one of its own peers.
  const self = typicalGapForSize(pool, rows[200]['FFM CAP (₹ Crores)'], 'S200');
  assert.equal(self.peers, SIZE_PEERS);
});

test('gap vs size: the same 2% gap is ordinary for a small company and unusual for a large one', () => {
  const { rows, stats } = universe();
  const stocks = [
    { symbol: 'SMALL', ffmCap: 800, pctChange: 2, status: 'advance' },
    { symbol: 'LARGE', ffmCap: 800_000, pctChange: -2, status: 'decline' },
    { symbol: 'NOCAP', ffmCap: null, pctChange: 2, status: 'advance' },
  ];
  applySizeGap(stocks, rows, stats);
  close(stocks[0].sizeGapX, 2); // 2% vs a typical 1%
  close(stocks[1].sizeGapX, 5); // 2% vs a typical 0.4%, either direction
  assert.deepEqual([stocks[1].sizeTypicalGap, stocks[1].sizeGapInfo.source], [0.4, 'history']);
  assert.equal(stocks[2].sizeGapX, null);
});

test('without enough history it falls back to today\'s pre-open gaps, and says so; too few stocks gives nothing', () => {
  const { rows } = universe();
  const pool = sizePeerPool(rows, {});
  assert.equal(pool.source, 'today');
  assert.equal(typicalGapForSize(pool, 10_000).gap, 0.5);
  assert.equal(sizePeerPool(rows.slice(0, MIN_POOL - 1), {}), null);
  // Indian digit grouping in an uploaded pm.csv still parses.
  const grouped = rows.map((r) => ({ ...r, 'FFM CAP (₹ Crores)': Math.round(r['FFM CAP (₹ Crores)']).toLocaleString('en-IN') }));
  assert.equal(sizePeerPool(grouped, {}).points.length, 400);
});

test('analyze adds the column for master-list stocks, using the whole pre-open feed as the peer pool', () => {
  const { rows, stats } = universe();
  const full = rows.map((r) => ({ ...r, SERIES: 'EQ', 'PREV. CLOSE': 100, 'FINAL PRICE': 100.5, CHANGE: 0.5 }));
  full[0] = { ...full[0], 'FINAL PRICE': 103, CHANGE: 3, '%CHANGE': 3 };
  const master = [{ Symbol: 'S0', Industry: 'Metals' }]; // only one stock in the master list
  const { stocks } = analyze(full, master, null, { context: { history: { stats } } });
  assert.equal(stocks.length, 1);
  close(stocks[0].sizeGapX, 3); // 3% vs the 1% typical of the smallest companies
  assert.equal(stocks[0].sizeGapInfo.peers, SIZE_PEERS);
});
