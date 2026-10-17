import { indiaDate, istInstant, marketDay } from './calendar.js';
import { BHAV_READY_TIME, parseNseDate } from './marketContext.js';
import { buildReportCard, dayTrades } from '../utils/reportCard.js';

/**
 * Daily recorder. NSE only serves today's pre-open, so each trading day's
 * snapshot is archived together with what was known that morning (master
 * list, price bands and surveillance, corporate events). Later, the day's
 * end-of-day file supplies the outcome, and the report card replays every
 * recorded day with any conviction settings.
 *
 * Store layout ({ read(name), write(name, value) }):
 *   recorded/index.json            { days: [{ date, marketUpdatedAt, stocks }] }
 *   recorded/YYYY-MM-DD.json       one day's snapshot (columnar) + morning inputs
 *   recorded/master-<id>.json      master lists, stored once per distinct list
 * Yesterday's ranges and average volumes come from the end-of-day files the
 * market-context service already keeps (bhav/YYYY-MM-DD.json).
 */

export const RECORD_VERSION = 1;
const INDEX = 'recorded/index.json';
const dayFile = (date) => `recorded/${date}.json`;
const masterFile = (id) => `recorded/master-${id}.json`;
const confirmFile = (date) => `recorded/confirm-${date}.json`;

/** FNV-1a hash of a string, as hex (identifies a master list's contents). */
export function contentId(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${text.length.toString(36)}`;
}

/** Rows as { columns, values } (about a third of the size of an array of objects). */
export function toColumns(rows) {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { columns, values: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}
export const fromColumns = ({ columns, values }) => values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));

/**
 * The trading date a snapshot belongs to, from NSE's own update time
 * ("15-Oct-2026 09:09:34"), or null when it isn't a trading day. Before the
 * 9:00 session NSE still shows the previous day, so the fetch time can't be used.
 */
export function snapshotDate(snapshot, calendar) {
  const at = parseNseDate(snapshot?.marketUpdatedAt);
  if (!at) return null;
  const date = indiaDate(at);
  return marketDay(date, calendar).open ? date : null;
}

/** Only what the analysis needs from the security list, for the snapshot's symbols. */
function compactSecList(secList, symbols) {
  if (!secList?.bands) return null;
  const bands = {};
  const info = {};
  for (const sym of symbols) {
    if (secList.bands[sym] != null) bands[sym] = secList.bands[sym];
    const i = secList.info?.[sym];
    if (i?.remarks || i?.series) info[sym] = { series: i.series ?? null, remarks: i.remarks ?? null };
  }
  return { bands, info };
}

/**
 * `context` is the market-context service (day(iso), statsBefore(iso)).
 * `inputs()` returns the morning's { masterRows, secList, events, market }; any of them
 * may be null (the day is still recorded).
 */
export function createRecorder({ store, calendar, context, inputs, now = () => new Date() }) {
  const cache = new Map(); // date -> { marketUpdatedAt, rows, masterRows, secList, events }
  const masters = new Map();
  const outcomes = new Map(); // date -> end-of-day rows (only once available)
  let writing = Promise.resolve();

  const readIndex = async () => (await store.read(INDEX)) ?? { days: [] };

  async function record(snapshot) {
    const date = snapshotDate(snapshot, calendar);
    if (!date || !Array.isArray(snapshot?.rows) || !snapshot.rows.length) return { recorded: false, date, reason: 'Not a trading-day snapshot.' };
    // One write at a time, so two quick fetches can't interleave index updates.
    const run = writing.then(async () => {
      const index = await readIndex();
      const existing = index.days.find((d) => d.date === date);
      const at = parseNseDate(snapshot.marketUpdatedAt);
      if (existing && parseNseDate(existing.marketUpdatedAt) >= at) return { recorded: false, date, reason: 'Already recorded.' };

      const { masterRows = null, secList = null, events = null, market = null } = (await inputs().catch(() => null)) ?? {};
      let masterId = null;
      if (Array.isArray(masterRows) && masterRows.length) {
        const text = JSON.stringify(masterRows);
        masterId = contentId(text);
        if (!(await store.read(masterFile(masterId)))) await store.write(masterFile(masterId), masterRows);
      }
      await store.write(dayFile(date), {
        version: RECORD_VERSION,
        date,
        marketUpdatedAt: snapshot.marketUpdatedAt,
        fetchedAt: snapshot.fetchedAt ?? null,
        recordedAt: now().toISOString(),
        snapshot: toColumns(snapshot.rows),
        masterId,
        secList: compactSecList(secList, snapshot.rows.map((r) => r.SYMBOL)),
        events: events?.date === date ? events : null,
        market: market?.date === date ? market : null, // GIFT Nifty, VIX and FII/DII as seen that morning
      });
      const entry = { date, marketUpdatedAt: snapshot.marketUpdatedAt, stocks: snapshot.rows.length };
      index.days = [...index.days.filter((d) => d.date !== date), entry].sort((a, b) => a.date.localeCompare(b.date));
      await store.write(INDEX, index);
      cache.delete(date);
      return { recorded: true, date };
    });
    writing = run.catch(() => {});
    return run;
  }

  async function loadDay(date) {
    if (cache.has(date)) return cache.get(date);
    const saved = await store.read(dayFile(date));
    if (!saved) return null;
    let masterRows = null;
    if (saved.masterId) {
      if (!masters.has(saved.masterId)) masters.set(saved.masterId, await store.read(masterFile(saved.masterId)));
      masterRows = masters.get(saved.masterId);
    }
    const day = { ...saved, rows: fromColumns(saved.snapshot), masterRows };
    cache.set(date, day);
    return day;
  }

  /** Outcome for a recorded day: { rows } | { pending: reason }. */
  async function outcome(date) {
    if (outcomes.has(date)) return { rows: outcomes.get(date) };
    if (now() < istInstant(date, BHAV_READY_TIME)) {
      const cached = await context.day(date, { cachedOnly: true });
      if (!cached) return { pending: `Results after ${BHAV_READY_TIME} IST.` };
      outcomes.set(date, cached);
      return { rows: cached };
    }
    try {
      const rows = await context.day(date);
      if (!rows) return { pending: 'NSE has not published the end-of-day file yet.' };
      outcomes.set(date, rows);
      return { rows };
    } catch (error) {
      return { pending: `Could not download the end-of-day file (${error.message}).` };
    }
  }

  /**
   * Keep the 9:20 confirmation reading for `reading.date` (see utils/confirmation.js).
   * The first on-time reading of the day is kept; a late one only fills a gap.
   */
  async function saveConfirmation(reading) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reading?.date ?? '') || !reading.readings || typeof reading.readings !== 'object') {
      throw new Error('A confirmation reading needs a date and readings.');
    }
    const existing = await store.read(confirmFile(reading.date));
    if (existing && (!existing.late || reading.late)) return { saved: false, reason: 'Already saved for this day.' };
    await store.write(confirmFile(reading.date), {
      date: reading.date, at: reading.at ?? now().toISOString(), late: Boolean(reading.late), readings: reading.readings,
      market: reading.market ?? null,
    });
    return { saved: true };
  }
  const confirmation = (date) => store.read(confirmFile(date));

  async function status() {
    const { days } = await readIndex();
    return { days: days.length, first: days[0]?.date ?? null, latest: days.at(-1)?.date ?? null };
  }

  /** Report card for every recorded day, scored with `factorSettings`. */
  async function report(factorSettings = null) {
    const { days } = await readIndex();
    const scored = [];
    const pending = [];
    const skipped = [];
    for (const { date } of days) {
      const day = await loadDay(date);
      if (!day?.masterRows) { skipped.push({ date, reason: 'No master list was recorded.' }); continue; }
      const result = await outcome(date);
      if (result.pending) { pending.push({ date, reason: result.pending }); continue; }
      const stats = await context.statsBefore(date);
      scored.push({
        date,
        trades: dayTrades({
          date,
          rows: day.rows,
          masterRows: day.masterRows,
          secList: day.secList,
          context: { history: { stats }, events: day.events, market: day.market ?? null },
          outcome: result.rows,
          factorSettings,
          // On-time 9:20 readings only: a late one has a wider range than 9:15–9:20.
          confirm: (await confirmation(date).then((c) => (c && !c.late ? c.readings : null))) ?? null,
        }),
      });
    }
    return { recorded: days.length, first: days[0]?.date ?? null, latest: days.at(-1)?.date ?? null, pending, skipped, ...buildReportCard(scored) };
  }

  return { record, status, report, saveConfirmation, confirmation };
}
