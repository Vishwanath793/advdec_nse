import { intradayCharges } from './charges.js';
import { cleanRiskSettings } from './risk.js';

/**
 * Simulated fills on 1-minute candles after 09:20 (candle backtests).
 *
 * Minute candles can't show the order of prices inside a minute, the order
 * book or queue position, so every ambiguity is resolved against the trade:
 *  - Entry (stop-style): triggers in the first minute whose high (low, for a
 *    short) reaches the trigger. It fills at the trigger or the minute's open,
 *    whichever is worse, plus slippage. Like a stop-loss limit order it never
 *    fills beyond the maximum entry. When the open is past that, it fills at
 *    the maximum entry only if the minute traded back to it.
 *  - Immediate entry: the 09:20 minute's open plus slippage, within the
 *    maximum entry.
 *  - Stop: hit when the low (high) reaches it. It fills at the stop or the
 *    minute's open, whichever is worse, minus slippage, so a gap through the
 *    stop costs more.
 *  - In the entry minute only the stop is checked: if that minute also reached
 *    the stop, the trade is stopped there.
 *  - When a minute reaches both the stop and a target, the stop is assumed first.
 *  - Targets: limit fills at the target price (no slippage), half at target 1.
 *    The stop moves to the entry price from the next minute. Target 2 only
 *    counts from the minute after target 1.
 *  - Entries not triggered by `entryUntil` are cancelled. What is still open
 *    exits at the `squareOffAt` minute's open minus slippage, or at the last
 *    close if the data ends sooner.
 *  - The daily-loss and losing-streak limits are checked when an entry
 *    triggers, as in paper trading.
 */

const ist = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const r2 = (n) => Math.round(n * 100) / 100;

/** Simulate one day's BUY/SELL decisions. `candlesBySymbol`: { SYM: [[Date, o, h, l, c, v], ...] }. */
export function simulateCandleDay({ date, decisions, candlesBySymbol, risk = {}, meta = {} }) {
  const s = cleanRiskSettings(risk);
  const slip = s.slippageBps / 10_000;
  const trades = (decisions ?? []).filter((d) => (d.decision === 'BUY' || d.decision === 'SELL') && d.plan?.qty > 0).map((d) => ({
    date, symbol: d.symbol, strategy: d.strategy ?? d.variant ?? null, score: d.score ?? null, direction: d.plan.direction, side: d.plan.side,
    plan: d.plan, qty: 0, entry: null, entryAt: null, exits: [], status: 'PENDING', t1Done: false, stop: d.plan.stop, reason: null,
    ...(meta[d.symbol] ?? {}),
  }));
  let realised = 0;
  let streak = 0;
  // Every minute from 09:20 to the square-off, in time order across all trades.
  const minutes = [...new Set(trades.flatMap((t) => (candlesBySymbol[t.symbol] ?? []).map((c) => ist(c[0])).filter((m) => m >= '09:20')))].sort();
  const candleAt = (t, m) => (candlesBySymbol[t.symbol] ?? []).find((c) => ist(c[0]) === m) ?? null;
  const exit = (t, qty, price, kind, m) => {
    t.exits.push({ qty, price: r2(price), kind, at: m });
    t.open -= qty;
    if (t.open > 0) return;
    t.status = 'CLOSED';
    t.exitAt = m;
    const exitValue = t.exits.reduce((a, x) => a + x.qty * x.price, 0);
    t.gross = r2(t.direction * (exitValue - t.qty * t.entry));
    t.charges = intradayCharges([{ side: t.side, value: t.qty * t.entry }, ...t.exits.map((x) => ({ side: t.side === 'BUY' ? 'SELL' : 'BUY', value: x.qty * x.price }))]).total;
    t.net = r2(t.gross - t.charges);
    t.r = t.plan.riskAmount > 0 ? t.net / t.plan.riskAmount : null;
    t.outcome = t.exits.map((x) => x.kind).join('+');
    realised += t.net;
    streak = t.net < 0 ? streak + 1 : 0;
  };

  for (const m of minutes) {
    for (const t of trades) {
      const c = candleAt(t, m);
      if (t.status === 'PENDING') {
        if (m >= s.entryUntil) { t.status = 'EXPIRED'; t.reason = `not triggered by ${s.entryUntil}`; continue; }
        if (!c) continue;
        const [, o, h, l] = c;
        const up = t.direction > 0;
        const p = t.plan;
        const triggered = p.immediate || (up ? h >= p.trigger : l <= p.trigger);
        if (!triggered) continue;
        if (realised <= -(s.capital * s.dailyLossPct) / 100 || streak >= s.maxConsecutiveLosses) {
          t.status = 'REJECTED'; t.reason = 'daily loss or losing-streak limit reached at the trigger'; continue;
        }
        const raw = p.immediate ? o : up ? Math.max(p.trigger, o) : Math.min(p.trigger, o);
        let price = up ? raw * (1 + slip) : raw * (1 - slip);
        if (up ? price > p.maxEntry : price < p.maxEntry) {
          const tradedBack = up ? l * (1 + slip) <= p.maxEntry : h * (1 - slip) >= p.maxEntry;
          if (!tradedBack) { t.status = p.immediate ? 'PENDING' : 'TRIGGERED'; if (!p.immediate) t.waiting = true; continue; }
          price = p.maxEntry;
        }
        t.status = 'OPEN'; t.entry = r2(price); t.entryAt = m; t.qty = p.qty; t.open = p.qty;
        // The entry minute: only the stop is checked (worst case).
        if (up ? l <= t.stop : h >= t.stop) exit(t, t.open, up ? Math.min(t.stop, o) * (1 - slip) : Math.max(t.stop, o) * (1 + slip), 'stop', m);
        continue;
      }
      if (t.status === 'TRIGGERED') {
        if (m >= s.entryUntil) { t.status = 'EXPIRED'; t.reason = 'triggered, but never fillable within the maximum entry'; continue; }
        if (!c) continue;
        const [, o, h, l] = c;
        const up = t.direction > 0;
        const p = t.plan;
        const at = up ? Math.min(o * (1 + slip), p.maxEntry) : Math.max(o * (1 - slip), p.maxEntry);
        const reachable = up ? l * (1 + slip) <= p.maxEntry : h * (1 - slip) >= p.maxEntry;
        if (!reachable) continue;
        t.status = 'OPEN'; t.entry = r2(at); t.entryAt = m; t.qty = p.qty; t.open = p.qty;
        if (up ? l <= t.stop : h >= t.stop) exit(t, t.open, up ? Math.min(t.stop, o) * (1 - slip) : Math.max(t.stop, o) * (1 + slip), 'stop', m);
        continue;
      }
      if (t.status !== 'OPEN' || m === t.entryAt) continue;
      if (m >= s.squareOffAt) {
        if (c) exit(t, t.open, t.direction > 0 ? c[1] * (1 - slip) : c[1] * (1 + slip), 'squareoff', m);
        continue;
      }
      if (!c) continue;
      const [, o, h, l] = c;
      const up = t.direction > 0;
      if (up ? l <= t.stop : h >= t.stop) {
        exit(t, t.open, up ? Math.min(t.stop, o) * (1 - slip) : Math.max(t.stop, o) * (1 + slip), t.t1Done ? 'breakeven' : 'stop', m);
        continue;
      }
      if (!t.t1Done && (up ? h >= t.plan.target1 : l <= t.plan.target1)) {
        const half = t.open > 1 ? Math.floor(t.open / 2) : t.open;
        exit(t, half, t.plan.target1, 'target1', m);
        t.t1Done = true;
        t.t1At = m;
        if (t.open > 0) t.stop = t.entry;
        continue;
      }
      if (t.t1Done && m !== t.t1At && (up ? h >= t.plan.target2 : l <= t.plan.target2)) exit(t, t.open, t.plan.target2, 'target2', m);
    }
  }
  // Data ended before the square-off: close at the last close.
  for (const t of trades) {
    if (t.status === 'OPEN') {
      const last = (candlesBySymbol[t.symbol] ?? []).at(-1);
      exit(t, t.open, t.direction > 0 ? last[4] * (1 - slip) : last[4] * (1 + slip), 'dataend', ist(last[0]));
    } else if (t.status === 'PENDING' || t.status === 'TRIGGERED') {
      t.status = 'EXPIRED'; t.reason = t.reason ?? 'not triggered before the candle data ended';
    }
  }
  return trades;
}
