import cron from 'node-cron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchPreopenSnapshot, NSE_URL, normalizePreopen, validateSchedule } from '../src/core/preopen.js';

// Shared with the Android app.
export { NSE_URL, normalizePreopen, validateSchedule };
export const TIMEZONE = 'Asia/Kolkata';

export function cronExpression(time) {
  const [hour, minute] = time.split(':').map(Number);
  return `${minute} ${hour} * * *`;
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
        const snapshot = await fetchPreopenSnapshot(fetchImpl);
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
