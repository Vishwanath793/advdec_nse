import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiteClient, QUOTE_BATCH } from '../src/core/kite.js';
import { foStats, parseFoBhav } from '../src/core/marketContext.js';
import { createRecorder } from '../src/core/recorder.js';
import { analyze } from '../src/utils/analysis.js';
import {
  confirmationPhase, confirmationReading, confirmSetup, minutesSinceOpen, readQuote,
} from '../src/utils/confirmation.js';
import { buildReportCard, dayTrades } from '../src/utils/reportCard.js';
import { oiBuild } from '../src/utils/signals.js';
import { readCalendar } from './tv/calendar.js';

const calendar = readCalendar();
const ist = (iso, time) => new Date(`${iso}T${time}+05:30`);

// ---- Kite quotes ----

test('Kite quotes are requested in batches of 500 with encoded symbols', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const ids = new URL(url).searchParams.getAll('i');
    return { ok: true, status: 200, json: async () => ({ data: Object.fromEntries(ids.map((i) => [i, { last_price: 1 }])) }) };
  };
  const kite = createKiteClient({ fetchImpl });
  const quotes = await kite.quote({ apiKey: 'k', accessToken: 't', instruments: ['NSE:M&M', 'NSE:INFY', 'NSE:INFY', 'bad'] });
  assert.deepEqual(Object.keys(quotes), ['NSE:M&M', 'NSE:INFY']); // duplicates and malformed ids dropped
  assert.match(calls[0].url, /\/quote\?i=NSE%3AM%26M&i=NSE%3AINFY$/);
  assert.equal(calls[0].init.headers.Authorization, 'token k:t');

  calls.length = 0;
  const many = Array.from({ length: QUOTE_BATCH + 3 }, (_, i) => `NSE:S${i}`);
  const all = await kite.quote({ apiKey: 'k', accessToken: 't', instruments: many });
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(all).length, QUOTE_BATCH + 3);
});

test('a Kite error is reported, not swallowed', async () => {
  const kite = createKiteClient({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Incorrect `api_key` or `access_token`.' }) }) });
  await assert.rejects(kite.quote({ apiKey: 'k', accessToken: 'old', instruments: ['NSE:INFY'] }), /Incorrect/);
});

// ---- F&O open interest ----

const FO_HEADER = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';
const fut = (sym, expiry, close, prev, oi, change, type = 'STF') =>
  `2026-10-16,2026-10-16,FO,NSE,${type},1,,${sym},,${expiry},${expiry},,,${sym}FUT,1,1,1,${close},${close},${prev},1,${close},${oi},${change},9,1,9,F1,100,,,,,`;

test('F&O file: open interest summed over expiries, price from the near month', () => {
  const rows = parseFoBhav([
    FO_HEADER,
    fut('ABC', '2026-12-29', 383.55, 386.4, 3031800, 3100),
    fut('ABC', '2026-10-27', 379.6, 382.3, 35293500, -282100), // near month
    fut('ABC', '2026-11-23', 381.5, 384.3, 1187300, 158100),
    fut('NIFTY', '2026-10-27', 23000, 22900, 100, 10, 'IDF'), // index future: ignored
    fut('ABC', '2026-10-27', 1, 1, 1, 1, 'STO'), // stock option: ignored
  ].join('\n'));
  assert.deepEqual(Object.keys(rows), ['ABC']);
  assert.deepEqual(rows.ABC, { oi: 39512600, oiChange: -120900, close: 379.6, prevClose: 382.3 });
  const s = foStats(rows).ABC;
  assert.ok(Math.abs(s.foOiChangePct - (-120900 / (39512600 + 120900)) * 100) < 1e-9);
  assert.ok(Math.abs(s.foPricePct - ((379.6 - 382.3) / 382.3) * 100) < 1e-9);
  assert.throws(() => parseFoBhav('A,B\n1,2'), /Unexpected F&O end-of-day file format/);
});

test('open-interest build-up classification', () => {
  assert.equal(oiBuild(1.2, 6), 'long build-up');
  assert.equal(oiBuild(-1.2, 6), 'short build-up');
  assert.equal(oiBuild(1.2, -6), 'short covering');
  assert.equal(oiBuild(-1.2, -6), 'long unwinding');
  assert.equal(oiBuild(0.1, 6), 'neutral');
  assert.equal(oiBuild(1.2, 0.5), 'neutral');
  assert.equal(oiBuild(null, 6), null);
});

test('OI factor scores build-ups in the gap direction (covering and unwinding count half)', () => {
  const master = [{ Symbol: 'UP', Industry: 'X' }, { Symbol: 'DOWN', Industry: 'X' }];
  const row = (SYMBOL, pct) => ({ SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5 });
  const score = (foPricePct, foOiChangePct) => {
    const stats = { prevHigh: 101, prevLow: 99, prevClose: 100, foOi: 1e6, foPricePct, foOiChangePct };
    const [up, down] = analyze([row('UP', 1.5), row('DOWN', -1.5)], master, null, {
      convictionFactors: { oi: { on: true, weight: 20 } }, context: { history: { stats: { UP: stats, DOWN: stats } } },
    }).stocks;
    const f = (s) => s.conviction.factors.find((x) => x.key === 'oi');
    return [f(up)?.value, f(down)?.value, f(up)?.detail];
  };
  assert.deepEqual(score(1.5, 10).slice(0, 2), [1, 0]); // long build-up, full strength at 10%
  assert.deepEqual(score(-1.5, 10).slice(0, 2), [0, 1]); // short build-up
  assert.deepEqual(score(1.5, -10).slice(0, 2), [0.75, 0.25]); // short covering: half
  assert.deepEqual(score(-1.5, -5).slice(0, 2), [0.375, 0.625]); // long unwinding, 5%: a quarter
  assert.deepEqual(score(0.1, 10).slice(0, 2), [0.5, 0.5]); // flat price: neutral
  assert.match(score(1.5, 10)[2], /Futures \+1\.50% with open interest \+10\.0% yesterday: long build-up, supports the gap/);
  // Not an F&O stock: the factor is missing, not neutral.
  assert.deepEqual(score(null, null).slice(0, 2), [undefined, undefined]);
});

// ---- Confirmation checks ----

const stock = (status, extra = {}) => ({ symbol: 'AAA', status, prevClose: 100, finalPrice: status === 'advance' ? 102 : 98, convictionScore: 70, avgVolume: 1_000_000, ...extra });
const quote = (o) => ({
  last_price: o.ltp, average_price: o.vwap, volume: o.volume ?? 120_000, buy_quantity: o.buy ?? 600, sell_quantity: o.sell ?? 400,
  ohlc: { open: o.open, high: o.high, low: o.low, close: 100 },
});

test('phases of the trading morning', () => {
  const d = '2026-10-19';
  assert.equal(confirmationPhase(ist(d, '09:10:00'), d, calendar, d), 'before');
  assert.equal(confirmationPhase(ist(d, '09:17:00'), d, calendar, d), 'forming');
  assert.equal(confirmationPhase(ist(d, '09:20:00'), d, calendar, d), 'set');
  assert.equal(confirmationPhase(ist(d, '15:31:00'), d, calendar, d), 'after');
  assert.equal(confirmationPhase(ist('2026-10-21', '09:17:00'), d, calendar, '2026-10-21'), 'closed'); // yesterday's pre-open
  assert.equal(confirmationPhase(ist('2026-10-20', '09:17:00'), '2026-10-20', calendar, '2026-10-20'), 'closed'); // Dussehra
  assert.equal(minutesSinceOpen(ist(d, '09:17:30'), d), 2.5);
  assert.equal(minutesSinceOpen(ist(d, '09:00:00'), d), 0);
});

test('a gap-up holding above its open, VWAP and the range high is confirmed', () => {
  const q = readQuote(quote({ ltp: 103.4, open: 102, high: 103.5, low: 101.6, vwap: 102.6 }));
  const c = confirmSetup(stock('advance'), q, { minutes: 5 });
  assert.deepEqual(c.checks.map((x) => [x.key, x.result]), [
    ['open', 'pass'], ['range', 'pass'], ['vwap', 'pass'], ['gap', 'pass'], ['volume', 'pass'], ['book', 'pass'],
  ]);
  assert.deepEqual([c.status, c.score], ['confirmed', 100]);
  assert.deepEqual(c.range, { high: 103.5, low: 101.6 });
  assert.equal(c.plan.entry, 103.51); // break above the range high (₹0.01 tick under ₹250)
  assert.equal(c.plan.stop, 101.6);
  assert.equal(c.plan.triggered, false);
  assert.match(c.checks[1].detail, /At 95% of the range ₹101\.60–₹103\.50 \(near the high\)/);
});

test('a gap-up that slips below its open is failing, and a filled gap fails outright', () => {
  const failing = confirmSetup(stock('advance'), readQuote(quote({ ltp: 101.2, open: 102, high: 102.3, low: 101, vwap: 101.8, buy: 300, sell: 700, volume: 20_000 })), { minutes: 5 });
  assert.equal(failing.status, 'failing');
  const filled = confirmSetup(stock('advance'), readQuote(quote({ ltp: 103, open: 102, high: 103.1, low: 99.9, vwap: 101.5 })), { minutes: 5 });
  assert.equal(filled.status, 'failed');
  assert.match(filled.checks.find((x) => x.key === 'gap').detail, /Gap filled: the low reached yesterday's close ₹100\.00/);
});

test('gap-downs are mirrored', () => {
  const q = readQuote(quote({ ltp: 96.7, open: 98, high: 98.3, low: 96.6, vwap: 97.4, buy: 300, sell: 700 }));
  const c = confirmSetup(stock('decline'), q, { minutes: 5 });
  assert.deepEqual([c.status, c.score], ['confirmed', 100]);
  assert.equal(c.plan.entry, 96.59); // break below the range low
  assert.equal(c.plan.stop, 98.3);
});

test('the volume check scales with the minutes since the open; missing data is left out', () => {
  const q = readQuote(quote({ ltp: 103, open: 102, high: 103.1, low: 101.8, vwap: 102.5, volume: 60_000 }));
  const vol = (minutes) => confirmSetup(stock('advance'), q, { minutes }).checks.find((x) => x.key === 'volume').result;
  assert.equal(vol(5), 'neutral'); // 6% of a normal day by 9:20
  assert.equal(vol(2.5), 'pass'); // the same volume by 9:17:30 is a strong pace
  const noAvg = confirmSetup(stock('advance', { avgVolume: null }), q, { minutes: 5 });
  assert.ok(!noAvg.checks.some((x) => x.key === 'volume'));
  assert.equal(readQuote({ last_price: 0, ohlc: { open: 1 } }), null); // no trade yet
  assert.equal(readQuote(undefined), null);
  assert.equal(confirmSetup(stock('advance'), null).status, 'no-data');
});

test('after 9:20 the frozen range decides the entry', () => {
  const q = readQuote(quote({ ltp: 104, open: 102, high: 104.2, low: 101.6, vwap: 103 }));
  const c = confirmSetup(stock('advance'), q, { range: { high: 103.5, low: 101.6 } });
  assert.equal(c.plan.entry, 103.51);
  assert.equal(c.plan.triggered, true);
});

test('the 9:20 reading keeps levels and results for scored stocks only, and flags late readings', () => {
  const stocks = [stock('advance'), { ...stock('decline'), symbol: 'BBB' }, { ...stock('advance'), symbol: 'CCC', convictionScore: null }];
  const quotes = {
    'NSE:AAA': quote({ ltp: 103.4, open: 102, high: 103.5, low: 101.6, vwap: 102.6 }),
    'NSE:CCC': quote({ ltp: 103.4, open: 102, high: 103.5, low: 101.6, vwap: 102.6 }),
  };
  const r = confirmationReading(stocks, quotes, ist('2026-10-19', '09:20:04'), '2026-10-19');
  assert.deepEqual(Object.keys(r.readings), ['AAA']); // BBB: no quote; CCC: not scored
  assert.deepEqual(r.readings.AAA, { ltp: 103.4, open: 102, high: 103.5, low: 101.6, vwap: 102.6, volume: 120000, status: 'confirmed', score: 100, tradeScore: 88 });
  assert.equal(r.late, false);
  assert.equal(confirmationReading(stocks, quotes, ist('2026-10-19', '09:40:00'), '2026-10-19').late, true);
});

// ---- Saving and scoring the 9:20 reading ----

function memoryStore() {
  const files = new Map();
  return { read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
}

test('the first on-time reading of a day is kept; a late one only fills a gap', async () => {
  const recorder = createRecorder({ store: memoryStore(), calendar, context: {}, inputs: async () => ({}) });
  const r = (late, ltp) => ({ date: '2026-10-19', at: 'x', late, readings: { AAA: { ltp } } });
  assert.deepEqual(await recorder.saveConfirmation(r(true, 1)), { saved: true });
  assert.deepEqual(await recorder.saveConfirmation(r(false, 2)), { saved: true }); // on time replaces late
  assert.equal((await recorder.saveConfirmation(r(false, 3))).saved, false);
  assert.equal((await recorder.saveConfirmation(r(true, 4))).saved, false);
  assert.equal((await recorder.confirmation('2026-10-19')).readings.AAA.ltp, 2);
  await assert.rejects(recorder.saveConfirmation({ date: '19-10-2026', readings: {} }), /needs a date/);
  await assert.rejects(recorder.saveConfirmation({ date: '2026-10-19' }), /needs a date/);
});

test('the report card measures confirmed vs failing setups from the 9:20 price', () => {
  const master = [{ Symbol: 'AAA', Industry: 'X' }, { Symbol: 'BBB', Industry: 'X' }];
  const row = (SYMBOL, pct) => ({ SYMBOL, 'PREV. CLOSE': 100, 'FINAL PRICE': 100 + pct, CHANGE: pct, '%CHANGE': pct, 'VALUE (₹ Crores)': 5 });
  const trades = dayTrades({
    date: '2026-10-19', rows: [row('AAA', 2), row('BBB', 1.5)], masterRows: master, secList: null, context: null,
    outcome: { AAA: { high: 106, low: 101, close: 105 }, BBB: { high: 102, low: 99, close: 99.5 } },
    factorSettings: null,
    confirm: { AAA: { ltp: 103, status: 'confirmed' }, BBB: { ltp: 101, status: 'failing' } },
  });
  const aaa = trades.find((t) => t.symbol === 'AAA');
  assert.equal(aaa.confirm, 'confirmed');
  assert.ok(Math.abs(aaa.ret920 - ((105 - 103) / 103) * 100) < 1e-9);
  const card = buildReportCard([{ date: '2026-10-19', trades }]);
  assert.equal(card.confirmation.days, 1);
  const by = Object.fromEntries(card.confirmation.statuses.map((s) => [s.status, s]));
  assert.deepEqual([by.confirmed.n, by.confirmed.continued], [1, 1]);
  assert.deepEqual([by.failing.n, by.failing.continued], [1, 0]);
  assert.equal(by.mixed.n, 0);
  // Without readings, the section is empty.
  const none = dayTrades({ date: 'x', rows: [row('AAA', 2)], masterRows: master, secList: null, context: null, outcome: { AAA: { high: 1, low: 1, close: 1 } } });
  assert.equal(buildReportCard([{ date: 'x', trades: none }]).confirmation.days, 0);
});

// ---- Market, sector and safety checks ----

import {
  CHASE_PCT, confirmFromQuotes, indexInstruments, MARKET_INDEX, SECTOR_INDEX, WIDE_STOP_PCT,
} from '../src/utils/confirmation.js';

const itStock = (extra = {}) => ({ ...stock('advance'), sector: 'Information Technology', prevHigh: 102.5, prevLow: 99, ...extra });
const kiteQuote = (o) => ({
  ...quote(o),
  upper_circuit_limit: o.uc ?? 120, lower_circuit_limit: o.lc ?? 80,
  depth: { buy: [{ price: o.bid ?? o.ltp - 0.05 }], sell: [{ price: o.ask ?? o.ltp + 0.05 }] },
  last_trade_time: o.traded ?? '2026-10-19 09:19:58', timestamp: o.at ?? '2026-10-19 09:20:00',
});
const index = (open, ltp) => ({ last_price: ltp, ohlc: { open, high: Math.max(open, ltp), low: Math.min(open, ltp), close: open } });
const strong = { ltp: 103.4, open: 102, high: 103.5, low: 101.6, vwap: 102.6 };

test('every check is present when the data is there, in a fixed order', () => {
  const quotes = {
    'NSE:AAA': kiteQuote(strong),
    [MARKET_INDEX]: index(23000, 23069), // +0.3%
    [SECTOR_INDEX['Information Technology']]: index(35000, 35210), // +0.6%
  };
  const c = confirmFromQuotes(itStock(), quotes, { minutes: 5 });
  assert.deepEqual(c.checks.map((x) => [x.key, x.result]), [
    ['open', 'pass'], ['range', 'pass'], ['vwap', 'pass'], ['gap', 'pass'], ['volume', 'pass'], ['book', 'pass'],
    ['pdhl', 'pass'], ['market', 'pass'], ['relative', 'pass'], ['sector', 'pass'],
  ]);
  assert.deepEqual(c.safety.map((x) => [x.key, x.result]), [['circuit', 'pass'], ['spread', 'pass'], ['fresh', 'pass'], ['stop', 'pass']]);
  assert.deepEqual([c.status, c.score, c.avoidReason], ['confirmed', 100, null]);
  assert.match(c.checks.find((x) => x.key === 'sector').detail, /NIFTY IT \+0\.60% since its open/);
  assert.match(c.checks.find((x) => x.key === 'relative').detail, /Stock \+1\.37% vs Nifty \+0\.30% since the open: leading/);
  assert.match(c.checks.find((x) => x.key === 'pdhl').detail, /above yesterday's high ₹102\.50: a true breakout/);
});

test('a falling Nifty counts against a gap-up; an unmapped sector has no sector check', () => {
  const quotes = { 'NSE:AAA': kiteQuote(strong), [MARKET_INDEX]: index(23000, 22885) }; // −0.5%
  const c = confirmFromQuotes(itStock({ sector: 'Textiles' }), quotes, { minutes: 5 });
  assert.equal(c.checks.find((x) => x.key === 'market').result, 'fail');
  assert.equal(c.checks.find((x) => x.key === 'relative').result, 'pass'); // still beating the index
  assert.ok(!c.checks.some((x) => x.key === 'sector'));
  // Inside yesterday's range is neutral, not a failure.
  const inside = confirmFromQuotes(itStock({ prevHigh: 110 }), quotes, { minutes: 5 });
  assert.equal(inside.checks.find((x) => x.key === 'pdhl').result, 'neutral');
  // Mirrored for a gap-down: Nifty falling helps.
  const down = confirmFromQuotes({ ...stock('decline'), sector: 'Textiles' },
    { 'NSE:AAA': kiteQuote({ ltp: 96.7, open: 98, high: 98.3, low: 96.6, vwap: 97.4, buy: 300, sell: 700 }), [MARKET_INDEX]: index(23000, 22885) }, { minutes: 5 });
  assert.equal(down.checks.find((x) => x.key === 'market').result, 'pass');
});

test('safety: too close to the circuit, or locked, means Avoid whatever the score', () => {
  const near = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, uc: 105 })), { minutes: 5 }); // 1.5% room
  assert.deepEqual([near.status, near.avoidReason], ['avoid', 'Room to the circuit']);
  assert.match(near.safety[0].detail, /1\.55% to the upper circuit ₹105\.00: too little room/);
  const locked = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, ltp: 103.5, uc: 103.5 })), { minutes: 5 });
  assert.match(locked.safety[0].detail, /At the upper circuit ₹103\.50: locked/);
  // A gap-down checks the lower limit.
  const down = confirmSetup(stock('decline'), readQuote(kiteQuote({ ltp: 96.7, open: 98, high: 98.3, low: 96.6, vwap: 97.4, lc: 96 })), { minutes: 5 });
  assert.equal(down.status, 'avoid');
  // Without live limits, the app's own circuit levels are used.
  const fallback = confirmSetup(itStock({ upperCircuit: 104 }), readQuote(quote(strong)), { minutes: 5 });
  assert.equal(fallback.safety.find((x) => x.key === 'circuit').result, 'fail');
});

test('safety: spread, a stale last trade, a wide stop and chasing', () => {
  const spread = (bid, ask) => confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, bid, ask })), { minutes: 5 }).safety.find((x) => x.key === 'spread');
  assert.equal(spread(103.35, 103.45).result, 'pass'); // 0.10%
  assert.equal(spread(103.3, 103.5).result, 'warn'); // 0.19%
  const wide = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, bid: 103, ask: 103.6 })), { minutes: 5 });
  assert.deepEqual([wide.safety.find((x) => x.key === 'spread').result, wide.status], ['fail', 'avoid']); // 0.58%
  const noSellers = confirmSetup(itStock(), readQuote({ ...kiteQuote(strong), depth: { buy: [{ price: 103.3 }], sell: [{ price: 0 }] } }), { minutes: 5 });
  assert.match(noSellers.safety.find((x) => x.key === 'spread').detail, /No sellers/);

  const stale = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, traded: '2026-10-19 09:17:30' })), { minutes: 5 });
  assert.deepEqual([stale.safety.find((x) => x.key === 'fresh').result, stale.status], ['warn', 'confirmed']); // a caution only

  const wideStop = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, low: 99.5 })), { range: { high: 103.5, low: 100.6 } });
  assert.ok(wideStop.plan.riskPct > WIDE_STOP_PCT);
  assert.equal(wideStop.safety.find((x) => x.key === 'stop').result, 'warn');

  const chased = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, ltp: 106, high: 106.2 })), { range: { high: 103.5, low: 101.6 } });
  assert.ok(chased.plan.triggered);
  const chase = chased.safety.find((x) => x.key === 'chase');
  assert.equal(chase.result, 'warn');
  assert.match(chase.detail, new RegExp(`past the entry: wait for a pullback towards ₹103\.51`));
  assert.ok(CHASE_PCT < 2.5);
});

test('index instruments: Nifty plus each sector index once; Kite times are read as IST', () => {
  const list = indexInstruments([itStock(), itStock(), { sector: 'Healthcare' }, { sector: 'Textiles' }]);
  assert.deepEqual(list, [MARKET_INDEX, 'NSE:NIFTY IT', 'NSE:NIFTY PHARMA']);
  const q = readQuote(kiteQuote(strong));
  assert.equal(q.lastTradeAt.toISOString(), '2026-10-19T03:49:58.000Z');
  assert.deepEqual([q.upperLimit, q.lowerLimit, q.bid, q.ask].map((n) => Math.round(n * 100) / 100), [120, 80, 103.35, 103.45]);
});

test('the 9:20 reading also keeps Nifty\'s move since the open', () => {
  const r = confirmationReading([itStock()], { 'NSE:AAA': kiteQuote(strong), [MARKET_INDEX]: index(23000, 23069) }, ist('2026-10-19', '09:20:04'), '2026-10-19');
  assert.equal(r.readings.AAA.status, 'confirmed');
  assert.ok(Math.abs(r.market.pct - 0.3) < 1e-9);
});

// ---- Importance weights and the trade score ----

import {
  checkWeights, CONFIRM_CHECKS, DEFAULT_CHECK_SETTINGS, MAX_CHECK_WEIGHT, tradeScore,
} from '../src/utils/confirmation.js';

test('default weights follow importance: more important 3, core 2, moderate 1', () => {
  const w = checkWeights(null);
  for (const k of ['pdhl', 'circuit', 'spread', 'fresh', 'stop', 'chase']) assert.equal(w[k], 3, k);
  for (const k of ['open', 'range', 'vwap', 'gap', 'volume', 'book']) assert.equal(w[k], 2, k);
  for (const k of ['market', 'sector', 'relative']) assert.equal(w[k], 1, k);
  assert.equal(CONFIRM_CHECKS.length, 15);
  assert.deepEqual(checkWeights(DEFAULT_CHECK_SETTINGS), w);
  // Bad values fall back to the default; off means 0; values are clamped.
  assert.equal(checkWeights({ pdhl: { on: true, weight: '' } }).pdhl, 3);
  assert.equal(checkWeights({ pdhl: { on: true, weight: null } }).pdhl, 3);
  assert.equal(checkWeights({ pdhl: { on: false, weight: 3 } }).pdhl, 0);
  assert.equal(checkWeights({ pdhl: { on: true, weight: 50 } }).pdhl, MAX_CHECK_WEIGHT);
  assert.equal(checkWeights({ pdhl: { on: true, weight: -2 } }).pdhl, 0);
});

test('the score is the importance-weighted average of signals and safety', () => {
  // Nifty falling (moderate, weight 1) costs little; inside yesterday's range (important, weight 3) costs more.
  const quotes = (niftyLtp) => ({ 'NSE:AAA': kiteQuote(strong), [MARKET_INDEX]: index(23000, niftyLtp) });
  const c = confirmFromQuotes(itStock({ sector: 'Textiles', prevHigh: 110 }), quotes(22885), { minutes: 5 });
  const used = [...c.checks, ...c.safety];
  const expected = used.reduce((s, x) => s + x.weight * { pass: 1, neutral: 0.5, warn: 0.5, fail: 0 }[x.result], 0)
    / used.reduce((s, x) => s + x.weight, 0);
  assert.equal(c.score, Math.round(expected * 100));
  assert.equal(c.checks.find((x) => x.key === 'market').weight, 1);
  assert.equal(c.checks.find((x) => x.key === 'pdhl').weight, 3);
  // The same Nifty drop hurts more if the user raises its weight.
  const heavy = confirmFromQuotes(itStock({ sector: 'Textiles', prevHigh: 110 }), quotes(22885),
    { minutes: 5, checkSettings: { market: { on: true, weight: 10 } } });
  assert.ok(heavy.score < c.score);
  // A safety caution now lowers the score (it used to be ignored).
  const stale = confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, traded: '2026-10-19 09:17:30' })), { minutes: 5 });
  const fresh = confirmSetup(itStock(), readQuote(kiteQuote(strong)), { minutes: 5 });
  assert.ok(stale.score < fresh.score);
});

test('turning a check off removes it from the score and from overriding the result', () => {
  const near = (checkSettings) => confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, uc: 105 })), { minutes: 5, checkSettings });
  assert.equal(near().status, 'avoid');
  const off = near({ circuit: { on: false, weight: 3 } });
  assert.equal(off.status, 'confirmed');
  assert.equal(off.safety.find((x) => x.key === 'circuit').weight, 0); // still shown, not counted
  const filled = (checkSettings) => confirmSetup(itStock(), readQuote(kiteQuote({ ...strong, low: 99.9 })), { minutes: 5, checkSettings });
  assert.equal(filled().status, 'failed');
  assert.notEqual(filled({ gap: { on: false, weight: 2 } }).status, 'failed');
  const allOff = Object.fromEntries(CONFIRM_CHECKS.map((x) => [x.key, { on: false, weight: x.weight }]));
  assert.deepEqual([near(allOff).score, near(allOff).status], [null, 'no-data']);
});

test('trade score blends the 9:20 confirmation with the 9:08 conviction', () => {
  assert.equal(tradeScore(70, 100), 88); // 60% confirmation by default
  assert.equal(tradeScore(70, 100, 1), 100);
  assert.equal(tradeScore(70, 100, 0), 70);
  assert.equal(tradeScore(70, 100, 5), 100); // clamped
  assert.equal(tradeScore(70, 100, 'x'), 88); // invalid -> default
  assert.equal(tradeScore(null, 80), 80);
  assert.equal(tradeScore(70, null), null);
});
