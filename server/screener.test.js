import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanScreener, DEFAULT_SCREENER, screenerMetrics, screenStocks } from '../src/utils/screener.js';

const stock = (symbol, extra = {}) => ({
  symbol, status: 'advance', pctChange: 1.5, buyQty: 700, sellQty: 300, valueCr: 5, rvolX: 2, delivPct: 50, delivQtyX: 1.5, flags: [], ...extra,
});

test('readings: gap either side, gap-side orders, value percentile, auction build in the gap direction', () => {
  const values = [1, 2, 5, 10];
  const up = screenerMetrics(stock('A', { auction: { gap: 2, earlyGap: 1.4 } }), values);
  assert.equal(up.absGap, 1.5);
  assert.equal(up.ordersPct, 70);
  assert.equal(up.valuePct, 50); // ₹5 Cr is higher than 2 of 4 stocks
  assert.ok(Math.abs(up.driftPts - 0.6) < 1e-9);
  const down = screenerMetrics(stock('B', { status: 'decline', pctChange: -2, auction: { gap: -2.5, earlyGap: -2 } }), values);
  assert.equal(down.absGap, 2);
  assert.equal(down.ordersPct, 30); // the sell side
  assert.ok(Math.abs(down.driftPts - 0.5) < 1e-9); // the gap-down grew by 0.5 points
  const bare = screenerMetrics({ symbol: 'C', status: 'advance', pctChange: 1 }, values);
  assert.equal(bare.ordersPct, null);
  assert.equal(bare.driftPts, null);
});

test('quality rank: average percentile among gapped stocks, needs 3 readings, ignores thresholds', () => {
  const stocks = [
    stock('BEST', { rvolX: 9, valueCr: 50, delivPct: 80, delivQtyX: 4, buyQty: 900, sellQty: 100 }),
    stock('MID', { rvolX: 3, valueCr: 10, delivPct: 50, delivQtyX: 1.5 }),
    stock('LOW', { rvolX: 0.5, valueCr: 1, delivPct: 20, delivQtyX: 0.5, buyQty: 400, sellQty: 600 }),
    stock('THIN', { rvolX: null, valueCr: null, delivPct: null, delivQtyX: null, buyQty: null, sellQty: null }),
    stock('FLAT', { status: 'unchanged', pctChange: 0 }),
  ];
  const all = screenStocks(stocks);
  assert.equal(all.gapped, 4); // unchanged stocks are left out
  assert.deepEqual(all.rows.map((r) => [r.stock.symbol, r.rank]), [['BEST', 1], ['MID', 2], ['LOW', 3], ['THIN', null]]);
  assert.equal(all.rows[0].quality, 100);
  assert.equal(all.rows[2].quality, 0);
  assert.equal(all.matched.length, 4); // no thresholds set
  // Thresholds don't change the rank.
  const filtered = screenStocks(stocks, { thresholds: { minRvol: 2 } });
  assert.deepEqual(filtered.matched.map((r) => [r.stock.symbol, r.rank]), [['BEST', 1], ['MID', 2]]);
  // Taking readings out of the rank changes it.
  const onlyOrders = screenStocks(stocks, { inRank: { rvolX: false, valuePct: false, delivPct: false, delivQtyX: false } });
  assert.ok(onlyOrders.rows.every((r) => r.rank == null)); // one reading left: below the minimum
});

test('thresholds: blank is off, missing data fails, rank and direction and tradeable filters', () => {
  const stocks = [
    stock('UP', { pctChange: 2.5, auction: { gap: 3, earlyGap: 2 } }),
    stock('DOWN', { status: 'decline', pctChange: -1, buyQty: 200, sellQty: 800 }),
    stock('LOCKED', { pctChange: 5, flags: [{ severity: 'block', label: 'Circuit' }] }),
  ];
  const by = (settings) => screenStocks(stocks, settings).matched.map((r) => r.stock.symbol).sort();
  assert.deepEqual(by({ thresholds: { minGap: 2 } }), ['LOCKED', 'UP']); // either side
  assert.deepEqual(by({ thresholds: { minGap: '' } }), ['DOWN', 'LOCKED', 'UP']); // blank = not applied
  assert.deepEqual(by({ thresholds: { minOrders: 75 } }), ['DOWN']); // 80% on the sell side
  assert.deepEqual(by({ thresholds: { minDrift: 0.5 } }), ['UP']); // others have no auction data
  assert.deepEqual(by({ direction: 'down' }), ['DOWN']);
  assert.deepEqual(by({ tradeableOnly: true }), ['DOWN', 'UP']);
  const r = screenStocks(stocks, { maxRank: 1 });
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].rank, 1);
  assert.match(r.rows.find((x) => !x.pass).failed.join(), /rank/);
  assert.match(screenStocks(stocks, { thresholds: { minDrift: 0.5 } }).rows.find((x) => x.stock.symbol === 'DOWN').failed.join(), /no data/);
});

test('auction readings: orders held, unmatched demand and futures vs cash, in the gap direction', () => {
  const auction = { gap: 2, earlyGap: 1.5, buyShare: 0.7, avgBuyShare: 0.6, imbalance: 50000, volume: 100000, buyQty: 900000, sellQty: 400000, future: { gap: 2.4, volume: 5000 } };
  const up = screenerMetrics(stock('A', { auction }), []);
  assert.ok(Math.abs(up.heldPts - 10) < 1e-9); // 70% buy at the end vs 60% on average
  assert.equal(up.imbalanceX, 0.5); // 50,000 unmatched on the buy side ÷ 100,000 matched
  assert.ok(Math.abs(up.futuresPts - 0.4) < 1e-9);
  // The same auction read for a gap-down: every reading turns against it.
  const down = screenerMetrics(stock('B', { status: 'decline', pctChange: -2, auction }), []);
  assert.ok(Math.abs(down.heldPts + 10) < 1e-9);
  assert.equal(down.imbalanceX, -0.5);
  assert.ok(Math.abs(down.futuresPts + 0.4) < 1e-9);
  // A future without pre-open volume is left out.
  assert.equal(screenerMetrics(stock('C', { auction: { ...auction, future: { gap: 3, volume: 0 } } }), []).futuresPts, null);
  const stocks = [stock('A', { auction }), stock('B', { status: 'decline', pctChange: -2, auction })];
  const names = (settings) => screenStocks(stocks, settings).matched.map((r) => r.stock.symbol);
  assert.deepEqual(names({ thresholds: { minHeld: 5, minImbalance: 0.3, minFutures: 0.2 } }), ['A']);
});

test('Gap built and Orders held use order entry up to its close, not the final readings', () => {
  const auction = {
    gap: 3.5, earlyGap: 1, buyShare: 0.1, avgBuyShare: 0.6, // final readings (after the matching)
    gapAtClose: 2, buyShareAtClose: 0.9, avgBuyShareToClose: 0.85, // order entry
  };
  const m = screenerMetrics(stock('A', { auction }), []);
  assert.ok(Math.abs(m.driftPts - 1) < 1e-9); // 1% → 2%, not → 3.5%
  assert.ok(Math.abs(m.heldPts - 5) < 1e-9); // 90% vs 85%, not 10% vs 60%
});

test('the buy/sell orders minimum reads the gap side, the buy side or the sell side', () => {
  const stocks = [stock('UP', { buyQty: 700, sellQty: 300 }), stock('DOWN', { status: 'decline', pctChange: -1, buyQty: 300, sellQty: 700 })];
  const names = (settings) => screenStocks(stocks, settings).matched.map((r) => r.stock.symbol).sort();
  assert.deepEqual(names({ thresholds: { minOrders: 60 } }), ['DOWN', 'UP']); // 70% on the gap side for both
  assert.deepEqual(names({ ordersSide: 'buy', thresholds: { minOrders: 60 } }), ['UP']);
  assert.deepEqual(names({ ordersSide: 'sell', thresholds: { minOrders: 60 } }), ['DOWN']);
  assert.equal(cleanScreener({ ordersSide: 'both' }).ordersSide, 'gap');
});

test('gap size can be capped (less than), alone or as a range, on either side', () => {
  const stocks = [stock('SMALL', { pctChange: 0.6 }), stock('MID', { pctChange: 2.5 }), stock('BIG', { status: 'decline', pctChange: -6 })];
  const names = (settings) => screenStocks(stocks, settings).matched.map((r) => r.stock.symbol).sort();
  assert.deepEqual(names({ maxGap: 3 }), ['MID', 'SMALL']); // less than 3%, either side
  assert.deepEqual(names({ maxGap: 3, thresholds: { minGap: 1 } }), ['MID']); // between 1% and 3%
  assert.deepEqual(names({ maxGap: 7 }), ['BIG', 'MID', 'SMALL']); // −6% counts as a 6% gap
  assert.match(screenStocks(stocks, { maxGap: 3 }).rows.find((r) => r.stock.symbol === 'BIG').failed.join(), /Gap size above 3/);
  assert.equal(cleanScreener({ maxGap: '-1' }).maxGap, null);
  assert.equal(cleanScreener({ maxGap: '2.5' }).maxGap, 2.5);
});

test('saved settings are cleaned: bad numbers dropped, defaults filled in', () => {
  const c = cleanScreener({ direction: 'sideways', maxRank: '0', thresholds: { minGap: 'abc', minRvol: '1.5' }, inRank: { rvolX: false } });
  assert.equal(c.direction, 'both');
  assert.equal(c.maxRank, null);
  assert.equal(c.thresholds.minGap, null);
  assert.equal(c.thresholds.minRvol, 1.5);
  assert.equal(c.inRank.rvolX, false);
  assert.equal(c.inRank.delivPct, true);
  assert.deepEqual(cleanScreener(null), cleanScreener(DEFAULT_SCREENER));
});
