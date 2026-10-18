import { indiaDate } from './calendar.js';
import { parseCSV, rowsToObjects } from '../utils/csv.js';

/**
 * Kite's instruments dump, cached once a day (Kite regenerates it daily; it
 * recommends fetching around 08:30). Only what the opening-window collector
 * needs is kept: NSE equity tokens with tick and lot sizes, NSE index tokens,
 * and each F&O stock's near-month future. Tokens are resolved from that day's
 * dump only, because exchanges may reuse tokens after expiries.
 *
 * Store file: instruments/YYYY-MM-DD.json
 */

const file = (date) => `instruments/${date}.json`;

/** Compact the NSE and NFO dumps (CSV text) for `date` (YYYY-MM-DD). */
export function compactInstruments(nseCsv, nfoCsv, date) {
  const equities = {};
  const indices = {};
  for (const r of rowsToObjects(parseCSV(nseCsv ?? ''))) {
    const token = Number(r.instrument_token);
    if (!token) continue;
    if (r.segment === 'INDICES') indices[r.tradingsymbol] = token;
    else if (r.instrument_type === 'EQ' && r.segment === 'NSE') {
      equities[r.tradingsymbol] = [token, Number(r.tick_size) || 0.05, Number(r.lot_size) || 1];
    }
  }
  // Near-month future per underlying: the earliest expiry on or after `date`.
  const futures = {};
  for (const r of rowsToObjects(parseCSV(nfoCsv ?? ''))) {
    if (r.instrument_type !== 'FUT' || !r.name || !r.expiry || r.expiry < date) continue;
    const cur = futures[r.name];
    if (!cur || r.expiry < cur[2]) futures[r.name] = [Number(r.instrument_token), r.tradingsymbol, r.expiry, Number(r.lot_size) || 1];
  }
  return { date, equities, indices, futures };
}

/** Lookups over a compact dump. */
export function instrumentIndex(compact) {
  const byToken = new Map();
  for (const [sym, [token, tick, lot]] of Object.entries(compact?.equities ?? {})) byToken.set(token, { kind: 'stock', symbol: sym, tick, lot });
  for (const [name, token] of Object.entries(compact?.indices ?? {})) byToken.set(token, { kind: 'index', symbol: name });
  for (const [underlying, [token, tradingsymbol, expiry, lot]] of Object.entries(compact?.futures ?? {})) {
    byToken.set(token, { kind: 'future', symbol: tradingsymbol, underlying, expiry, lot });
  }
  return {
    date: compact?.date ?? null,
    equity: (symbol) => {
      const e = compact?.equities?.[symbol];
      return e ? { token: e[0], tick: e[1], lot: e[2] } : null;
    },
    /** Index token by Kite instrument key ("NSE:NIFTY 50") or tradingsymbol. */
    index: (key) => compact?.indices?.[String(key).replace(/^NSE:/, '')] ?? null,
    future: (underlying) => {
      const f = compact?.futures?.[underlying];
      return f ? { token: f[0], tradingsymbol: f[1], expiry: f[2], lot: f[3] } : null;
    },
    byToken: (token) => byToken.get(token) ?? null,
  };
}

export function createInstrumentService({ store, kite, now = () => new Date() }) {
  const memory = new Map();
  /** Today's instruments: from the store, or downloaded once (needs a Kite session). */
  async function load({ apiKey, accessToken } = {}) {
    const date = indiaDate(now());
    if (memory.has(date)) return memory.get(date);
    let compact = await store.read(file(date));
    if (!compact) {
      if (!accessToken) throw new Error('Kite login needed to download today\'s instruments.');
      const [nse, nfo] = await Promise.all([
        kite.instrumentsCsv({ apiKey, accessToken, exchange: 'NSE' }),
        kite.instrumentsCsv({ apiKey, accessToken, exchange: 'NFO' }),
      ]);
      compact = compactInstruments(nse, nfo, date);
      if (!Object.keys(compact.equities).length) throw new Error('Kite\'s instruments dump had no NSE equities.');
      await store.write(file(date), compact);
    }
    const index = instrumentIndex(compact);
    memory.clear();
    memory.set(date, index);
    return index;
  }
  return { load };
}
