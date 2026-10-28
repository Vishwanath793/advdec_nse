import { roundTripCharges } from './charges.js';
import { cleanRiskSettings, positionSize } from './risk.js';

/**
 * Entry, stop, targets, size and costs for one strategy signal. Prices are
 * rounded to the instrument's tick: entry triggers and stops away from the
 * current price (conservative), targets towards it.
 *
 * Reward is the average of exiting half at target 1 and half at target 2 (the
 * paper broker does exactly that). Reward/risk is after estimated costs. Nothing
 * here promises a fill at the stop or at a target.
 */

const roundUp = (p, tick) => Math.ceil(p / tick - 1e-9) * tick;
const roundDown = (p, tick) => Math.floor(p / tick + 1e-9) * tick;
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * `signal`: { direction: 1 | -1, trigger, stop, target1, target2, immediate? }
 * `features`: sealed stock features (depth, tick, lot). Returns the plan with
 * `ok` and the reasons when it isn't acceptable.
 */
export function buildTradePlan(signal, features, riskSettings, { availableMargin = null } = {}) {
  const s = cleanRiskSettings(riskSettings);
  const tick = features.tick || 0.05;
  const up = signal.direction > 0;
  const reasons = [];
  const bestBid = features.depth?.bestBid ?? null;
  const bestAsk = features.depth?.bestAsk ?? null;
  // Candle backtests have no book at all: the fill simulation uses the candles instead.
  if ((bestBid == null || bestAsk == null) && features.source !== 'candles') reasons.push('no live two-sided order book');
  const spreadBps = features.depth?.spreadBps ?? null;
  if (spreadBps != null && spreadBps > s.maxSpreadBps) reasons.push(`spread ${spreadBps.toFixed(1)} bps is above ${s.maxSpreadBps} bps`);

  // Entry: a stop-style trigger beyond the level, or now at the ask (bid for shorts).
  const touch = up ? bestAsk : bestBid;
  const triggerRaw = signal.immediate ? touch ?? features.ltp : signal.trigger;
  const trigger = r2(up ? roundUp(triggerRaw, tick) : roundDown(triggerRaw, tick));
  const expectedEntryOf = (t) => r2(up ? t + (t * s.slippageBps) / 10_000 : t - (t * s.slippageBps) / 10_000);
  const slip = (trigger * s.slippageBps) / 10_000;
  const expectedEntry = r2(up ? trigger + slip : trigger - slip);
  let maxEntry = r2(up ? trigger * (1 + s.maxSlippageBps / 10_000) : trigger * (1 - s.maxSlippageBps / 10_000));
  // A strategy's own chase limit (D: half the structural risk past its level), frozen at the decision.
  if (signal.maxEntryPrice != null) maxEntry = r2(up ? Math.min(maxEntry, signal.maxEntryPrice) : Math.max(maxEntry, signal.maxEntryPrice));
  if (signal.maxEntryPrice != null && (up ? expectedEntryOf(trigger) > maxEntry : expectedEntryOf(trigger) < maxEntry)) reasons.push(`expected entry is beyond the chase limit ₹${maxEntry} (EXTENDED_ENTRY)`);
  const stop = r2(up ? roundDown(signal.stop, tick) : roundUp(signal.stop, tick));
  const target1 = r2(up ? roundDown(signal.target1, tick) : roundUp(signal.target1, tick));
  const target2 = r2(up ? roundDown(signal.target2, tick) : roundUp(signal.target2, tick));
  const riskPerShare = up ? expectedEntry - stop : stop - expectedEntry;
  if (!(riskPerShare > 0)) reasons.push('stop is not beyond the entry');
  if (up ? target1 <= expectedEntry : target1 >= expectedEntry) reasons.push('target 1 is not beyond the entry');

  // Circuit room: the move to target 1 must fit before the circuit limit.
  const limit = up ? features.upperCircuit : features.lowerCircuit;
  if (limit && (up ? target1 >= limit : target1 <= limit)) reasons.push(`target 1 is at or beyond the ${up ? 'upper' : 'lower'} circuit ₹${limit}`);

  const size = riskPerShare > 0 ? positionSize({ entry: expectedEntry, stop, lot: features.lot ?? 1, settings: s, availableMargin }) : { qty: 0, riskAmount: 0 };
  if (!size.qty) reasons.push(size.reason ?? 'size is zero');
  const qty = size.qty;
  const half = Math.floor(qty / 2);
  const rewardPerShare1 = up ? target1 - expectedEntry : expectedEntry - target1;
  const rewardPerShare2 = up ? target2 - expectedEntry : expectedEntry - target2;
  const grossReward = half * rewardPerShare1 + (qty - half) * rewardPerShare2;
  const avgExit = qty ? (half * target1 + (qty - half) * target2) / qty : expectedEntry;
  const costs = qty ? roundTripCharges({ side: up ? 'BUY' : 'SELL', qty, entry: expectedEntry, exit: avgExit, exitOrders: half ? 2 : 1 }, s.charges) : { total: 0 };
  const stopCosts = qty ? roundTripCharges({ side: up ? 'BUY' : 'SELL', qty, entry: expectedEntry, exit: stop }, s.charges) : { total: 0 };
  const netReward = grossReward - costs.total;
  const netRisk = qty * riskPerShare + stopCosts.total;
  const rewardRisk = netRisk > 0 ? netReward / netRisk : null;
  if (rewardRisk != null && rewardRisk < s.minRewardRisk) reasons.push(`reward/risk after costs ${rewardRisk.toFixed(2)} is below ${s.minRewardRisk}`);
  // Some strategies also need the whole position's net reward to target 1 alone to justify the risk.
  let firstTargetRR = null;
  if (signal.minFirstTargetRR != null && qty) {
    const t1Costs = roundTripCharges({ side: up ? 'BUY' : 'SELL', qty, entry: expectedEntry, exit: target1 }, s.charges);
    firstTargetRR = netRisk > 0 ? (qty * rewardPerShare1 - t1Costs.total) / netRisk : null;
    if (firstTargetRR != null && firstTargetRR < signal.minFirstTargetRR) reasons.push(`reward/risk to target 1 after costs ${firstTargetRR.toFixed(2)} is below ${signal.minFirstTargetRR}`);
  }

  return {
    side: up ? 'BUY' : 'SELL', direction: signal.direction, immediate: Boolean(signal.immediate),
    trigger, expectedEntry, maxEntry, stop, target1, target2,
    riskPerShare: r2(riskPerShare), qty, firstExitQty: half, riskAmount: r2(netRisk), notional: r2(qty * expectedEntry),
    grossReward: r2(grossReward), costs, netReward: r2(netReward), rewardRisk: rewardRisk != null ? r2(rewardRisk) : null,
    firstTargetRR: firstTargetRR != null ? r2(firstTargetRR) : null, entryDeadline: signal.entryDeadline ?? null,
    ...(signal.revalidate ? { revalidate: signal.revalidate, strategyVersion: signal.strategyVersion ?? null } : {}),
    slippageBps: s.slippageBps, maxSlippageBps: s.maxSlippageBps, tick, chargeRates: s.charges,
    ok: reasons.length === 0, reasons,
  };
}
