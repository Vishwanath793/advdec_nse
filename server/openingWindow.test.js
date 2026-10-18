import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTickerMessage, PACKET_SIZE, parseTickerMessage } from '../src/core/kiteTicks.js';
import { createOpeningWindow, depthSummary, impactCost } from '../src/utils/openingWindow.js';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';

const DATE = '2026-10-19';
const at = (time) => +new Date(`${DATE}T${time}+05:30`);

// ---- Binary packets ----

test('full-mode equity packet: every field at its documented offset', () => {
  // Built by hand, byte by byte, from the documented layout (not with the encoder).
  const size = PACKET_SIZE.full;
  const buf = new ArrayBuffer(2 + 2 + size);
  const dv = new DataView(buf);
  dv.setInt16(0, 1);
  dv.setInt16(2, size);
  const p = 4;
  const fields = [408065, 150025, 25, 149950, 1234567, 50000, 60000, 148000, 151000, 147500, 146000,
    Math.floor(at('09:17:05') / 1000), 0, 0, 0, Math.floor(at('09:17:06') / 1000)];
  fields.forEach((v, i) => dv.setInt32(p + i * 4, v));
  // Depth: bid 1 = 100 @ 1500.00 (3 orders); ask 1 = 80 @ 1500.50 (2 orders).
  dv.setInt32(p + 64, 100); dv.setInt32(p + 68, 150000); dv.setInt16(p + 72, 3);
  dv.setInt32(p + 124, 80); dv.setInt32(p + 128, 150050); dv.setInt16(p + 132, 2);
  const [t] = parseTickerMessage(buf);
  assert.equal(t.token, 408065);
  assert.deepEqual([t.ltp, t.lastQty, t.avgPrice, t.volume, t.buyQty, t.sellQty], [1500.25, 25, 1499.5, 1234567, 50000, 60000]);
  assert.deepEqual([t.open, t.high, t.low, t.close], [1480, 1510, 1475, 1460]);
  assert.equal(t.lastTradeTime, at('09:17:05'));
  assert.equal(t.exchangeTime, at('09:17:06'));
  assert.deepEqual(t.depth.buy[0], { qty: 100, price: 1500, orders: 3 });
  assert.deepEqual(t.depth.sell[0], { qty: 80, price: 1500.5, orders: 2 });
  assert.equal(t.depth.buy.length, 5);
});

test('index, LTP and quote packets; heartbeats and truncated messages', () => {
  const ticks = [
    { token: 256265, index: true, ltp: 23000.5, high: 23100, low: 22900, open: 22950, close: 22800, change: 0.88, exchangeTime: at('09:16:00') },
    { token: 1, mode: 'ltp', ltp: 99.95 },
    { token: 2, mode: 'quote', ltp: 10, lastQty: 1, avgPrice: 10, volume: 5, buyQty: 1, sellQty: 2, open: 9, high: 11, low: 8, close: 9.5 },
  ];
  const parsed = parseTickerMessage(encodeTickerMessage(ticks));
  assert.deepEqual(parsed.map((t) => t.mode), ['full', 'ltp', 'quote']);
  assert.equal(parsed[0].index, true);
  assert.equal(parsed[0].exchangeTime, at('09:16:00'));
  assert.equal(parsed[0].open, 22950);
  assert.equal(parsed[1].ltp, 99.95);
  assert.equal(parsed[2].sellQty, 2);
  assert.deepEqual(parseTickerMessage(new Uint8Array([0])), []); // heartbeat
  const msg = encodeTickerMessage(ticks);
  assert.equal(parseTickerMessage(msg.slice(0, msg.length - 5)).length, 2); // truncated: keeps the complete packets
});

// ---- The opening window ----

const meta = {
  1: { kind: 'stock', symbol: 'AAA', prevClose: 100, preOpenVolume: 1000, openVol5Avg: 10_000, sector: 'IT', sectorIndex: 'NIFTY IT', prevHigh: 101, prevLow: 98 },
  2: { kind: 'index', symbol: 'NIFTY 50' },
  3: { kind: 'future', symbol: 'AAAFUT', underlying: 'AAA', prevOi: 1_000_000 },
  4: { kind: 'stock', symbol: 'BBB', prevClose: 50 },
  5: { kind: 'index', symbol: 'NIFTY IT' },
};
const stockTick = (time, ltp, volume, extra = {}) => ({
  token: 1, ltp, volume, avgPrice: 101, buyQty: 500, sellQty: 400, open: 101, high: Math.max(102, ltp), low: Math.min(100.5, ltp), close: 100, exchangeTime: typeof time === 'number' ? time : at(time), ...extra,
});

test('the 09:20:00 cut-off: 09:19:59.999 counts, 09:20:00.000 does not, and the seal is final', () => {
  const w = createOpeningWindow({ date: DATE, instruments: meta });
  w.ingest(stockTick('09:15:00', 101, 2000), at('09:15:00'));
  assert.equal(w.ingest(stockTick(at('09:20') - 1, 103, 5000), at('09:20')).counted, true);
  assert.deepEqual(w.ingest(stockTick(at('09:20'), 110, 9000), at('09:20') + 5), { counted: false, reason: 'after 09:20:00' });
  const live = w.snapshot(at('09:20')).stocks.find((s) => s.symbol === 'AAA');
  assert.equal(live.ltp, 103);
  assert.equal(live.windowVolume, 4000); // 5000 − pre-open 1000
  const sealed = w.seal(at('09:20:01'));
  assert.equal(sealed.sealed, true);
  w.ingest(stockTick(at('09:19:59'), 200, 99_999), at('09:20:02')); // a late packet after the seal
  assert.equal(w.seal().stocks.find((s) => s.symbol === 'AAA').ltp, 103); // unchanged
  assert.equal(w.snapshot(at('09:30')), sealed);
});

test('one-minute and 5-minute candles from ticks', () => {
  const w = createOpeningWindow({ date: DATE, instruments: meta });
  const prices = [['09:15:01', 101, 1500], ['09:15:40', 101.8, 1800], ['09:15:59', 101.2, 2000], ['09:16:10', 100.9, 2600],
    ['09:17:30', 102.4, 3000], ['09:18:05', 102.1, 3500], ['09:19:50', 102.9, 4200]];
  for (const [t, p, v] of prices) w.ingest(stockTick(t, p, v, { high: 103, low: 100.5 }), at(t));
  const s = w.seal().stocks.find((x) => x.symbol === 'AAA');
  assert.deepEqual(s.candles[0], { minute: 0, o: 101, h: 101.8, l: 101, c: 101.2, volume: 1000, approximate: true });
  assert.deepEqual([s.candles[1].o, s.candles[1].c, s.candles[1].volume], [100.9, 100.9, 600]);
  assert.equal(s.candles[2].c, 102.4);
  assert.deepEqual([s.candles[4].c, s.candles[4].volume], [102.9, 700]);
  assert.deepEqual(s.candle5, { o: 101, h: 103, l: 100.5, c: 102.9, volume: 3200 }); // range from Kite's official high/low
  assert.equal(s.windowVolume, 3200);
  assert.ok(Math.abs(s.closePos - (102.9 - 100.5) / 2.5) < 1e-9);
  assert.ok(Math.abs(s.rvol - 0.32) < 1e-9);
  assert.equal(s.gapPct, 1);
});

test('volume: pre-open excluded, duplicates, out-of-order ticks, gaps and feed resets', () => {
  const w = createOpeningWindow({ date: DATE, instruments: meta });
  w.ingest(stockTick('09:14:50', 101, 1200), at('09:14:50')); // last pre-09:15 reading wins as the baseline
  w.ingest(stockTick('09:15:05', 101, 1500), at('09:15:05'));
  w.ingest(stockTick('09:15:05', 101, 1500), at('09:15:06')); // duplicate packet
  w.ingest(stockTick('09:16:30', 101.5, 2500), at('09:16:30'));
  w.ingest(stockTick('09:16:00', 101.2, 2100), at('09:16:31')); // older tick arriving late: no volume
  w.ingest(stockTick('09:18:40', 102, 4000), at('09:18:40')); // a gap: volume lands in the 09:18 minute
  w.ingest(stockTick('09:19:00', 102, 300), at('09:19:00')); // feed reset: cumulative restarted
  w.ingest(stockTick('09:19:30', 102.2, 800), at('09:19:30'));
  const s = w.seal().stocks.find((x) => x.symbol === 'AAA');
  assert.deepEqual(s.minuteVolume, [300, 1000, 0, 1500, 500]);
  assert.equal(s.windowVolume, 3300);
  assert.deepEqual([s.quality.duplicates, s.quality.outOfOrder, s.quality.resets, s.quality.volumeBaseline], [1, 1, 1, 'pre-09:15 tick']);
  assert.equal(s.candles[1].l, 101.2); // the late tick still shows the price traded then
  // Without a pre-09:15 tick, NSE's pre-open quantity is the baseline; without that, the first tick (flagged).
  const w2 = createOpeningWindow({ date: DATE, instruments: { 4: { kind: 'stock', symbol: 'BBB', prevClose: 50 } } });
  w2.ingest({ ...stockTick('09:15:10', 50.5, 900), token: 4 }, at('09:15:10'));
  w2.ingest({ ...stockTick('09:16:10', 50.6, 1400), token: 4 }, at('09:16:10'));
  const b = w2.seal().stocks[0];
  assert.deepEqual([b.windowVolume, b.quality.volumeBaseline], [500, 'first window tick (estimated)']);
});

test('depth: imbalance, spread in bps, liquidity, impact cost', () => {
  const depth = {
    buy: [{ qty: 300, price: 100, orders: 4 }, { qty: 200, price: 99.95, orders: 2 }, { qty: 100, price: 99.9, orders: 1 }, { qty: 0, price: 0, orders: 0 }, { qty: 0, price: 0, orders: 0 }],
    sell: [{ qty: 100, price: 100.1, orders: 1 }, { qty: 100, price: 100.15, orders: 1 }, { qty: 100, price: 100.2, orders: 1 }, { qty: 0, price: 0, orders: 0 }, { qty: 0, price: 0, orders: 0 }],
  };
  const d = depthSummary(depth);
  assert.equal(d.usable, true);
  assert.ok(Math.abs(d.spreadBps - (0.1 / 100.05) * 10_000) < 1e-9);
  assert.equal(d.imbalanceBest, (300 - 100) / 400);
  assert.equal(d.imbalance5, (600 - 300) / 900);
  // Buying ₹15,000: 100 @ 100.10 + 50 @ 100.15 -> above the mid.
  const ic = impactCost(depth, 1, 15_000);
  assert.ok(ic > 0 && ic < 20, `impact ${ic}`);
  assert.equal(impactCost(depth, 1, 10_000_000), null); // the visible book can't fill it
  assert.equal(depthSummary({ buy: [], sell: [] }).usable, false);
});

test('F&O: OI change from the previous close, premium, agreement; missing future -> cash only', () => {
  const w = createOpeningWindow({ date: DATE, instruments: meta });
  w.ingest(stockTick('09:15:00', 101, 2000), at('09:15:00'));
  w.ingest(stockTick('09:19:00', 102, 3000), at('09:19:00'));
  w.ingest({ token: 3, ltp: 101.4, volume: 100, open: 101.3, oi: 1_000_000, exchangeTime: at('09:15:01') }, at('09:15:01'));
  w.ingest({ token: 3, ltp: 102.3, volume: 900, open: 101.3, oi: 1_060_000, exchangeTime: at('09:19:10') }, at('09:19:10'));
  w.ingest({ token: 2, index: true, ltp: 23050, open: 23000, exchangeTime: at('09:19:30') }, at('09:19:30'));
  w.ingest({ token: 5, index: true, ltp: 35100, open: 35000, exchangeTime: at('09:19:30') }, at('09:19:30'));
  const s = w.seal().stocks.find((x) => x.symbol === 'AAA');
  assert.equal(s.fo.oiChange, 60_000);
  assert.equal(s.fo.oiBaseline, 'previous close (historical)');
  assert.ok(Math.abs(s.fo.oiChangePct - 6) < 1e-9);
  assert.equal(s.fo.build, 'long build-up');
  assert.equal(s.fo.agrees, true);
  assert.ok(Math.abs(s.fo.premiumPct - pctOf(102.3, 102)) < 1e-9);
  assert.ok(Math.abs(s.market.relVsNiftyPct - (pctOf(102, 101) - pctOf(23050, 23000))) < 1e-9);
  assert.equal(s.market.sector.symbol, 'NIFTY IT');
  // Without future ticks: no OI, nothing invented.
  const w2 = createOpeningWindow({ date: DATE, instruments: meta });
  w2.ingest(stockTick('09:16:00', 101, 2000), at('09:16:00'));
  const s2 = w2.seal().stocks.find((x) => x.symbol === 'AAA');
  assert.deepEqual(s2.fo, { symbol: 'AAAFUT', missing: 'no future ticks' });
  assert.equal(w2.seal().stocks.find((x) => x.symbol === 'BBB').quality.stale, true); // never ticked
});
const pctOf = (a, b) => ((a - b) / b) * 100;

test('simulated morning: deterministic, 13 stocks, every scenario visible in the sealed features', () => {
  const a = simulatedMorning();
  const b = simulatedMorning();
  assert.deepEqual(a.ticks.slice(0, 50), b.ticks.slice(0, 50));
  assert.equal(a.ticks.length, b.ticks.length);
  const w = createOpeningWindow({ date: a.date, instruments: a.instruments });
  for (const { tick, receivedAt } of a.ticks) for (const t of parseTickerMessage(encodeTickerMessage([tick]))) w.ingest(t, receivedAt);
  const s = Object.fromEntries(w.seal(w.sealAt + 1500).stocks.map((x) => [x.symbol, x]));
  assert.equal(Object.keys(s).length, 13);
  assert.ok(s.ORBUP.closePos > 0.85 && s.ORBUP.rvol > 1.5);
  assert.ok(s.ORBDN.closePos < 0.15);
  assert.ok(s.FAKEOUT.ret5Pct < 0 && s.FAKEOUT.gapPct > 0);
  assert.ok(s.GAPPULL.gapPct >= 3.75 && s.GAPPULL.vwapDistPct > 0 && s.GAPPULL.rvol > 2);
  assert.ok(s.DEADCAT.gapPct >= 3.75 && s.DEADCAT.vwapDistPct < 0 && s.DEADCAT.rvol < 1);
  assert.ok(s.OVEREXT.ret5Pct > 3.5);
  assert.ok(s.ILLIQ.depth.spreadBps > 50);
  assert.equal(s.STALE.quality.stale, true);
  assert.equal(s.LOCKED.depth, null); // one-sided book
  assert.equal(s.FNOSHORT.fo.build, 'short build-up');
  assert.equal(s.NOFUT.fo.missing, 'no future ticks');
  assert.equal(s.MOMO.quality.outOfOrder, 1);
  assert.equal(s.ORBUP.quality.duplicates, 1);
});
