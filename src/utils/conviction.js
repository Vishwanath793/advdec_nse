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

/*
 * Default weights (version 2): equal ("unit") weights on the factors that held
 * up in measured outcomes, which is the robust choice while there are only a
 * few days of data: fitted weights mostly fit that data's noise, and unit
 * weights are known to predict about as well out of sample (Dawes 1979).
 *
 * Evidence, 14–15 Oct 2026 (Spearman of each factor vs the open-to-close move in
 * the gap direction, ~100 gap-ups and ~100 gap-downs a day): pre-open value
 * helped in all four day/direction groups, sector in three, gap size once it
 * was scored as an inverted U. Buy/sell orders looked flat alone but ranking
 * without it was clearly worse on 15 Oct, so it stays. 52-week breakout and
 * gap vs yesterday's range correlated negatively: off. Results catalyst and
 * relative volume were mixed and added nothing on top: off until the report
 * card shows otherwise. On 15 Oct, unit weights on the five core factors
 * ranked gap-ups at ρ 0.25 and gap-downs at 0.22, against 0.18/0.19 for
 * weights fitted to the single-factor correlations.
 *
 * Every factor defaults to the same weight, so "Check all" means equal weights.
 * Re-derive as more days are recorded.
 */
export const CONVICTION_FACTORS = [
  { key: 'gap', label: 'Gap size', weight: 20, help: 'Moderate gaps score best: full marks for 0.75–2% gap-ups and 0.75–3% gap-downs; bigger gaps taper because they tend to fade.' },
  { key: 'sector', label: 'Sector strength', weight: 20, help: "Sector's average gap vs other sectors, plus peers gapping 1%+ the same way." },
  { key: 'orders', label: 'Buy/sell orders', weight: 20, help: 'Share of pending pre-open orders on the gap side (counts ¼ for F&O stocks).' },
  { key: 'market', label: 'Market A/D agrees', weight: 20, help: 'Share of all stocks moving in the gap direction.' },
  { key: 'range', label: '52-week breakout', weight: 20, defaultOn: false, help: 'Full marks when opening through the 52-week high (or low); otherwise neutral.' },
  { key: 'value', label: 'Pre-open value', weight: 20, help: 'Pre-open traded value compared with other stocks.' },
  { key: 'catalyst', label: 'Results catalyst', weight: 20, defaultOn: false, help: 'Results announced since the last close score full marks; an ex-date today scores zero (the gap may be a price adjustment).' },
  { key: 'rvol', label: 'Relative volume', weight: 20, defaultOn: false, help: 'Pre-open quantity vs its 20-day average daily volume, ranked against other stocks.' },
  { key: 'prevRange', label: "Gap vs yesterday's range", weight: 20, defaultOn: false, help: "Full marks when opening beyond yesterday's high (gap-up) or low (gap-down); otherwise neutral." },
];

/** Default per-factor settings: { key: { on, weight } }. */
export const DEFAULT_FACTOR_SETTINGS = Object.fromEntries(
  CONVICTION_FACTORS.map((f) => [f.key, { on: f.defaultOn ?? true, weight: f.weight }])
);

/** Bump when the default weights change, so users who never customised get the new ones. */
export const FACTOR_DEFAULTS_VERSION = 2;

/** Earlier default sets ({ key: [on, weight] }); saved settings equal to one of these were never customised. */
const LEGACY_DEFAULTS = [
  { gap: [true, 20], sector: [true, 20], orders: [true, 20], market: [true, 15], range: [true, 15], value: [true, 10],
    catalyst: [false, 15], rvol: [false, 15], prevRange: [false, 15] },
];

/**
 * Conviction factor settings to use after loading saved settings: saved
 * settings from an older version that still equal that version's defaults are
 * replaced with the current defaults; customised ones are kept as they are.
 */
export function migrateFactorSettings(saved, savedVersion) {
  if (!saved || typeof saved !== 'object') return DEFAULT_FACTOR_SETTINGS;
  if (savedVersion === FACTOR_DEFAULTS_VERSION) return saved;
  const untouched = LEGACY_DEFAULTS.some((legacy) => Object.entries(legacy).every(([key, [on, weight]]) => {
    const s = saved[key];
    // Keys added after the settings were saved are missing, which is fine.
    return s == null || (s.on === on && Number(s.weight) === weight);
  }));
  return untouched ? DEFAULT_FACTOR_SETTINGS : saved;
}

/** Largest weight a factor can have (the UI's slider and number box use the same range). */
export const MAX_FACTOR_WEIGHT = 100;

/**
 * A usable weight, or null. Rejects null/blank/NaN (JSON turns NaN into null,
 * and Number(null) is 0, which would silently switch a factor off) and clamps
 * to 0..MAX_FACTOR_WEIGHT.
 */
export function cleanWeight(value) {
  if (value == null || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_FACTOR_WEIGHT, Math.max(0, n));
}

/**
 * Effective weight per factor from user settings (missing keys or unusable
 * values fall back to the defaults, so factors added later still appear).
 * Off or 0 means excluded.
 */
export function factorWeights(settings) {
  return Object.fromEntries(CONVICTION_FACTORS.map((f) => {
    const s = settings?.[f.key];
    const on = typeof s?.on === 'boolean' ? s.on : (f.defaultOn ?? true);
    return [f.key, on ? cleanWeight(s?.weight) ?? f.weight : 0];
  }));
}

/**
 * Whole-number shares (%) of the active weights that add up to exactly 100
 * (largest-remainder rounding; plain rounding can give 99 or 101).
 */
export function weightShares(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  const shares = Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  if (!total) return shares;
  const raw = entries.map(([k, w]) => ({ k, exact: (w / total) * 100 }));
  raw.forEach((r) => { shares[r.k] = Math.floor(r.exact); });
  let left = 100 - raw.reduce((sum, r) => sum + shares[r.k], 0);
  for (const r of [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (left-- <= 0) break;
    shares[r.k]++;
  }
  return shares;
}

/**
 * Gap-size sweet spot (%), by direction. Measured on 14–15 Oct 2026 (NSE open
 * vs close, ~200 gappers a day): big gap-ups faded (15 Oct: 2%+ gap-ups
 * continued 17% of the time, avg −4%), while gap-downs held up to ~3% (2–3%
 * gap-downs continued 90%) and faded beyond. Scoring: 0.6 at the 0.5% minimum,
 * rising to full marks at FULL_FROM, full up to FULL_TO, falling to 0.3 at
 * FULL_TO + 2 and to 0.1 at FULL_TO + 6 and beyond.
 */
export const GAP_SWEET_SPOT = { up: [0.75, 2], down: [0.75, 3] };

const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));

/** Gap factor value (0..1) for an absolute gap % in a direction (+1 up, -1 down). */
export function gapScore(gap, dir) {
  const [from, to] = GAP_SWEET_SPOT[dir > 0 ? 'up' : 'down'];
  if (gap < from) return lerp(gap, MIN_GAP_PCT, from, 0.6, 1);
  if (gap <= to) return 1;
  if (gap <= to + 2) return lerp(gap, to, to + 2, 1, 0.3);
  return lerp(gap, to + 2, to + 6, 0.3, 0.1);
}

/**
 * Stocks that can't be traded intraday (trade-to-trade series, or locked at a
 * circuit) have their score capped here. They often gap the most and looked
 * best on paper, then reversed (THELEELA 15 Oct 2026: locked at UC, scored 85,
 * closed −9.4% from the open).
 */
export const BLOCKED_SCORE_CAP = 30;

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
  const [from, to] = GAP_SWEET_SPOT[up ? 'up' : 'down'];
  out.gap = {
    value: gapScore(gap, dir),
    detail: `${gap.toFixed(2)}% gap: ${
      gap < from ? 'small' : gap <= to ? 'sweet spot' : `large gap-${up ? 'ups' : 'downs'} often fade`
    } (full marks ${from}–${to}%)`,
  };

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
    // Inconsistent pre-open data (see analysis.js dataIssue) is not scored.
    if (!dir || Math.abs(stock.pctChange ?? 0) < MIN_GAP_PCT || stock.dataIssue) {
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
    const raw = totalWeight
      ? Math.round((factors.reduce((sum, f) => sum + f.value * f.weight, 0) / totalWeight) * 100)
      : null;
    const blocks = (stock.flags ?? []).filter((f) => f.severity === 'block');
    const capped = raw != null && blocks.length > 0 && raw > BLOCKED_SCORE_CAP;
    const score = capped ? BLOCKED_SCORE_CAP : raw;
    stock.conviction = {
      score,
      rawScore: raw,
      cappedBy: blocks.length ? blocks.map((f) => f.label) : null,
      direction: dir > 0 ? 'up' : 'down',
      factors,
      missing: CONVICTION_FACTORS.filter((f) => weights[f.key] && !scores[f.key]).map((f) => f.label),
      excluded,
    };
    stock.convictionScore = score;
  }
  return stocks;
}
