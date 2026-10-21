/**
 * Analyzer stock filter (replaces the "Sector Bias" spotlight): every gapped
 * stock with the readings below, a quality rank relative to the other gapped
 * stocks, and thresholds the user types in (a blank threshold is not applied).
 *
 * Readings (all from the analysed stock; "gap side" = buy side for a gap-up,
 * sell side for a gap-down):
 *   absGap     |%change| from NSE's pre-open (either side)
 *   rvolX      pre-open quantity vs the 20-day average daily volume, as a multiple
 *              of the typical stock (the "Relative volume" factor, signals.js)
 *   ordersPct  gap-side share of pending pre-open buy + sell quantity (%)
 *   valuePct   pre-open traded value: higher than this % of all stocks
 *   delivPct   yesterday's delivery % (NSE end-of-day file)
 *   delivQtyX  yesterday's delivered shares ÷ the 20-session average (research.js)
 *   driftPts   gap built during the auction: the indicative gap's change from
 *              09:04 to the end of order entry, in the gap direction (points;
 *              Kite pre-open readings, auctionLayer.js)
 *   heldPts    gap-side orders held: the gap-side share of pending orders at the
 *              end of order entry minus its average through the auction (points)
 *   imbalanceX unmatched auction demand: Kite's imbalance quantity ÷ the matched
 *              volume, positive when the unmatched side is the gap side (×)
 *   futuresPts futures auction vs cash: the near-month future's pre-open gap minus
 *              the stock's, in the gap direction (points; F&O stocks only)
 * The orders threshold can be read on the gap side (default), the buy side or
 * the sell side; the rank always uses the gap side.
 *
 * Quality = the average percentile of the readings switched into the rank,
 * each taken among all gapped stocks that have it (0–100). It needs at least
 * MIN_QUALITY_METRICS readings; rank 1 is the best. The rank is computed before
 * any threshold, so it doesn't move as filters change. A ranking, not a forecast.
 */

import { auctionImbalance } from './auctionLayer.js';

export const MIN_QUALITY_METRICS = 3;
export const SCREENER_LIMIT = 200;

/**
 * The readings and their typed minimums. `group` and `short` lay out the filter
 * panel; `unit` follows the box; `help` is the full explanation (shown on hover).
 */
export const SCREENER_METRICS = [
  { key: 'absGap', label: 'Gap size', short: 'Gap size', group: 'preopen', filter: 'minGap', unit: '%', step: 0.1, ranked: false,
    help: "The pre-open gap (%CHANGE), either side: 2 keeps gap-ups of +2% or more and gap-downs of −2% or more." },
  { key: 'rvolX', label: 'Relative volume', short: 'Relative volume', group: 'preopen', filter: 'minRvol', unit: '× typical', step: 1, ranked: true,
    help: "Pre-open quantity vs its 20-day average daily volume, as a multiple of the typical stock: the \"Vol ×\" badge. 28 keeps Vol 28× and above." },
  { key: 'ordersPct', label: 'Buy/sell orders', short: 'Buy/sell orders', group: 'preopen', filter: 'minOrders', unit: '% of pending', step: 5, ranked: true, sided: true,
    help: 'Share of pending pre-open buy + sell quantity on the chosen side. The rank always uses the gap side.' },
  { key: 'valuePct', label: 'Pre-open value', short: 'Pre-open value', group: 'preopen', filter: 'minValuePct', unit: '% beaten', step: 5, ranked: true,
    help: 'Pre-open traded value higher than this % of all stocks: 90 keeps the top 10% by value.' },
  { key: 'delivPct', label: 'Delivery % (yesterday)', short: 'Delivery %', group: 'history', filter: 'minDeliv', unit: '%', step: 5, ranked: true,
    help: "Yesterday's delivery % (NSE end-of-day file)." },
  { key: 'delivQtyX', label: 'Delivery quantity surge', short: 'Delivery qty surge', group: 'history', filter: 'minDelivQtyX', unit: '× usual', step: 0.5, ranked: true,
    help: "Yesterday's delivered shares ÷ its average over the 20 sessions before." },
  { key: 'driftPts', label: 'Gap built during the auction', short: 'Gap built', group: 'auction', filter: 'minDrift', unit: 'pts', step: 0.1, ranked: true,
    help: 'How much the indicative gap grew from 09:04 to the end of order entry, in the gap direction (points).' },
  { key: 'heldPts', label: 'Gap-side orders held', short: 'Orders held', group: 'auction', filter: 'minHeld', unit: 'pts', step: 1, ranked: true,
    help: 'Gap-side share of pending orders at the end of order entry minus its average through the auction (points): positive = added late, negative = pulled late.' },
  { key: 'imbalanceX', label: 'Unmatched auction demand', short: 'Unmatched demand', group: 'auction', filter: 'minImbalance', unit: '× matched', step: 0.1, ranked: true,
    help: "Kite's unmatched quantity at the close of order entry ÷ the matched volume; positive when the unmatched side is the gap side." },
  { key: 'futuresPts', label: 'Futures auction vs cash', short: 'Futures vs cash', group: 'auction', filter: 'minFutures', unit: 'pts', step: 0.1, ranked: true,
    help: "F&O stocks: the near-month future's pre-open gap minus the stock's, in the gap direction (points)." },
];

/** Filter panel groups, in order. */
export const SCREENER_GROUPS = [
  { key: 'preopen', label: 'Pre-open', source: 'NSE, 09:08' },
  { key: 'history', label: 'Yesterday', source: 'NSE end-of-day' },
  { key: 'auction', label: 'Auction', source: 'Kite, 09:00–09:08' },
];

/** Which side the buy/sell orders threshold reads. */
export const ORDER_SIDES = { gap: 'Gap side', buy: 'Buy', sell: 'Sell' };

/** Default filter settings: no thresholds, both directions, every reading in the rank. */
export const DEFAULT_SCREENER = {
  direction: 'both', // 'both' | 'up' | 'down'
  ordersSide: 'gap', // 'gap' | 'buy' | 'sell'
  tradeableOnly: false,
  maxRank: null,
  thresholds: Object.fromEntries(SCREENER_METRICS.map((m) => [m.filter, null])),
  inRank: Object.fromEntries(SCREENER_METRICS.filter((m) => m.ranked).map((m) => [m.key, true])),
};

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Settings merged over the defaults, with unusable thresholds dropped. */
export function cleanScreener(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  return {
    direction: ['both', 'up', 'down'].includes(s.direction) ? s.direction : 'both',
    ordersSide: Object.hasOwn(ORDER_SIDES, s.ordersSide ?? '') ? s.ordersSide : 'gap',
    tradeableOnly: s.tradeableOnly === true,
    maxRank: num(s.maxRank) != null && num(s.maxRank) >= 1 ? Math.floor(num(s.maxRank)) : null,
    thresholds: Object.fromEntries(SCREENER_METRICS.map((m) => [m.filter, num(s.thresholds?.[m.filter])])),
    inRank: Object.fromEntries(SCREENER_METRICS.filter((m) => m.ranked).map((m) => [m.key, s.inRank?.[m.key] !== false])),
  };
}

/** Share of `sorted` (ascending) strictly below `v`, 0..1. */
function shareBelow(sorted, v) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : null;
}
/** Percentile (0..1) of `v` among `sorted`, ties counting half. */
function percentile(sorted, v) {
  if (sorted.length < 2) return null;
  let below = 0;
  let equal = 0;
  for (const x of sorted) { if (x < v) below++; else if (x === v) equal++; }
  return (below + (equal - 1) / 2) / (sorted.length - 1);
}

/** The readings for one stock (null where there is no data). */
export function screenerMetrics(s, valuesSorted) {
  const dir = s.status === 'advance' ? 1 : s.status === 'decline' ? -1 : 0;
  const pendingTotal = (s.buyQty ?? 0) + (s.sellQty ?? 0);
  const a = s.auction;
  const buyPct = s.buyQty != null && s.sellQty != null && pendingTotal > 0 ? (s.buyQty / pendingTotal) * 100 : null;
  // Same readings as the Auction layer's factors (auctionLayer.js), kept in raw units for typed thresholds.
  const imb = auctionImbalance(a);
  return {
    dir,
    absGap: s.pctChange != null ? Math.abs(s.pctChange) : null,
    rvolX: s.rvolX ?? null,
    buyPct,
    sellPct: buyPct == null ? null : 100 - buyPct,
    ordersPct: buyPct == null ? null : dir > 0 ? buyPct : 100 - buyPct,
    valuePct: s.valueCr != null && valuesSorted.length ? shareBelow(valuesSorted, s.valueCr) * 100 : null,
    delivPct: s.delivPct ?? null,
    delivQtyX: s.delivQtyX ?? null,
    driftPts: a?.gap != null && a.earlyGap != null ? dir * (a.gap - a.earlyGap) : null,
    heldPts: a?.buyShare != null && a.avgBuyShare != null ? dir * (a.buyShare - a.avgBuyShare) * 100 : null,
    imbalanceX: imb ? dir * imb.side * imb.x : null,
    futuresPts: a?.future?.gap != null && a.future.volume > 0 && a.gap != null ? dir * (a.future.gap - a.gap) : null,
  };
}

/** The value a threshold is compared with (the orders one reads the chosen side). */
const filterValue = (m, metrics, cfg) => (m.sided && cfg.ordersSide !== 'gap' ? metrics[`${cfg.ordersSide}Pct`] : metrics[m.key]);

/**
 * Screen the analysed `stocks` with `settings` (see DEFAULT_SCREENER).
 * Returns { rows, matched, gapped, ranked }: `rows` are all gapped stocks
 * (rank order, unranked last), each { stock, metrics, quality, rank, pass, failed };
 * `matched` the rows that pass every threshold that is set (a stock without the
 * reading fails that threshold).
 */
export function screenStocks(stocks, settings = DEFAULT_SCREENER) {
  const cfg = cleanScreener(settings);
  const valuesSorted = stocks.map((s) => s.valueCr).filter((v) => v != null).sort((x, y) => x - y);
  const rows = stocks
    .map((stock) => ({ stock, metrics: screenerMetrics(stock, valuesSorted) }))
    .filter((r) => r.metrics.dir !== 0);

  // Quality: average percentile among the gapped stocks of the readings in the rank.
  const rankedKeys = SCREENER_METRICS.filter((m) => m.ranked && cfg.inRank[m.key]).map((m) => m.key);
  const sortedBy = Object.fromEntries(rankedKeys.map((k) => [k, rows.map((r) => r.metrics[k]).filter((v) => v != null).sort((x, y) => x - y)]));
  for (const r of rows) {
    const pcts = rankedKeys.map((k) => (r.metrics[k] == null ? null : percentile(sortedBy[k], r.metrics[k]))).filter((p) => p != null);
    r.qualityParts = pcts.length;
    r.quality = pcts.length >= MIN_QUALITY_METRICS ? Math.round((pcts.reduce((x, y) => x + y, 0) / pcts.length) * 100) : null;
  }
  rows.sort((x, y) => (y.quality ?? -1) - (x.quality ?? -1)
    || (y.stock.valueCr ?? -1) - (x.stock.valueCr ?? -1)
    || x.stock.symbol.localeCompare(y.stock.symbol));
  let rank = 0;
  for (const r of rows) r.rank = r.quality == null ? null : ++rank;

  for (const r of rows) {
    const failed = [];
    if (cfg.direction === 'up' && r.metrics.dir < 0) failed.push('gap-down');
    if (cfg.direction === 'down' && r.metrics.dir > 0) failed.push('gap-up');
    if (cfg.tradeableOnly && (r.stock.flags ?? []).some((f) => f.severity === 'block')) failed.push('not tradeable');
    for (const m of SCREENER_METRICS) {
      const min = cfg.thresholds[m.filter];
      if (min == null) continue;
      const v = filterValue(m, r.metrics, cfg);
      if (v == null) failed.push(`${m.label}: no data`);
      else if (v < min) failed.push(`${m.label} below ${min}`);
    }
    if (cfg.maxRank != null && (r.rank == null || r.rank > cfg.maxRank)) failed.push(r.rank == null ? 'unranked' : `rank ${r.rank}`);
    r.failed = failed;
    r.pass = failed.length === 0;
  }
  return { rows, matched: rows.filter((r) => r.pass), gapped: rows.length, ranked: rank, rankedKeys };
}
