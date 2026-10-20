import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';
import { ticksToCandles } from '../src/utils/ticksToCandles.js';
import { candleFeatures, windowCandles } from '../src/utils/candleWindow.js';
import { runStrategies } from '../src/utils/strategies.js';
import { openingRejections, scoreOpening } from '../src/utils/confirmation.js';
import { buildTradePlan } from '../src/utils/tradePlan.js';
import { simulateCandleDay } from '../src/utils/candleFills.js';
import { summarize, breakdown, gapBucket, regimeOf } from '../src/utils/backtestStats.js';
import { dayFeatures, runBacktest, runVariant, VARIANTS } from '../src/utils/backtestRunner.js';
import { DEFAULT_RISK_SETTINGS } from '../src/utils/risk.js';

const DATE = '2026-10-19';
const at = (time, date = DATE) => new Date(`${date}T${time}:00+05:30`);
const candle = (time, o, h, l, c, v = 1000, date = DATE) => [at(time, date), o, h, l, c, v];

/** The simulated morning as a candle day (the same 13 scenarios as the tick tests). */
function simulatedCandleDay(date = DATE) {
  const sim = simulatedMorning();
  const shift = +at('09:15', date) - +at('09:15', sim.date);
  const byToken = new Map();
  for (const { tick } of sim.ticks) {
    if (!byToken.has(tick.token)) byToken.set(tick.token, []);
    byToken.get(tick.token).push({ ...tick, exchangeTime: tick.exchangeTime + shift });
  }
  const stocks = [];
  const indices = {};
  for (const [token, m] of Object.entries(sim.instruments)) {
    const candles = ticksToCandles(byToken.get(Number(token)) ?? []);
    if (m.kind === 'index') indices[m.symbol] = candles;
    if (m.kind === 'stock') stocks.push({ meta: { ...m, token: Number(token), convictionScore: sim.candidates.find((c) => c.symbol === m.symbol)?.convictionScore }, candles });
  }
  return { date, recorded: true, stocks, indices };
}

test('ticks become 1-minute candles: OHLC from the LTP, volume from cumulative volume', () => {
  const t0 = +at('09:15');
  const c = ticksToCandles([
    { exchangeTime: t0, ltp: 100, volume: 1000 }, { exchangeTime: t0 + 20_000, ltp: 102, volume: 1300 },
    { exchangeTime: t0 + 40_000, ltp: 99, volume: 1500 }, { exchangeTime: t0 + 61_000, ltp: 101, volume: 1600 },
  ]);
  assert.equal(c.length, 2);
  assert.deepEqual(c[0].slice(1), [100, 102, 99, 99, 500]);
  assert.deepEqual(c[1].slice(1), [101, 101, 101, 101, 100]);
});

test('candle features: same shape as the live window, no order book or F&O, and no look-ahead', () => {
  const day = simulatedCandleDay();
  const s = day.stocks.find((x) => x.meta.symbol === 'ORBUP');
  const f = candleFeatures(s.meta, s.candles, {});
  const w = windowCandles(s.candles).filter(Boolean);
  assert.equal(f.source, 'candles');
  assert.equal(w.length, 5);
  assert.equal(f.orHigh, Math.max(...w.map((c) => c[2])));
  assert.equal(f.orLow, Math.min(...w.map((c) => c[3])));
  assert.equal(f.ltp, w[4][4]);
  assert.equal(f.depth, null);
  assert.ok(f.fo.missing);
  assert.equal(f.upperCircuit, null);
  assert.match(f.vwapSource, /computed from 1-minute candles/);
  // Changing anything after 09:20 changes nothing at 09:20.
  const later = s.candles.map((c) => (c[0] >= at('09:20') ? [c[0], 1, 9999, 1, 9999, 1e9] : c));
  assert.deepEqual(candleFeatures(s.meta, later, {}), f);
});

test('on candles, order-book checks are "not tested" (never passed on made-up data); a missing minute is a hard rejection', () => {
  const day = simulatedCandleDay();
  const f = candleFeatures(day.stocks.find((x) => x.meta.symbol === 'ORBUP').meta, day.stocks.find((x) => x.meta.symbol === 'ORBUP').candles, {});
  const orb = runStrategies(f).find((r) => r.strategy === 'orb');
  const spread = orb.checks.find((c) => c.key === 'spread');
  assert.equal(spread.untested, true);
  assert.match(spread.detail, /not tested/);
  const score = scoreOpening(f, { direction: 1, strategy: orb });
  assert.ok(score.factors.filter((x) => x.group === 'depth').every((x) => x.result == null), 'depth factors not scored');
  assert.deepEqual(openingRejections(f), []);
  const plan = buildTradePlan(orb.signal, f, DEFAULT_RISK_SETTINGS);
  assert.ok(!plan.reasons.includes('no live two-sided order book'));
  const stale = day.stocks.find((x) => x.meta.symbol === 'STALE');
  assert.match(openingRejections(candleFeatures(stale.meta, stale.candles, {}))[0], /of the five 09:15–09:19 candles/);
});

// ── Fill rules on handmade candles ─────────────────────────────────────────────
const plan = (p = {}) => ({ direction: 1, side: 'BUY', trigger: 100, maxEntry: 100.15, stop: 98, target1: 103, target2: 106, qty: 100, firstExitQty: 50, riskAmount: 200, rewardRisk: 2, immediate: false, ...p });
const sim = (candles, p = {}, risk = {}) => simulateCandleDay({ date: DATE, decisions: [{ symbol: 'X', decision: 'BUY', strategy: 'orb', plan: plan(p) }], candlesBySymbol: { X: candles }, risk: { ...DEFAULT_RISK_SETTINGS, slippageBps: 5, ...risk } })[0];

test('candle fills: entry at the worse of trigger and open plus slippage; a minute with both stop and target counts as the stop', () => {
  const t = sim([
    candle('09:20', 99.5, 100.1, 99.4, 100),
    candle('09:21', 100.5, 103.5, 97.5, 101), // both target 1 and the stop: the stop wins
  ]);
  assert.equal(t.entry, 100.05); // trigger 100 + 5 bps
  assert.equal(t.exits[0].kind, 'stop');
  assert.ok(t.net < 0);
});

test('candle fills: a gap through the stop fills at the open; targets fill at the target price', () => {
  const gap = sim([candle('09:20', 99.9, 100.2, 99.9, 100.1), candle('09:21', 97, 97.5, 96.5, 97)]);
  assert.equal(gap.exits[0].price, 96.95); // the open 97 minus 5 bps, worse than the 98 stop
  const win = sim([
    candle('09:20', 99.9, 100.2, 99.9, 100.1), candle('09:21', 101, 103.2, 100.5, 103), candle('09:22', 103, 106.5, 102.8, 106),
  ]);
  assert.deepEqual(win.exits.map((x) => [x.kind, x.qty, x.price]), [['target1', 50, 103], ['target2', 50, 106]]);
  assert.ok(win.net > 0 && win.charges > 0 && win.net < win.gross);
});

test('candle fills: entry beyond the maximum waits like a limit; untriggered entries expire; the square-off closes the rest', () => {
  const waits = sim([candle('09:20', 101, 101.5, 100.9, 101.2), candle('09:21', 100.5, 100.8, 100.0, 100.4)]);
  assert.equal(waits.entryAt, '09:21');
  assert.equal(waits.entry, 100.15);
  const expired = sim([candle('09:20', 99, 99.5, 98.9, 99.2), candle('09:30', 99, 99.5, 98.9, 99.2)]);
  assert.equal(expired.status, 'EXPIRED');
  const held = sim([candle('09:20', 99.9, 100.2, 99.9, 100.1), candle('11:00', 101, 101.5, 100.8, 101), candle('15:10', 101.2, 101.3, 101, 101.1)]);
  assert.equal(held.exits[0].kind, 'squareoff');
  assert.equal(held.exits[0].price, 101.15); // the 15:10 open minus 5 bps
});

test('candle fills: the daily loss limit, reached by an earlier loss, rejects a later entry', () => {
  const decisions = [
    { symbol: 'A', decision: 'BUY', plan: plan({ qty: 600 }) },
    { symbol: 'B', decision: 'BUY', plan: plan() },
  ];
  const trades = simulateCandleDay({
    date: DATE, decisions, risk: DEFAULT_RISK_SETTINGS,
    candlesBySymbol: {
      A: [candle('09:20', 99.9, 100.2, 99.9, 100.1), candle('09:21', 96, 96.2, 95.8, 96)], // −₹2,400 at the stop
      B: [candle('09:20', 99, 99.2, 98.9, 99), candle('09:22', 99.9, 100.3, 99.8, 100.2)],
    },
  });
  assert.equal(trades[0].exits[0].kind, 'stop');
  assert.equal(trades[1].status, 'REJECTED');
});

test('statistics: win rate, profit factor, drawdown, expectancy and the longest losing streak', () => {
  const tr = (date, exitAt, net, r = null) => ({ status: 'CLOSED', date, exitAt, net, r, charges: 1, plan: { rewardRisk: 2 } });
  const s = summarize([tr('d1', '10:00', 300), tr('d1', '11:00', -100), tr('d2', '10:00', -200), tr('d2', '11:00', -50), tr('d3', '10:00', 400)]);
  assert.deepEqual([s.trades, s.wins, s.losses, s.net], [5, 2, 3, 350]);
  assert.equal(s.winRate, 0.4);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.maxDrawdown, 350); // from +300 down to −50
  assert.equal(s.longestLosingStreak, 3);
  assert.equal(s.expectancy, 70);
  assert.equal(gapBucket({ gapPct: -4 }), '3.75% and over');
  assert.equal(regimeOf(-0.5), 'Nifty down');
  assert.deepEqual(breakdown([tr('d1', '10:00', 5)], () => null).map((b) => b.key), ['unknown']);
});

test('runner on the simulated morning: the combined decision trades ORBUP (both targets) and MOMO (stopped), like paper trading', () => {
  const prepared = [dayFeatures(simulatedCandleDay())];
  const trades = runVariant(prepared, 'combined', {}).filter((t) => t.status === 'CLOSED');
  const by = Object.fromEntries(trades.map((t) => [t.symbol, t]));
  assert.deepEqual(Object.keys(by).sort(), ['MOMO', 'ORBUP']);
  assert.equal(by.ORBUP.outcome, 'target1+target2');
  assert.equal(by.MOMO.outcome, 'stop');
  // Conviction alone runs only on recorded days (it needs the 09:10 conviction).
  assert.equal(runVariant([{ ...prepared[0], recorded: false }], 'conviction', {}).length, 0);
  assert.ok(runVariant(prepared, 'conviction', {}).length > 0);
});

test('tick replay of a recorded morning: the same decision and paper fills at the recorded bid/ask; open positions close when the recording ends', async () => {
  const { replayRecordedDay } = await import('../src/utils/tickReplay.js');
  const sim = simulatedMorning();
  const r = replayRecordedDay({ date: sim.date, meta: sim.instruments, ticks: sim.ticks });
  assert.equal(r.decisions, 2);
  const by = Object.fromEntries(r.trades.map((t) => [t.symbol, t]));
  assert.deepEqual(Object.keys(by).sort(), ['MOMO', 'ORBUP']);
  assert.equal(by.ORBUP.outcome, 'target1+target2');
  assert.equal(by.MOMO.outcome, 'stop');
  assert.ok(r.trades.every((t) => t.status === 'CLOSED' && t.net != null));
  // Recorded mornings end at 09:25: a position still open then is closed at the last bid/ask.
  const cut = sim.ticks.filter((x) => x.tick.exchangeTime < +at('09:21', sim.date));
  const rc = replayRecordedDay({ date: sim.date, meta: sim.instruments, ticks: cut });
  assert.deepEqual(rc.trades.map((t) => [t.symbol, t.status, t.outcome]).sort(), [['MOMO', 'CLOSED', 'recordingend'], ['ORBUP', 'CLOSED', 'recordingend']]);
});

test('full backtest: all six comparisons, breakdowns, slippage and parameter sensitivity, out-of-sample and walk-forward', () => {
  const dates = ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14'];
  const progress = [];
  const r = runBacktest(dates.map((d) => simulatedCandleDay(d)), {}, { onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(r.days, 9);
  assert.deepEqual(r.variants.map((v) => v.key), VARIANTS.map((v) => v.key));
  const combined = r.variants.find((v) => v.key === 'combined').summary;
  assert.equal(combined.trades, 18); // two a day
  // More slippage never helps.
  const nets = r.slippage.map((x) => x.summary.net);
  for (let i = 1; i < nets.length; i++) assert.ok(nets[i] <= nets[i - 1], `slippage ${r.slippage[i].bps} bps`);
  assert.equal(r.sweeps.length, 3);
  assert.ok(r.oos.inSample.trades > 0 && r.oos.outOfSample.trades > 0);
  assert.equal(r.walkForward.steps.length, 3);
  assert.ok(r.walkForward.steps.every((s) => [60, 70, 80].includes(s.chosen) && s.trainDays && s.testDays));
  assert.ok(r.breakdowns.regime.length && r.breakdowns.gap.length && r.breakdowns.strategy.length);
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  assert.ok(r.limitations.some((x) => /order-book/.test(x)));
});
