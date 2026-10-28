import {
  cleanOpeningThresholds, CONFIRMED_SCORE, DEFAULT_FACTOR_SETTINGS, DEFAULT_GROUP_WEIGHTS, DEFAULT_OPENING_THRESHOLDS, DEFAULT_SCORE_PRESET, DEFAULT_SCORE_TIERS,
  MAX_FACTOR_WEIGHT, openingRejections, SCORE_PRESETS, scoreOpening,
} from './confirmation.js';
import { cleanRiskSettings, tradeBlockers } from './risk.js';
import { runStrategies, strategySettings, STRATEGY_LABEL } from './strategies.js';
import { buildTradePlan } from './tradePlan.js';

/**
 * The 09:20 decision (pure): for every stock in the sealed window, run the
 * strategies, plan each passing signal, score it, apply the hard rejections,
 * then rank what's left and fill the free slots under the risk limits.
 * The default for every stock is NO TRADE; each one says why.
 */

export const DEFAULT_SCORING_SETTINGS = {
  preset: DEFAULT_SCORE_PRESET, minScore: CONFIRMED_SCORE, groupWeights: DEFAULT_GROUP_WEIGHTS,
  factors: DEFAULT_FACTOR_SETTINGS, tiers: DEFAULT_SCORE_TIERS, thresholds: DEFAULT_OPENING_THRESHOLDS,
};

const clampNum = (v, d, lo, hi) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n));
};

/** Scoring settings merged over the defaults: preset, minimum score, group and factor weights, tiers, thresholds. */
export function cleanScoringSettings(input = {}) {
  const tiers = Object.fromEntries(Object.entries(DEFAULT_SCORE_TIERS).map(([k, d]) => [k, clampNum(input?.tiers?.[k], d, 0, 100)]));
  // Keep the tiers in order: strong ≥ watchlist ≥ weak.
  tiers.watchlist = Math.min(tiers.watchlist, tiers.strong);
  tiers.weak = Math.min(tiers.weak, tiers.watchlist);
  return {
    preset: SCORE_PRESETS[input?.preset] ? input.preset : 'unit',
    minScore: clampNum(input?.minScore, CONFIRMED_SCORE, 0, 100),
    groupWeights: Object.fromEntries(Object.entries(DEFAULT_GROUP_WEIGHTS).map(([k, d]) => [k, clampNum(input?.groupWeights?.[k], d, 0, 100)])),
    factors: Object.fromEntries(Object.entries(DEFAULT_FACTOR_SETTINGS).map(([k, d]) => [k, {
      on: typeof input?.factors?.[k]?.on === 'boolean' ? input.factors[k].on : d.on,
      weight: clampNum(input?.factors?.[k]?.weight, d.weight, 0, MAX_FACTOR_WEIGHT),
    }])),
    tiers,
    thresholds: cleanOpeningThresholds(input?.thresholds),
  };
}

const NO_DAY = { killSwitch: false, realised: 0, trades: 0, open: 0, consecutiveLosses: 0 };

/** One stock: the best plan among its passing strategies, or why there's none. */
export function evaluateStock(f, { strategies, risk, scoring, partial = false, availableMargin = null } = {}) {
  const results = runStrategies(f, strategies);
  const options = (r, plan) => ({
    direction: r.direction, strategy: r, plan, preset: scoring.preset, groupWeights: scoring.groupWeights, factorSettings: scoring.factors,
    tiers: scoring.tiers, thresholds: scoring.thresholds, minRewardRisk: risk.minRewardRisk, maxSpreadBps: risk.maxSpreadBps,
  });
  const tried = results.filter((r) => r.pass && !r.shadow).map((r) => {
    const plan = buildTradePlan(r.signal, f, risk, { availableMargin });
    return { result: r, plan, score: scoreOpening(f, options(r, plan)) };
  });
  tried.sort((a, b) => (b.plan.ok - a.plan.ok) || (b.score.score - a.score.score) || ((b.plan.rewardRisk ?? 0) - (a.plan.rewardRisk ?? 0)));
  const best = tried[0] ?? null;
  // Without a passing strategy, still score the stock's own direction so the scanner can show it.
  const nearest = results.filter((r) => r.applies).sort((a, b) => b.checks.filter((c) => c.ok).length / Math.max(1, b.checks.length) - a.checks.filter((c) => c.ok).length / Math.max(1, a.checks.length))[0];
  const direction = best?.result.direction ?? nearest?.direction ?? Math.sign(f.ret5Pct || f.gapPct || 1);
  const score = best?.score ?? scoreOpening(f, options(nearest ?? { direction, checks: [], label: '', pass: false }, null));
  const rejections = openingRejections(f, { direction, partial, minTicks: scoring.thresholds?.minTicks });

  const reasons = [];
  if (rejections.length) reasons.push(...rejections);
  if (!best) {
    const why = results.map((r) => `${r.label}: ${r.applies ? r.checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase()).join(', ') || r.reason || 'no signal' : r.reason}`);
    reasons.push('no strategy setup', ...why);
  } else {
    if (!best.plan.ok) reasons.push(...best.plan.reasons);
    if (best.score.score == null || best.score.score < scoring.minScore) reasons.push(`score ${best.score.score ?? 'n/a'} is below ${scoring.minScore}`);
  }
  const eligible = Boolean(best) && rejections.length === 0 && best.plan.ok && best.score.score >= scoring.minScore;
  return {
    symbol: f.symbol, token: f.token, sector: f.sector, direction, eligible,
    strategy: best?.result.strategy ?? null, strategyLabel: best?.result.label ?? null,
    score: score.score, tier: score.tier, coverage: score.coverage, groups: score.groups, factors: score.factors,
    plan: best?.plan ?? null, signalNote: best?.result.signal?.note ?? null,
    rejections, reasons,
    strategies: results.map((r) => ({
      strategy: r.strategy, label: r.label, applies: r.applies, pass: r.pass, shadow: Boolean(r.shadow), code: r.code ?? null,
      direction: r.direction ?? null, reason: r.reason ?? null, summary: r.summary ?? null, checks: r.checks, metrics: r.metrics ?? null,
    })),
    alternatives: tried.slice(1).map((t) => ({ strategy: t.result.strategy, score: t.score.score, ok: t.plan.ok, rewardRisk: t.plan.rewardRisk })),
  };
}

/** Gap-up stocks (strategy B's threshold and above), reported on their own: recovery vs dead-cat bounce. */
export function gapReport(evaluations, strategies) {
  const cfg = strategySettings(strategies).gapPullback;
  return evaluations.filter((e) => e.gapPct != null && e.gapPct >= cfg.minGapPct).map((e) => {
    const b = e.strategies.find((s) => s.strategy === 'gapPullback');
    const failed = new Set((b?.checks ?? []).filter((c) => !c.ok).map((c) => c.key));
    const verdict = b?.pass ? 'real recovery'
      : failed.has('gapHeld') ? 'gap filled'
        : failed.has('order') || failed.has('pullback') ? 'no pullback yet'
          : failed.has('volume') || failed.has('vwap') || failed.has('recovery') ? 'dead-cat bounce'
            : 'recovery, but not tradeable';
    return { symbol: e.symbol, gapPct: e.gapPct, verdict, failed: [...failed], decision: e.decision };
  });
}

/**
 * Decide at the seal. `day`: today's ledger so far ({ killSwitch, realised, trades, open,
 * consecutiveLosses }). Returns { decisions, gapReport, blockers, slots, settings }.
 */
export function decideOpening(sealed, { strategies = {}, risk = {}, scoring = {}, day = NO_DAY, partial = false, availableMargin = null, mode = 'PAPER' } = {}) {
  const r = cleanRiskSettings(risk);
  const sc = cleanScoringSettings(scoring);
  const st = strategySettings(strategies);
  const evaluations = (sealed?.stocks ?? []).map((f) => ({ ...evaluateStock(f, { strategies: st, risk: r, scoring: sc, partial, availableMargin }), gapPct: f.gapPct }));
  const blockers = tradeBlockers({ ...NO_DAY, ...day }, r);
  const slots = Math.max(0, Math.min(r.maxOpenPositions - (day.open ?? 0), r.maxTradesPerDay - (day.trades ?? 0)));
  const ranked = evaluations.filter((e) => e.eligible).sort((a, b) => b.score - a.score || (b.plan.rewardRisk ?? 0) - (a.plan.rewardRisk ?? 0));
  ranked.forEach((e, i) => { e.rank = i + 1; });
  for (const e of evaluations) {
    e.decision = 'NO TRADE';
    if (!e.eligible) continue;
    if (blockers.length) e.reasons.push(...blockers);
    else if (e.rank > slots) e.reasons.push(`ranked ${e.rank} of ${ranked.length}; only ${slots} slot(s) free under the position and trade limits`);
    else e.decision = e.direction > 0 ? 'BUY' : 'SELL';
  }
  const order = { BUY: 0, SELL: 0, 'NO TRADE': 1 };
  evaluations.sort((a, b) => order[a.decision] - order[b.decision] || (b.eligible - a.eligible) || (b.score ?? -1) - (a.score ?? -1));
  return {
    date: sealed?.date ?? null, sealedAt: sealed?.sealedAt ?? null, mode, partial,
    decisions: evaluations, gapReport: gapReport(evaluations, st), blockers, slots,
    settings: { risk: r, scoring: sc, strategies: st },
  };
}

/** A compact row per decision for the scanner (the full one is fetched on demand). */
export const decisionRow = (d) => ({
  symbol: d.symbol, decision: d.decision, strategy: d.strategy, strategyLabel: d.strategyLabel ?? (d.strategy ? STRATEGY_LABEL[d.strategy] : null),
  score: d.score, tier: d.tier, rank: d.rank ?? null, reasons: d.reasons.slice(0, 3),
});
