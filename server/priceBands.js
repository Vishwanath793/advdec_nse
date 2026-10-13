import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCSV, rowsToObjects } from '../src/utils/csv.js';

// NSE's daily list of securities with their price band (circuit) percentage.
// "No Band" marks F&O stocks, which have dynamic limits instead of fixed circuits.
export const SEC_LIST_URL = 'https://nsearchives.nseindia.com/content/equities/sec_list.csv';

/**
 * Parse sec_list.csv into { bands: { SYMBOL: percent | 'none' }, info: { SYMBOL: { series, remarks } } }.
 * Prefers the EQ row when a symbol is listed in several series (e.g. EQ + warrants).
 * `remarks` carries surveillance tags such as "GSM STAGE - I" ('' when none).
 */
export function parseSecList(text) {
  const bands = {};
  const info = {};
  for (const row of rowsToObjects(parseCSV(text.replace(/^﻿/, '')))) {
    const symbol = (row.Symbol ?? '').trim().toUpperCase();
    const raw = (row.Band ?? '').trim();
    if (!symbol || !raw) continue;
    if (symbol in bands && info[symbol].series === 'EQ') continue;
    const pct = Number(raw);
    const remarks = (row.Remarks ?? '').trim();
    bands[symbol] = /no\s*band/i.test(raw) ? 'none' : Number.isFinite(pct) && pct > 0 ? pct : null;
    info[symbol] = { series: (row.Series ?? '').trim(), remarks: remarks === '-' ? '' : remarks };
  }
  if (Object.keys(bands).length === 0) throw new Error('NSE price band file had no usable rows.');
  return { bands, info };
}

const istDate = (date) => new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/**
 * Fetches the band file at most once per IST day (cached on disk). Failed
 * fetches keep serving the last good copy, flagged with lastError.
 */
export function createPriceBandService({ file, fetchImpl = fetch, now = () => new Date() }) {
  let cache = null;
  try { cache = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.error(`Price bands cache unreadable: ${error.message}`); }
  let running = null;

  async function fetchBands() {
    const response = await fetchImpl(SEC_LIST_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nseindia.com/' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`NSE price band request failed (HTTP ${response.status}).`);
    const next = { fetchedAt: now().toISOString(), ...parseSecList(await response.text()) };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
    cache = next;
    return cache;
  }

  return {
    async get({ force = false } = {}) {
      // Caches written before series/remarks were stored (no `info`) are refetched.
      if (!force && cache?.info && istDate(cache.fetchedAt) === istDate(now())) return cache;
      running ??= fetchBands().finally(() => { running = null; });
      try { return await running; }
      catch (error) {
        const message = error.name === 'TimeoutError' ? 'NSE price band request timed out.' : error.message;
        if (cache) return { ...cache, lastError: message };
        throw new Error(message);
      }
    },
  };
}
