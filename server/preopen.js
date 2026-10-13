import cron from 'node-cron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const NSE_URL = 'https://www.nseindia.com/api/NextApi/apiClient/cmPreOpenApi?functionName=getPreOpenData&category=ALL&symbol=';
export const TIMEZONE = 'Asia/Kolkata';

export function validateSchedule(config) {
  if (typeof config?.enabled !== 'boolean' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config?.time ?? '')) {
    throw new Error('Provide enabled (true/false) and a valid time in HH:mm format.');
  }
  return { enabled: config.enabled, time: config.time };
}

export function cronExpression(time) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

const number = (value) => {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const crores = (value) => {
  const parsed = number(value);
  return parsed == null ? null : parsed / 10_000_000;
};

export function normalizePreopen(payload) {
  if (!Array.isArray(payload?.data) || !payload.data.length) {
    throw new Error('NSE returned no pre-open data. The previous successful data is retained.');
  }
  const rows = payload.data.filter((item) => typeof item?.symbol === 'string' && item.symbol.trim())
    .map((item) => ({
      SYMBOL: item.symbol.trim().toUpperCase(),
      SERIES: typeof item.series === 'string' ? item.series.trim() : null,
      'PREV. CLOSE': number(item.prevClose),
      'BASE PRICE': number(item.basePrice),
      'FINAL PRICE': number(item.finalPrice),
      CHANGE: number(item.change),
      '%CHANGE': number(item.perChange),
      'VALUE (₹ Crores)': crores(item.finalValue),
      'FFM CAP (₹ Crores)': crores(item.ffmMarketCap),
      // Conviction-score inputs (same column names as pm.csv where it has them).
      'FINAL VOLUME': number(item.finalQuantity),
      'TOTAL BUY QTY': number(item.totalBuyQuantity),
      'TOTAL SELL QTY': number(item.totalSellQuantity),
      '52 WEEK HIGH': number(item.yearHigh),
      '52 WEEK LOW': number(item.yearLow),
    }));
  if (!rows.length || !rows.some((row) => row['FINAL PRICE'] != null)) {
    throw new Error('NSE response did not contain usable stock prices.');
  }
  return { rows, marketUpdatedAt: payload.data.find((item) => item?.lastUpdateTime)?.lastUpdateTime ?? null };
}

export function createPreopenService({ file, fetchImpl = fetch, schedule = cron.schedule }) {
  let state = { config: { enabled: true, time: '09:10' }, snapshot: null, lastAttempt: null, lastError: null };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    state = { ...state, ...saved, config: validateSchedule(saved.config) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot load NSE schedule: ${error.message}`);
  }
  let task;
  let running = null;
  const listeners = new Set();

  function persist(next) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${file}.tmp`, file);
    state = next;
  }

  function status() {
    return { ...state, timezone: TIMEZONE, running: !!running, nextRun: task?.getNextRun()?.toISOString() ?? null };
  }

  function publish(includeSnapshot = false) {
    const update = status();
    if (!includeSnapshot) delete update.snapshot;
    for (const listener of listeners) {
      try { listener(update); }
      catch { listeners.delete(listener); }
    }
  }

  function refresh() {
    if (running) return running;
    const previousSnapshot = state.snapshot;
    running = (async () => {
      try {
        persist({ ...state, lastAttempt: new Date().toISOString(), lastError: null });
        const response = await fetchImpl(NSE_URL, {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.nseindia.com/' },
          signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) throw new Error(`NSE request failed (HTTP ${response.status}).`);
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('json')) throw new Error('NSE returned a non-JSON response. Please try again later.');
        const data = normalizePreopen(await response.json());
        const snapshot = { ...data, fetchedAt: new Date().toISOString() };
        persist({ ...state, snapshot, lastError: null });
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'NSE request timed out. Please try again.' : error.message;
        state = { ...state, lastError: message };
        persist(state);
        throw new Error(message);
      }
    })().finally(() => {
      running = null;
      publish(state.snapshot !== previousSnapshot);
    });
    publish();
    return running;
  }

  function reschedule() {
    task?.destroy();
    task = null;
    if (state.config.enabled) {
      task = schedule(cronExpression(state.config.time), async () => {
        try { await refresh(); }
        catch (error) { console.error(`NSE scheduled fetch: ${error.message}`); }
      }, { timezone: TIMEZONE, noOverlap: true, name: 'nse-preopen' });
    }
  }

  persist(state);
  reschedule();
  return {
    status,
    refresh,
    subscribe(listener) {
      // Send the cached snapshot once on connection, without contacting NSE.
      listener(status());
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(config) {
      persist({ ...state, config: validateSchedule(config) });
      reschedule();
      publish();
      return status();
    },
    close() { task?.destroy(); listeners.clear(); },
  };
}
