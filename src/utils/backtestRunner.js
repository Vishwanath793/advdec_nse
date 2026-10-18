import { candleFeatures, indexMove } from './candleWindow.js';
import { simulateCandleDay } from './candleFills.js';
import { cleanScoringSettings, decideOpening } from './decision.js';
import { cleanRiskSettings } from './risk.js';
import { strategySettings } from './strategies.js';
import { openingRejections } from './confirmation.js';
import { buildTradePlan } from './tradePlan.js';
import {
  breakdown, gapBucket, GAP_BUCKETS, regimeOf, REGIMES, rvolBucket, RVOL_BUCKETS, summarize,
} from './backtestStats.js';

/**
 * Candle backtest runner (milestone 3): the same features → strategies → score
 * → decision → plan pipeline as live, on Kite historical candles, with fills
 * simulated by utils/candleFills.js. Pure: the data comes in, results go out.
 *
 * `days`: [{ date, recorded, stocks: [{ meta, candles }], indices: { 'NIFTY 50': candles, ... } }],
 * oldest first. `meta` per stock: see candleFeatures (prevClose, atr14,
 * openVol5Avg, sector, sectorIndex, convictionScore for recorded days, ...).
 */

export const VARIANTS = [
  { key: 'combined', label: 'Combined 09:20 decision (A + B + C, score, limits)' },
  { key: 'orb', label: 'A. Opening-range breakout only' },
  { key: 'gapPullback', label: 'B. Gap-up pullback recovery only' },
  { key: 'momentum', label: 'C. Opening momentum only' },
  { key: 'baseline', label: 'Simple opening-range baseline (no filters, 1R/2R)' },
  { key: 'conviction', label: '09:10 pre-open conviction alone (recorded days only)' },
];
export const SLIPPAGE_STEPS = [0, 5, 10, 20];
export const SWEEPS = [
  { key: 'minScore', label: 'Minimum score to trade', values: [60, 70, 80], apply: (s, v) => ({ ...s, scoring: { ...s.scoring, minScore: v } }) },
  { key: 'orb.minRvol', label: 'A: minimum RVOL', values: [1, 1.2, 1.5, 2], apply: (s, v) => ({ ...s, strategies: { ...s.strategies, orb: { ...s.strategies.orb, minRvol: v } } }) },
  { key: 'momentum.maxVwapDistPct', label: 'C: maximum distance from VWAP %', values: [1, 1.5, 2, 3], apply: (s, v) => ({ ...s, strategies: { ...s.strategies, momentum: { ...s.strategies.momentum, maxVwapDistPct: v } } }) },
];
export const WALK_FORWARD = { folds: 4, choose: 'minScore', values: [60, 70, 80], minTrades: 10 };

export const LIMITATIONS = [
  'Minute candles can\'t reproduce exact intraminute fills or order-book behaviour: every ambiguity is resolved against the trade (stop before target, worse of trigger and open, slippage on every market-type fill).',
  'There is no order-book history in Kite: depth, spread and imbalance checks are "not tested" here. Only recorded mornings (tick replay) test them.',
  'F&O open interest and circuit limits are not used in candle backtests.',
  'VWAP is computed from 1-minute candles, not Kite\'s average traded price; the 09:15 candle may include the pre-open auction volume differently from live ticks.',
  'Universe: on recorded days, the stocks that gapped in that day\'s recorded pre-open with the master list of that day. On other days, the current master list\'s stocks that gapped at the open, so stocks delisted or renamed since are missing (survivorship bias), and conviction is unknown.',
  'Days with a gap above 20% are skipped (likely a corporate action, not a real gap).',
];

const settingsOf = (input = {}) => ({
  risk: cleanRiskSettings(input.risk ?? {}),
  strategies: strategySettings(input.strategies ?? {}),
  scoring: cleanScoringSettings(input.scoring ?? {}),
});
const only = (s, key) => ({ ...s, strategies: Object.fromEntries(Object.entries(s.strategies).map(([k, v]) => [k, { ...v, enabled: k === key }])) });
const withSlippage = (s, bps) => ({ ...s, risk: { ...s.risk, slippageBps: bps } });

/** One day's features from its candles (built once, reused by every variant). */
export function dayFeatures(day) {
  const idx = (name) => (day.indices?.[name] ? indexMove(name, day.indices[name]) : null);
  const nifty = idx('NIFTY 50');
  const bankNifty = idx('NIFTY BANK');
  const features = day.stocks.map(({ meta, candles }) => candleFeatures(meta, candles, {
    nifty, bankNifty, sector: meta.sectorIndex ? idx(meta.sectorIndex) : null,
  }));
  const candles = Object.fromEntries(day.stocks.map(({ meta, candles }) => [meta.symbol, candles]));
  const tags = Object.fromEntries(features.map((f) => [f.symbol, {
    gapPct: f.gapPct ?? null, rvol: f.rvol ?? null, sector: f.sector ?? null, regime: regimeOf(nifty?.pct ?? null), convictionScore: f.convictionScore ?? null,
  }]));
  return { date: day.date, recorded: Boolean(day.recorded), features, candles, tags, niftyPct: nifty?.pct ?? null };
}

/** Free slots for a day under the limits (each simulated day starts flat). */
const slotsFor = (risk) => Math.min(risk.maxOpenPositions, risk.maxTradesPerDay);

/** Baseline: break of the 09:15–09:20 range in the direction of the move, stop at the other side, 1R/2R, no filters. */
function baselineDecisions(features, s) {
  const risk = { ...s.risk, minRewardRisk: 0.5 }; // the baseline doesn't filter on reward/risk
  const picks = [];
  for (const f of features) {
    if (f.ret5Pct == null || f.ret5Pct === 0 || !(f.orHigh > f.orLow) || openingRejections(f).length) continue;
    const dir = Math.sign(f.ret5Pct);
    const tick = f.tick || 0.05;
    const trigger = dir > 0 ? f.orHigh + tick : f.orLow - tick;
    const stop = dir > 0 ? f.orLow : f.orHigh;
    const R = Math.abs(trigger - stop);
    const plan = buildTradePlan({ direction: dir, trigger, stop, target1: trigger + dir * R, target2: trigger + dir * 2 * R }, f, risk);
    if (plan.ok) picks.push({ symbol: f.symbol, strategy: 'baseline', plan, rank: Math.abs(f.ret5Pct) });
  }
  return picks.sort((a, b) => b.rank - a.rank).slice(0, slotsFor(s.risk)).map((p) => ({ ...p, decision: p.plan.side }));
}

/** Conviction alone: the top tradeable 09:10 picks in the gap direction, entered at 09:20, stop at the range's other side, held to square-off. */
function convictionDecisions(features, s) {
  const picks = [];
  for (const f of features) {
    if (f.convictionScore == null || f.gapPct == null || f.gapPct === 0 || openingRejections(f).length) continue;
    const dir = Math.sign(f.gapPct);
    const stop = dir > 0 ? f.orLow : f.orHigh;
    const R = Math.abs(f.ltp - stop);
    if (!(R > 0) || dir * (f.ltp - stop) <= 0) continue;
    // Targets far away: the position is held to the stop or the square-off.
    const plan = buildTradePlan({ direction: dir, immediate: true, trigger: f.ltp, stop, target1: f.ltp + dir * 1000 * R, target2: f.ltp + dir * 2000 * R }, f, s.risk);
    if (plan.qty > 0) picks.push({ symbol: f.symbol, strategy: 'conviction', plan, rank: f.convictionScore });
  }
  return picks.sort((a, b) => b.rank - a.rank).slice(0, slotsFor(s.risk)).map((p) => ({ ...p, decision: p.plan.side }));
}

/** Trades for one variant over the prepared days. */
export function runVariant(prepared, key, settings) {
  const s = settingsOf(settings);
  const trades = [];
  for (const d of prepared) {
    let decisions;
    if (key === 'baseline') decisions = baselineDecisions(d.features, s);
    else if (key === 'conviction') { if (!d.recorded) continue; decisions = convictionDecisions(d.features, s); }
    else {
      const cfg = key === 'combined' ? s : only(s, key);
      decisions = decideOpening({ date: d.date, stocks: d.features }, { ...cfg, mode: 'BACKTEST' }).decisions;
    }
    trades.push(...simulateCandleDay({ date: d.date, decisions, candlesBySymbol: d.candles, risk: s.risk, meta: d.tags }));
  }
  return trades;
}

function walkForward(prepared, settings) {
  const n = prepared.length;
  const { folds, values, minTrades } = WALK_FORWARD;
  if (n < folds * 2) return { skipped: `needs at least ${folds * 2} days (have ${n})` };
  // Even chronological folds (9 days → 2, 3, 2, 2).
  const edge = (i) => Math.round((i * n) / folds);
  const parts = Array.from({ length: folds }, (_, i) => prepared.slice(edge(i), edge(i + 1))).filter((p) => p.length);
  const sweep = SWEEPS.find((x) => x.key === WALK_FORWARD.choose);
  const steps = [];
  const chosenTrades = [];
  const fixedTrades = [];
  for (let i = 1; i < parts.length; i++) {
    const train = parts.slice(0, i).flat();
    const scored = values.map((v) => ({ v, sum: summarize(runVariant(train, 'combined', sweep.apply(settingsOf(settings), v))) }));
    const eligible = scored.filter((x) => x.sum.trades >= minTrades && x.sum.expectancy != null);
    const best = eligible.sort((a, b) => b.sum.expectancy - a.sum.expectancy)[0];
    const chosen = best?.v ?? settingsOf(settings).scoring.minScore;
    const test = runVariant(parts[i], 'combined', sweep.apply(settingsOf(settings), chosen));
    const fixed = runVariant(parts[i], 'combined', settings);
    chosenTrades.push(...test);
    fixedTrades.push(...fixed);
    steps.push({
      trainDays: `${train[0].date} – ${train.at(-1).date}`, testDays: `${parts[i][0].date} – ${parts[i].at(-1).date}`,
      chosen, chosenBecause: best ? `best in-sample expectancy (₹${best.sum.expectancy})` : `no setting had ${minTrades}+ in-sample trades: kept the current one`,
      test: summarize(test), fixed: summarize(fixed),
    });
  }
  return { parameter: sweep.label, steps, outOfSample: summarize(chosenTrades), fixedOutOfSample: summarize(fixedTrades) };
}

/** Everything the research page shows. `onProgress(done, total)` is called between runs. */
export function runBacktest(days, settings = {}, { onProgress = () => {} } = {}) {
  const prepared = days.map(dayFeatures);
  const total = VARIANTS.length + SLIPPAGE_STEPS.length + SWEEPS.reduce((n, x) => n + x.values.length, 0) + 2;
  let done = 0;
  const tick = () => { done += 1; onProgress(done, total); };

  const variants = VARIANTS.map((v) => {
    const trades = runVariant(prepared, v.key, settings);
    tick();
    return { ...v, summary: summarize(trades), trades };
  });
  const combined = variants.find((v) => v.key === 'combined').trades;
  const slippage = SLIPPAGE_STEPS.map((bps) => {
    const r = { bps, summary: summarize(runVariant(prepared, 'combined', withSlippage(settingsOf(settings), bps))) };
    tick();
    return r;
  });
  const sweeps = SWEEPS.map((sw) => ({
    key: sw.key, label: sw.label,
    values: sw.values.map((value) => { const r = { value, summary: summarize(runVariant(prepared, 'combined', sw.apply(settingsOf(settings), value))) }; tick(); return r; }),
  }));
  const cut = Math.floor(prepared.length * 0.7);
  const oos = prepared.length >= 4 ? {
    split: prepared[cut]?.date ?? null,
    inSample: summarize(runVariant(prepared.slice(0, cut), 'combined', settings)),
    outOfSample: summarize(runVariant(prepared.slice(cut), 'combined', settings)),
  } : { skipped: 'needs at least 4 days' };
  tick();
  const wf = walkForward(prepared, settings);
  tick();

  return {
    days: prepared.length,
    recordedDays: prepared.filter((d) => d.recorded).length,
    first: prepared[0]?.date ?? null,
    last: prepared.at(-1)?.date ?? null,
    stocksTested: prepared.reduce((n, d) => n + d.features.length, 0),
    variants: variants.map(({ trades, ...v }) => v),
    breakdowns: {
      strategy: breakdown(combined, (t) => t.strategy),
      gap: breakdown(combined, gapBucket, GAP_BUCKETS),
      rvol: breakdown(combined, rvolBucket, RVOL_BUCKETS),
      sector: breakdown(combined, (t) => t.sector),
      regime: breakdown(combined, (t) => t.regime, REGIMES),
    },
    slippage, sweeps, oos, walkForward: wf,
    trades: combined.filter((t) => t.status === 'CLOSED').map((t) => ({
      date: t.date, symbol: t.symbol, strategy: t.strategy, side: t.side, score: t.score, qty: t.qty, entry: t.entry, entryAt: t.entryAt,
      exits: t.exits, outcome: t.outcome, gross: t.gross, charges: t.charges, net: t.net, r: t.r != null ? Math.round(t.r * 100) / 100 : null,
      gapPct: t.gapPct, rvol: t.rvol, sector: t.sector, regime: t.regime,
    })),
    notFilled: combined.filter((t) => t.status !== 'CLOSED').map((t) => ({ date: t.date, symbol: t.symbol, strategy: t.strategy, status: t.status, reason: t.reason })),
    limitations: LIMITATIONS,
  };
}
