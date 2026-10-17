import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { indiaDate, istInstant, marketDay } from '../src/core/calendar.js';
import { snapshotDate } from '../src/core/recorder.js';
import { analyze } from '../src/utils/analysis.js';
import { exportFileName, stocksWorkbook } from '../src/utils/exportStocks.js';

/** Saved at this time (IST) on trading days; a late start catches up until CLOSE_TIME. */
export const EXPORT_TIME = '09:30';
export const CLOSE_TIME = '15:30';
export const DEFAULT_EXPORT_DIR = process.env.EXPORT_DIR || join(homedir(), 'Downloads');

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
};

/**
 * Saves the Stocks table (all stocks, with the conviction breakdown) as an
 * Excel file once per trading day at 9:30 IST, scored with the conviction
 * factors last chosen in the browser. Runs without the browser open.
 *
 * `inputs()` returns { snapshot, masterRows, secList, context }.
 */
export function createAutoExport({ dataDir, exportDir = DEFAULT_EXPORT_DIR, calendar, inputs, now = () => new Date() }) {
  const settingsFile = join(dataDir, 'export-settings.json');
  const lastFile = join(dataDir, 'export-last.json');
  let running = null;

  function status() {
    return { dir: exportDir, time: EXPORT_TIME, last: readJson(lastFile), settingsSavedAt: readJson(settingsFile)?.savedAt ?? null };
  }

  function saveSettings(factorSettings) {
    if (factorSettings != null && typeof factorSettings !== 'object') throw new Error('factorSettings must be an object.');
    writeJson(settingsFile, { factorSettings: factorSettings ?? null, savedAt: now().toISOString() });
    return status();
  }

  /** Why today's file isn't due yet (or is done), or null when it should be written now. */
  function notDue(t = now()) {
    const today = indiaDate(t);
    if (!marketDay(today, calendar).open) return 'Not a trading day.';
    if (t < istInstant(today, EXPORT_TIME)) return `Waiting for ${EXPORT_TIME} IST.`;
    if (t > istInstant(today, CLOSE_TIME)) return 'Market closed for the day.';
    if (readJson(lastFile)?.date === today) return 'Already saved today.';
    return null;
  }

  /** Write today's file if due. Returns { saved, file?, reason? }. */
  function run({ force = false } = {}) {
    running ??= (async () => {
      const t = now();
      const reason = force ? null : notDue(t);
      if (reason) return { saved: false, reason };
      const { snapshot, masterRows, secList, context } = await inputs();
      const today = indiaDate(t);
      if (snapshotDate(snapshot, calendar) !== today) return { saved: false, reason: "Today's pre-open data hasn't been fetched." };
      const factorSettings = readJson(settingsFile)?.factorSettings ?? null;
      const { stocks } = analyze(snapshot.rows, masterRows ?? [], secList, { convictionFactors: factorSettings, context });
      const bytes = stocksWorkbook(stocks, factorSettings, {
        exportedAt: t,
        source: `NSE pre-open · ${snapshot.marketUpdatedAt}`,
        filters: 'None (all stocks in the master list); saved automatically',
      });
      mkdirSync(exportDir, { recursive: true });
      const file = join(exportDir, exportFileName(t));
      writeFileSync(file, bytes);
      writeJson(lastFile, { date: today, file, at: t.toISOString(), stocks: stocks.length });
      return { saved: true, file };
    })().finally(() => { running = null; });
    return running;
  }

  return { status, saveSettings, run, notDue };
}
