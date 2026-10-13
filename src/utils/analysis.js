import { toNumber } from './csv.js';
import { marketCapKey, marketCapOf } from './master.js';
import { scoreConviction } from './conviction.js';
import { tradeFlags } from './tradeability.js';

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
 */
export function analyze(pmRows, masterRows, secList = null) {
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
    const circuitBase = !Number.isNaN(basePrice) ? basePrice : Number.isNaN(prevClose) ? null : prevClose;
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
      // Pre-open data carries the session's series; uploads fall back to the NSE list.
      series: String(row['SERIES'] ?? '').trim() || info[symbol]?.series || null,
      surveillance: info[symbol]?.remarks || null,
      status,
    });
  }
  for (const stock of stocks) stock.flags = tradeFlags(stock);

  const sectors = [...sectorMap.values()].sort((a, b) => b.total - a.total);
  const total = advances + declines + unchanged;
  const adRatio = declines > 0 ? advances / declines : advances > 0 ? Infinity : null;
  const summary = { total, advances, declines, unchanged, skipped, adRatio };
  scoreConviction(stocks, sectors, summary);

  return {
    summary,
    sectors,
    stocks,
    hasMarketCap: Boolean(capKey),
  };
}
