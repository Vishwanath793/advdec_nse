import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { runStrategies, DEFAULT_STRATEGY_SETTINGS } from '../src/utils/strategies.js';
import { scoreOpening, openingRejections, scoreTier, CONFIRMED_SCORE, FAILING_SCORE } from '../src/utils/confirmation.js';
import { buildTradePlan } from '../src/utils/tradePlan.js';
import { intradayCharges } from '../src/utils/charges.js';
import { positionSize, tradeBlockers, DEFAULT_RISK_SETTINGS } from '../src/utils/risk.js';
import { decideOpening } from '../src/utils/decision.js';
import { applyEvent, emptyLedger, rebuildLedger, stepTick, orderEvents } from '../src/utils/paperLedger.js';
import { createPaperBroker } from '../src/core/paperBroker.js';
import { createTradingDesk, cleanTradingSettings } from '../src/core/tradingDesk.js';
import { addTradingRoutes } from './tradingRoutes.js';

/** The simulated morning, sealed at 09:20:01.5, plus the ticks that came after. */
function sealedMorning() {
  const sim = simulatedMorning();
  const w = createOpeningWindow({ date: sim.date, instruments: sim.instruments });
  const sealAt = w.sealAt + 1500;
  let i = 0;
  for (; i < sim.ticks.length && sim.ticks[i].receivedAt < sealAt; i++) w.ingest(sim.ticks[i].tick, sim.ticks[i].receivedAt);
  return { sim, sealed: w.seal(sealAt), after: sim.ticks.slice(i) };
}
const { sim, sealed, after } = sealedMorning();
const stock = (symbol) => sealed.stocks.find((s) => s.symbol === symbol);
const strat = (symbol, key) => runStrategies(stock(symbol)).find((r) => r.strategy === key);
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.key);

const memStore = () => {
  const files = new Map();
  return { files, read: async (n) => (files.has(n) ? JSON.parse(files.get(n)) : null), write: async (n, v) => { files.set(n, JSON.stringify(v)); } };
};
const memLog = () => {
  const days = new Map();
  return { days, append: (d, e) => { if (!days.has(d)) days.set(d, []); days.get(d).push(JSON.parse(JSON.stringify(e))); }, read: (d) => days.get(d) ?? [], text: (d) => (days.has(d) ? days.get(d).map((e) => JSON.stringify(e)).join('\n') : null) };
};

// ── Strategies on the simulated scenarios ─────────────────────────────────────
test('strategy A (opening-range breakout): valid long and short, false breakout rejected', () => {
  const up = strat('ORBUP', 'orb');
  assert.equal(up.pass, true);
  assert.equal(up.signal.direction, 1);
  assert.ok(up.signal.trigger > stock('ORBUP').orHigh, 'triggers above the range high');
  assert.ok(up.signal.target1 > up.signal.trigger && up.signal.target2 > up.signal.target1);
  const dn = strat('ORBDN', 'orb');
  assert.equal(dn.pass, true);
  assert.equal(dn.signal.direction, -1);
  assert.ok(dn.signal.trigger < stock('ORBDN').orLow);
  assert.ok(dn.checks.some((c) => c.key === 'shorts' && c.ok), 'shorts are MIS intraday only and allowed by default');
  assert.equal(runStrategies(stock('ORBDN'), { orb: { allowShorts: false } })[0].pass, false);
  assert.equal(strat('FAKEOUT', 'orb').pass, false);
  assert.ok(failed(strat('ILLIQ', 'orb')).includes('spread'));
  assert.equal(strat('FLAT', 'orb').applies, false);
});

test('strategy B (gap-up pullback): a real recovery passes, a dead-cat bounce does not', () => {
  const g = strat('GAPPULL', 'gapPullback');
  assert.equal(g.pass, true, JSON.stringify(failed(g)));
  assert.ok(g.signal.stop < g.signal.trigger);
  assert.ok(g.metrics.volRatio >= DEFAULT_STRATEGY_SETTINGS.gapPullback.minRecoveryVolumeRatio);
  const d = strat('DEADCAT', 'gapPullback');
  assert.equal(d.applies, true);
  assert.equal(d.pass, false);
  for (const k of ['vwap', 'volume']) assert.ok(failed(d).includes(k), `dead cat fails ${k}`);
  assert.equal(strat('ORBUP', 'gapPullback').applies, false, 'below the 3.75% gap threshold');
});

test('strategy C (momentum): consistent move passes, overextended move is rejected', () => {
  const m = strat('MOMO', 'momentum');
  assert.equal(m.pass, true, JSON.stringify(failed(m)));
  assert.equal(m.signal.immediate, true);
  const o = strat('OVEREXT', 'momentum');
  assert.equal(o.pass, false);
  assert.ok(failed(o).includes('notExtended'));
});

// ── Score ────────────────────────────────────────────────────────────────────
test('09:20 score: unit and research presets, tiers, missing F&O left out (never invented)', () => {
  const f = stock('ORBUP');
  const r = strat('ORBUP', 'orb');
  const unit = scoreOpening(f, { direction: 1, strategy: r });
  const research = scoreOpening(f, { direction: 1, strategy: r, preset: 'research' });
  assert.equal(unit.preset, 'unit');
  assert.deepEqual(research.groups.map((g) => g.weight), [20, 20, 20, 15, 10, 10, 5]);
  assert.ok(unit.score >= 0 && unit.score <= 100 && research.score >= 0 && research.score <= 100);
  assert.ok(unit.factors.every((x) => x.source), 'every factor says where it comes from');
  const fo = unit.factors.filter((x) => x.group === 'fo');
  assert.ok(fo.every((x) => x.result == null), 'ORBUP has no future: F&O factors unavailable, not scored');
  assert.ok(unit.coverage < 100);
  assert.equal(scoreTier(90), 'strong');
  assert.equal(scoreTier(CONFIRMED_SCORE), 'watchlist');
  assert.equal(scoreTier(60), 'weak');
  assert.equal(scoreTier(FAILING_SCORE), 'reject');
  const fs = scoreOpening(stock('FNOSHORT'), { direction: -1 });
  assert.equal(fs.factors.find((x) => x.key === 'build').result, 'pass', 'short build-up agrees with a short');
});

test('hard rejections: stale, no book, circuit, partial window and 09:10 blocks beat any score', () => {
  assert.ok(openingRejections(stock('STALE')).some((r) => r.startsWith('stale')));
  const locked = openingRejections(stock('LOCKED'), { direction: 1 });
  assert.ok(locked.includes('no live two-sided order book') && locked.includes('at the upper circuit'));
  assert.ok(openingRejections(stock('ORBUP'), { partial: true }).length > 0);
  const blocked = { ...stock('ORBUP'), flags: [{ key: 't2t', label: 'T2T', severity: 'block', detail: 'trade-to-trade segment' }] };
  assert.ok(openingRejections(blocked).some((r) => r.startsWith('T2T')));
  const d = decideOpening({ ...sealed, stocks: [blocked] });
  assert.equal(d.decisions[0].decision, 'NO TRADE');
  assert.ok(d.decisions[0].score >= CONFIRMED_SCORE, 'the score is high, the rejection still wins');
});

// ── Plan, costs, size ───────────────────────────────────────────────────────
test('charges follow the Zerodha intraday schedule; brokerage capped at ₹20 an order', () => {
  const c = intradayCharges([{ side: 'BUY', value: 100_000 }, { side: 'SELL', value: 100_000 }]);
  assert.equal(c.brokerage, 40); // 0.03% = ₹30 each, capped at ₹20
  assert.equal(c.stt, 25); // 0.025% of the sell
  assert.equal(c.stamp, 3); // 0.003% of the buy
  assert.ok(Math.abs(c.exchange - 6.14) < 0.01);
  assert.ok(c.total > 80 && c.total < 90);
  assert.equal(intradayCharges([{ side: 'BUY', value: 10_000 }]).brokerage, 3);
});

test('trade plan: tick-rounded levels, size from risk, reward/risk after costs', () => {
  const f = stock('ORBUP');
  const r = strat('ORBUP', 'orb');
  const p = buildTradePlan(r.signal, f, DEFAULT_RISK_SETTINGS);
  const onTick = (x) => Math.abs(Math.round(x / 0.05) * 0.05 - x) < 1e-6;
  assert.ok([p.trigger, p.stop, p.target1, p.target2].every(onTick));
  assert.ok(p.expectedEntry > p.trigger && p.maxEntry > p.expectedEntry);
  assert.ok(p.riskAmount <= (DEFAULT_RISK_SETTINGS.capital * DEFAULT_RISK_SETTINGS.riskPerTradePct) / 100 + p.costs.total + 1);
  assert.equal(p.firstExitQty, Math.floor(p.qty / 2));
  assert.equal(p.ok, true);
  const tight = buildTradePlan({ ...r.signal, target1: r.signal.trigger + 0.5, target2: r.signal.trigger + 1 }, f, DEFAULT_RISK_SETTINGS);
  assert.equal(tight.ok, false);
  assert.ok(tight.reasons.some((x) => x.startsWith('reward/risk after costs')));
  const nearCircuit = buildTradePlan(r.signal, { ...f, upperCircuit: r.signal.target1 - 1 }, DEFAULT_RISK_SETTINGS);
  assert.ok(nearCircuit.reasons.some((x) => x.includes('circuit')));
});

test('risk: size from the risk budget and leverage cap; daily limits block new trades', () => {
  const s = { ...DEFAULT_RISK_SETTINGS };
  assert.equal(positionSize({ entry: 100, stop: 99, settings: s }).qty, 250); // ₹250 risk / ₹1
  assert.equal(positionSize({ entry: 1000, stop: 999.9, settings: s }).qty, 500); // capped by ₹5 lakh notional
  assert.equal(positionSize({ entry: 100, stop: 99, lot: 100, settings: s }).qty, 200);
  assert.deepEqual(tradeBlockers({ killSwitch: false, realised: 0, trades: 0, open: 0, consecutiveLosses: 0 }, s), []);
  assert.equal(tradeBlockers({ killSwitch: true, realised: -1000, trades: 3, open: 2, consecutiveLosses: 2 }, s).length, 5);
});

// ── Decision ─────────────────────────────────────────────────────────────────
test('decision: NO TRADE by default, every stock has reasons, slots limit the trades', () => {
  const d = decideOpening(sealed);
  assert.equal(d.decisions.length, sealed.stocks.length);
  const trades = d.decisions.filter((x) => x.decision !== 'NO TRADE');
  assert.equal(trades.length, DEFAULT_RISK_SETTINGS.maxOpenPositions);
  assert.ok(d.decisions.filter((x) => x.decision === 'NO TRADE').every((x) => x.reasons.length > 0));
  for (const sym of ['STALE', 'LOCKED', 'ILLIQ', 'OVEREXT', 'DEADCAT', 'FLAT', 'FAKEOUT']) {
    assert.equal(d.decisions.find((x) => x.symbol === sym).decision, 'NO TRADE', sym);
  }
  assert.ok(trades.every((x) => x.plan.ok && x.score >= CONFIRMED_SCORE));
  const ranked = d.decisions.find((x) => x.eligible && x.decision === 'NO TRADE');
  assert.match(ranked.reasons.at(-1), /slot/);
  const gap = Object.fromEntries(d.gapReport.map((g) => [g.symbol, g.verdict]));
  assert.equal(gap.GAPPULL, 'real recovery');
  assert.notEqual(gap.DEADCAT, 'real recovery');
  // The kill switch, or a partial window, means no trade at all.
  assert.equal(decideOpening(sealed, { day: { killSwitch: true, realised: 0, trades: 0, open: 0, consecutiveLosses: 0 } }).decisions.filter((x) => x.decision !== 'NO TRADE').length, 0);
  assert.equal(decideOpening(sealed, { partial: true }).decisions.filter((x) => x.decision !== 'NO TRADE').length, 0);
  assert.equal(decideOpening(sealed, { scoring: { minScore: 101 } }).decisions.filter((x) => x.decision !== 'NO TRADE').length, 0);
});

// ── Paper fills ──────────────────────────────────────────────────────────────
const T0 = Date.parse('2026-10-19T03:50:30Z'); // 09:20:30 IST
const book = (bid, ask, qty = [100, 100, 100, 100, 100]) => ({
  buy: qty.map((q, i) => ({ qty: q, price: +(bid - i * 0.05).toFixed(2), orders: 1 })),
  sell: qty.map((q, i) => ({ qty: q, price: +(ask + i * 0.05).toFixed(2), orders: 1 })),
});
const tick = (ltp, bid, ask, qty) => ({ token: 7, ltp, depth: book(bid, ask, qty) });
const ledgerWith = (order) => {
  const s = emptyLedger('2026-10-19');
  applyEvent(s, { type: 'decided', at: 'x', rows: [] });
  applyEvent(s, { type: 'order', at: 'x', order: { id: 'o1', symbol: 'TEST', token: 7, side: 'BUY', direction: 1, strategy: 'orb', qty: 100, trigger: 100, maxEntry: 100.15, stop: 98, target1: 103, target2: 106, expiresAt: new Date(T0 + 600_000).toISOString(), ...order } });
  return s;
};
const risk = { ...DEFAULT_RISK_SETTINGS, slippageBps: 5 };

test('paper fills: at the ask plus slippage (never the last price), partial across levels, rest expires', () => {
  const s = ledgerWith({});
  assert.deepEqual(stepTick(s, tick(99.9, 99.85, 99.95), T0, risk), [], 'not triggered below 100');
  const ev = stepTick(s, tick(100, 100, 100.05, [30, 20, 400, 0, 0]), T0 + 1000, risk);
  const fill = ev.find((e) => e.type === 'fill');
  // Levels 100.05 and 100.10 (+5 bps = 100.10, 100.15) are within maxEntry 100.15; 100.15 (+5 bps = 100.2) is not.
  assert.equal(fill.qty, 50);
  assert.ok(fill.price > 100.05 && fill.price <= 100.15, `filled at ${fill.price}, never the LTP 100`);
  assert.equal(s.orders[0].status, 'PARTIAL');
  stepTick(s, tick(100.6, 100.55, 100.6), T0 + 2000, risk); // beyond the limit: waits
  assert.equal(s.orders[0].filledQty, 50);
  const exp = stepTick(s, tick(100.2, 100.15, 100.2), T0 + 600_000, risk);
  assert.equal(exp[0].type, 'cancel');
  assert.equal(s.orders[0].open, false);
  assert.equal(s.positions[0].qty, 50, 'the filled part is a position');
});

test('paper exits: half at target 1, stop to breakeven, stop fills at the bid minus slippage', () => {
  const s = ledgerWith({});
  stepTick(s, tick(100, 99.95, 100), T0, risk);
  const p = s.positions[0];
  assert.equal(p.qty, 100);
  stepTick(s, tick(103, 103, 103.05), T0 + 5000, risk);
  assert.equal(p.qty, 50);
  assert.equal(p.exits[0].price, 103);
  assert.equal(p.stop, p.avgEntry, 'stop moved to the entry');
  stepTick(s, tick(99, 98.9, 99), T0 + 9000, risk);
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.exits[1].reason, 'breakeven stop');
  assert.ok(p.exits[1].price < p.avgEntry, 'a gap through the stop fills worse than the stop');
  assert.ok(p.charges > 0 && p.net < p.gross);
  assert.equal(s.trades, 1);
});

test('paper risk: kill switch closes and cancels; daily loss rejects the next entry; square-off', () => {
  const s = ledgerWith({});
  stepTick(s, tick(100, 99.95, 100), T0, risk);
  applyEvent(s, { type: 'kill', on: true, at: 'x' });
  stepTick(s, tick(101, 100.9, 101), T0 + 1000, risk);
  assert.equal(s.positions[0].status, 'CLOSED');
  assert.equal(s.positions[0].exits[0].kind, 'kill');

  const d = ledgerWith({});
  d.realised = -1000; // the day's loss limit (1% of ₹1 lakh)
  const ev = stepTick(d, tick(100, 99.95, 100), T0, risk);
  assert.equal(ev[0].type, 'reject');
  assert.match(ev[0].reason, /daily loss/);

  const q = ledgerWith({});
  stepTick(q, tick(100, 99.95, 100), T0, risk);
  stepTick(q, tick(101, 100.9, 101), T0 + 1000, risk, { squareOffAt: T0 + 1000 });
  assert.equal(q.positions[0].exits[0].kind, 'squareoff');
});

test('ledger: rebuilt from its events; duplicate orders ignored; one order id per day/stock/strategy', () => {
  const s = ledgerWith({});
  const events = [{ type: 'decided', at: 'x', rows: [] }];
  events.push({ type: 'order', at: 'x', order: s.orders[0] });
  const live = rebuildLedger('2026-10-19', events);
  events.push(...stepTick(live, tick(100, 99.95, 100), T0, risk));
  events.push({ type: 'order', at: 'x', order: { ...s.orders[0], qty: 999 } }); // duplicate
  const rebuilt = rebuildLedger('2026-10-19', events);
  assert.equal(rebuilt.orders.length, 1);
  assert.equal(rebuilt.positions[0].qty, live.positions[0].qty);
  const decision = decideOpening(sealed);
  const once = orderEvents(emptyLedger(sealed.date), decision, { at: 'x' });
  const st = emptyLedger(sealed.date);
  once.forEach((e) => applyEvent(st, e));
  assert.equal(orderEvents(st, decision, { at: 'x' }).length, 0, 'no second order after a restart');
  assert.ok(once.every((e) => /^[A-Za-z0-9]{1,20}$/.test(e.order.tag)), 'Kite tags: alphanumeric, ≤ 20 characters');
});

test('paper broker: restart rebuilds from the log, decides once, reconciles a bad snapshot', async () => {
  const store = memStore();
  const log = memLog();
  const b1 = createPaperBroker({ store, log });
  await b1.load(sealed.date);
  const decision = decideOpening(sealed);
  assert.equal(b1.decide(decision, { at: sealed.sealedAt }).orders, 2);
  for (const t of after) b1.onTicks([t.tick], t.receivedAt);
  await b1.flushed();

  const b2 = createPaperBroker({ store, log });
  const r = await b2.load(sealed.date);
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual(b2.state.orders.map((o) => [o.id, o.status]), b1.state.orders.map((o) => [o.id, o.status]));
  assert.equal(b2.decide(decision, { at: sealed.sealedAt }).orders, 0, 'already decided today');

  const snap = JSON.parse(store.files.get(`paper/${sealed.date}.json`));
  snap.realised += 500;
  store.files.set(`paper/${sealed.date}.json`, JSON.stringify(snap));
  const b3 = createPaperBroker({ store, log });
  const r3 = await b3.load(sealed.date);
  assert.ok(r3.mismatches.some((m) => m.startsWith('realised')));
  assert.equal(b3.state.realised, b1.state.realised, 'the log wins');
});

test('simulated replay through the desk: two paper trades, a target win and a stop loss', async () => {
  const desk = createTradingDesk({ store: memStore(), log: memLog(), calendar: null, settings: () => ({}) });
  await desk.onSeal(sealed, { replay: true });
  for (const t of after) desk.onTicks([t.tick], t.receivedAt, { replay: true });
  desk.onReplayEnd();
  const v = desk.view('replay');
  assert.equal(v.mode, 'PAPER');
  const pos = Object.fromEntries(v.ledgerState.positions.map((p) => [p.symbol, p]));
  assert.deepEqual(Object.keys(pos).sort(), ['MOMO', 'ORBUP']);
  assert.deepEqual(pos.ORBUP.exits.map((x) => x.kind), ['target1', 'target2']);
  assert.ok(pos.ORBUP.net > 0);
  assert.equal(pos.MOMO.exits[0].kind, 'stop');
  assert.ok(pos.MOMO.net < 0);
  assert.equal(v.ledgerState.trades, 2);
  assert.ok(desk.decisionDetail('ORBUP', 'replay').factors.length > 10);
  assert.equal(desk.view('day').ledgerState, null, 'the replay never touches today\'s ledger');
});

test('trading settings are cleaned; LIVE cannot be switched on; routes are same-origin only', async () => {
  assert.equal(cleanTradingSettings({ mode: 'LIVE' }).mode, 'PAPER');
  assert.equal(cleanTradingSettings({ risk: { riskPerTradePct: 'x' } }).risk.riskPerTradePct, 0.25);
  assert.equal(cleanTradingSettings({ strategies: { orb: { minRvol: '2' } } }).strategies.orb.minRvol, 2);
  const desk = createTradingDesk({ store: memStore(), log: memLog(), calendar: null });
  const app = express();
  app.use(express.json());
  addTradingRoutes(app, desk, { settingsFile: `${process.env.TEMP ?? '/tmp'}/trading-settings-test.json`, log: memLog() });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const live = await fetch(`${base}/api/trading/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'LIVE' }) });
    assert.equal(live.status, 409);
    const cross = await fetch(`${base}/api/trading/kill`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"on":true}' });
    assert.equal(cross.status, 403);
    const state = await (await fetch(`${base}/api/trading/state`)).json();
    assert.equal(state.mode, 'PAPER');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
