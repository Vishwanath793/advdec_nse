import { fetchPreopenSnapshot, validateSchedule } from '../core/preopen.js';
import { indiaDate, istInstant, marketDay, upcomingTradingRuns } from '../core/calendar.js';

/** After a failed scheduled fetch, wait this long before trying again. */
export const RETRY_MS = 5 * 60 * 1000;
/** How many upcoming trading days get a 9:10 reminder notification. */
export const NOTIFY_DAYS = 14;

/**
 * The Android app's version of the backend's daily NSE pre-open job.
 *
 * A phone can't run a cron job reliably, so instead:
 *  - a local notification fires at the scheduled time on each trading day;
 *  - `tick()` (app start, resume, and every few seconds while open) fetches
 *    once the scheduled time has passed and today's data isn't loaded yet.
 * Same state shape and status() as the backend, so the UI is unchanged.
 */
export function createPhonePreopen({ store, fetchImpl, calendar, now = () => new Date(), notifier = null }) {
  let state = { config: { enabled: true, time: '09:10' }, snapshot: null, lastAttempt: null, lastError: null };
  let loaded = null;
  let running = null;
  const listeners = new Set();

  const load = () => (loaded ??= store.read('nse-preopen.json').then((saved) => {
    if (saved) state = { ...state, ...saved, config: validateSchedule(saved.config) };
  }).catch(() => {}));

  async function persist(next) {
    state = next;
    await store.write('nse-preopen.json', state);
  }

  function status() {
    const [next] = state.config.enabled ? upcomingTradingRuns(now(), state.config.time, calendar, 1) : [];
    return { ...state, timezone: 'Asia/Kolkata', running: !!running, nextRun: next?.toISOString() ?? null };
  }

  function publish(includeSnapshot = false) {
    const update = status();
    if (!includeSnapshot) delete update.snapshot;
    for (const listener of listeners) {
      try { listener(update); } catch { listeners.delete(listener); }
    }
  }

  function refresh() {
    if (running) return running;
    const previousSnapshot = state.snapshot;
    running = (async () => {
      try {
        await persist({ ...state, lastAttempt: now().toISOString(), lastError: null });
        const snapshot = await fetchPreopenSnapshot(fetchImpl, now);
        await persist({ ...state, snapshot, lastError: null });
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'NSE request timed out. Please try again.' : error.message;
        await persist({ ...state, lastError: message });
        throw new Error(message);
      }
    })().finally(() => {
      running = null;
      publish(state.snapshot !== previousSnapshot);
    });
    publish();
    return running;
  }

  /** True when today's scheduled fetch is due and hasn't succeeded yet. */
  function due() {
    if (!state.config.enabled || running) return false;
    const t = now();
    const today = indiaDate(t);
    if (!marketDay(today, calendar).open) return false;
    const scheduled = istInstant(today, state.config.time);
    if (t < scheduled) return false;
    if (state.snapshot && new Date(state.snapshot.fetchedAt) >= scheduled) return false;
    const last = state.lastAttempt ? new Date(state.lastAttempt) : null;
    return !(last && last >= scheduled && t - last < RETRY_MS);
  }

  async function reschedule() {
    if (!notifier) return;
    const runs = state.config.enabled ? upcomingTradingRuns(now(), state.config.time, calendar, NOTIFY_DAYS) : [];
    await notifier.schedule(runs);
  }

  return {
    async status() { await load(); return status(); },
    async subscribe(listener) {
      await load();
      listener(status());
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() { await load(); await refresh(); return status(); },
    async update(config) {
      await load();
      await persist({ ...state, config: validateSchedule(config) });
      await reschedule();
      publish();
      return status();
    },
    async tick() {
      await load();
      if (due()) await refresh().catch(() => {}); // the error is kept in state.lastError
    },
    async reschedule() { await load(); await reschedule(); },
  };
}
