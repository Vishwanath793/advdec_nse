import { createOpeningWindow } from './openingWindow.js';
import { cleanScoringSettings, decideOpening } from './decision.js';
import { applyEvent, emptyLedger, orderEvents, stepTick } from './paperLedger.js';
import { cleanRiskSettings } from './risk.js';
import { strategySettings } from './strategies.js';
import { istInstant } from '../core/calendar.js';
import { regimeOf } from './backtestStats.js';

/**
 * Tick replay of a recorded morning (milestone 3): the recorded Kite WebSocket
 * ticks go through the same opening window, decision and paper ledger as live
 * (fills at the recorded bid/ask plus slippage, depth and spread rules
 * included). This is the only test of the depth-sensitive rules.
 *
 * The recording ends at 09:25, so positions still open then are closed at the
 * last recorded bid/ask ("recording ended"). Exits after 09:25 can't be judged
 * from a recording.
 */

export const SEAL_GRACE_MS = 1_500; // the same as the live collector

/** `rec`: { date, meta: { token: instrument }, ticks: [{ tick, receivedAt }] } (server/tickLog.js read()). */
export function replayRecordedDay(rec, settings = {}) {
  const risk = cleanRiskSettings(settings.risk ?? {});
  const window = createOpeningWindow({ date: rec.date, instruments: rec.meta });
  const sealAt = window.sealAt + SEAL_GRACE_MS;
  const ticks = [...rec.ticks].sort((a, b) => a.receivedAt - b.receivedAt);
  let i = 0;
  for (; i < ticks.length && ticks[i].receivedAt < sealAt; i++) window.ingest(ticks[i].tick, ticks[i].receivedAt);
  const sealed = window.seal(sealAt);
  const decision = decideOpening(sealed, {
    strategies: strategySettings(settings.strategies ?? {}), risk, scoring: cleanScoringSettings(settings.scoring ?? {}), mode: 'BACKTEST',
  });

  const state = emptyLedger(rec.date, 'research');
  const at = new Date(sealAt).toISOString();
  applyEvent(state, { type: 'decided', at, rows: [] });
  for (const e of orderEvents(state, decision, { at, entryUntilAt: istInstant(rec.date, risk.entryUntil).toISOString() })) applyEvent(state, e);
  const squareOffAt = +istInstant(rec.date, risk.squareOffAt);
  const last = new Map();
  for (; i < ticks.length; i++) {
    const { tick, receivedAt } = ticks[i];
    if (tick.index) continue;
    last.set(tick.token, tick);
    stepTick(state, tick, tick.exchangeTime ?? receivedAt, risk, { squareOffAt });
  }
  // The recording has ended: close what's open at the last recorded bid/ask; unfilled entries lapse.
  applyEvent(state, { type: 'close-all', reason: 'recording ended', at: 'end' });
  for (const t of last.values()) stepTick(state, t, t.exchangeTime ?? sealAt, risk);

  const byId = new Map(decision.decisions.filter((d) => d.decision !== 'NO TRADE').map((d) => [`${rec.date}-${d.symbol}-${d.strategy}`, d]));
  const features = new Map(sealed.stocks.map((f) => [f.symbol, f]));
  const trades = state.positions.map((p) => {
    const d = byId.get(p.id);
    const f = features.get(p.symbol) ?? {};
    const lastExit = p.exits.at(-1);
    return {
      date: rec.date, symbol: p.symbol, strategy: p.strategy, side: p.side, score: d?.score ?? null, plan: d?.plan ?? null,
      status: p.status === 'CLOSED' ? 'CLOSED' : 'OPEN', qty: p.entryQty, entry: p.avgEntry,
      exits: p.exits.map((x) => ({ qty: x.qty, price: x.price, kind: x.kind === 'close-all' ? 'recordingend' : x.kind })),
      outcome: p.exits.map((x) => (x.kind === 'close-all' ? 'recordingend' : x.kind)).join('+'),
      exitAt: lastExit?.at ?? null, gross: p.gross, charges: p.charges, net: p.net,
      r: d?.plan?.riskAmount > 0 && p.net != null ? p.net / d.plan.riskAmount : null,
      gapPct: f.gapPct ?? null, rvol: f.rvol ?? null, sector: f.sector ?? null, regime: regimeOf(sealed.market?.nifty?.pct ?? null),
    };
  });
  const notFilled = state.orders.filter((o) => o.filledQty === 0).map((o) => ({ date: rec.date, symbol: o.symbol, strategy: o.strategy, status: o.status, reason: o.reason }));
  return { date: rec.date, decisions: decision.decisions.filter((d) => d.decision !== 'NO TRADE').length, trades, notFilled };
}
