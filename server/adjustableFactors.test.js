import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { runStrategies } from '../src/utils/strategies.js';
import {
  cleanOpeningThresholds, DEFAULT_FACTOR_SETTINGS, DEFAULT_OPENING_THRESHOLDS, OPENING_FACTORS, OPENING_GROUPS, openingRejections, scoreOpening, scoreTier,
} from '../src/utils/confirmation.js';
import { cleanScoringSettings, decideOpening, DEFAULT_SCORING_SETTINGS } from '../src/utils/decision.js';
import { cleanChargeRates, INTRADAY_EQUITY_RATES, intradayCharges, roundTripCharges } from '../src/utils/charges.js';
import { cleanRiskSettings } from '../src/utils/risk.js';
import { buildTradePlan } from '../src/utils/tradePlan.js';
import { applyEvent, emptyLedger, orderEvents } from '../src/utils/paperLedger.js';
import { cleanTradingSettings } from '../src/core/tradingDesk.js';

// Phase 1: every 09:20 factor adjustable. Defaults must reproduce the original behaviour exactly.

function sealedMorning() {
  const sim = simulatedMorning();
  const w = createOpeningWindow({ date: sim.date, instruments: sim.instruments });
  const sealAt = w.sealAt + 1500;
  for (const t of sim.ticks) if (t.receivedAt < sealAt) w.ingest(t.tick, t.receivedAt);
  return w.seal(sealAt);
}
const sealed = sealedMorning();
const stock = (symbol) => sealed.stocks.find((s) => s.symbol === symbol);
const orb = runStrategies(stock('ORBUP')).find((r) => r.strategy === 'orb');
const opts = { direction: 1, strategy: orb, plan: null, minRewardRisk: 1.5, maxSpreadBps: 25 };
const trades = (d) => d.decisions.filter((x) => x.decision !== 'NO TRADE').map((x) => `${x.symbol} ${x.decision}`).sort();

test('defaults: cleaned settings equal the defaults, and the score and decisions are unchanged', () => {
  assert.deepEqual(cleanScoringSettings({}), DEFAULT_SCORING_SETTINGS);
  assert.deepEqual(cleanOpeningThresholds({}), DEFAULT_OPENING_THRESHOLDS);
  const plain = scoreOpening(stock('ORBUP'), opts);
  const explicit = scoreOpening(stock('ORBUP'), { ...opts, factorSettings: DEFAULT_FACTOR_SETTINGS, thresholds: DEFAULT_OPENING_THRESHOLDS });
  assert.equal(plain.score, explicit.score);
  assert.equal(plain.coverage, explicit.coverage);
  // Every factor the scorer produces can be configured.
  const keys = new Set(OPENING_FACTORS.map((x) => x.key));
  for (const f of plain.factors) assert.ok(keys.has(f.key), f.key);
  for (const f of OPENING_FACTORS) assert.ok(OPENING_GROUPS.some((g) => g.key === f.group), f.key);
  // The simulated morning still buys ORBUP and MOMO.
  assert.deepEqual(trades(decideOpening(sealed)), ['MOMO BUY', 'ORBUP BUY']);
  assert.deepEqual(trades(decideOpening(sealed, { scoring: cleanScoringSettings({}) })), ['MOMO BUY', 'ORBUP BUY']);
});

test('a factor switched off is shown but not scored; a heavier factor counts more in its group', () => {
  const base = scoreOpening(stock('ORBUP'), opts);
  const scoredFactor = base.factors.find((f) => f.result === 'pass' && f.group === 'price');
  const off = scoreOpening(stock('ORBUP'), { ...opts, factorSettings: { ...DEFAULT_FACTOR_SETTINGS, [scoredFactor.key]: { on: false, weight: 1 } } });
  const shown = off.factors.find((f) => f.key === scoredFactor.key);
  assert.equal(shown.off, true);
  assert.equal(shown.result, scoredFactor.result); // still shown with its reading
  const g0 = base.groups.find((g) => g.key === 'price');
  const g1 = off.groups.find((g) => g.key === 'price');
  assert.equal(g1.factors, g0.factors - 1);
  // Weight 0 is the same as off.
  const zero = scoreOpening(stock('ORBUP'), { ...opts, factorSettings: { ...DEFAULT_FACTOR_SETTINGS, [scoredFactor.key]: { on: true, weight: 0 } } });
  assert.equal(zero.score, off.score);

  // A failing factor weighted 5 pulls its group down more than at weight 1.
  const failing = base.factors.find((f) => f.result === 'fail' || f.result === 'warn');
  if (failing) {
    const heavy = scoreOpening(stock('ORBUP'), { ...opts, factorSettings: { ...DEFAULT_FACTOR_SETTINGS, [failing.key]: { on: true, weight: 5 } } });
    const before = base.groups.find((g) => g.key === failing.group).score;
    const after = heavy.groups.find((g) => g.key === failing.group).score;
    assert.ok(after < before, `${failing.key}: ${after} < ${before}`);
  }
});

test('custom preset: group weights are yours; a group at weight 0 is left out', () => {
  const research = scoreOpening(stock('ORBUP'), { ...opts, preset: 'research' });
  const sameAsResearch = scoreOpening(stock('ORBUP'), { ...opts, preset: 'custom', groupWeights: Object.fromEntries(OPENING_GROUPS.map((g) => [g.key, g.research])) });
  assert.equal(sameAsResearch.score, research.score);
  const onlyVolume = Object.fromEntries(OPENING_GROUPS.map((g) => [g.key, g.key === 'volume' ? 1 : 0]));
  const v = scoreOpening(stock('ORBUP'), { ...opts, preset: 'custom', groupWeights: onlyVolume });
  assert.equal(v.score, v.groups.find((g) => g.key === 'volume').score);
  assert.equal(v.preset, 'custom');
  assert.equal(cleanScoringSettings({ preset: 'nonsense' }).preset, 'unit');
});

test('pass/warn lines are adjustable: a higher RVOL bar turns the RVOL factor down', () => {
  const s = stock('ORBUP');
  const at = (thresholds) => scoreOpening(s, { ...opts, thresholds }).factors.find((f) => f.key === 'rvol').result;
  assert.equal(at({}), 'pass');
  assert.equal(at({ rvolGood: s.rvol + 1, rvolOk: s.rvol - 0.01 }), 'warn');
  assert.equal(at({ rvolGood: s.rvol + 2, rvolOk: s.rvol + 1 }), 'fail');
  // Clamped and typed: strings from the form become numbers; nonsense keeps the default.
  const t = cleanOpeningThresholds({ rvolGood: '2.5', consistentGood: 9, rvolOk: 'abc' });
  assert.equal(t.rvolGood, 2.5);
  assert.equal(t.consistentGood, 5);
  assert.equal(t.rvolOk, DEFAULT_OPENING_THRESHOLDS.rvolOk);
});

test('tiers and the tick minimum are adjustable', () => {
  assert.equal(scoreTier(80), 'watchlist');
  assert.equal(scoreTier(80, { strong: 75, watchlist: 60, weak: 40 }), 'strong');
  const tiers = cleanScoringSettings({ tiers: { strong: 60, watchlist: 90, weak: 95 } }).tiers;
  assert.deepEqual(tiers, { strong: 60, watchlist: 60, weak: 60 }); // kept in order
  const f = { ...stock('ORBUP'), quality: { ...stock('ORBUP').quality, ticks: 8 } };
  assert.deepEqual(openingRejections(f, { direction: 1 }), []);
  assert.match(openingRejections(f, { direction: 1, minTicks: 10 }).join(), /too few ticks \(8\)/);
  const d = decideOpening({ ...sealed, stocks: [f] }, { scoring: { thresholds: { minTicks: 10 } } });
  assert.equal(d.decisions[0].decision, 'NO TRADE');
  assert.match(d.decisions[0].reasons.join(), /too few ticks/);
});

test('the minimum score and a factor switched off change the decision', () => {
  assert.deepEqual(trades(decideOpening(sealed, { scoring: { minScore: 100 } })), []);
  const allOff = Object.fromEntries(OPENING_FACTORS.map((x) => [x.key, { on: false, weight: 1 }]));
  const d = decideOpening(sealed, { scoring: { factors: allOff } });
  assert.deepEqual(trades(d), []); // nothing scored: no score, no trade
  assert.ok(d.decisions.every((x) => x.score == null));
});

test('charge rates: cleaned, used by the plan, carried to the paper ledger', () => {
  assert.deepEqual(cleanChargeRates({}), INTRADAY_EQUITY_RATES);
  assert.equal(cleanChargeRates({ brokeragePct: '-1' }).brokeragePct, 0);
  assert.equal(cleanChargeRates({ gstPct: 'x' }).gstPct, INTRADAY_EQUITY_RATES.gstPct);
  const free = { ...INTRADAY_EQUITY_RATES, brokeragePct: 0, sttSellPct: 0, exchangePct: 0, sebiPerCrore: 0, stampBuyPct: 0 };
  assert.equal(roundTripCharges({ side: 'BUY', qty: 100, entry: 1000, exit: 1010 }, free).total, 0);
  assert.ok(intradayCharges([{ side: 'BUY', value: 100_000 }], undefined).total > 0); // undefined rates: the defaults

  const signal = orb.signal;
  const normal = buildTradePlan(signal, stock('ORBUP'), {});
  const cheap = buildTradePlan(signal, stock('ORBUP'), { charges: free });
  assert.ok(normal.costs.total > 0);
  assert.equal(cheap.costs.total, 0);
  assert.ok(cheap.rewardRisk > normal.rewardRisk);
  assert.equal(cheap.chargeRates.brokeragePct, 0);

  // The 09:20 order carries the plan's rates; closing the position charges with them.
  const decision = decideOpening(sealed, { risk: { charges: free } });
  let state = emptyLedger(sealed.date);
  const events = orderEvents(state, decision, { at: '2026-10-19T03:50:02Z', entryUntilAt: Date.parse('2026-10-19T04:00:00Z') });
  assert.ok(events.length > 0);
  assert.equal(events[0].order.chargeRates.brokeragePct, 0);
  for (const e of events) state = applyEvent(state, e);
  const o = events[0].order;
  state = applyEvent(state, { type: 'fill', orderId: o.id, qty: o.qty, price: o.trigger, at: '2026-10-19T03:51:00Z' });
  state = applyEvent(state, { type: 'exit', positionId: o.id, qty: o.qty, price: o.trigger + 1, kind: 'square-off', at: '2026-10-19T09:40:00Z' });
  const p = state.positions.find((x) => x.id === o.id);
  assert.equal(p.status, 'CLOSED');
  assert.equal(p.charges, 0);
});

test('trading settings from the form (strings) are cleaned into numbers and booleans', () => {
  const s = cleanTradingSettings({
    risk: { capital: '200000', charges: { brokeragePct: '0.02' } },
    scoring: { preset: 'custom', minScore: '65', groupWeights: { depth: '0' }, factors: { spread: { on: false, weight: '3' } }, tiers: { strong: '90' } },
    strategies: { orb: { minRvol: '1.4', allowShorts: false } },
  });
  assert.equal(s.mode, 'PAPER');
  assert.equal(s.risk.capital, 200_000);
  assert.equal(s.risk.charges.brokeragePct, 0.02);
  assert.equal(s.scoring.preset, 'custom');
  assert.equal(s.scoring.minScore, 65);
  assert.equal(s.scoring.groupWeights.depth, 0);
  assert.deepEqual(s.scoring.factors.spread, { on: false, weight: 3 });
  assert.equal(s.scoring.tiers.strong, 90);
  assert.equal(s.strategies.orb.minRvol, 1.4);
  assert.equal(s.strategies.orb.allowShorts, false);
  assert.equal(cleanRiskSettings({}).charges.checked, INTRADAY_EQUITY_RATES.checked);
});
