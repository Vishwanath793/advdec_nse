import { toNumber } from './csv.js';

/**
 * Build the advance/decline analysis by joining pm.csv rows with the
 * master stock list (symbol -> industry/sector).
 *
 * Classification: CHANGE > 0 => advance, CHANGE < 0 => decline, else unchanged.
 */
export function analyze(pmRows, masterRows) {
  const sectorBySymbol = new Map();
  const nameBySymbol = new Map();
  for (const m of masterRows) {
    const sym = (m['Symbol'] || '').trim().toUpperCase();
    if (!sym) continue;
    sectorBySymbol.set(sym, (m['Industry'] || 'Unknown').trim());
    nameBySymbol.set(sym, (m['Company Name'] || '').trim());
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
      change: Number.isNaN(change) ? null : change,
      pctChange: Number.isNaN(pctChange) ? null : pctChange,
      prevClose: Number.isNaN(prevClose) ? null : prevClose,
      finalPrice: Number.isNaN(finalPrice) ? null : finalPrice,
      ffmCap: Number.isNaN(ffmCap) ? null : ffmCap,
      valueCr: Number.isNaN(valueCr) ? null : valueCr,
      status,
    });
  }

  const sectors = [...sectorMap.values()].sort((a, b) => b.total - a.total);
  const total = advances + declines + unchanged;
  const adRatio = declines > 0 ? advances / declines : advances > 0 ? Infinity : null;

  return {
    summary: { total, advances, declines, unchanged, skipped, adRatio },
    sectors,
    stocks,
  };
}
