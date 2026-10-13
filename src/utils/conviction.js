/**
 * Gap-continuation conviction score (0–100) for each gapped stock.
 *
 * Every factor is scored 0..1 *in the direction of the gap* (for a gap-down,
 * "supportive" means more sellers, a weaker sector, etc.), then combined by
 * weight. Factors whose data is missing (e.g. buy/sell quantities are not in
 * an uploaded pm.csv) are dropped and the remaining weights rescaled.
 *
 * This ranks setups; it does not predict outcomes.
 */

export const CONVICTION_FACTORS = [
  { key: 'gap', label: 'Gap size', weight: 20 },
  { key: 'sector', label: 'Sector agrees', weight: 20 },
  { key: 'orders', label: 'Buy/sell orders', weight: 20 },
  { key: 'market', label: 'Market A/D agrees', weight: 15 },
  { key: 'range', label: '52-week position', weight: 15 },
  { key: 'value', label: 'Pre-open value', weight: 10 },
];

/** A gap of this size (%) or more earns the full gap score. */
export const FULL_GAP_PCT = 3;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const pct = (n) => `${Math.round(n * 100)}%`;

/** Percentile rank (0..1) of each value within a sorted ascending array. */
function percentileOf(sorted, v) {
  if (sorted.length <= 1) return 1;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / (sorted.length - 1);
}

/** Score one factor; returns { value 0..1, detail } or null when data is missing. */
function factorScores(stock, dir, ctx) {
  const up = dir > 0;
  const out = {};

  const gap = Math.abs(stock.pctChange ?? 0);
  out.gap = { value: clamp01(gap / FULL_GAP_PCT), detail: `${gap.toFixed(2)}% gap (full marks at ${FULL_GAP_PCT}%)` };

  const sector = ctx.sectorByName.get(stock.sector);
  if (sector?.total) {
    const share = (up ? sector.advances : sector.declines) / sector.total;
    out.sector = { value: share, detail: `${pct(share)} of ${sector.sector} ${up ? 'advancing' : 'declining'} (${sector.total} stocks)` };
  }

  const { buyQty, sellQty } = stock;
  if (buyQty != null && sellQty != null && buyQty + sellQty > 0) {
    const share = (up ? buyQty : sellQty) / (buyQty + sellQty);
    out.orders = {
      value: share,
      detail: `${pct(share)} of pending pre-open quantity is ${up ? 'buy' : 'sell'} orders`,
    };
  }

  if (ctx.summary.total) {
    const share = (up ? ctx.summary.advances : ctx.summary.declines) / ctx.summary.total;
    out.market = { value: share, detail: `${pct(share)} of all stocks ${up ? 'advancing' : 'declining'}` };
  }

  const { yearHigh, yearLow, finalPrice } = stock;
  if (yearHigh != null && yearLow != null && finalPrice != null && yearHigh > yearLow) {
    // Gap-ups near/through the 52-week high and gap-downs near/through the
    // 52-week low have no nearby overhead supply / support to stall them.
    const position = clamp01((finalPrice - yearLow) / (yearHigh - yearLow));
    const value = up ? position : 1 - position;
    const breakout = up ? finalPrice >= yearHigh : finalPrice <= yearLow;
    out.range = {
      value,
      detail: breakout
        ? `Opening ${up ? 'at/above 52-week high' : 'at/below 52-week low'}`
        : `${pct(position)} of the way from 52-week low to high`,
    };
  }

  if (stock.valueCr != null && ctx.values.length) {
    const rank = percentileOf(ctx.values, stock.valueCr);
    out.value = { value: rank, detail: `₹${stock.valueCr.toFixed(2)} Cr traded in pre-open (higher than ${pct(rank)} of stocks)` };
  }

  return out;
}

/**
 * Attach `conviction` ({ score, direction, factors }) and a flat
 * `convictionScore` to each stock. Unchanged stocks get null.
 */
export function scoreConviction(stocks, sectors, summary) {
  const ctx = {
    summary,
    sectorByName: new Map(sectors.map((s) => [s.sector, s])),
    values: stocks.map((s) => s.valueCr).filter((v) => v != null).sort((a, b) => a - b),
  };

  for (const stock of stocks) {
    const dir = stock.status === 'advance' ? 1 : stock.status === 'decline' ? -1 : 0;
    if (!dir) {
      stock.conviction = null;
      stock.convictionScore = null;
      continue;
    }
    const scores = factorScores(stock, dir, ctx);
    const factors = CONVICTION_FACTORS.filter((f) => scores[f.key]).map((f) => ({ ...f, ...scores[f.key] }));
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const score = totalWeight
      ? Math.round((factors.reduce((sum, f) => sum + f.value * f.weight, 0) / totalWeight) * 100)
      : null;
    stock.conviction = {
      score,
      direction: dir > 0 ? 'up' : 'down',
      factors,
      missing: CONVICTION_FACTORS.filter((f) => !scores[f.key]).map((f) => f.label),
    };
    stock.convictionScore = score;
  }
  return stocks;
}
