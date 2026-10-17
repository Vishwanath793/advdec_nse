import { strFromU8, unzipSync } from 'fflate';
import { indiaDate, previousTradingDays } from './calendar.js';

export { previousTradingDays };

/**
 * Context for the 9:10 decision that the pre-open feed doesn't carry:
 *  - history: yesterday's high/low/close and 20-day average volume per symbol,
 *    from NSE's daily end-of-day files (sec_bhavdata_full), cached in `store`;
 *  - events: results announced since the last close, results due today and
 *    corporate-action ex-dates today, from NSE's corporate feeds;
 *  - market: market-wide direction signals for the day: GIFT Nifty before the
 *    open, and the previous session's India VIX change and FII/DII flows.
 * History also carries delivery % and recent closes (trend) per symbol.
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

/** Parse a sec_bhavdata_full CSV into { SYMBOL: { high, low, close, volume, open, delivery } }, preferring EQ rows. */
export function parseBhavcopy(text) {
  const [header, ...lines] = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const keys = header.split(',').map((k) => k.trim());
  const at = (name) => keys.indexOf(name);
  const idx = { sym: at('SYMBOL'), series: at('SERIES'), high: at('HIGH_PRICE'), low: at('LOW_PRICE'), close: at('CLOSE_PRICE'), vol: at('TTL_TRD_QNTY') };
  const openAt = at('OPEN_PRICE');
  const delivAt = at('DELIV_PER');
  if (Object.values(idx).some((i) => i < 0)) throw new Error('Unexpected end-of-day file format.');
  const out = {};
  for (const line of lines) {
    const v = line.split(',').map((x) => x.trim());
    const sym = v[idx.sym];
    if (!sym || (out[sym] && out[sym].series === 'EQ')) continue;
    const row = { series: v[idx.series], high: Number(v[idx.high]), low: Number(v[idx.low]), close: Number(v[idx.close]), volume: Number(v[idx.vol]) };
    const open = openAt < 0 ? NaN : Number(v[openAt]);
    if (Number.isFinite(open)) row.open = open;
    const delivery = delivAt < 0 || !v[delivAt] || v[delivAt] === '-' ? NaN : Number(v[delivAt]);
    if (Number.isFinite(delivery)) row.delivery = delivery;
    if ([row.high, row.low, row.close, row.volume].every(Number.isFinite)) out[sym] = row;
  }
  return out;
}

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/**
 * Per-symbol stats from daily files ordered oldest -> newest: previous
 * session's high/low/close and delivery %, the closes 1, 5 and 20 sessions
 * before it, average volume over the last HISTORY_DAYS, and average delivery %
 * over the sessions before the last (so "usual" excludes the day being judged).
 */
export function historyStats(days) {
  const latest = days.at(-1);
  if (!latest) return {};
  const closeAgo = (sym, n) => days.at(-1 - n)?.rows[sym]?.close ?? null;
  const stats = {};
  for (const [sym, last] of Object.entries(latest.rows)) {
    const vols = days.slice(-HISTORY_DAYS).map((d) => d.rows[sym]?.volume).filter(Number.isFinite);
    const delivs = days.slice(-HISTORY_DAYS - 1, -1).map((d) => d.rows[sym]?.delivery).filter(Number.isFinite);
    stats[sym] = {
      prevHigh: last.high,
      prevLow: last.low,
      prevClose: last.close,
      avgVolume: vols.length >= Math.min(10, days.length) ? average(vols) : null,
      volumeDays: vols.length,
      prevDelivery: Number.isFinite(last.delivery) ? last.delivery : null,
      avgDelivery: delivs.length >= 5 ? average(delivs) : null,
      close1: closeAgo(sym, 1), // the session before yesterday
      close5: closeAgo(sym, 5),
      close20: closeAgo(sym, 20),
    };
  }
  return stats;
}

const RESULTS = (a) => /financial result/i.test(a.desc ?? '')
  || (/outcome of board meeting/i.test(a.desc ?? '') && /financial results?/i.test(a.attchmntText ?? ''));

/** Results announced at/after `since` (Date): { SYMBOL: [{ at, text }] }. */
export function parseResults(announcements, since, until = null) {
  const out = {};
  for (const a of announcements ?? []) {
    const at = parseNseDate(a.an_dt ?? a.sort_date);
    if (!a.symbol || !at || at < since || (until && at > until) || !RESULTS(a)) continue;
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

/**
 * Compact a parsed end-of-day file for storage:
 * { SYMBOL: [high, low, close, volume, open, delivery %] }.
 * Older files have four or five values (no open / no delivery %).
 */
export const packDay = (rows) => Object.fromEntries(Object.entries(rows).map(([sym, r]) => [sym, [r.high, r.low, r.close, r.volume, r.open ?? null, r.delivery ?? null]]));
export const unpackDay = (packed) => Object.fromEntries(Object.entries(packed).map(([sym, [high, low, close, volume, open, delivery]]) => [sym, { high, low, close, volume, open: open ?? null, delivery: delivery ?? null }]));
/** Saved before delivery % was kept, so worth downloading again. */
const outdated = (packed) => Object.values(packed).some((v) => v.length < 6);

// ---- Market-wide signals ----

const MARKET_FILE = 'nse-market.json';
/** Market signals are re-fetched when older than this. */
export const MARKET_MAX_AGE_MS = 5 * 60 * 1000;
/** GIFT Nifty readings from 06:00 up to the pre-open close (IST) are the morning reading the 09:10 decision uses. */
export const GIFT_MORNING_END = '09:08';
const KEEP_DAYS = 40;

const toNumber = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
};
const istTime = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);

/** GIFT Nifty (NSE IX Nifty futures) from /api/marketStatus, with the Nifty 50's last close. */
export function parseGiftNifty(status) {
  const g = status?.giftnifty;
  const at = parseNseDate(g?.TIMESTMP);
  const last = toNumber(g?.LASTPRICE);
  if (!at || last == null) return null;
  const nifty = (status.marketState ?? []).find((m) => m.index === 'NIFTY 50');
  return { at: at.toISOString(), last, change: toNumber(g.DAYCHANGE), pct: toNumber(g.PERCHANGE), niftyClose: toNumber(nifty?.last) };
}

/** India VIX from /api/allIndices; "closing" when the values are a session's close (15:30 or later). */
export function parseVix(allIndices) {
  const at = parseNseDate(allIndices?.timestamp);
  const v = (allIndices?.data ?? []).find((d) => d.index === 'INDIA VIX');
  const last = toNumber(v?.last);
  if (!at || last == null) return null;
  return { date: indiaDate(at), closing: istTime(at) >= '15:30', last, pct: toNumber(v.percentChange), prevClose: toNumber(v.previousClose) };
}

/** FII/DII net cash-market flows (₹ Cr) from /api/fiidiiTradeReact. */
export function parseFlows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const fii = list.find((r) => /FII|FPI/i.test(r.category ?? ''));
  const dii = list.find((r) => /^DII/i.test(r.category ?? ''));
  const at = parseNseDate((fii ?? dii)?.date);
  if (!at) return null;
  return { date: indiaDate(at), fii: toNumber(fii?.netValue), dii: toNumber(dii?.netValue) };
}

/** Merge one fetch into the stored market history (VIX closes and flows kept by date). */
export function mergeMarket(saved, { gift, vix, flows }, fetchedAt) {
  const next = {
    gift: saved?.gift ?? null,
    // Last reading before each day's open, by date.
    giftMornings: { ...(saved?.giftMornings ?? {}) },
    vix: { ...(saved?.vix ?? {}) },
    flows: { ...(saved?.flows ?? {}) },
    fetchedAt,
  };
  if (gift) {
    next.gift = gift;
    const time = istTime(new Date(gift.at));
    if (time >= '06:00' && time <= GIFT_MORNING_END) next.giftMornings[indiaDate(new Date(gift.at))] = gift;
  }
  if (vix?.closing) next.vix[vix.date] = { last: vix.last, pct: vix.pct, prevClose: vix.prevClose };
  if (flows) next.flows[flows.date] = { fii: flows.fii, dii: flows.dii };
  const trim = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)).slice(-KEEP_DAYS));
  next.giftMornings = trim(next.giftMornings);
  next.vix = trim(next.vix);
  next.flows = trim(next.flows);
  return next;
}

/**
 * The market signals that apply to trading day `today`: the previous
 * session's VIX close and FII/DII flows, and GIFT Nifty before today's open
 * (a later same-day reading only when no morning one was caught).
 */
export function marketSignalsFor(saved, today, calendar) {
  const [prev] = previousTradingDays(today, 1, calendar);
  // A later reading only counts once the session is open (not the early-hours night session).
  const later = saved?.gift && indiaDate(new Date(saved.gift.at)) === today && istTime(new Date(saved.gift.at)) > GIFT_MORNING_END;
  const morning = saved?.giftMornings?.[today];
  const gift = morning ? { ...morning, morning: true } : later ? { ...saved.gift, morning: false } : null;
  return {
    date: today,
    previousSession: prev ?? null,
    gift,
    vix: prev && saved?.vix?.[prev] ? { date: prev, ...saved.vix[prev] } : null,
    flows: prev && saved?.flows?.[prev] ? { date: prev, ...saved.flows[prev] } : null,
  };
}

/** NSE usually publishes the day's end-of-day file by early evening (IST). */
export const BHAV_READY_TIME = '18:30';

// ---- F&O open interest (stock futures, from NSE's F&O end-of-day file) ----

const FO_URL = (iso) => `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${iso.replace(/-/g, '')}_F_0000.csv.zip`;

/**
 * Stock futures from the F&O end-of-day CSV (UDiFF format): per symbol, open
 * interest and its change summed over all expiries (so expiry roll-overs
 * cancel out), and the near-month future's close and previous close.
 */
export function parseFoBhav(text) {
  const [header, ...lines] = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const keys = header.split(',').map((k) => k.trim());
  const at = (name) => keys.indexOf(name);
  const idx = {
    type: at('FinInstrmTp'), sym: at('TckrSymb'), expiry: at('XpryDt'), close: at('ClsPric'),
    prev: at('PrvsClsgPric'), oi: at('OpnIntrst'), change: at('ChngInOpnIntrst'),
  };
  if (Object.values(idx).some((i) => i < 0)) throw new Error('Unexpected F&O end-of-day file format.');
  const out = {};
  for (const line of lines) {
    const v = line.split(',');
    if (v[idx.type] !== 'STF') continue;
    const sym = v[idx.sym]?.trim();
    const oi = Number(v[idx.oi]);
    const change = Number(v[idx.change]);
    if (!sym || !Number.isFinite(oi) || !Number.isFinite(change)) continue;
    const row = out[sym] ??= { oi: 0, oiChange: 0, close: null, prevClose: null, expiry: null };
    row.oi += oi;
    row.oiChange += change;
    const expiry = v[idx.expiry];
    if (!row.expiry || expiry < row.expiry) {
      row.expiry = expiry;
      row.close = Number(v[idx.close]) || null;
      row.prevClose = Number(v[idx.prev]) || null;
    }
  }
  for (const row of Object.values(out)) delete row.expiry;
  return out;
}

/** Compact F&O rows for storage: { SYMBOL: [oi, oiChange, close, prevClose] }. */
const packFo = (rows) => Object.fromEntries(Object.entries(rows).map(([s, r]) => [s, [r.oi, r.oiChange, r.close, r.prevClose]]));
const unpackFo = (packed) => Object.fromEntries(Object.entries(packed).map(([s, [oi, oiChange, close, prevClose]]) => [s, { oi, oiChange, close, prevClose }]));

/** Per-symbol F&O stats for the stats table: OI change % and the future's price change %. */
export function foStats(rows) {
  const out = {};
  for (const [sym, r] of Object.entries(rows ?? {})) {
    const before = r.oi - r.oiChange;
    out[sym] = {
      foOi: r.oi,
      foOiChangePct: before > 0 ? (r.oiChange / before) * 100 : null,
      foPricePct: r.close && r.prevClose ? ((r.close - r.prevClose) / r.prevClose) * 100 : null,
    };
  }
  return out;
}

/** Add the previous session's F&O stats to the per-symbol history stats. */
function withFo(stats, fo) {
  if (!fo) return stats;
  const merged = { ...stats };
  for (const [sym, f] of Object.entries(foStats(fo))) merged[sym] = { ...(merged[sym] ?? {}), ...f };
  return merged;
}

/** After a failed market-signal fetch, wait this long before trying again. */
export const MARKET_RETRY_MS = 60 * 1000;

/**
 * `store` is a JSON key/value store ({ read(name), write(name, value) }): files on
 * the backend, app storage on Android. `calendar` is the parsed holidays.json.
 *
 * Everything is computed for a trading `date` (default: today), the morning
 * the pre-open belongs to: "yesterday" is the session before that date, never
 * a later one. Viewing Friday's pre-open on Saturday must not use Friday's close.
 */
export function createMarketContextService({ store, fetchImpl = fetch, now = () => new Date(), calendar }) {
  let events;
  const pastEvents = new Map(); // date -> events, for dates before today (not stored)
  const unavailable = new Set(); // files that returned 404 this session
  const upgraded = new Set(); // older files already re-downloaded this session
  const foUnavailable = new Set(); // F&O files that returned 404 this session
  let market;
  let marketAttempt = 0; // last market-signal fetch (ms), successful or not
  const histories = new Map(); // date -> history (a few recent dates)
  const running = new Map(); // date -> in-flight get()

  async function fetchText(url) {
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(25_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`NSE request failed (HTTP ${response.status}).`);
    return response.text();
  }
  /** Bytes of a file (zip), or null on 404. `binary` tells the Android fetch to keep the bytes. */
  async function fetchBytes(url) {
    const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(40_000), binary: true });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`NSE request failed (HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The F&O end-of-day file for `iso` (stock futures OI), cached like the equity files. */
  async function foDay(iso, { cachedOnly = false } = {}) {
    const name = `fo/${iso}.json`;
    let packed = await store.read(name);
    if (!packed && !cachedOnly && !foUnavailable.has(iso)) {
      const bytes = await fetchBytes(FO_URL(iso));
      if (!bytes) {
        if (iso !== indiaDate(now())) foUnavailable.add(iso);
      } else {
        const files = unzipSync(bytes);
        const csv = Object.entries(files).find(([n]) => n.toLowerCase().endsWith('.csv'));
        if (!csv) throw new Error('F&O end-of-day file had no CSV inside.');
        packed = packFo(parseFoBhav(strFromU8(csv[1])));
        await store.write(name, packed);
      }
    }
    return packed ? unpackFo(packed) : null;
  }
  const fetchJson = async (path) => {
    const text = await fetchText(`${API}/${path}`);
    const parsed = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : parsed?.data ?? [];
  };

  /**
   * One day's end-of-day file ({ SYMBOL: { high, low, close, volume, open } }),
   * from the store or NSE; null when NSE doesn't have it (yet). With
   * `cachedOnly`, never contacts NSE. Throws on network errors.
   */
  async function day(iso, { cachedOnly = false } = {}) {
    const name = `bhav/${iso}.json`;
    let packed = await store.read(name);
    if ((!packed || (outdated(packed) && !upgraded.has(iso))) && !cachedOnly && !unavailable.has(iso)) {
      if (packed) upgraded.add(iso); // re-download an older file once, for delivery %
      try {
        const text = await fetchText(BHAV_URL(isoToCompact(iso)));
        if (!text) {
          // Today's file may simply not be published yet: only remember older misses.
          if (iso !== indiaDate(now())) unavailable.add(iso);
        } else {
          packed = packDay(parseBhavcopy(text));
          await store.write(name, packed);
        }
      } catch (error) {
        if (!packed) throw error; // the older copy is still usable
      }
    }
    return packed ? unpackDay(packed) : null;
  }

  /** Yesterday's range and average volume as of the morning of `iso`, from stored files only. */
  async function statsBefore(iso) {
    const days = [];
    for (const d of previousTradingDays(iso, HISTORY_DAYS + 1, calendar).reverse()) {
      const rows = await day(d, { cachedOnly: true });
      if (rows) days.push({ date: d, rows });
    }
    const [prev] = previousTradingDays(iso, 1, calendar);
    return withFo(historyStats(days), prev ? await foDay(prev, { cachedOnly: true }) : null);
  }

  /** Yesterday's range, volume, delivery and trend as of the morning of `date` (default today). */
  async function refreshHistory(date = indiaDate(now())) {
    const wanted = previousTradingDays(date, HISTORY_DAYS + 1, calendar).reverse();
    const errors = [];
    const days = [];
    for (const iso of wanted) {
      try {
        const rows = await day(iso);
        if (rows) days.push({ date: iso, rows });
      } catch (error) { errors.push(`${iso}: ${error.message}`); }
    }
    // The previous session's F&O open interest (F&O stocks only).
    let fo = null;
    const prev = wanted.at(-1);
    if (prev) {
      try { fo = await foDay(prev); } catch (error) { errors.push(`F&O ${prev}: ${error.message}`); }
    }
    const history = {
      asOf: days.at(-1)?.date ?? null,
      days: days.length,
      foAsOf: fo ? prev : null,
      stats: withFo(historyStats(days), fo),
      error: errors.length ? `Some end-of-day files could not be downloaded (${errors.length}).` : null,
    };
    histories.set(date, history);
    while (histories.size > 3) histories.delete(histories.keys().next().value);
    return history;
  }

  /**
   * Corporate events for the morning of `date` (default today): results since
   * the previous session's close, results due and ex-dates that day. For a past
   * date, announcements after that morning's open are left out.
   */
  async function refreshEvents(date = indiaDate(now())) {
    const today = indiaDate(now());
    const [lastSession] = previousTradingDays(date, 1, calendar);
    const since = lastSession ? new Date(`${lastSession}T15:30:00+05:30`) : new Date(`${date}T00:00:00+05:30`);
    const until = date < today ? new Date(`${date}T09:15:00+05:30`) : null;
    const from = isoToNse(lastSession ?? date);
    const [announcements, actions, meetings] = await Promise.all([
      fetchJson(`corporate-announcements?index=equities&from_date=${from}&to_date=${isoToNse(date)}`),
      fetchJson(`corporates-corporateActions?index=equities&from_date=${isoToNse(date)}&to_date=${isoToNse(date)}`),
      fetchJson(`event-calendar?index=equities&from_date=${isoToNse(date)}&to_date=${isoToNse(date)}`),
    ]);
    const result = {
      date,
      fetchedAt: now().toISOString(),
      resultsSince: since.toISOString(),
      results: parseResults(announcements, since, until),
      resultsDue: parseResultsDue(meetings, date),
      exDates: parseExDates(actions, date),
    };
    if (date === today) {
      events = result;
      await store.write('nse-events.json', events);
    } else {
      pastEvents.set(date, result);
      while (pastEvents.size > 3) pastEvents.delete(pastEvents.keys().next().value);
    }
    return result;
  }

  async function fetchJsonRaw(path) {
    const text = await fetchText(`${API}/${path}`);
    return text ? JSON.parse(text) : null;
  }

  /** GIFT Nifty, India VIX and FII/DII; each source can fail on its own. */
  async function refreshMarket() {
    if (market === undefined) market = await store.read(MARKET_FILE);
    marketAttempt = +now();
    const [status, indices, flows] = await Promise.allSettled([
      fetchJsonRaw('marketStatus'), fetchJsonRaw('allIndices'), fetchJsonRaw('fiidiiTradeReact'),
    ]);
    const failed = [['GIFT Nifty', status], ['India VIX', indices], ['FII/DII', flows]]
      .filter(([, r]) => r.status === 'rejected').map(([name]) => name);
    // Only a complete fetch counts as fresh, so a failed source is retried soon.
    market = mergeMarket(market, {
      gift: status.status === 'fulfilled' ? parseGiftNifty(status.value) : null,
      vix: indices.status === 'fulfilled' ? parseVix(indices.value) : null,
      flows: flows.status === 'fulfilled' ? parseFlows(flows.value) : null,
    }, failed.length ? market?.fetchedAt ?? null : now().toISOString());
    await store.write(MARKET_FILE, market);
    if (failed.length) throw new Error(`${failed.join(', ')} unavailable.`);
    return market;
  }

  /**
   * Context for the pre-open of trading day `date` (YYYY-MM-DD; default today,
   * and never later than today).
   */
  async function get({ force = false, forceMarket = false, date = null } = {}) {
    const today = indiaDate(now());
    const target = date && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today ? date : today;
    if (events === undefined) events = await store.read('nse-events.json');
    if (market === undefined) market = await store.read(MARKET_FILE);
    if (running.has(target)) return running.get(target);
    const job = (async () => {
      const errors = [];
      let history = histories.get(target);
      if (force || !history || history.asOf !== previousTradingDays(target, 1, calendar)[0]) {
        try { history = await refreshHistory(target); } catch (error) { errors.push(`History: ${error.message}`); }
      }
      let dayEvents = target === today ? events : pastEvents.get(target) ?? (events?.date === target ? events : null);
      const stale = !dayEvents || dayEvents.date !== target
        || (target === today && now() - new Date(dayEvents.fetchedAt) > EVENTS_MAX_AGE_MS);
      if (force || stale) {
        try { dayEvents = await refreshEvents(target); } catch (error) { errors.push(`Corporate events: ${error.message}`); }
      }
      const fresh = market?.fetchedAt && now() - new Date(market.fetchedAt) <= MARKET_MAX_AGE_MS;
      if (force || forceMarket || (!fresh && now() - marketAttempt > MARKET_RETRY_MS)) {
        try { await refreshMarket(); } catch (error) { errors.push(`Market signals: ${error.message}`); }
      }
      if (history?.error) errors.push(history.error);
      return {
        date: target,
        history: history ?? null,
        events: dayEvents?.date === target ? dayEvents : null,
        market: marketSignalsFor(market, target, calendar),
        error: errors.length ? errors.join(' ') : null,
      };
    })().finally(() => running.delete(target));
    running.set(target, job);
    return job;
  }

  return { get, refreshHistory, refreshEvents, refreshMarket, day, foDay, statsBefore };
}
