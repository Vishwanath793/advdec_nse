import { indiaDate, istInstant, marketDay } from './calendar.js';
import { createPaperBroker } from './paperBroker.js';
import { cleanScoringSettings, decideOpening, decisionRow, DEFAULT_SCORING_SETTINGS } from '../utils/decision.js';
import { ledgerDay } from '../utils/paperLedger.js';
import { cleanRiskSettings, DEFAULT_RISK_SETTINGS, tradeBlockers } from '../utils/risk.js';
import { DEFAULT_STRATEGY_SETTINGS, strategySettings } from '../utils/strategies.js';

/**
 * The 09:20 trading desk (milestone 2: PAPER only).
 *
 * At the seal it decides (utils/decision.js) and places paper orders; ticks
 * after the seal drive the simulated fills (utils/paperLedger.js) until the
 * entry window ends and the positions close (target, stop, square-off, kill
 * switch). Two ledgers: `day` (today, saved under .data/paper/) and `replay`
 * (the simulated or recorded replay, in memory only).
 *
 * LIVE execution is milestone 4 and doesn't exist here: the mode is always PAPER.
 */

export const TRADING_MODES = ['BACKTEST', 'PAPER', 'LIVE'];
export const DEFAULT_TRADING_SETTINGS = {
  mode: 'PAPER', risk: DEFAULT_RISK_SETTINGS, strategies: DEFAULT_STRATEGY_SETTINGS, scoring: DEFAULT_SCORING_SETTINGS,
};

/** Numbers stay numbers, booleans booleans; anything else falls back to the default. */
function cleanStrategies(input = {}) {
  const merged = strategySettings(input);
  return Object.fromEntries(Object.entries(DEFAULT_STRATEGY_SETTINGS).map(([k, d]) => [k, Object.fromEntries(Object.entries(d).map(([f, v]) => {
    const x = merged[k][f];
    if (typeof v === 'boolean') return [f, typeof x === 'boolean' ? x : v];
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
  };
}

export function createTradingDesk({
  store, log, calendar, settings = () => DEFAULT_TRADING_SETTINGS, now = () => new Date(),
  setTimer = setTimeout, clearTimer = clearTimeout, onUpdate = () => {},
}) {
  const cfg = () => cleanTradingSettings(settings());
  const changed = () => { try { onUpdate(); } catch { /* ignore */ } };
  const brokers = {
    day: createPaperBroker({ store, log, ledger: 'day', risk: () => cfg().risk, onChange: changed, now }),
    replay: createPaperBroker({ ledger: 'replay', risk: () => cfg().risk, onChange: changed, now }),
  };
  const decisions = { day: null, replay: null };
  let links = { follow: () => {}, unfollow: () => {} };
  let squareOffTimer = null;
  let lastReconcile = null;

  const at = (date, time) => +istInstant(date, time);

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
      reconcile: ledger === 'day' ? lastReconcile : null,
    };
  }

  return {
    /** The collector's follow/unfollow, so open positions keep streaming after 09:30. */
    attach(l) { links = { ...links, ...l }; },

    /** Called by the collector when the window seals. */
    async onSeal(sealed, { replay = false, partial = false } = {}) {
      const ledger = replay ? 'replay' : 'day';
      if (replay) brokers.replay.reset(sealed.date);
      else {
        lastReconcile = await brokers.day.load(sealed.date);
        armSquareOff(sealed.date);
      }
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

    /** The full decision for one stock (factors, strategy checks, plan). */
    decisionDetail(symbol, ledger = 'day') {
      return decisions[ledger]?.decisions.find((d) => d.symbol === symbol) ?? null;
    },
  };
}
