import { CONVICTION_FACTORS, cleanWeight } from './conviction.js';
import { cleanScreener } from './screener.js';

/**
 * Identity of an Analyzer view, shared by the browser and the backend's AI
 * Analyst, so "Ask AI about this stock" explains exactly the view on screen:
 *  - snapshot ID: the trading date plus a hash of the pre-open rows;
 *  - profile hash: the conviction factors and Stock filter settings, normalised;
 *  - fingerprints of the market context and the other inputs (master list,
 *    price bands), so a backend that has refreshed them since the page loaded
 *    is noticed instead of silently explaining different numbers.
 * Pure: no I/O.
 */

export const PROFILE_VERSION = 1;

/** FNV-1a hash of a string, as 8 hex digits plus the length (base 36). */
export function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}${text.length.toString(36)}`;
}

/** JSON with object keys sorted, so equal values always give the same text. */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Hash of pre-open rows that ignores row order, key order and null cells (the
 * recorder stores rows as columns and fills missing cells with null).
 */
export function rowsHash(rows) {
  const canon = (rows ?? [])
    .map((r) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v != null && v !== '')))
    .sort((a, b) => String(a.SYMBOL ?? '').localeCompare(String(b.SYMBOL ?? '')) || stableStringify(a).localeCompare(stableStringify(b)));
  return hashText(stableStringify(canon));
}

export const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}\.[0-9a-f]{8}[0-9a-z]{1,8}$/;

/** Stable snapshot ID: `YYYY-MM-DD.<rows hash>`. */
export const snapshotIdFor = (date, rows) => `${date}.${rowsHash(rows)}`;

/** Every conviction factor as { on, weight }, the way the score reads the settings (factorWeights). */
export function normalizeFactors(settings) {
  return Object.fromEntries(CONVICTION_FACTORS.map((f) => {
    const s = settings?.[f.key];
    const on = typeof s?.on === 'boolean' ? s.on : (f.defaultOn ?? true);
    return [f.key, { on, weight: cleanWeight(s?.weight) ?? f.weight }];
  }));
}

/** The settings that change an Analyzer result, normalised (unknown keys dropped). */
export function normalizeProfile(profile) {
  return {
    version: PROFILE_VERSION,
    convictionFactors: normalizeFactors(profile?.convictionFactors),
    screener: cleanScreener(profile?.screener),
  };
}

export const profileHash = (profile) => hashText(stableStringify(normalizeProfile(profile)));

/**
 * Fingerprint of the market context an analysis used. Leaves out fields that
 * change without changing any number: status lines, error text, the time
 * corporate events were re-fetched (their contents count). With a `profile`,
 * the market-wide signals (GIFT Nifty, India VIX, FII/DII, re-read every few
 * minutes in market hours) count only when their conviction factor is on.
 */
export function contextFingerprint(context, profile = null) {
  if (!context) return hashText('none');
  const h = context.history ?? null;
  const e = context.events ?? null;
  const factors = profile ? normalizeProfile(profile).convictionFactors : null;
  const market = context.market && factors
    ? Object.fromEntries(['gift', 'vix', 'flows'].filter((k) => factors[k]?.on).map((k) => [k, context.market[k] ?? null]))
    : context.market ?? null;
  return hashText(stableStringify({
    date: context.date ?? null,
    history: h ? { asOf: h.asOf ?? null, days: h.days ?? null, foAsOf: h.foAsOf ?? null, foDays: h.foDays ?? null } : null,
    events: e ? { date: e.date ?? null, contents: hashText(stableStringify({ results: e.results ?? null, resultsDue: e.resultsDue ?? null, exDates: e.exDates ?? null })) } : null,
    market,
    auction: context.auction ? { date: context.auction.date, from: context.auction.from, to: context.auction.to, snaps: context.auction.snaps } : null,
    preopen: context.preopen ? hashText(JSON.stringify(context.preopen)) : null,
  }));
}

/** Fingerprint of the master list and price bands an analysis used. */
export function inputsFingerprint({ masterRows, priceBands }) {
  return hashText(stableStringify({
    master: masterRows ? hashText(JSON.stringify(masterRows)) : null,
    bands: priceBands?.fetchedAt ?? null,
  }));
}

/**
 * The analysis context the browser sends with "Ask AI": what the Analyzer
 * shows, by ID and hash. The backend recomputes every hash and refuses a
 * mismatch.
 */
export function analyzerContext({ date, rows, convictionFactors, screener, context, masterRows, priceBands }) {
  if (!date || !rows?.length) return null;
  const profile = normalizeProfile({ convictionFactors, screener });
  return {
    source: 'analyzer',
    snapshotId: snapshotIdFor(date, rows),
    date,
    profile,
    profileHash: profileHash(profile),
    contextFp: contextFingerprint(context, profile),
    inputsFp: inputsFingerprint({ masterRows, priceBands }),
  };
}
