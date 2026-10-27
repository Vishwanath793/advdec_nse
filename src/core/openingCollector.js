import { indiaDate, istInstant, marketDay } from './calendar.js';
import { createKiteTicker } from './kiteTicker.js';
import { redactSecrets } from './kite.js';
import { createOpeningWindow } from '../utils/openingWindow.js';
import { indexInstruments } from '../utils/confirmation.js';

/**
 * The opening-window collector. It only reads market data; the 09:20 decision and
 * paper fills happen in the trading desk (`trading`: core/tradingDesk.js), which
 * gets the seal, every later tick, and (after STOP_AT) a connection kept for the
 * stocks with open paper positions (follow/unfollow).
 *
 * Daily timeline (IST, trading days only; unknown calendar years fail closed):
 *   after the 09:10 pre-open import   prepare(): universe, tokens, history, /quote check
 *   09:14:00                          connect the Kite WebSocket (full mode)
 *   09:15:00–09:19:59.999             ticks feed the opening window and the recording
 *   09:20:00 (+ SEAL_GRACE_MS)        seal: features frozen and saved
 *   STOP_AT (09:30)                   disconnect
 * The grace admits ticks stamped before 09:20:00 that are still in flight; ticks
 * stamped 09:20:00 or later never count (see utils/openingWindow.js).
 *
 * Store files: opening/YYYY-MM-DD.json (sealed features), opening/YYYY-MM-DD-universe.json.
 * Ticks are written through `tickLog` (the backend writes NDJSON per day).
 */

export const CONNECT_AT = '09:14';
export const STOP_AT = '09:30';
export const RECORD_UNTIL = '09:25';
export const SEAL_GRACE_MS = 1_500;
export const PUBLISH_EVERY_MS = 1_000;
export const DEFAULT_COLLECTOR_SETTINGS = { minGapPct: 0.5, watchlist: [], includeFutures: true };
const MARKET = ['NIFTY 50', 'NIFTY BANK'];

/** A compact scanner row (the SSE payload; details are fetched on demand). */
export function scannerRow(f, candidate = {}) {
  return {
    symbol: f.symbol, sector: f.sector, direction: f.status === 'decline' ? 'down' : f.status === 'advance' ? 'up' : null,
    convictionScore: candidate.convictionScore ?? null,
    gapPct: f.gapPct ?? null, ret5Pct: f.ret5Pct ?? null, ltp: f.ltp ?? null,
    windowVolume: f.windowVolume ?? null, rvol: f.rvol ?? null,
    rvalue: f.research?.rvalue ?? null, rangeX: f.research?.rangeX ?? null, gapX: f.research?.gapX ?? null, baselineDays: f.research?.baselineDays ?? null,
    vwapDistPct: f.vwapDistPct ?? null, closePos: f.closePos ?? null,
    imbalance5: f.depth?.imbalance5 ?? null, spreadBps: f.depth?.spreadBps ?? null,
    oiChangePct: f.fo?.oiChangePct ?? null, oiBuild: f.fo?.build ?? null, fnoMissing: f.fo?.missing ?? null,
    sectorPct: f.market?.sector?.pct ?? null, sectorIndex: f.market?.sector?.symbol ?? null, relVsNiftyPct: f.market?.relVsNiftyPct ?? null,
    stale: f.quality?.stale ?? true, ticks: f.quality?.ticks ?? 0,
  };
}

export function createOpeningCollector({
  store, kite, instruments, history, calendar, getCandidates, tickLog = null,
  settings = () => DEFAULT_COLLECTOR_SETTINGS, WebSocketImpl = globalThis.WebSocket,
  now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, onUpdate = () => {}, trading = null,
}) {
  let session = null;
  let day = null; // { date, universe, meta, window, candidates, ticker, sealed, phase, message, source, ... }
  let timers = [];
  let lastPublish = 0;
  let publishTimer = null;
  let follower = null; // a ticker kept for open paper positions after STOP_AT (or after a restart)

  const safe = (text) => redactSecrets(text, session?.accessToken, session?.apiKey);
  const status = () => ({
    date: day?.date ?? indiaDate(now()),
    phase: day?.phase ?? 'idle',
    message: day?.message ?? null,
    source: day?.source ?? null,
    session: Boolean(session?.accessToken),
    universe: day?.universe ? { stocks: day.universe.stocks.length, indices: day.universe.indices.length, futures: day.universe.futures.length, missing: day.universe.missing } : null,
    ticker: day?.ticker?.status?.() ?? null,
    prep: day?.prep ?? null,
    sealedAt: day?.sealed?.sealedAt ?? null,
    partialFrom: day?.partialFrom ?? null,
    counters: day?.window?.counters?.() ?? null,
    following: follower ? follower.status?.() ?? true : null,
    tradingError: day?.tradingError ?? null,
  });

  function publish(force = false) {
    if (!day?.window) { onUpdate({ status: status(), rows: [], market: null, breadth: null }); return; }
    const t = +now();
    if (!force && t - lastPublish < PUBLISH_EVERY_MS) {
      if (!publishTimer) publishTimer = setTimer(() => { publishTimer = null; publish(true); }, PUBLISH_EVERY_MS - (t - lastPublish));
      return;
    }
    lastPublish = t;
    const snap = day.sealed ?? day.window.snapshot(day.virtualNow?.() ?? t);
    const byCandidate = new Map(day.candidates.map((c) => [c.symbol, c]));
    try {
      onUpdate({
        status: status(), sealed: Boolean(day.sealed), market: snap.market, indices: snap.indices, breadth: snap.breadth,
        rows: snap.stocks.map((f) => scannerRow(f, byCandidate.get(f.symbol))),
      });
    } catch { /* listener errors don't matter */ }
  }

  const setPhase = (phase, message = null) => { if (day) { day.phase = phase; day.message = message ? safe(message) : null; } publish(true); };
  const clearTimers = () => { timers.forEach(clearTimer); timers = []; };
  const at = (date, time) => +istInstant(date, time);

  /** Build the universe for today from the 09:10 candidates. */
  async function prepare({ force = false } = {}) {
    const date = indiaDate(now());
    const md = marketDay(date, calendar);
    if (!md.open) { day = { date, phase: 'closed', message: md.reason }; publish(true); return status(); }
    if (day?.date === date && day.window && !force) return status();
    if (day?.ticker) day.ticker.close();
    day = { date, phase: 'preparing', candidates: [], source: 'websocket' };
    if (!session?.accessToken) { setPhase('needs-kite', 'Log in to Kite before 09:15: the opening window needs a Kite session.'); return status(); }
    try {
      const { stocks = [], snapshotDate = null } = (await getCandidates(date)) ?? {};
      if (snapshotDate !== date) { setPhase('waiting', 'Today\'s 09:10 pre-open data isn\'t loaded yet.'); return status(); }
      const cfg = { ...DEFAULT_COLLECTOR_SETTINGS, ...settings() };
      const watch = new Set((cfg.watchlist ?? []).map((s) => String(s).toUpperCase()));
      const candidates = stocks.filter((s) => watch.has(s.symbol) || (s.convictionScore != null && Math.abs(s.pctChange ?? 0) >= cfg.minGapPct));
      day.candidates = candidates.map((s) => ({ symbol: s.symbol, convictionScore: s.convictionScore, gapPct: s.pctChange, sector: s.sector }));
      const ix = await instruments.load(session);
      const meta = {};
      const missing = [];
      const universe = { stocks: [], indices: [], futures: [], missing };
      for (const s of candidates) {
        const e = ix.equity(s.symbol);
        if (!e) { missing.push(s.symbol); continue; }
        const sectorIndex = indexInstruments([s])[1]?.replace(/^NSE:/, '') ?? null;
        meta[e.token] = {
          kind: 'stock', symbol: s.symbol, sector: s.sector, sectorIndex, status: s.status,
          prevClose: s.prevClose, preOpenPrice: s.finalPrice, preOpenVolume: s.finalVolume ?? null,
          avgVolume: s.avgVolume ?? null, prevHigh: s.prevHigh ?? null, prevLow: s.prevLow ?? null, avgAbsGap: s.avgAbsGap ?? null,
          upperCircuit: s.upperCircuit ?? null, lowerCircuit: s.lowerCircuit ?? null, tick: e.tick, lot: e.lot, fno: s.band === 'none',
          // 09:10 tradeability flags (T2T, circuit, surveillance, data) and conviction, for the 09:20 decision.
          flags: (s.flags ?? []).map((f) => ({ key: f.key, label: f.label, severity: f.severity, detail: f.detail })), convictionScore: s.convictionScore ?? null,
        };
        universe.stocks.push({ symbol: s.symbol, token: e.token });
        const fut = cfg.includeFutures && s.band === 'none' ? ix.future(s.symbol) : null;
        if (fut) {
          meta[fut.token] = { kind: 'future', symbol: fut.tradingsymbol, underlying: s.symbol, lot: fut.lot, prevOi: null };
          universe.futures.push({ symbol: fut.tradingsymbol, token: fut.token, underlying: s.symbol });
        }
      }
      for (const key of [...MARKET.map((m) => `NSE:${m}`), ...indexInstruments(candidates).slice(1)]) {
        const token = ix.index(key);
        const symbol = key.replace(/^NSE:/, '');
        if (!token) { missing.push(symbol); continue; }
        if (!meta[token]) { meta[token] = { kind: 'index', symbol }; universe.indices.push({ symbol, token }); }
      }

      // Validation snapshot: circuit limits and previous close from Kite's /quote (1 req/s, 500 a request).
      try {
        const quotes = await kite.quote({ ...session, instruments: universe.stocks.map((s) => `NSE:${s.symbol}`) });
        for (const s of universe.stocks) {
          const q = quotes[`NSE:${s.symbol}`];
          const m = meta[s.token];
          if (!q) continue;
          if (q.upper_circuit_limit) { m.upperCircuit = q.upper_circuit_limit; m.lowerCircuit = q.lower_circuit_limit; }
          const kitePrev = q.ohlc?.close;
          if (kitePrev && m.prevClose && Math.abs(kitePrev - m.prevClose) / m.prevClose > 0.0005) {
            m.prevCloseMismatch = { nse: m.prevClose, kite: kitePrev };
            m.prevClose = kitePrev; // Kite's is the reference for its own ticks
          }
        }
      } catch (error) {
        day.validationError = safe(error.message);
        if (error.status === 403) throw error;
      }

      // History: ATR, average opening volume, futures' previous OI (cached per day).
      day.prep = { done: 0, total: universe.stocks.length };
      publish(true);
      const items = universe.stocks.map((s) => ({ symbol: s.symbol, token: s.token, futureToken: universe.futures.find((f) => f.underlying === s.symbol)?.token }));
      const { history: h, errors } = await history.load(items, session, { onProgress: (p) => { day.prep = p; publish(); } });
      for (const s of universe.stocks) {
        const m = meta[s.token];
        const hx = h[s.symbol];
        if (!hx) continue;
        m.atr14 = hx.atr14;
        // Kite's previous completed daily candle (the 9:15 gap plan's previous high/low; prevHigh/prevLow above stay the 09:10 data's).
        m.kitePrevDay = hx.prevDay ?? null;
        m.openVol5Avg = hx.openVol5Avg;
        m.openValueAvg = hx.openValueAvg ?? null;
        m.openRangePctAvg = hx.openRangePctAvg ?? null;
        m.openVolDays = hx.openVolDays ?? 0;
        const fut = universe.futures.find((f) => f.underlying === s.symbol);
        if (fut && hx.prevOi != null) meta[fut.token].prevOi = hx.prevOi;
      }
      day.historyErrors = errors.length;
      day.meta = meta;
      day.universe = universe;
      day.window = createOpeningWindow({ date, instruments: meta });
      await store.write(`opening/${date}-universe.json`, { date, universe, meta, validationError: day.validationError ?? null });
      setPhase('ready', missing.length ? `Not found in Kite's instruments: ${missing.join(', ')}` : null);
      scheduleDay();
    } catch (error) {
      setPhase(error.status === 403 ? 'needs-kite' : 'error', error.status === 403 ? 'Kite session expired: log in to Kite again.' : `Preparation failed: ${error.message}`);
    }
    return status();
  }

  function connect() {
    if (!day?.window || day.ticker || !session?.accessToken || day.replay) return;
    if (tickLog) tickLog.open(day.date, { meta: day.meta });
    // The trading desk places the 9:15 gap entries (paper) before the first tick of the session.
    Promise.resolve(trading?.onStart?.({ date: day.date, meta: day.meta, replay: false })).catch((error) => { day.tradingError = safe(`9:15 gap entries failed: ${error.message}`); });
    day.ticker = createKiteTicker({
      ...session, WebSocketImpl, now: () => +now(), setTimer, clearTimer,
      onTicks: (ticks, receivedAt) => {
        if (tickLog && receivedAt <= at(day.date, RECORD_UNTIL)) tickLog.append(ticks, receivedAt);
        for (const t of ticks) day.window.ingest(t, receivedAt);
        trading?.onTicks(ticks, receivedAt, { replay: false });
        publish();
      },
      onStatus: (s) => {
        if (s.state === 'closed' && s.message) setPhase('error', s.message);
        else if (s.state === 'connected' && day.phase !== 'sealed') setPhase('collecting');
        else publish();
      },
    });
    day.ticker.subscribe([...day.universe.stocks, ...day.universe.indices, ...day.universe.futures].map((x) => x.token), 'full');
    day.ticker.connect();
    setPhase('connecting');
  }

  async function sealNow() {
    if (!day?.window || day.sealed) return;
    day.sealed = { ...day.window.seal(+now()), partialFrom: day.partialFrom ?? null };
    day.phase = 'sealed';
    if (!day.replay) await store.write(`opening/${day.date}.json`, day.sealed);
    try { await trading?.onSeal(day.sealed, { replay: false }); } catch (error) { day.tradingError = safe(`09:20 decision failed: ${error.message}`); }
    publish(true);
  }

  function stop() {
    day?.ticker?.close();
    if (day) day.ticker = null;
    const keep = day?.replay ? [] : trading?.keepTokens?.() ?? [];
    if (keep.length) follow(keep);
    if (tickLog && !day?.replay) tickLog.close?.();
    if (day && day.phase !== 'error') setPhase(day.sealed ? 'sealed' : 'stopped');
  }

  /** Keep streaming these tokens (open paper orders/positions) into the trading desk. */
  function follow(tokens) {
    if (!tokens?.length) return;
    if (follower) { follower.subscribe(tokens, 'full'); return; }
    if (!session?.accessToken) return;
    follower = createKiteTicker({
      ...session, WebSocketImpl, now: () => +now(), setTimer, clearTimer,
      onTicks: (ticks, receivedAt) => trading?.onTicks(ticks, receivedAt, { replay: false }),
      onStatus: () => publish(),
    });
    follower.subscribe(tokens, 'full');
    follower.connect();
    publish(true);
  }
  function unfollow() { follower?.close(); follower = null; publish(true); }

  /**
   * Timers for the rest of today: connect, seal, stop. Started late (after 09:15) the window is
   * flagged partial; started after the seal time, there is no window to collect today.
   */
  function scheduleDay() {
    clearTimers();
    if (!day?.window) return;
    const t = +now();
    const sealAt = at(day.date, '09:20') + SEAL_GRACE_MS;
    if (t >= sealAt) { setPhase('missed', 'The backend was not collecting during 09:15–09:20, so there is no opening window today.'); return; }
    if (t > at(day.date, '09:15')) day.partialFrom = new Date(t).toISOString();
    if (t >= at(day.date, CONNECT_AT)) connect();
    else timers.push(setTimer(connect, at(day.date, CONNECT_AT) - t));
    timers.push(setTimer(() => { sealNow(); }, sealAt - t));
    timers.push(setTimer(stop, at(day.date, STOP_AT) - t));
  }

  /**
   * Replay recorded or simulated ticks through the same window, `speed` times
   * faster than real time. Nothing is written to the day's files.
   */
  function replay({ date, instruments: meta, candidates = [], ticks }, { speed = 20 } = {}) {
    clearTimers();
    day?.ticker?.close();
    const window = createOpeningWindow({ date, instruments: meta });
    const first = ticks[0]?.receivedAt ?? at(date, '09:14');
    const startReal = +now();
    const virtualNow = () => first + (+now() - startReal) * speed;
    day = { date, phase: 'collecting', source: 'replay', replay: true, window, meta, candidates, virtualNow, message: `Replaying a simulated morning at ${speed}× speed (no Kite needed).` };
    day.universe = {
      stocks: Object.values(meta).filter((m) => m.kind === 'stock'), indices: Object.values(meta).filter((m) => m.kind === 'index'),
      futures: Object.values(meta).filter((m) => m.kind === 'future'), missing: [],
    };
    Promise.resolve(trading?.onStart?.({ date, meta, replay: true })).catch((error) => { day.tradingError = `9:15 gap entries failed: ${error.message}`; });
    let i = 0;
    const sealVirtual = window.sealAt + SEAL_GRACE_MS;
    const step = () => {
      if (!day?.replay || day.window !== window) return;
      const v = virtualNow();
      while (i < ticks.length && ticks[i].receivedAt <= v) {
        if (!day.sealed && ticks[i].receivedAt >= sealVirtual) break;
        window.ingest(ticks[i].tick, ticks[i].receivedAt);
        // Every tick goes to the replay ledger: the 9:15 gap entries fill from 09:15, the 09:20 orders after the seal.
        trading?.onTicks([ticks[i].tick], ticks[i].receivedAt, { replay: true });
        i++;
      }
      if (!day.sealed && v >= sealVirtual) {
        day.sealed = window.seal(sealVirtual);
        day.phase = 'sealed';
        // Paper decision on the replay ledger (in memory); later ticks drive its fills.
        Promise.resolve(trading?.onSeal(day.sealed, { replay: true })).catch((error) => { day.tradingError = `09:20 decision failed: ${error.message}`; });
        publish(true);
      } else publish();
      if (i < ticks.length) timers.push(setTimer(step, 50));
      else { trading?.onReplayEnd?.(); day.message = 'Replay finished.'; publish(true); }
    };
    publish(true);
    timers.push(setTimer(step, 0));
    return status();
  }

  /** Full features for one stock (candles, depth levels, F&O) for the detail view. */
  function stockDetail(symbol) {
    if (!day?.window) return null;
    const snap = day.sealed ?? day.window.snapshot(day.virtualNow?.() ?? +now());
    return snap.stocks.find((s) => s.symbol === symbol) ?? null;
  }

  /**
   * Pre-market setup check with the current Kite session, read-only market data only:
   * instruments dump, one historical request, one /quote, and a short WebSocket
   * subscription (INFY + NIFTY 50, full mode). Never places orders; never returns the token.
   */
  async function selfTest({ symbol = 'INFY', waitMs = 8_000 } = {}) {
    if (!session?.accessToken) return { ok: false, steps: [{ step: 'Kite session', ok: false, detail: 'Not logged in to Kite.' }] };
    const steps = [];
    const step = async (name, fn) => {
      try { const detail = await fn(); steps.push({ step: name, ok: true, detail }); return true; }
      catch (error) { steps.push({ step: name, ok: false, detail: safe(error.message) }); return false; }
    };
    let ix = null;
    await step('Instruments dump', async () => {
      ix = await instruments.load(session);
      const e = ix.equity(symbol);
      if (!e) throw new Error(`${symbol} not found`);
      const fut = ix.future(symbol);
      return `${symbol} token ${e.token}, tick ₹${e.tick}; near-month future ${fut ? `${fut.tradingsymbol} (lot ${fut.lot})` : 'none'}; NIFTY 50 token ${ix.index('NIFTY 50') ?? 'missing'}`;
    });
    await step('Historical candles', async () => {
      const e = ix?.equity(symbol);
      if (!e) throw new Error('needs the instruments step');
      const today = indiaDate(now());
      const from = new Date(+now() - 10 * 86_400_000);
      const candles = await kite.historical({ ...session, token: e.token, interval: 'day', from: `${indiaDate(from)} 00:00:00`, to: `${today} 23:59:59` });
      const last = candles.at(-1);
      if (!last) throw new Error('no candles returned');
      return `${candles.length} daily candles; last ${indiaDate(last[0])}: O ${last[1]} H ${last[2]} L ${last[3]} C ${last[4]} V ${last[5]}`;
    });
    await step('Quote API', async () => {
      const q = (await kite.quote({ ...session, instruments: [`NSE:${symbol}`] }))[`NSE:${symbol}`];
      if (!q) throw new Error('no quote returned');
      return `last ${q.last_price}, circuit ${q.lower_circuit_limit}–${q.upper_circuit_limit}, depth ${q.depth?.buy?.length ?? 0}×${q.depth?.sell?.length ?? 0}, timestamp ${q.timestamp}`;
    });
    await step('WebSocket (full mode)', () => new Promise((resolve, reject) => {
      const e = ix?.equity(symbol);
      const nifty = ix?.index('NIFTY 50');
      if (!e) { reject(new Error('needs the instruments step')); return; }
      const seen = new Map();
      let finished = false;
      const done = (fn) => { if (finished) return; finished = true; clearTimer(timer); ticker.close(); fn(); };
      const ticker = createKiteTicker({
        ...session, WebSocketImpl, now: () => +now(), setTimer, clearTimer,
        onTicks: (ticks) => {
          for (const t of ticks) seen.set(t.token, t);
          if (seen.has(e.token) && (!nifty || seen.has(nifty))) {
            done(() => {
              const s = seen.get(e.token);
              const n = nifty ? seen.get(nifty) : null;
              resolve(`${symbol}: ${s.mode} packet, last ${s.ltp}, volume ${s.volume}, avg ${s.avgPrice}, depth ${s.depth ? `${s.depth.buy.filter((l) => l.qty).length}+${s.depth.sell.filter((l) => l.qty).length} levels` : 'none'}, exchange time ${s.exchangeTime ? new Date(s.exchangeTime).toISOString() : 'n/a'}`
                + (n ? `; NIFTY 50: ${n.mode} index packet, last ${n.ltp}` : ''));
            });
          }
        },
        onStatus: (s) => { if (s.state === 'closed' && s.message) done(() => reject(new Error(s.message))); },
      });
      ticker.subscribe([e.token, ...(nifty ? [nifty] : [])], 'full');
      ticker.connect();
      const timer = setTimer(() => done(() => reject(new Error(`no ticks within ${waitMs / 1000} s${seen.size ? ` (got ${seen.size} instrument)` : ''}`))), waitMs);
    }));
    return { ok: steps.every((s) => s.ok), steps, at: now().toISOString() };
  }

  return {
    selfTest,
    setSession(s) { session = s?.accessToken && s?.apiKey ? { apiKey: s.apiKey, accessToken: s.accessToken } : null; publish(true); },
    prepare, connect, sealNow, stop, replay, stockDetail, status, follow, unfollow,
    /** Called at start-up and each morning: prepare if the pre-open data is in, and arm today's timers. */
    async wake() {
      const date = indiaDate(now());
      if (!marketDay(date, calendar).open) { day = { date, phase: 'closed', message: marketDay(date, calendar).reason }; publish(true); return status(); }
      if (day?.date === date && (day.window || day.sealed)) { if (!day.sealed) scheduleDay(); else publish(true); return status(); }
      // Restarted after today's seal: show what was saved, never collect again.
      const saved = await store.read(`opening/${date}.json`);
      if (saved) {
        const uni = await store.read(`opening/${date}-universe.json`);
        day = { date, phase: 'sealed', sealed: saved, source: 'websocket', candidates: [], universe: uni?.universe ?? null, message: 'Loaded today\'s sealed window from disk.' };
        publish(true);
        return status();
      }
      const t = +now();
      if (t >= at(date, '09:20') + SEAL_GRACE_MS) {
        day = { date, phase: 'missed', message: 'The backend was not collecting during 09:15–09:20, so there is no opening window today.' };
        publish(true);
      } else if (t >= at(date, '09:08')) await prepare();
      else publish(true);
      return status();
    },
    /** Sealed features saved for `date`. */
    sealedFor: (date) => store.read(`opening/${date}.json`),
    latest: () => { publish(true); },
  };
}
