/**
 * Pre-open decision signals that need data beyond the pre-open feed
 * (`context` from GET /api/nse/context):
 *  1. Catalyst: results announced since the last close, results due today,
 *     or a corporate-action ex-date today (the gap may be an adjustment).
 *  2. Relative volume: pre-open quantity as a % of the 20-day average daily
 *     volume, and as a multiple of the median stock's ratio ("Vol ×").
 *  3. Gap vs yesterday's range: opening above yesterday's high (gap-up) or
 *     below yesterday's low (gap-down) — a "true" gap — or inside it.
 *  4. Yesterday's delivery % (vs its usual), where it closed in its range,
 *     and the 5- and 20-session trend.
 */

/** "Vol ×" at or above this multiple of the median stock is highlighted. */
export const HIGH_RVOL_X = 10;
/** A "Deliv ×" badge shows when yesterday's delivery % is at least this multiple of the stock's usual. */
export const HIGH_DELIVERY_X = 1.5;
/** An "OI …" badge shows when yesterday's futures open interest changed at least this much (%). */
export const NOTABLE_OI_PCT = 5;

/** Moves smaller than these (%) count as flat when reading open-interest build-up. */
export const OI_FLAT_PRICE_PCT = 0.25;
export const OI_FLAT_CHANGE_PCT = 1;

/**
 * Open-interest build-up from the futures' price change and OI change (%):
 *  price up + OI up = long build-up; price down + OI up = short build-up;
 *  price up + OI down = short covering; price down + OI down = long unwinding.
 */
export function oiBuild(pricePct, oiPct) {
  if (pricePct == null || oiPct == null) return null;
  if (Math.abs(pricePct) < OI_FLAT_PRICE_PCT || Math.abs(oiPct) < OI_FLAT_CHANGE_PCT) return 'neutral';
  if (pricePct > 0) return oiPct > 0 ? 'long build-up' : 'short covering';
  return oiPct > 0 ? 'short build-up' : 'long unwinding';
}

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

    // Yesterday's delivery %, where it closed in its range, and the recent trend.
    const ratio = (a, b) => (a != null && b ? a / b : null);
    s.delivPct = h?.prevDelivery ?? null;
    s.delivAvg = h?.avgDelivery ?? null;
    s.delivX = ratio(s.delivPct, s.delivAvg);
    s.prevMovePct = h?.prevClose != null && h?.close1 ? (ratio(h.prevClose, h.close1) - 1) * 100 : null;
    s.closeLocation = h && h.prevHigh > h.prevLow ? (h.prevClose - h.prevLow) / (h.prevHigh - h.prevLow) : null;
    s.ret5 = h?.prevClose != null && h?.close5 ? (ratio(h.prevClose, h.close5) - 1) * 100 : null;
    s.ret20 = h?.prevClose != null && h?.close20 ? (ratio(h.prevClose, h.close20) - 1) * 100 : null;

    // Previous session's stock-futures open interest (F&O stocks only).
    s.foOi = h?.foOi ?? null;
    s.foOiChangePct = h?.foOiChangePct ?? null;
    s.foPricePct = h?.foPricePct ?? null;
    s.foBuild = oiBuild(s.foPricePct, s.foOiChangePct);

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
