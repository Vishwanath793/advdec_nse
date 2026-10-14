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
  { key: 'gap', label: 'Gap size', weight: 20, help: 'Bigger gap scores higher (full marks at 3%).' },
  { key: 'sector', label: 'Sector strength', weight: 20, help: "Sector's average gap vs other sectors, plus peers gapping 1%+ the same way." },
  { key: 'orders', label: 'Buy/sell orders', weight: 20, help: 'Share of pending pre-open orders on the gap side (counts ¼ for F&O stocks).' },
  { key: 'market', label: 'Market A/D agrees', weight: 15, help: 'Share of all stocks moving in the gap direction.' },
  { key: 'range', label: '52-week breakout', weight: 15, help: 'Full marks when opening through the 52-week high (or low); otherwise neutral.' },
  { key: 'value', label: 'Pre-open value', weight: 10, help: 'Pre-open traded value compared with other stocks.' },
  // Off by default until tested over more days; turn on in "Conviction factors".
  { key: 'catalyst', label: 'Results catalyst', weight: 15, defaultOn: false, help: 'Results announced since the last close score full marks; an ex-date today scores zero (the gap may be a price adjustment).' },
  { key: 'rvol', label: 'Relative volume', weight: 15, defaultOn: false, help: 'Pre-open quantity vs its 20-day average daily volume, ranked against other stocks.' },
  { key: 'prevRange', label: "Gap vs yesterday's range", weight: 15, defaultOn: false, help: "Full marks when opening beyond yesterday's high (gap-up) or low (gap-down); otherwise neutral." },
];

/** Default per-factor settings: { key: { on, weight } }. */
export const DEFAULT_FACTOR_SETTINGS = Object.fromEntries(
  CONVICTION_FACTORS.map((f) => [f.key, { on: f.defaultOn ?? true, weight: f.weight }])
);

/**
 * Effective weight per factor from user settings (missing keys fall back to the
 * defaults, so factors added later still appear). Off or 0 means excluded.
 */
export function factorWeights(settings) {
  return Object.fromEntries(CONVICTION_FACTORS.map((f) => {
    const s = settings?.[f.key];
    const weight = Number.isFinite(Number(s?.weight)) ? Math.max(0, Number(s.weight)) : f.weight;
    return [f.key, (s?.on ?? f.defaultOn ?? true) ? weight : 0];
  }));
}

/** A gap of this size (%) or more earns the full gap score. */
export const FULL_GAP_PCT = 3;

/** Gaps smaller than this (%) are not gap trades and get no score. */
export const MIN_GAP_PCT = 0.5;

/**
 * F&O stocks count the buy/sell-order factor at this fraction of its weight.
 * Their pre-open book is deep and mostly resting limit orders, so the pending
 * buy/sell split says little about direction (e.g. HCLTECH/TCS on 13 Oct 2026:
 * more sellers pending, then +5%).
 */
export const FNO_ORDERS_SHARE = 0.25;

/**
 * Sector strength = half how the sector's average gap ranks against other
 * sectors, half how many of its stocks gapped CLUSTER_GAP_PCT+ the same way
 * (full marks at FULL_CLUSTER). It spots theme days, e.g. 13 Oct 2026 when IT
 * averaged +0.57% (3x the next sector) with 13 IT stocks gapping 1%+.
 * Sectors with fewer than MIN_RANKED_SECTOR stocks are too small to rank and
 * get a neutral rank.
 */
export const CLUSTER_GAP_PCT = 1;
export const FULL_CLUSTER = 5;
export const MIN_RANKED_SECTOR = 5;

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

/** Per-sector average gap, its rank among sectors (0..1, ascending) and gap clusters. */
function sectorStrength(stocks, sectors) {
  const stats = sectors.map((sec) => {
    const members = stocks.filter((s) => s.sector === sec.sector);
    const gaps = members.map((s) => s.pctChange ?? 0);
    return {
      sector: sec.sector,
      total: members.length,
      avg: gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1),
      upCluster: gaps.filter((g) => g >= CLUSTER_GAP_PCT).length,
      downCluster: gaps.filter((g) => g <= -CLUSTER_GAP_PCT).length,
      rank: null,
      place: null,
    };
  });
  const ranked = stats.filter((s) => s.total >= MIN_RANKED_SECTOR).sort((a, b) => a.avg - b.avg);
  ranked.forEach((s, i) => {
    s.rank = ranked.length > 1 ? i / (ranked.length - 1) : 0.5;
    s.place = ranked.length - i; // 1 = strongest average gap
  });
  return { sectorStrength: new Map(stats.map((s) => [s.sector, s])), rankedSectors: ranked.length };
}

/** Score one factor; returns { value 0..1, detail } or null when data is missing. */
function factorScores(stock, dir, ctx) {
  const up = dir > 0;
  const out = {};

  const gap = Math.abs(stock.pctChange ?? 0);
  out.gap = { value: clamp01(gap / FULL_GAP_PCT), detail: `${gap.toFixed(2)}% gap (full marks at ${FULL_GAP_PCT}%)` };

  const sector = ctx.sectorStrength.get(stock.sector);
  if (sector) {
    // Rank is ascending by average gap, so a gap-down wants the weakest sectors.
    const rank = sector.rank == null ? 0.5 : up ? sector.rank : 1 - sector.rank;
    const peers = up ? sector.upCluster : sector.downCluster;
    const value = 0.5 * rank + 0.5 * Math.min(peers / FULL_CLUSTER, 1);
    const place = sector.rank == null
      ? `too few stocks to rank (${sector.total})`
      : `#${sector.place} of ${ctx.rankedSectors} sectors by average gap (${sector.avg >= 0 ? '+' : ''}${sector.avg.toFixed(2)}%)`;
    out.sector = {
      value,
      detail: `${stock.sector}: ${place}; ${peers} stock${peers === 1 ? '' : 's'} gapped ${up ? '+' : '−'}${CLUSTER_GAP_PCT}% or more`,
    };
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
    // Breakout bonus only: opening through the 52-week high (gap-up) or low
    // (gap-down) scores full marks; anywhere else is neutral. Being near the
    // opposite extreme is not penalised, because rebounds from 52-week lows
    // can run hard (13 Oct 2026: BSOFT, KPIT, TCS near lows, up 3-6%).
    const position = clamp01((finalPrice - yearLow) / (yearHigh - yearLow));
    const breakout = up ? finalPrice >= yearHigh : finalPrice <= yearLow;
    out.range = {
      value: breakout ? 1 : 0.5,
      detail: breakout
        ? `Opening ${up ? 'at/above 52-week high' : 'at/below 52-week low'} (breakout)`
        : `No breakout, neutral (${pct(position)} of the way from 52-week low to high)`,
    };
  }

  if (stock.eventsChecked) {
    const exDate = stock.exDate?.length;
    out.catalyst = exDate
      ? { value: 0, detail: `Ex-date today (${stock.exDate.join('; ')}): gap may be a price adjustment` }
      : stock.results?.length
        ? { value: 1, detail: 'Results announced since the last close' }
        : { value: 0.5, detail: 'No results since the last close (neutral)' };
  }

  if (stock.rvolRank != null) {
    out.rvol = {
      value: stock.rvolRank,
      detail: `Pre-open qty = ${stock.rvolPct.toFixed(2)}% of 20-day avg daily volume (${stock.rvolX.toFixed(1)}× the typical stock; higher than ${pct(stock.rvolRank)})`,
    };
  }

  if (stock.rangeBreak) {
    const beyond = stock.rangeBreak !== 'inside';
    out.prevRange = {
      value: beyond ? 1 : 0.5,
      detail: beyond
        ? `Opening ${up ? `above yesterday's high ₹${stock.prevHigh}` : `below yesterday's low ₹${stock.prevLow}`} (true gap)`
        : `Inside yesterday's range ₹${stock.prevLow}–₹${stock.prevHigh} (neutral)`,
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
export function scoreConviction(stocks, sectors, summary, factorSettings = null) {
  const weights = factorWeights(factorSettings);
  const excluded = CONVICTION_FACTORS.filter((f) => !weights[f.key]).map((f) => f.label);
  const ctx = {
    summary,
    values: stocks.map((s) => s.valueCr).filter((v) => v != null).sort((a, b) => a - b),
    ...sectorStrength(stocks, sectors),
  };

  for (const stock of stocks) {
    const dir = stock.status === 'advance' ? 1 : stock.status === 'decline' ? -1 : 0;
    if (!dir || Math.abs(stock.pctChange ?? 0) < MIN_GAP_PCT) {
      stock.conviction = null;
      stock.convictionScore = null;
      continue;
    }
    const scores = factorScores(stock, dir, ctx);
    const fno = stock.band === 'none';
    const factors = CONVICTION_FACTORS.filter((f) => weights[f.key] && scores[f.key]).map((f) => {
      const factor = { ...f, ...scores[f.key], weight: weights[f.key] };
      if (f.key === 'orders' && fno) {
        factor.weight = weights[f.key] * FNO_ORDERS_SHARE;
        factor.detail += ' (F&O stock: ¼ weight, deep book of resting orders)';
      }
      return factor;
    });
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    const score = totalWeight
      ? Math.round((factors.reduce((sum, f) => sum + f.value * f.weight, 0) / totalWeight) * 100)
      : null;
    stock.conviction = {
      score,
      direction: dir > 0 ? 'up' : 'down',
      factors,
      missing: CONVICTION_FACTORS.filter((f) => weights[f.key] && !scores[f.key]).map((f) => f.label),
      excluded,
    };
    stock.convictionScore = score;
  }
  return stocks;
}
