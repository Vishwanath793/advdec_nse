import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { indiaDate, marketDay, readCalendar } from './tv/calendar.js';

/**
 * Context for the 9:10 decision that the pre-open feed doesn't carry:
 *  - history: yesterday's high/low/close and 20-day average volume per symbol,
 *    from NSE's daily end-of-day files (sec_bhavdata_full), cached on disk;
 *  - events: results announced since the last close, results due today and
 *    corporate-action ex-dates today, from NSE's corporate feeds.
 */

const BHAV_URL = (ddmmyyyy) => `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;
const API = 'https://www.nseindia.com/api';
export const HISTORY_DAYS = 20;
const EVENTS_MAX_AGE_MS = 10 * 60 * 1000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/csv', Referer: 'https://www.nseindia.com/' };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const isoToNse = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`; // YYYY-MM-DD -> DD-MM-YYYY
const isoToCompact = (iso) => isoToNse(iso).replace(/-/g, '');
/** "12-Oct-2026 16:58:53" or "12-Oct-2026" (IST) -> Date. */
export function parseNseDate(text) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(text ?? '').trim());
  if (!m || MONTHS[m[2]] == null) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return new Date(`${m[3]}-${pad(MONTHS[m[2]] + 1)}-${pad(m[1])}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}+05:30`);
}

/** The `count` most recent NSE trading days strictly before `today` (YYYY-MM-DD). */
export function previousTradingDays(today, count, calendar) {
  const days = [];
  const d = new Date(`${today}T12:00:00Z`);
  for (let i = 0; i < 120 && days.length < count; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    if (marketDay(iso, calendar).open) days.push(iso);
  }
  return days;
}

/** Parse a sec_bhavdata_full CSV into { SYMBOL: { high, low, close, volume } }, preferring EQ rows. */
export function parseBhavcopy(text) {
  const [header, ...lines] = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const keys = header.split(',').map((k) => k.trim());
  const at = (name) => keys.indexOf(name);
  const idx = { sym: at('SYMBOL'), series: at('SERIES'), high: at('HIGH_PRICE'), low: at('LOW_PRICE'), close: at('CLOSE_PRICE'), vol: at('TTL_TRD_QNTY') };
  if (Object.values(idx).some((i) => i < 0)) throw new Error('Unexpected end-of-day file format.');
  const out = {};
  for (const line of lines) {
    const v = line.split(',').map((x) => x.trim());
    const sym = v[idx.sym];
    if (!sym || (out[sym] && out[sym].series === 'EQ')) continue;
    const row = { series: v[idx.series], high: Number(v[idx.high]), low: Number(v[idx.low]), close: Number(v[idx.close]), volume: Number(v[idx.vol]) };
    if ([row.high, row.low, row.close, row.volume].every(Number.isFinite)) out[sym] = row;
  }
  return out;
}

/**
 * Per-symbol stats from daily files ordered oldest -> newest:
 * previous session's high/low/close and average volume over the last HISTORY_DAYS.
 */
export function historyStats(days) {
  const latest = days.at(-1);
  if (!latest) return {};
  const stats = {};
  for (const [sym, last] of Object.entries(latest.rows)) {
    const vols = days.slice(-HISTORY_DAYS).map((d) => d.rows[sym]?.volume).filter(Number.isFinite);
    stats[sym] = {
      prevHigh: last.high,
      prevLow: last.low,
      prevClose: last.close,
      avgVolume: vols.length >= Math.min(10, days.length) ? vols.reduce((a, b) => a + b, 0) / vols.length : null,
      volumeDays: vols.length,
    };
  }
  return stats;
}

const RESULTS = (a) => /financial result/i.test(a.desc ?? '')
  || (/outcome of board meeting/i.test(a.desc ?? '') && /financial results?/i.test(a.attchmntText ?? ''));

/** Results announced at/after `since` (Date): { SYMBOL: [{ at, text }] }. */
export function parseResults(announcements, since) {
  const out = {};
  for (const a of announcements ?? []) {
    const at = parseNseDate(a.an_dt ?? a.sort_date);
    if (!a.symbol || !at || at < since || !RESULTS(a)) continue;
    (out[a.symbol] ??= []).push({ at: at.toISOString(), text: (a.attchmntText || a.desc || '').slice(0, 200) });
  }
  return out;
}

/** Board meetings for results scheduled on `today` (YYYY-MM-DD): { SYMBOL: purpose }. */
export function parseResultsDue(calendarRows, today) {
  const out = {};
  for (const c of calendarRows ?? []) {
    const date = parseNseDate(c.date);
    if (c.symbol && date && indiaDate(date) === today && /financial result/i.test(c.purpose ?? '')) out[c.symbol] = c.purpose;
  }
  return out;
}

/** Corporate actions going ex on `today`: { SYMBOL: [subject] }. */
export function parseExDates(actions, today) {
  const out = {};
  for (const a of actions ?? []) {
    const ex = parseNseDate(a.exDate);
    if (a.symbol && ex && indiaDate(ex) === today) (out[a.symbol] ??= []).push(a.subject);
  }
  return out;
}

export function createMarketContextService({ dir, fetchImpl = fetch, now = () => new Date(), calendar = readCalendar() }) {
  const bhavDir = join(dir, 'bhav');
  const eventsFile = join(dir, 'nse-events.json');
  let events = null;
  try { events = JSON.parse(readFileSync(eventsFile, 'utf8')); } catch { /* none yet */ }
  const unavailable = new Set(); // files that returned 404 this session
  let history = null;
  let running = null;

  async function fetchText(url) {
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(25_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`NSE request failed (HTTP ${response.status}).`);
    return response.text();
  }
  const fetchJson = async (path) => {
    const text = await fetchText(`${API}/${path}`);
    const parsed = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : parsed?.data ?? [];
  };

  async function refreshHistory() {
    mkdirSync(bhavDir, { recursive: true });
    const wanted = previousTradingDays(indiaDate(now()), HISTORY_DAYS + 1, calendar).reverse();
    const errors = [];
    for (const iso of wanted) {
      const file = join(bhavDir, `${iso}.csv`);
      if (existsSync(file) || unavailable.has(iso)) continue;
      try {
        const text = await fetchText(BHAV_URL(isoToCompact(iso)));
        if (!text) { unavailable.add(iso); continue; }
        parseBhavcopy(text); // validate before caching
        writeFileSync(`${file}.tmp`, text);
        renameSync(`${file}.tmp`, file);
      } catch (error) { errors.push(`${iso}: ${error.message}`); }
    }
    const files = new Set(readdirSync(bhavDir));
    const days = wanted.filter((iso) => files.has(`${iso}.csv`))
      .map((iso) => ({ date: iso, rows: parseBhavcopy(readFileSync(join(bhavDir, `${iso}.csv`), 'utf8')) }));
    history = {
      asOf: days.at(-1)?.date ?? null,
      days: days.length,
      stats: historyStats(days),
      error: errors.length ? `Some end-of-day files could not be downloaded (${errors.length}).` : null,
    };
    return history;
  }

  async function refreshEvents() {
    const today = indiaDate(now());
    const [lastSession] = previousTradingDays(today, 1, calendar);
    const since = lastSession ? new Date(`${lastSession}T15:30:00+05:30`) : new Date(`${today}T00:00:00+05:30`);
    const from = isoToNse(lastSession ?? today);
    const [announcements, actions, meetings] = await Promise.all([
      fetchJson(`corporate-announcements?index=equities&from_date=${from}&to_date=${isoToNse(today)}`),
      fetchJson(`corporates-corporateActions?index=equities&from_date=${isoToNse(today)}&to_date=${isoToNse(today)}`),
      fetchJson(`event-calendar?index=equities&from_date=${isoToNse(today)}&to_date=${isoToNse(today)}`),
    ]);
    events = {
      date: today,
      fetchedAt: now().toISOString(),
      resultsSince: since.toISOString(),
      results: parseResults(announcements, since),
      resultsDue: parseResultsDue(meetings, today),
      exDates: parseExDates(actions, today),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${eventsFile}.tmp`, JSON.stringify(events));
    renameSync(`${eventsFile}.tmp`, eventsFile);
    return events;
  }

  async function get({ force = false } = {}) {
    running ??= (async () => {
      const today = indiaDate(now());
      const errors = [];
      if (force || !history || history.asOf !== previousTradingDays(today, 1, calendar)[0]) {
        try { await refreshHistory(); } catch (error) { errors.push(`History: ${error.message}`); }
      }
      const stale = !events || events.date !== today || now() - new Date(events.fetchedAt) > EVENTS_MAX_AGE_MS;
      if (force || stale) {
        try { await refreshEvents(); } catch (error) { errors.push(`Corporate events: ${error.message}`); }
      }
      if (history?.error) errors.push(history.error);
      return {
        history,
        events: events?.date === today ? events : null,
        error: errors.length ? errors.join(' ') : null,
      };
    })().finally(() => { running = null; });
    return running;
  }

  return { get, refreshHistory, refreshEvents };
}
