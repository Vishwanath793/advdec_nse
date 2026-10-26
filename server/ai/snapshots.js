import { BHAV_READY_TIME, parseNseDate } from '../../src/core/marketContext.js';
import { istInstant } from '../../src/core/calendar.js';
import { snapshotDate } from '../../src/core/recorder.js';
import { contextFingerprint, inputsFingerprint, snapshotIdFor } from '../../src/utils/aiContext.js';

/**
 * Snapshots the AI Analyst can open (read only):
 *  - 'analyzer': the backend's current NSE pre-open snapshot, with the same
 *    context, master list and price bands the Analyzer page loads;
 *  - 'recorded': a recorded morning, rebuilt from what was saved that morning
 *    (as the report card does).
 * Never downloads an end-of-day file: outcomes come from stored files only.
 */
export function createSnapshotService({ preopen, recorder, marketContext, contextFor, priceBands, masterRows, calendar, store }) {
  const ids = new Map(); // `${date}|${stamp}` -> snapshot id
  const idFor = (date, stamp, rows) => {
    const key = `${date}|${stamp}`;
    if (!ids.has(key)) ids.set(key, snapshotIdFor(date, rows));
    while (ids.size > 40) ids.delete(ids.keys().next().value);
    return ids.get(key);
  };
  const iso = (d) => {
    const t = d ? new Date(d) : null;
    return t && Number.isFinite(+t) ? t.toISOString() : null;
  };
  const latest = (...xs) => xs.filter(Boolean).sort().at(-1) ?? null;

  function live() {
    const snapshot = preopen.status().snapshot;
    const date = snapshotDate(snapshot, calendar);
    if (!date || !snapshot?.rows?.length) return null;
    return { snapshot, date, snapshotId: idFor(date, `live:${snapshot.fetchedAt}`, snapshot.rows) };
  }

  async function recordedList() {
    const out = [];
    for (const d of await recorder.days()) {
      const inputs = await recorder.dayInputs(d.date, { withContext: false });
      if (!inputs) continue;
      out.push({ date: d.date, inputs, snapshotId: idFor(d.date, `rec:${inputs.recordedAt}`, inputs.rows) });
    }
    return out;
  }

  async function list() {
    const items = [];
    const l = live();
    if (l) {
      items.push({
        snapshotId: l.snapshotId, date: l.date, source: 'analyzer', stocks: l.snapshot.rows.length,
        exchangeAt: iso(parseNseDate(l.snapshot.marketUpdatedAt)), fetchedAt: iso(l.snapshot.fetchedAt), recordedAt: null,
      });
    }
    for (const r of await recordedList()) {
      items.push({
        snapshotId: r.snapshotId, date: r.date, source: 'recorded', stocks: r.inputs.rows.length,
        exchangeAt: iso(parseNseDate(r.inputs.marketUpdatedAt)), fetchedAt: iso(r.inputs.fetchedAt), recordedAt: iso(r.inputs.recordedAt),
      });
    }
    return items;
  }

  async function openLive(snapshotId) {
    const l = live();
    if (!l || l.snapshotId !== snapshotId) return null;
    const [context, secList] = await Promise.all([contextFor(l.date).catch(() => null), priceBands.get().catch(() => null)]);
    const master = masterRows();
    const fetchedAt = iso(l.snapshot.fetchedAt);
    return {
      snapshotId, date: l.date, source: 'analyzer', rows: l.snapshot.rows, masterRows: master, secList, context,
      times: {
        exchangeAt: iso(parseNseDate(l.snapshot.marketUpdatedAt)),
        fetchedAt,
        recordedAt: null,
        // The view as a whole was known once its last input arrived.
        availableAt: latest(fetchedAt, iso(context?.events?.fetchedAt), iso(secList?.fetchedAt)),
      },
      contextFp: contextFingerprint(context),
      inputsFp: inputsFingerprint({ masterRows: master, priceBands: secList }),
    };
  }

  function fromInputs(inputs, snapshotId) {
    const recordedAt = iso(inputs.recordedAt);
    return {
      snapshotId, date: inputs.date, source: 'recorded', rows: inputs.rows, masterRows: inputs.masterRows, secList: inputs.secList, context: inputs.context,
      times: { exchangeAt: iso(parseNseDate(inputs.marketUpdatedAt)), fetchedAt: iso(inputs.fetchedAt), recordedAt, availableAt: recordedAt },
      contextFp: contextFingerprint(inputs.context),
      inputsFp: null,
    };
  }

  async function openRecorded(date) {
    const inputs = await recorder.dayInputs(date);
    return inputs ? fromInputs(inputs, idFor(date, `rec:${inputs.recordedAt}`, inputs.rows)) : null;
  }

  async function open({ source, snapshotId }) {
    if (source === 'analyzer') return openLive(snapshotId);
    const date = snapshotId.slice(0, 10);
    const snap = await openRecorded(date);
    return snap?.snapshotId === snapshotId ? snap : null;
  }

  async function outcome(date) {
    const rows = await marketContext.day(date, { cachedOnly: true }).catch(() => null);
    return rows ? { rows, availableAt: istInstant(date, BHAV_READY_TIME).toISOString() } : null;
  }

  async function extras(date) {
    const [auction, opening, paper] = await Promise.all([store.read(`auction/${date}.json`), store.read(`opening/${date}.json`), store.read(`paper/${date}.json`)]);
    return {
      auction: Boolean(auction?.snaps?.length),
      opening: opening?.sealedAt ? { sealedAt: opening.sealedAt, partial: Boolean(opening.partialFrom) } : null,
      paper: paper ? {
        trades: paper.trades ?? 0, wins: paper.wins ?? 0, losses: paper.losses ?? 0, realised: paper.realised ?? 0, charges: paper.charges ?? 0,
        decidedAt: paper.decidedAt ?? null, availableAt: istInstant(date, '15:30').toISOString(),
      } : null,
    };
  }

  return { list, open, openRecorded, outcome, extras };
}
