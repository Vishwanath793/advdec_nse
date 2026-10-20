/**
 * History layer: extra, optional inference from the 20-session end-of-day
 * history (`context.history.stats`, see core/marketContext.js historyStats).
 * It sits on top of the conviction score without changing it:
 *  - separate: every gapped stock gets its own History score (0–100, equal
 *    weights over the factors that have data), shown next to the conviction;
 *  - include: each factor is also a conviction factor (off by default), so it
 *    can be added to the conviction score one by one or all together.
 * The report card measures every factor against outcomes, as for the others.
 *
 * Each factor is scored 0..1 in the direction of the gap (0.5 = neutral) and
 * normalised by the stock's own history rather than by fixed % thresholds, so a
 * 2% gap in a stock that usually gaps 0.3% reads differently from one that
 * usually gaps 2%. They are hypotheses until the report card shows they help.
 *
 * Inputs (set on each stock by signals.js and research.js from history.stats):
 *   gapX          |gap| ÷ avgAbsGap (≥ 5 sessions)
 *   delivQtyX     prevDelivQty ÷ avgDelivQty; delivQty, delivPct for yesterday's volume
 *   avgVolume     20-day average daily volume
 *   prevMovePct   prevClose vs close1
 *   foBuild, foOiChangePct, oiRank (foOiRank)
 *   rsSectorPct   ret20 (prevClose vs close20) minus the sector median
 */

export const HISTORY_GROUP = 'history';
const SOURCE = 'NSE end-of-day files, 20 sessions';

export const HISTORY_FACTORS = [
  { key: 'hGapNorm', label: 'Gap vs its usual gap', help: "Today's gap as a multiple of the stock's own average gap (20 sessions). Full marks at 1.5–3× its usual: clearly unusual but not extreme; routine gaps (under 0.75×) are neutral and extreme ones (6×+) score low because they tend to fade." },
  { key: 'hDelivQty', label: 'Delivery quantity surge', help: "Yesterday's delivered shares vs its 20-session average: a surge on an up day (accumulation) supports a gap-up, on a down day (distribution) a gap-down. Full marks at 3× the usual; less delivery than usual is neutral." },
  { key: 'hVolume', label: "Yesterday's volume vs usual", help: "Yesterday's traded quantity vs its 20-day average, in the direction of yesterday's move: heavy volume behind a move the gap continues supports it. Full marks at 2× the usual." },
  { key: 'hOiRank', label: 'Unusual OI build-up', help: "Yesterday's futures OI build-up, scaled by how unusual its OI change was for this stock (percentile of the last 20 sessions) instead of a fixed %: long build-up supports gap-ups, short build-up gap-downs; covering/unwinding count half. Full marks at the 90th percentile." },
  { key: 'hRsSector', label: '20-session strength vs sector', help: "The stock's 20-session return minus its sector's median: leaders gapping up and laggards gapping down score higher. Full marks at ±10 points." },
].map((f) => ({ ...f, weight: 20, defaultOn: false, group: HISTORY_GROUP, source: SOURCE }));

/** Full-marks points. */
export const GAP_NORM = { neutralBelow: 0.75, fullFrom: 1.5, fullTo: 3, low: 6, floor: 10 };
export const DELIV_QTY_FULL_X = 3;
export const VOLUME_FULL_X = 2;
export const OI_RANK_FULL = 0.9;
export const RS_FULL_PTS = 10;
/** A previous-day move smaller than this (%) counts as flat. */
const FLAT_MOVE_PCT = 0.25;
const OI_BIAS = {
  'long build-up': [1, 1], 'short covering': [1, 0.5],
  'short build-up': [-1, 1], 'long unwinding': [-1, 0.5],
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const clampSigned = (n) => Math.max(-1, Math.min(1, n));
const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * clamp01((x - x0) / (x1 - x0));
const signed = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}`;
const times = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
const leaning = (v) => (v >= 0.6 ? 'supports the gap' : v <= 0.4 ? 'against the gap' : 'neutral');

/** Gap-vs-usual value (0..1) for a multiple of the stock's average absolute gap. */
export function gapNormScore(x) {
  const g = GAP_NORM;
  if (x < g.neutralBelow) return 0.5;
  if (x < g.fullFrom) return lerp(x, g.neutralBelow, g.fullFrom, 0.5, 1);
  if (x <= g.fullTo) return 1;
  if (x <= g.low) return lerp(x, g.fullTo, g.low, 1, 0.3);
  return lerp(x, g.low, g.floor, 0.3, 0.1);
}

/** Direction of yesterday's move: +1, −1 or 0 when flat or unknown. */
const movedDir = (pct) => (pct == null || Math.abs(pct) < FLAT_MOVE_PCT ? 0 : Math.sign(pct));

/**
 * The history-layer factors for one stock in direction `dir` (+1 gap-up, −1 gap-down):
 * { key: { value 0..1, detail } } for the factors that have data.
 */
export function historyLayerFactors(stock, dir) {
  const out = {};
  const moved = movedDir(stock.prevMovePct);
  const yesterday = stock.prevMovePct == null ? 'yesterday' : `yesterday (${signed(stock.prevMovePct, 2)}%)`;

  if (stock.gapX != null) {
    const value = gapNormScore(stock.gapX);
    const kind = stock.gapX < GAP_NORM.neutralBelow ? 'routine for this stock'
      : stock.gapX <= GAP_NORM.fullTo ? 'unusual for this stock' : 'extreme for this stock, often fades';
    out.hGapNorm = { value, detail: `${Math.abs(stock.pctChange).toFixed(2)}% gap = ${times(stock.gapX)} its usual ${stock.avgAbsGap?.toFixed(2)}%: ${kind}` };
  }

  if (stock.delivQtyX != null) {
    const strength = stock.delivQtyX > 1 ? clamp01(Math.log(stock.delivQtyX) / Math.log(DELIV_QTY_FULL_X)) : 0;
    const value = 0.5 + 0.5 * strength * moved * dir;
    const kind = strength === 0 ? 'no surge (neutral)' : moved === 0 ? 'surge on a flat day (neutral)'
      : `${moved > 0 ? 'accumulation' : 'distribution'}, ${leaning(value)}`;
    out.hDelivQty = { value, detail: `Delivered shares ${times(stock.delivQtyX)} the usual ${yesterday}: ${kind}` };
  }

  // Yesterday's quantity = delivered shares ÷ delivery % (NSE rounds DELIV_PER to 2 decimals).
  const prevVolume = stock.delivQty != null && stock.delivPct > 0 ? stock.delivQty / (stock.delivPct / 100) : null;
  if (prevVolume != null && stock.avgVolume > 0) {
    const x = prevVolume / stock.avgVolume;
    const strength = clamp01((x - 1) / (VOLUME_FULL_X - 1));
    const value = 0.5 + 0.5 * strength * moved * dir;
    out.hVolume = { value, detail: `Volume ${times(x)} its 20-day average ${yesterday}: ${strength === 0 || moved === 0 ? 'no conviction behind the move (neutral)' : leaning(value)}` };
  }

  if (stock.foBuild && stock.oiRank != null) {
    const [bias, share] = OI_BIAS[stock.foBuild] ?? [0, 0];
    const strength = clamp01((stock.oiRank - 0.5) / (OI_RANK_FULL - 0.5)) * share;
    const value = 0.5 + 0.5 * strength * bias * dir;
    const reading = stock.foBuild === 'neutral' ? 'no clear build-up (neutral)' : leaning(value);
    out.hOiRank = { value, detail: `OI ${signed(stock.foOiChangePct)}% (${stock.foBuild}), larger than ${Math.round(stock.oiRank * 100)}% of its last 20 sessions: ${reading}` };
  }

  if (stock.rsSectorPct != null) {
    const value = 0.5 + 0.5 * clampSigned((dir * stock.rsSectorPct) / RS_FULL_PTS);
    out.hRsSector = { value, detail: `20 sessions ${signed(stock.ret20)}% vs sector median ${signed(stock.sectorRet20)}% (${signed(stock.rsSectorPct)} pts): ${stock.rsSectorPct > 0 ? 'leader' : stock.rsSectorPct < 0 ? 'laggard' : 'in line'}, ${leaning(value)}` };
  }
  return out;
}

/**
 * The separate History score for each gapped, scored stock (call after
 * scoreConviction, which decides the direction and which gaps are scored):
 * stock.historyLayer = { score, direction, factors, missing, coverage } and stock.historyScore.
 * Equal weights over the factors with data; null with fewer than MIN_FACTORS.
 */
export const MIN_HISTORY_FACTORS = 2;
export function applyHistoryLayer(stocks) {
  for (const s of stocks) {
    if (!s.conviction) { s.historyLayer = null; s.historyScore = null; continue; }
    const dir = s.conviction.direction === 'up' ? 1 : -1;
    const scores = historyLayerFactors(s, dir);
    const factors = HISTORY_FACTORS.filter((f) => scores[f.key]).map((f) => ({ key: f.key, label: f.label, ...scores[f.key] }));
    const score = factors.length >= MIN_HISTORY_FACTORS
      ? Math.round((factors.reduce((sum, f) => sum + f.value, 0) / factors.length) * 100)
      : null;
    s.historyLayer = {
      score,
      direction: s.conviction.direction,
      factors,
      missing: HISTORY_FACTORS.filter((f) => !scores[f.key]).map((f) => f.label),
      coverage: `${factors.length}/${HISTORY_FACTORS.length}`,
    };
    s.historyScore = score;
  }
  return stocks;
}
