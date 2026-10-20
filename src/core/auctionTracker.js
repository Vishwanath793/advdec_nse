import { indiaDate, istInstant, marketDay } from './calendar.js';
import { QUOTE_MAX, QUOTE_SPACING_MS, redactSecrets } from './kite.js';
import { auctionFeatures } from '../utils/auctionLayer.js';

/**
 * Pre-open auction recorder (read-only market data; see utils/auctionLayer.js).
 * On trading days it reads Kite's /quote for the master-list stocks, their
 * near-month futures and the Nifty / Bank Nifty futures every SWEEP_EVERY_MS
 * from AUCTION_START until AUCTION_END, and saves every reading. The last
 * reading is after order entry closes, so it holds the equilibrium result.
 *
 * About 1,000 instruments are two /quote requests (500 each) spaced over a
 * second, inside Kite's limit of one quote request a second. It stops before
 * the 09:10 NSE import, after which the opening collector uses /quote.
 *
 * Needs a Kite session with the market-data subscription. Without one the day
 * shows "needs-kite" and it keeps trying until AUCTION_END (logging in at 09:03
 * still records the rest of the auction).
 *
 * Store file: auction/YYYY-MM-DD.json (format in utils/auctionLayer.js).
 */

export const AUCTION_START = '09:00';
export const FIRST_SWEEP_DELAY_MS = 5_000;
export const AUCTION_END_MS = 9 * 60_000 + 45_000; // last sweep starts by 09:09:45
export const SWEEP_EVERY_MS = 15_000;
export const AUCTION_VERSION = 1;
const INDEX_FUTURES = ['NIFTY', 'BANKNIFTY'];
export const auctionFile = (date) => `auction/${date}.json`;

export function createAuctionTracker({
  store, kite, instruments, calendar, symbols = () => [],
  now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let session = null;
  let day = null; // { date, phase, message, saved, errors, lastError }
  let timer = null;
  let sweeping = null;
  const featureCache = new Map(); // date -> features of a finished day

  const safe = (text) => redactSecrets(text, session?.accessToken, session?.apiKey);
  const start = (date) => +istInstant(date, AUCTION_START);
  const end = (date) => start(date) + AUCTION_END_MS;

  function status() {
    return {
      date: day?.date ?? indiaDate(now()),
      phase: day?.phase ?? 'idle',
      message: day?.message ?? null,
      session: Boolean(session?.accessToken),
      instruments: day?.saved?.keys?.length ?? 0,
      readings: day?.saved?.snaps?.length ?? 0,
      lastAt: day?.saved?.snaps?.at(-1)?.t ?? null,
      errors: day?.errors ?? 0,
      lastError: day?.lastError ?? null,
    };
  }

  const setPhase = (phase, message = null) => { day.phase = phase; day.message = message ? safe(message) : null; };
  const arm = (at) => {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; sweep().catch(() => {}); }, Math.max(0, at - +now()));
  };

  /** Today's instruments: the master-list stocks, their near-month futures and the index futures. */
  async function universe(date) {
    const ix = await instruments.load(session);
    const keys = [];
    const futures = {};
    for (const symbol of [...new Set(symbols().map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean))]) {
      if (!ix.equity(symbol)) continue;
      keys.push(`NSE:${symbol}`);
      const f = ix.future(symbol);
      if (f) futures[symbol] = `NFO:${f.tradingsymbol}`;
    }
    for (const name of INDEX_FUTURES) {
      const f = ix.future(name);
      if (f) futures[name] = `NFO:${f.tradingsymbol}`;
    }
    keys.push(...Object.values(futures));
    return { version: AUCTION_VERSION, date, keys, meta: keys.map(() => null), futures, snaps: [] };
  }

  async function quoteAll(keys) {
    const out = {};
    for (let i = 0; i < keys.length; i += QUOTE_MAX) {
      if (i) await wait(QUOTE_SPACING_MS);
      Object.assign(out, await kite.quote({ ...session, instruments: keys.slice(i, i + QUOTE_MAX) }));
    }
    return out;
  }

  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

  async function sweepOnce() {
    const { date } = day;
    if (!session?.accessToken) {
      setPhase('needs-kite', 'Log in to Kite before 09:00 to record the pre-open auction.');
      return;
    }
    if (!day.saved) day.saved = (await store.read(auctionFile(date))) ?? await universe(date);
    const saved = day.saved;
    if (!saved.keys.length) { setPhase('error', 'No master-list stock was found in Kite\'s instruments.'); return; }
    setPhase('recording');
    const t = +now();
    const quotes = await quoteAll(saved.keys);
    const q = [];
    saved.keys.forEach((key, i) => {
      const x = quotes[key];
      if (!x) return;
      saved.meta[i] = [num(x.ohlc?.close), num(x.lower_circuit_limit), num(x.upper_circuit_limit)];
      q.push([i, num(x.ohlc?.open), num(x.volume), num(x.buy_quantity), num(x.sell_quantity), num(x.total_imbalance_qty)]);
    });
    saved.snaps.push({ t, q });
    await store.write(auctionFile(date), saved);
  }

  async function sweep() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      try {
        await sweepOnce();
      } catch (error) {
        day.errors = (day.errors ?? 0) + 1;
        day.lastError = safe(error.message);
        // 403: the session expired, or the Kite app has no market-data subscription. Keep trying.
        if (error.status === 403) setPhase('needs-kite', `Kite refused the quote request: ${error.message}`);
      } finally {
        sweeping = null;
        const next = +now() + SWEEP_EVERY_MS;
        if (next <= end(day.date)) arm(next);
        else finish();
      }
    })();
    return sweeping;
  }

  function finish() {
    if (!day) return;
    if (day.saved?.snaps?.length) setPhase('done', `Recorded ${day.saved.snaps.length} readings of ${day.saved.keys.length} instruments.`);
    else if (day.phase !== 'needs-kite') setPhase('missed', 'No auction readings were recorded today.');
    else setPhase('missed', `No auction readings: ${day.message ?? 'no Kite session'}`);
  }

  /** Arm today's run (call before 09:00, on start-up and when a Kite session arrives). */
  async function wake() {
    const date = indiaDate(now());
    if (day?.date !== date) {
      if (timer) clearTimer(timer);
      timer = null;
      day = { date, phase: 'idle', message: null, saved: null, errors: 0, lastError: null };
    }
    const md = marketDay(date, calendar);
    if (!md.open) { setPhase('closed', md.reason); return status(); }
    const t = +now();
    if (t > end(date)) {
      if (!day.saved) day.saved = await store.read(auctionFile(date));
      if (day.phase !== 'done' && day.phase !== 'missed') finish();
      return status();
    }
    if (!timer && !sweeping) {
      arm(Math.max(t, start(date) + FIRST_SWEEP_DELAY_MS));
      if (t < start(date)) setPhase(session?.accessToken ? 'waiting' : 'needs-kite', session?.accessToken ? null : 'Log in to Kite before 09:00 to record the pre-open auction.');
    }
    return status();
  }

  /** Features for `date` (null when nothing was recorded). Finished days are cached. */
  async function features(date) {
    if (featureCache.has(date)) return featureCache.get(date);
    const live = day?.date === date && day.saved ? day.saved : await store.read(auctionFile(date));
    const f = auctionFeatures(live);
    if (f && +now() > end(date)) featureCache.set(date, f);
    return f;
  }

  return {
    status,
    wake,
    features,
    setSession(s) {
      session = s?.accessToken && s?.apiKey ? { apiKey: s.apiKey, accessToken: s.accessToken } : null;
      if (day?.phase === 'needs-kite' && session) setPhase('waiting');
      wake().catch(() => {});
    },
    close() { if (timer) clearTimer(timer); timer = null; },
  };
}
