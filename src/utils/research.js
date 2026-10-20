import { toNumber } from './csv.js';

/**
 * "How unusual is this compared with the last 20 sessions?" Research columns:
 * each reading is compared with the same stock's (or the market's) previous
 * RESEARCH_DAYS completed sessions, never including the observation itself,
 * and the number of sessions that had data is shown with it ("17/20").
 *
 * These are for research only: none of them change the conviction score or the
 * 09:20 score until the report card shows they help.
 *
 * Sources:
 *  - pre-open volume / value and sector breadth: the app's own recorded pre-open
 *    snapshots (NSE keeps no pre-open archive), so coverage grows one day at a time;
 *  - delivery quantity, gap size, 20-session returns: NSE end-of-day files
 *    (sec_bhavdata_full); delivery quantity = traded quantity × delivery % / 100;
 *  - Nifty 50 and India VIX closes: NSE's daily index file (ind_close_all);
 *  - futures OI change: NSE's F&O end-of-day files, OI summed over all expiries
 *    so a roll-over between contracts cancels out;
 *  - FII/DII: NSE's provisional cash-market figures (combined NSE, BSE and MSEI),
 *    kept by date each evening, so coverage also grows one day at a time;
 *  - 09:15–09:20 volume, value and range: Kite's historical 1-minute candles.
 */

export const RESEARCH_DAYS = 20;
/** Fewer comparable sessions than this: no ratio, only the coverage. */
export const MIN_RESEARCH_DAYS = 5;
/** Sector median 20-session return needs this many stocks with a return. */
export const MIN_SECTOR_STOCKS = 3;
/** Label for the FII/DII figures the app stores (NSE's fiidiiTradeReact). */
export const FLOWS_SCOPE = 'NSE provisional, combined NSE + BSE + MSEI cash market';

const finite = (xs) => xs.filter((x) => x != null && Number.isFinite(x));
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** Sample standard deviation; null for fewer than two values. */
export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** value ÷ the average of `history`: { x, avg, days }, or null when there is too little history. */
export function ratioToAverage(value, history, minDays = MIN_RESEARCH_DAYS) {
  const h = finite(history);
  const avg = mean(h);
  if (value == null || !Number.isFinite(value) || h.length < minDays || !(avg > 0)) return null;
  return { x: value / avg, avg, days: h.length };
}

/** Share of `history` below `value` (ties count half), 0..1; null when there is too little history. */
export function percentileRank(value, history, minDays = MIN_RESEARCH_DAYS) {
  const h = finite(history);
  if (value == null || !Number.isFinite(value) || h.length < minDays) return null;
  const below = h.filter((x) => x < value).length;
  const equal = h.filter((x) => x === value).length;
  return (below + equal / 2) / h.length;
}

/** (value − mean) ÷ standard deviation of `history`: { z, mean, sd, days }, or null. */
export function zScore(value, history, minDays = MIN_RESEARCH_DAYS) {
  const h = finite(history);
  const sd = stdev(h);
  if (value == null || !Number.isFinite(value) || h.length < minDays || !sd) return null;
  const m = mean(h);
  return { z: (value - m) / sd, mean: m, sd, days: h.length };
}

/** "17/20" */
export const coverage = (days, of = RESEARCH_DAYS) => `${days ?? 0}/${of}`;

// ---- FII/DII flow history ----

/**
 * Flow statistics for one side ('fii' or 'dii'). `flows` is { YYYY-MM-DD: { fii, dii } };
 * `sessions` the trading days oldest -> newest ending with the session being judged
 * (the previous session at 09:10), RESEARCH_DAYS + 1 long.
 *  - latest: that session's net flow (₹ Cr), the actual buying or selling;
 *  - z: how unusual it is against the RESEARCH_DAYS sessions before it (positive
 *    can mean less selling than usual, so read it with `latest`);
 *  - sum5 / sum20: cumulative net flow over the last 5 / 20 sessions including it;
 *  - buyDays: net-buying sessions among the last 20 that have data.
 */
export function flowSideStats(flows, sessions, side) {
  const value = (d) => {
    const v = flows?.[d]?.[side];
    return v != null && Number.isFinite(v) ? v : null;
  };
  const judged = sessions.at(-1);
  const latest = judged ? value(judged) : null;
  const before = sessions.slice(-RESEARCH_DAYS - 1, -1).map(value);
  const last5 = finite(sessions.slice(-5).map(value));
  const last20 = finite(sessions.slice(-RESEARCH_DAYS).map(value));
  const z = zScore(latest, before);
  return {
    latest,
    z: z?.z ?? null,
    mean: z?.mean ?? mean(finite(before)),
    days: finite(before).length,
    sum5: last5.length ? last5.reduce((a, b) => a + b, 0) : null,
    days5: last5.length,
    sum20: last20.length ? last20.reduce((a, b) => a + b, 0) : null,
    days20: last20.length,
    buyDays: last20.filter((v) => v > 0).length,
  };
}

/** Both buying, both selling, or opposite directions. */
export function flowAgreement(fii, dii) {
  if (fii == null || dii == null) return null;
  if (fii > 0 && dii > 0) return 'both buying';
  if (fii < 0 && dii < 0) return 'both selling';
  if (fii > 0 && dii < 0) return 'FII buying, DII selling';
  if (fii < 0 && dii > 0) return 'FII selling, DII buying';
  return 'flat';
}

/** FII and DII flow history for the session at the end of `sessions` (see flowSideStats). */
export function flowHistoryStats(flows, sessions) {
  const judged = sessions.at(-1) ?? null;
  const fii = flowSideStats(flows, sessions, 'fii');
  const dii = flowSideStats(flows, sessions, 'dii');
  return {
    date: judged,
    scope: FLOWS_SCOPE,
    fii,
    dii,
    agreement: flowAgreement(fii.latest, dii.latest),
  };
}

// ---- Pre-open history (from recorded snapshots) ----

/**
 * One recorded pre-open day, compacted: per symbol [final quantity, value ₹ Cr],
 * per sector (the master list's Industry that day) [advances, total].
 */
export function preopenDaySummary(rows, masterRows) {
  const sectorOf = new Map();
  for (const m of masterRows ?? []) {
    const sym = String(m.Symbol ?? '').trim().toUpperCase();
    if (sym) sectorOf.set(sym, String(m.Industry || 'Unknown').trim());
  }
  const symbols = {};
  const sectors = {};
  for (const r of rows ?? []) {
    const sym = String(r.SYMBOL ?? '').trim().toUpperCase();
    if (!sym) continue;
    const qty = toNumber(r['FINAL VOLUME']);
    const value = toNumber(r['VALUE (₹ Crores)']);
    symbols[sym] = [Number.isFinite(qty) ? qty : null, Number.isFinite(value) ? value : null];
    const sector = sectorOf.get(sym);
    if (!sector) continue; // same rule as the analysis: stocks outside the master list are left out
    const change = toNumber(r.CHANGE);
    const s = sectors[sector] ??= [0, 0];
    if (change > 0) s[0]++;
    s[1]++;
  }
  return { symbols, sectors };
}

/**
 * Baseline from up to RESEARCH_DAYS recorded days before the one being judged
 * (`summaries` oldest -> newest, each { date, symbols, sectors }):
 *   stocks:  { SYMBOL: [average final quantity, average value ₹ Cr, days] }
 *   sectors: { SECTOR: [average advancing %, days] }
 * Compact arrays because this goes to the browser with the context.
 */
export function preopenBaseline(summaries) {
  const used = summaries.slice(-RESEARCH_DAYS);
  const acc = {};
  const sec = {};
  for (const day of used) {
    for (const [sym, [qty, value]] of Object.entries(day.symbols ?? {})) {
      const a = acc[sym] ??= { qty: [], value: [] };
      if (qty != null) a.qty.push(qty);
      if (value != null) a.value.push(value);
    }
    for (const [name, [adv, total]] of Object.entries(day.sectors ?? {})) {
      if (total > 0) (sec[name] ??= []).push((adv / total) * 100);
    }
  }
  const round = (n, d) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);
  return {
    days: used.length,
    from: used[0]?.date ?? null,
    to: used.at(-1)?.date ?? null,
    stocks: Object.fromEntries(Object.entries(acc).map(([sym, a]) => [sym, [round(mean(a.qty), 0), round(mean(a.value), 4), Math.max(a.qty.length, a.value.length)]])),
    sectors: Object.fromEntries(Object.entries(sec).map(([name, list]) => [name, [round(mean(list), 2), list.length]])),
  };
}

// ---- Per-stock and per-sector research columns (the 09:10 analysis) ----

/**
 * Adds research fields to each analysed stock (after applySignals), using
 * `context.history.stats` (end-of-day files), `context.history.indices` (Nifty /
 * VIX) and `context.preopen` (recorded pre-open baseline):
 *   preRvolX      today's matched pre-open quantity ÷ its average matched pre-open quantity
 *   preValueX     today's pre-open value ÷ its average pre-open value
 *   gapX          |today's gap %| ÷ its average |open vs previous close| (direction: pctChange)
 *   delivQtyX     yesterday's delivered shares ÷ the average of the 20 sessions before
 *   rsSectorPct   20-session return minus the sector's median 20-session return (points)
 *   rsNiftyPct    20-session return minus the Nifty 50's (points)
 *   oiRank        yesterday's |futures OI change %| as a percentile of the 20 before (0..1)
 * and `researchDays` with the sessions behind each ratio.
 */
export function applyResearch(stocks, context) {
  const stats = context?.history?.stats ?? {};
  const pre = context?.preopen?.stocks ?? {};
  const nifty = context?.history?.indices?.nifty ?? null;

  for (const s of stocks) {
    const h = stats[s.symbol];
    const p = pre[s.symbol];
    const preQty = p && p[2] >= MIN_RESEARCH_DAYS && p[0] > 0 && s.finalVolume != null ? s.finalVolume / p[0] : null;
    const preValue = p && p[2] >= MIN_RESEARCH_DAYS && p[1] > 0 && s.valueCr != null ? s.valueCr / p[1] : null;
    s.preRvolX = preQty;
    s.preValueX = preValue;
    s.preAvgVolume = p?.[0] ?? null;
    s.preAvgValueCr = p?.[1] ?? null;
    s.gapX = h?.avgAbsGap > 0 && h.gapDays >= MIN_RESEARCH_DAYS && s.pctChange != null ? Math.abs(s.pctChange) / h.avgAbsGap : null;
    s.avgAbsGap = h?.gapDays >= MIN_RESEARCH_DAYS ? h.avgAbsGap : null;
    s.delivQty = h?.prevDelivQty ?? null;
    s.avgDelivQty = h?.avgDelivQty ?? null;
    s.delivQtyX = h?.avgDelivQty > 0 && h.delivQtyDays >= MIN_RESEARCH_DAYS && h.prevDelivQty != null ? h.prevDelivQty / h.avgDelivQty : null;
    s.rsNiftyPct = s.ret20 != null && nifty?.ret20 != null ? s.ret20 - nifty.ret20 : null;
    s.oiRank = h?.foOiRank ?? null;
    s.researchDays = {
      preopen: p?.[2] ?? 0,
      gap: h?.gapDays ?? 0,
      deliv: h?.delivQtyDays ?? 0,
      oi: h?.foOiDays ?? 0,
    };
  }

  // Sector median 20-session return, over the stocks analysed today.
  const bySector = new Map();
  for (const s of stocks) if (s.ret20 != null) (bySector.get(s.sector) ?? bySector.set(s.sector, []).get(s.sector)).push(s.ret20);
  const sectorRet = new Map([...bySector].filter(([, list]) => list.length >= MIN_SECTOR_STOCKS).map(([name, list]) => [name, median(list)]));
  for (const s of stocks) {
    const r = sectorRet.get(s.sector);
    s.sectorRet20 = r ?? null;
    s.rsSectorPct = s.ret20 != null && r != null ? s.ret20 - r : null;
  }
  return stocks;
}

/** Today's advancing % per sector minus its average over the recorded pre-open baseline (percentage points). */
export function applySectorResearch(sectors, context) {
  const base = context?.preopen?.sectors ?? {};
  for (const s of sectors) {
    const b = base[s.sector];
    const advPct = s.total ? (s.advances / s.total) * 100 : null;
    s.usualAdvPct = b && b[1] >= MIN_RESEARCH_DAYS ? b[0] : null;
    s.advVsUsualPp = advPct != null && s.usualAdvPct != null ? advPct - s.usualAdvPct : null;
    s.breadthDays = b?.[1] ?? 0;
  }
  return sectors;
}
