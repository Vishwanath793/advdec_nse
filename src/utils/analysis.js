import { toNumber } from './csv.js';
import { marketCapKey, marketCapOf } from './master.js';
import { scoreConviction } from './conviction.js';
import { tradeFlags } from './tradeability.js';
import { applySignals } from './signals.js';
import { applyResearch, applySectorResearch } from './research.js';

const num = (v) => {
  const n = toNumber(v);
  return Number.isNaN(n) ? null : n;
};

/** NSE equity tick size (₹) by price, per the 2025 revised tick-size slabs. */
export function tickSize(price) {
  if (price < 250) return 0.01;
  if (price < 1000) return 0.05;
  if (price < 5000) return 0.1;
  if (price < 10000) return 0.5;
  if (price < 20000) return 1;
  return 5;
}

/**
 * Circuit limits from the session's base price (normally the previous close).
 * NSE rounds the upper limit down and the lower limit up to the tick size,
 * e.g. base 599.90 at 20% -> 479.95 / 719.85.
 */
/** Final price may differ from base + change by at most this % before the row is flagged. */
export const DATA_TOLERANCE_PCT = 0.05;

/**
 * NSE pre-open rows occasionally contradict themselves, e.g. on 15 Oct 2026
 * NSLNISP showed final ₹39.68 on base ₹39.63 with change +2.37 (+5.98%), and
 * NEULANDLAB final ₹20,200 = base with change +150. Such rows (both had ₹0
 * pre-open value: no trades) give a gap the price doesn't support. Returns a
 * description of the mismatch, or null when consistent or not checkable.
 */
export function dataIssue({ base, change, finalPrice, valueCr }) {
  if (!(base > 0) || !(finalPrice > 0) || change == null) return null;
  const expected = base + change;
  const offPct = (Math.abs(finalPrice - expected) / base) * 100;
  if (offPct <= DATA_TOLERANCE_PCT) return null;
  const rs = (n) => `₹${n.toFixed(2)}`;
  return `Final price ${rs(finalPrice)} but base ${rs(base)} ${change >= 0 ? '+' : '−'} change ${Math.abs(change).toFixed(2)} = ${rs(expected)}`
    + `${valueCr === 0 ? '; ₹0 traded in pre-open' : ''}. The gap may not be real: check the live price before trading.`;
}

export function circuitFor(band, basePrice, finalPrice) {
  if (typeof band !== 'number' || basePrice == null) return { upperCircuit: null, lowerCircuit: null, circuitHit: null };
  // Work in paise to avoid floating-point drift.
  const tick = Math.round(tickSize(basePrice) * 100);
  const base = Math.round(basePrice * 100);
  const upperCircuit = (Math.floor((base * (100 + band)) / 100 / tick + 1e-9) * tick) / 100;
  const lowerCircuit = (Math.ceil((base * (100 - band)) / 100 / tick - 1e-9) * tick) / 100;
  const circuitHit = finalPrice == null ? null
    : finalPrice >= upperCircuit ? 'upper'
    : finalPrice <= lowerCircuit ? 'lower'
    : null;
  return { upperCircuit, lowerCircuit, circuitHit };
}

/**
 * Build the advance/decline analysis by joining pm.csv rows with the
 * master stock list (symbol -> industry/sector).
 *
 * Classification: CHANGE > 0 => advance, CHANGE < 0 => decline, else unchanged.
 *
 * `secList` (optional) is the parsed NSE security list: `bands` maps SYMBOL ->
 * price band % or 'none' (F&O, dynamic limits); `info` maps SYMBOL ->
 * { series, remarks } for the tradeability checks.
 *
 * `options.convictionFactors` ({ key: { on, weight } }) adjusts the conviction
 * score's factors; defaults apply when omitted. `options.context` (from
 * /api/nse/context) adds yesterday's range, relative volume and corporate events.
 */
export function analyze(pmRows, masterRows, secList = null, options = {}) {
  const bands = secList?.bands;
  const info = secList?.info ?? {};
  const sectorBySymbol = new Map();
  const nameBySymbol = new Map();
  const capBySymbol = new Map();
  const capKey = marketCapKey(masterRows[0]);
  for (const m of masterRows) {
    const sym = (m['Symbol'] || '').trim().toUpperCase();
    if (!sym) continue;
    sectorBySymbol.set(sym, (m['Industry'] || 'Unknown').trim());
    nameBySymbol.set(sym, (m['Company Name'] || '').trim());
    capBySymbol.set(sym, marketCapOf(m, capKey));
  }

  const stocks = [];
  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  let skipped = 0;
  const sectorMap = new Map();

  for (const row of pmRows) {
    const symbol = (row['SYMBOL'] || '').trim().toUpperCase();
    if (!symbol) continue;

    const sector = sectorBySymbol.get(symbol);
    if (!sector) {
      // Not in master_stock.csv — exclude from the analysis entirely.
      skipped++;
      continue;
    }

    const change = toNumber(row['CHANGE']);
    const pctChange = toNumber(row['%CHANGE']);
    const prevClose = toNumber(row['PREV. CLOSE']);
    const finalPrice = toNumber(row['FINAL PRICE']);
    // NSE's base price differs from prev close after corporate actions; CSV uploads lack it.
    const basePrice = toNumber(row['BASE PRICE']);
    // A base of 0 (seen for ADROITIND on 15 Oct 2026) is missing data, not a price.
    const circuitBase = basePrice > 0 ? basePrice : prevClose > 0 ? prevClose : null;
    const ffmCap = toNumber(row['FFM CAP (₹ Crores)']);
    const valueCr = toNumber(row['VALUE (₹ Crores)']);

    let status;
    if (Number.isNaN(change) || change === 0) {
      status = 'unchanged';
      unchanged++;
    } else if (change > 0) {
      status = 'advance';
      advances++;
    } else {
      status = 'decline';
      declines++;
    }

    if (!sectorMap.has(sector)) {
      sectorMap.set(sector, { sector, advances: 0, declines: 0, unchanged: 0, total: 0 });
    }
    const s = sectorMap.get(sector);
    s[status === 'advance' ? 'advances' : status === 'decline' ? 'declines' : 'unchanged']++;
    s.total++;

    stocks.push({
      symbol,
      company: nameBySymbol.get(symbol) || '—',
      sector,
      marketCap: capBySymbol.get(symbol) ?? null,
      band: bands ? bands[symbol] ?? null : null,
      bandPct: typeof bands?.[symbol] === 'number' ? bands[symbol] : null,
      circuitBase,
      ...circuitFor(bands?.[symbol], circuitBase, Number.isNaN(finalPrice) ? null : finalPrice),
      change: Number.isNaN(change) ? null : change,
      pctChange: Number.isNaN(pctChange) ? null : pctChange,
      prevClose: Number.isNaN(prevClose) ? null : prevClose,
      finalPrice: Number.isNaN(finalPrice) ? null : finalPrice,
      ffmCap: Number.isNaN(ffmCap) ? null : ffmCap,
      valueCr: Number.isNaN(valueCr) ? null : valueCr,
      buyQty: num(row['TOTAL BUY QTY']),
      sellQty: num(row['TOTAL SELL QTY']),
      yearHigh: num(row['52 WEEK HIGH']),
      yearLow: num(row['52 WEEK LOW']),
      finalVolume: num(row['FINAL VOLUME']),
      // Pre-open data carries the session's series; uploads fall back to the NSE list.
      series: String(row['SERIES'] ?? '').trim() || info[symbol]?.series || null,
      surveillance: info[symbol]?.remarks || null,
      dataIssue: dataIssue({
        base: circuitBase,
        change: Number.isNaN(change) ? null : change,
        finalPrice: Number.isNaN(finalPrice) ? null : finalPrice,
        valueCr: Number.isNaN(valueCr) ? null : valueCr,
      }),
      status,
    });
  }
  applySignals(stocks, options.context);
  applyResearch(stocks, options.context); // research columns only: not part of any score
  for (const stock of stocks) stock.flags = tradeFlags(stock);

  const sectors = applySectorResearch([...sectorMap.values()].sort((a, b) => b.total - a.total), options.context);
  const total = advances + declines + unchanged;
  const adRatio = declines > 0 ? advances / declines : advances > 0 ? Infinity : null;
  const summary = { total, advances, declines, unchanged, skipped, adRatio };
  scoreConviction(stocks, sectors, summary, options.convictionFactors, options.context?.market ?? null);

  return {
    summary,
    sectors,
    stocks,
    hasMarketCap: Boolean(capKey),
  };
}
