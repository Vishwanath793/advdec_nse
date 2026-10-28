import { indiaDate, istInstant, marketDay } from './calendar.js';
import { createPaperBroker } from './paperBroker.js';
import { cleanScoringSettings, decideOpening, decisionRow, DEFAULT_SCORING_SETTINGS } from '../utils/decision.js';
import { GAP_CHECK_FALLBACK_MS, ledgerDay } from '../utils/paperLedger.js';
import { cleanRiskSettings, DEFAULT_RISK_SETTINGS, tradeBlockers } from '../utils/risk.js';
import { DEFAULT_STRATEGY_SETTINGS, STRATEGY_CHOICES, strategySettings } from '../utils/strategies.js';
import { cleanGapExitSettings, DEFAULT_GAP_EXIT_SETTINGS, gapExitPlan } from '../utils/gapExits.js';
import { SIMULATED_DATE, SIMULATED_GAP_LIST } from '../utils/simulatedMorning.js';

/**
 * The 09:20 trading desk (milestone 2: PAPER only).
 *
 * At the seal it decides (utils/decision.js) and places paper orders; ticks
 * after the seal drive the simulated fills (utils/paperLedger.js) until the
 * entry window ends and the positions close (target, stop, square-off, kill
 * switch). Two ledgers: `day` (today, saved under .data/paper/) and `replay`
 * (the simulated or recorded replay, in memory only).
 *
 * The 9:15 gap entries (utils/gapExits.js) use the same ledgers: when the collector
 * starts the day (onStart, 09:14), each stock on the gap list gets a paper market
 * order active from 09:15:00, sized and levelled from its gap.
 *
 * LIVE execution is milestone 4 and doesn't exist here: the mode is always PAPER.
 */

export const TRADING_MODES = ['BACKTEST', 'PAPER', 'LIVE'];
export const DEFAULT_TRADING_SETTINGS = {
  mode: 'PAPER', risk: DEFAULT_RISK_SETTINGS, strategies: DEFAULT_STRATEGY_SETTINGS, scoring: DEFAULT_SCORING_SETTINGS, gapExits: DEFAULT_GAP_EXIT_SETTINGS,
};

/** Plan inputs for one stock from the collector's instrument meta, with where each comes from. */
export function gapInputsFromMeta(m, { symbol, side }) {
  // Previous high/low: Kite's previous completed daily candle, else the 09:10 analyzer data (labelled).
  const kite = m.kitePrevDay;
  return {
    symbol, side, prevClose: m.prevClose, open: m.preOpenPrice, atr: m.atr14 ?? null, tick: m.tick ?? null, lot: m.lot ?? 1,
    upperCircuit: m.upperCircuit ?? null, lowerCircuit: m.lowerCircuit ?? null,
    prevHigh: kite?.high ?? m.prevHigh ?? null, prevLow: kite?.low ?? m.prevLow ?? null,
    sources: {
      prevClose: m.prevCloseMismatch ? 'Kite /quote ohlc.close (NSE differed)' : 'NSE pre-open (09:10 import), checked against Kite /quote',
      open: 'NSE pre-open final price (09:10 import)',
      atr: m.atr14 ? 'ATR(14) from Kite daily candles' : 'missing: estimated from the previous close',
      tick: m.tick ? 'Kite instruments' : 'default ₹0.05',
      circuit: m.upperCircuit ? 'Kite /quote circuit limits (else NSE price bands)' : 'not known',
      prevHigh: kite ? `Kite daily candle of ${kite.date}` : m.prevHigh ? '09:10 analyzer data (Kite daily candle missing)' : 'not known',
    },
  };
}

/** Numbers stay numbers, booleans booleans; anything else falls back to the default. */
function cleanStrategies(input = {}) {
  const merged = strategySettings(input);
  return Object.fromEntries(Object.entries(DEFAULT_STRATEGY_SETTINGS).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([f, v]) => {
    const x = merged[k][f];
    if (typeof v === 'boolean') return [f, typeof x === 'boolean' ? x : v];
    if (typeof v === 'string') {
      if (STRATEGY_CHOICES[f]) return [f, STRATEGY_CHOICES[f].includes(x) ? x : v];
      return [f, /^09:(2\d|[3-5]\d)$|^1[0-4]:[0-5]\d$/.test(x ?? '') ? x : v]; // a time, 09:20–14:59
    }
    const n = Number(x);
    return [f, Number.isFinite(n) ? n : v];
  }))]));
}

export function cleanTradingSettings(input = {}) {
  return {
    mode: 'PAPER', // LIVE is not available until milestone 4
    risk: cleanRiskSettings(input?.risk ?? {}),
    strategies: cleanStrategies(input?.strategies ?? {}),
    scoring: cleanScoringSettings(input?.scoring ?? {}),
    gapExits: cleanGapExitSettings(input?.gapExits ?? {}),
  };
}

/**
 * `gapList(date)`: today's 9:15 gap entries [{ symbol, side, source }] (the saved list, plus
 * paper shadows of scheduled 09:15 market orders when that is on).
 * `gapFallback(symbol)`: plan inputs for a stock outside the collector's universe (or null).
 */
export function createTradingDesk({
  store, log, calendar, settings = () => DEFAULT_TRADING_SETTINGS, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout, onUpdate = () => {},
  gapList = async () => [], gapFallback = async () => null,
}) {
  const cfg = () => cleanTradingSettings(settings());
  const changed = () => { try { onUpdate(); } catch { /* ignore */ } };
  const at = (date, time) => +istInstant(date, time);
  const gapTiming = (date) => ({ settings: cfg().gapExits, checkAt: at(date, '09:20') + GAP_CHECK_FALLBACK_MS, timeStopAt: at(date, cfg().gapExits.timeStopAt) });
  const brokers = {
    day: createPaperBroker({ store, log, ledger: 'day', risk: () => cfg().risk, gap: gapTiming, onChange: changed, now }),
    replay: createPaperBroker({ ledger: 'replay', risk: () => cfg().risk, gap: gapTiming, onChange: changed, now }),
  };
  const decisions = { day: null, replay: null };
  const gapPlans = { day: [], replay: [] };
  const metas = { day: null, replay: null };
  let replayStarted = false;
  let links = { follow: () => {}, unfollow: () => {} };
  let squareOffTimer = null;
  let lastReconcile = null;

  /** Plan every gap-list stock from the instrument meta and place the paper market orders (before the entry window ends). */
  async function startGap(date, meta, ledger) {
    const s = cfg();
    const bySymbol = new Map(Object.entries(meta ?? {}).filter(([, m]) => m.kind === 'stock').map(([token, m]) => [m.symbol, { token: Number(token), m }]));
    metas[ledger] = bySymbol;
    let list = (await gapList(date)) ?? [];
    if (ledger === 'replay') {
      list = list.filter((e) => bySymbol.has(e.symbol));
      if (!list.length && date === SIMULATED_DATE) list = SIMULATED_GAP_LIST;
    }
    const seen = new Set();
    gapPlans[ledger] = list.filter((e) => !seen.has(e.symbol) && seen.add(e.symbol)).map((e) => {
      const hit = bySymbol.get(e.symbol);
      if (!hit) return { ...e, plan: null, error: 'not in today\'s opening universe (no 09:10 pre-open row, or not in Kite\'s instruments)' };
      const plan = gapExitPlan(gapInputsFromMeta(hit.m, e), s.gapExits, s.risk);
      return { ...e, token: hit.token, plan, error: plan.ok ? null : plan.error };
    });
    const until = at(date, s.risk.entryUntil);
    if (ledger === 'day' && +now() >= until) return { orders: 0, skipped: `after ${s.risk.entryUntil}: no gap entries placed` };
    const placedAt = ledger === 'replay' ? at(date, '09:14') : Math.min(+now(), at(date, '09:15'));
    return brokers[ledger].placeGap(gapPlans[ledger].filter((x) => x.plan?.ok), {
      at: new Date(placedAt).toISOString(), activeFrom: new Date(at(date, '09:15')).toISOString(), expiresAt: new Date(until).toISOString(),
    });
  }

  function armSquareOff(date) {
    if (squareOffTimer) clearTimer(squareOffTimer);
    squareOffTimer = null;
    const t = at(date, cfg().risk.squareOffAt) - +now();
    if (t <= 0) {
      if (brokers.day.openTokens().length) brokers.day.closeAll(`square-off at ${cfg().risk.squareOffAt}`);
      return;
    }
    squareOffTimer = setTimer(() => {
      squareOffTimer = null;
      brokers.day.closeAll(`square-off at ${cfg().risk.squareOffAt}`);
      setTimer(() => { if (!brokers.day.openTokens().length) links.unfollow(); }, 60_000);
    }, t);
  }

  async function decide(sealed, ledger, { partial = false } = {}) {
    const broker = brokers[ledger];
    const s = cfg();
    const decision = decideOpening(sealed, { ...s, day: ledgerDay(broker.state), partial: partial || Boolean(sealed.partialFrom), mode: s.mode });
    decisions[ledger] = decision;
    if (ledger === 'day') await store.write(`paper/${sealed.date}-decision.json`, decision);
    const sealedAt = sealed.sealedAt ?? new Date(at(sealed.date, '09:20')).toISOString();
    return broker.decide(decision, { at: sealedAt, entryUntilAt: new Date(at(sealed.date, s.risk.entryUntil)).toISOString() });
  }

  /** Compact state for the trading panel and the scanner. */
  function view(ledger = 'day') {
    const s = cfg();
    const broker = brokers[ledger];
    const state = broker.view();
    const day = state ? ledgerDay(state) : { killSwitch: false, realised: 0, trades: 0, open: 0, consecutiveLosses: 0 };
    return {
      mode: s.mode, ledger, date: state?.date ?? null, settings: s,
      ledgerState: state, blockers: tradeBlockers(day, s.risk),
      dailyLossLimit: (s.risk.capital * s.risk.dailyLossPct) / 100,
      decisions: state?.decision?.rows ?? decisions[ledger]?.decisions.map(decisionRow) ?? [],
      gapReport: state?.decision?.gapReport ?? decisions[ledger]?.gapReport ?? [],
      gapEntries: { plans: gapPlans[ledger], totals: state?.gap ?? null },
      reconcile: ledger === 'day' ? lastReconcile : null,
    };
  }

  return {
    /** The collector's follow/unfollow, so open positions keep streaming after 09:30. */
    attach(l) { links = { ...links, ...l }; },

    /**
     * Called by the collector when it starts the day (connecting at 09:14, or a replay):
     * the 9:15 gap entries are planned and their paper market orders placed.
     */
    async onStart({ date, meta, replay = false }) {
      const ledger = replay ? 'replay' : 'day';
      if (replay) { brokers.replay.reset(date); replayStarted = true; } else {
        lastReconcile = await brokers.day.load(date);
        armSquareOff(date);
      }
      const result = await startGap(date, meta, ledger);
      changed();
      return result;
    },

    /** Called by the collector when the window seals. */
    async onSeal(sealed, { replay = false, partial = false } = {}) {
      const ledger = replay ? 'replay' : 'day';
      if (replay) {
        if (!replayStarted || brokers.replay.state?.date !== sealed.date) brokers.replay.reset(sealed.date);
        replayStarted = false;
      } else {
        lastReconcile = await brokers.day.load(sealed.date);
        armSquareOff(sealed.date);
      }
      brokers[ledger].sealCheck(sealed); // the 9:15 gap entries' 09:20 check, from the sealed window
      const result = await decide(sealed, ledger, { partial });
      changed();
      return result;
    },

    /** Every tick batch from the collector (only matters once there are orders). */
    onTicks(ticks, receivedAt, { replay = false } = {}) {
      const broker = brokers[replay ? 'replay' : 'day'];
      const date = broker.state?.date;
      broker.onTicks(ticks, receivedAt, { squareOffAt: date && !replay ? at(date, cfg().risk.squareOffAt) : null });
    },

    /** End of a replay: close what's still open at the last bid/ask. */
    onReplayEnd() {
      if (brokers.replay.state) brokers.replay.closeAll('replay ended (closed at the last bid/ask)');
    },

    keepTokens: () => brokers.day.openTokens(),

    /**
     * Start-up and each morning: load today's ledger from its log (reconciled),
     * re-arm the square-off, keep following open positions, and decide if the
     * window was sealed but the decision never happened (only before the entry window ends).
     */
    async wake({ sealedFor } = {}) {
      const date = indiaDate(now());
      if (!marketDay(date, calendar).open) return null;
      lastReconcile = await brokers.day.load(date);
      const sealed = sealedFor ? await sealedFor(date) : null;
      if (sealed) {
        decisions.day = decisions.day?.date === date ? decisions.day : await store.read(`paper/${date}-decision.json`);
        if (!brokers.day.state.decidedAt && +now() < at(date, cfg().risk.entryUntil)) await decide(sealed, 'day');
      }
      armSquareOff(date);
      const tokens = brokers.day.openTokens();
      if (tokens.length) links.follow(tokens);
      changed();
      return lastReconcile;
    },

    kill(on, ledger = 'day') { brokers[ledger].kill(on); changed(); return view(ledger); },
    closeAll(ledger = 'day') { brokers[ledger].closeAll('square off all (manual)'); changed(); return view(ledger); },

    view,

    /**
     * The 9:15 gap plan for one stock now (for the Orders page): from today's opening
     * universe when the stock is in it, else from `gapFallback` (the 09:10 pre-open row).
     */
    async gapPlanFor(symbol, side = 'BUY') {
      const s = cfg();
      const hit = metas.day?.get(symbol);
      const inputs = hit ? gapInputsFromMeta(hit.m, { symbol, side }) : await gapFallback(symbol, side);
      if (!inputs) return null;
      return { ...gapExitPlan(inputs, s.gapExits, s.risk), from: hit ? 'opening universe' : inputs.atr ? 'pre-open row + Kite ATR' : 'pre-open row' };
    },

    /** The full decision for one stock (factors, strategy checks, plan). */
    decisionDetail(symbol, ledger = 'day') {
      return decisions[ledger]?.decisions.find((d) => d.symbol === symbol) ?? null;
    },
  };
}
