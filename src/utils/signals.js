/**
 * Pre-open decision signals that need data beyond the pre-open feed
 * (`context` from GET /api/nse/context):
 *  1. Catalyst: results announced since the last close, results due today,
 *     or a corporate-action ex-date today (the gap may be an adjustment).
 *  2. Relative volume: pre-open quantity as a % of the 20-day average daily
 *     volume, and as a multiple of the median stock's ratio ("Vol ×").
 *  3. Gap vs yesterday's range: opening above yesterday's high (gap-up) or
 *     below yesterday's low (gap-down) — a "true" gap — or inside it.
 */

/** "Vol ×" at or above this multiple of the median stock is highlighted. */
export const HIGH_RVOL_X = 10;

export function applySignals(stocks, context) {
  const stats = context?.history?.stats ?? {};
  const events = context?.events ?? null;

  for (const s of stocks) {
    const h = stats[s.symbol];
    s.prevHigh = h?.prevHigh ?? null;
    s.prevLow = h?.prevLow ?? null;
    s.avgVolume = h?.avgVolume ?? null;
    s.rvolPct = s.finalVolume != null && s.avgVolume ? (s.finalVolume / s.avgVolume) * 100 : null;

    s.rangeBreak = null;
    if (s.finalPrice != null && s.prevHigh != null && s.prevLow != null) {
      if (s.status === 'advance') s.rangeBreak = s.finalPrice > s.prevHigh ? 'above' : 'inside';
      else if (s.status === 'decline') s.rangeBreak = s.finalPrice < s.prevLow ? 'below' : 'inside';
    }

    s.eventsChecked = Boolean(events);
    s.results = events?.results?.[s.symbol] ?? null;
    s.resultsDue = events?.resultsDue?.[s.symbol] ?? null;
    s.exDate = events?.exDates?.[s.symbol] ?? null;
  }

  // Relative volume vs the rest of the market: multiple of the median ratio and percentile.
  const ratios = stocks.map((s) => s.rvolPct).filter((v) => v != null && v > 0).sort((a, b) => a - b);
  const median = ratios.length ? ratios[ratios.length >> 1] : null;
  for (const s of stocks) {
    if (s.rvolPct == null || !median) { s.rvolX = null; s.rvolRank = null; continue; }
    s.rvolX = s.rvolPct / median;
    let below = 0;
    while (below < ratios.length && ratios[below] < s.rvolPct) below++;
    s.rvolRank = ratios.length > 1 ? below / (ratios.length - 1) : 1;
  }
  return stocks;
}
