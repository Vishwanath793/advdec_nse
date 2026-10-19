import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyStats, marketSignalsFor, mergeMarket, parseFlows, parseGiftNifty, parseVix,
} from '../src/core/marketContext.js';
import { analyze } from '../src/utils/analysis.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();

// Shapes as returned by NSE on 16-17 Oct 2026.
const marketStatus = (time, last = 23085, pct = -0.04) => ({
  marketState: [{ market: 'Capital Market', index: 'NIFTY 50', last: 23146.15, tradeDate: '16-Oct-2026 15:30' }],
  giftnifty: { LASTPRICE: last, DAYCHANGE: -9.5, PERCHANGE: pct, SYMBOL: 'NIFTY', TIMESTMP: time },
});
const allIndices = (timestamp, last = 14.08, pct = 0.35) => ({
  timestamp, data: [{ index: 'NIFTY 50', last: 23146.15 }, { index: 'INDIA VIX', last, percentChange: pct, previousClose: 14.03 }],
});
const flowsRows = (date, fii, dii) => [
  { category: 'DII', date, netValue: String(dii) },
  { category: 'FII/FPI', date, netValue: String(fii) },
];

test('NSE market feeds are parsed', () => {
  assert.deepEqual(parseGiftNifty(marketStatus('19-Oct-2026 09:07')), {
    at: '2026-10-19T03:37:00.000Z', last: 23085, change: -9.5, pct: -0.04, niftyClose: 23146.15,
  });
  assert.equal(parseGiftNifty({}), null);
  assert.deepEqual(parseVix(allIndices('16-Oct-2026 15:30')), { date: '2026-10-16', closing: true, last: 14.08, pct: 0.35, prevClose: 14.03 });
  assert.equal(parseVix(allIndices('19-Oct-2026 09:05')).closing, false);
  assert.deepEqual(parseFlows(flowsRows('16-Oct-2026', 1165.92, -3661.28)), { date: '2026-10-16', fii: 1165.92, dii: -3661.28 });
  assert.equal(parseFlows([]), null);
});

test('market history keeps closing VIX and flows by date, and the morning GIFT reading', () => {
  let m = mergeMarket(null, {
    gift: parseGiftNifty(marketStatus('17-Oct-2026 02:44')), // night session: not a morning reading
    vix: parseVix(allIndices('16-Oct-2026 15:30')),
    flows: parseFlows(flowsRows('16-Oct-2026', 1165.92, -3661.28)),
  }, '2026-10-17T00:00:00Z');
  assert.deepEqual(m.giftMornings, {});
  assert.deepEqual(Object.keys(m.vix), ['2026-10-16']);

  // Monday: 09:07 GIFT reading, VIX during the pre-open (not a close: ignored).
  m = mergeMarket(m, {
    gift: parseGiftNifty(marketStatus('19-Oct-2026 09:07', 23250, 0.6)),
    vix: parseVix(allIndices('19-Oct-2026 09:05', 13.5, -4)),
    flows: null,
  }, '2026-10-19T03:37:00Z');
  // 11:00 reading replaces the latest, not the morning one.
  m = mergeMarket(m, { gift: parseGiftNifty(marketStatus('19-Oct-2026 11:00', 23400, 1.2)), vix: null, flows: null }, 'x');
  assert.equal(m.giftMornings['2026-10-19'].last, 23250);
  assert.equal(m.gift.last, 23400);
  assert.deepEqual(Object.keys(m.vix), ['2026-10-16']);

  const signals = marketSignalsFor(m, '2026-10-19', calendar); // previous session: Fri 16 Oct
  assert.equal(signals.previousSession, '2026-10-16');
  assert.deepEqual([signals.gift.last, signals.gift.morning], [23250, true]);
  assert.deepEqual(signals.vix, { date: '2026-10-16', last: 14.08, pct: 0.35, prevClose: 14.03 });
  assert.deepEqual(signals.flows, { date: '2026-10-16', fii: 1165.92, dii: -3661.28 });

  // A day with no readings of its own gets nothing stale.
  const tuesday = marketSignalsFor(m, '2026-10-20', calendar);
  assert.deepEqual([tuesday.gift, tuesday.vix, tuesday.flows], [null, null, null]);
  // Only a later reading that day: used, but marked as after the open.
  const late = marketSignalsFor({ ...m, giftMornings: {} }, '2026-10-19', calendar);
  assert.deepEqual([late.gift.last, late.gift.morning], [23400, false]);
  // The early-hours night session (02:44) is not today's reading.
  const night = mergeMarket(null, { gift: parseGiftNifty(marketStatus('19-Oct-2026 02:44')), vix: null, flows: null }, 'x');
  assert.equal(marketSignalsFor(night, '2026-10-19', calendar).gift, null);
});

test('history keeps delivery % against its usual level, and closes for the trend', () => {
  const day = (n, close, delivery) => ({ date: `d${n}`, rows: { AAA: { high: close + 1, low: close - 1, close, volume: 100, delivery } } });
  const days = Array.from({ length: 21 }, (_, i) => day(i, 100 + i, i === 20 ? 80 : 40));
  const s = historyStats(days).AAA;
  assert.equal(s.prevDelivery, 80);
  assert.equal(s.avgDelivery, 40); // the last day isn't part of "usual"
  assert.deepEqual([s.prevClose, s.close1, s.close5, s.close20], [120, 119, 115, 100]);
});

const master = [{ Symbol: 'UP', Industry: 'X' }, { Symbol: 'DOWN', Industry: 'X' }];
const row = (SYMBOL, pct) => ({ SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5 });
const ON = Object.fromEntries(['delivery', 'closeLoc', 'trend', 'gift', 'vix', 'flows'].map((k) => [k, { on: true, weight: 20 }]));
const factor = (s, key) => s.conviction.factors.find((f) => f.key === key);

function score(stats, market) {
  const stocks = analyze([row('UP', 1.5), row('DOWN', -1.5)], master, null, {
    convictionFactors: ON,
    context: { history: { stats: { UP: stats, DOWN: stats } }, market },
  }).stocks;
  return { up: stocks[0], down: stocks[1] };
}

test('delivery, close location and trend score in the gap direction', () => {
  // Yesterday +2% to a close near the high on 2x usual delivery, after a 5- and 20-session rise.
  const { up, down } = score({ prevHigh: 102, prevLow: 98, prevClose: 101.6, prevDelivery: 60, avgDelivery: 30, close1: 99.6, close5: 96.76, close20: 92.36 });
  assert.equal(factor(up, 'delivery').value, 1); // accumulation: supports buying the gap-up
  assert.equal(factor(down, 'delivery').value, 0); // ...and argues against shorting
  assert.match(factor(up, 'delivery').detail, /Yesterday \+2\.01% on 60\.0% delivery, 2\.0× its usual 30\.0%: buying taken for delivery \(accumulation\)/);
  assert.equal(Math.round(factor(up, 'closeLoc').value * 100), 90);
  assert.equal(Math.round(factor(down, 'closeLoc').value * 100), 10);
  assert.match(factor(up, 'closeLoc').detail, /90% of its low–high range \(near the high\)/);
  assert.equal(factor(up, 'trend').value, 1); // +5% and +10%: full marks with the trend
  assert.equal(factor(down, 'trend').value, 0);
  assert.match(factor(up, 'trend').detail, /5 sessions \+5\.0%, 20 sessions \+10\.0%: with the gap/);

  // Normal delivery or a flat day is neutral.
  assert.equal(factor(score({ prevHigh: 102, prevLow: 98, prevClose: 101, prevDelivery: 30, avgDelivery: 30, close1: 99 }).up, 'delivery').value, 0.5);
  assert.equal(factor(score({ prevHigh: 102, prevLow: 98, prevClose: 100.1, prevDelivery: 90, avgDelivery: 30, close1: 100 }).up, 'delivery').value, 0.5);
  // Missing history: the factors are reported as missing, not guessed.
  const bare = score({ prevHigh: 102, prevLow: 98, prevClose: 101 }).up;
  // Relative volume is on by default (version 3) and has no volume history here: reported missing too.
  assert.deepEqual(bare.conviction.missing, ['Buy/sell orders', 'Relative volume', 'Delivery % (yesterday)', 'Trend (5 & 20 sessions)', 'GIFT Nifty', 'India VIX change', 'FII/DII flows']);
});

test('GIFT Nifty, VIX and FII flows tilt gap-ups and gap-downs in opposite directions', () => {
  const market = {
    gift: { at: '2026-10-19T03:37:00Z', last: 23250, pct: 0.5, morning: true },
    vix: { date: '2026-10-16', last: 14.08, pct: -10 },
    flows: { date: '2026-10-16', fii: -1500, dii: 2000 },
  };
  const { up, down } = score({ prevHigh: 102, prevLow: 98, prevClose: 100 }, market);
  assert.deepEqual([factor(up, 'gift').value, factor(down, 'gift').value], [0.75, 0.25]);
  assert.deepEqual([factor(up, 'vix').value, factor(down, 'vix').value], [1, 0]); // fear easing helps gap-ups
  assert.deepEqual([factor(up, 'flows').value, factor(down, 'flows').value], [0.25, 0.75]); // FII selling helps gap-downs
  assert.match(factor(up, 'gift').detail, /GIFT Nifty 23,250 \(\+0\.50%\) at 09:07 IST: supports the gap/);
  assert.match(factor(down, 'vix').detail, /India VIX 14\.08 \(−10\.00%\) on 16 Oct: fear easing, against the gap/);
  assert.match(factor(down, 'flows').detail, /FII net −₹1,500 Cr, DII net \+₹2,000 Cr on 16 Oct: supports the gap/);
  // Beyond the full-marks point the score stays within 0..1.
  const big = score({ prevHigh: 102, prevLow: 98, prevClose: 100 }, { ...market, gift: { ...market.gift, pct: 3 } });
  assert.deepEqual([factor(big.up, 'gift').value, factor(big.down, 'gift').value], [1, 0]);
});
