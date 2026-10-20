/**
 * Backtest statistics (milestone 3), always on net P&L after Zerodha charges
 * and slippage: number of trades, win rate, average win and loss, profit factor,
 * net P&L, maximum drawdown, expectancy (₹ and R), average planned
 * reward/risk, longest losing streak; and breakdowns by any key.
 * A trade is { date, exitAt, net, r, plan: { rewardRisk } }; only closed trades count.
 */

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export const closedTrades = (trades) => trades.filter((t) => t.status === 'CLOSED');

export function summarize(trades) {
  const closed = closedTrades(trades).sort((a, b) => `${a.date} ${a.exitAt}`.localeCompare(`${b.date} ${b.exitAt}`));
  const wins = closed.filter((t) => t.net > 0);
  const losses = closed.filter((t) => t.net <= 0);
  const grossWin = wins.reduce((s, t) => s + t.net, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.net, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let longestLosingStreak = 0;
  for (const t of closed) {
    equity += t.net;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    streak = t.net <= 0 ? streak + 1 : 0;
    longestLosingStreak = Math.max(longestLosingStreak, streak);
  }
  const days = new Set(closed.map((t) => t.date)).size;
  return {
    trades: closed.length,
    days,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: r2(avg(wins.map((t) => t.net))),
    avgLoss: r2(avg(losses.map((t) => t.net))),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : grossWin > 0 ? Infinity : null,
    net: r2(equity),
    charges: r2(closed.reduce((s, t) => s + (t.charges ?? 0), 0)),
    maxDrawdown: r2(maxDrawdown),
    expectancy: r2(avg(closed.map((t) => t.net))),
    expectancyR: r2(avg(closed.filter((t) => t.r != null).map((t) => t.r))),
    avgRewardRisk: r2(avg(closed.map((t) => t.plan?.rewardRisk).filter((x) => x != null))),
    longestLosingStreak,
  };
}

/** Group trades by `keyOf(trade)` (null keys are "unknown") and summarise each group, in `order` when given. */
export function breakdown(trades, keyOf, order = null) {
  const groups = new Map();
  for (const t of closedTrades(trades)) {
    const k = keyOf(t) ?? 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const keys = order ? [...order.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !order.includes(k))] : [...groups.keys()].sort();
  return keys.map((key) => ({ key, ...summarize(groups.get(key)) }));
}

export const GAP_BUCKETS = ['under 1%', '1–2%', '2–3.75%', '3.75% and over'];
export const gapBucket = (t) => {
  const g = Math.abs(t.gapPct ?? NaN);
  if (!Number.isFinite(g)) return null;
  return g < 1 ? GAP_BUCKETS[0] : g < 2 ? GAP_BUCKETS[1] : g < 3.75 ? GAP_BUCKETS[2] : GAP_BUCKETS[3];
};
export const RVOL_BUCKETS = ['under 1', '1–1.5', '1.5–2.5', '2.5 and over'];
export const rvolBucket = (t) => (t.rvol == null ? null : t.rvol < 1 ? RVOL_BUCKETS[0] : t.rvol < 1.5 ? RVOL_BUCKETS[1] : t.rvol < 2.5 ? RVOL_BUCKETS[2] : RVOL_BUCKETS[3]);
/** Market regime from Nifty 50's 09:15–09:20 move. */
export const REGIMES = ['Nifty up', 'Nifty flat', 'Nifty down'];
export const regimeOf = (niftyPct) => (niftyPct == null ? null : niftyPct > 0.2 ? REGIMES[0] : niftyPct < -0.2 ? REGIMES[2] : REGIMES[1]);
