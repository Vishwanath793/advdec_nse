/**
 * Strategy D's release prerequisite (docs/plan-920-volume-breakout-confirmation.md §5.2): does the opening
 * volume the app counts from live ticks (cumulative-volume differences, pre-open auction excluded) match
 * Kite's historical 1-minute bars for the same minutes? Pure: per-minute tick volumes and candles in, a
 * comparison and a verdict out. The 09:15 minute is reported on its own, because it is where an auction
 * difference would show. Nothing here corrects the numbers: a mismatch means "establish a convention first".
 */

export const MINUTES = ['09:15', '09:16', '09:17', '09:18', '09:19'];
export const RECONCILE_RULE = { tolerance: 0.05, minStockDays: 30, minMornings: 3, minShareWithin: 0.8 };
const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r4 = (n) => (n == null ? null : Math.round(n * 10_000) / 10_000);

/**
 * One morning. `stocks`: [{ symbol, minuteVolume: [5], minuteVolumeLow: [5], volumeBaseline }] (rebuilt from the
 * recorded ticks); `candlesBySymbol`: { SYMBOL: [[Date|ms, o, h, l, c, v], ...] } from Kite. Returns comparison rows.
 */
export function reconcileDay(date, stocks, candlesBySymbol) {
  const rows = [];
  for (const s of stocks) {
    const byMinute = new Map();
    for (const c of candlesBySymbol[s.symbol] ?? []) {
      const k = ist.format(new Date(c[0]));
      if (!byMinute.has(k)) byMinute.set(k, c[5]);
    }
    MINUTES.forEach((m, i) => {
      const kite = byMinute.get(m);
      const ticks = s.minuteVolume?.[i];
      if (kite == null || ticks == null) return;
      rows.push({
        date, symbol: s.symbol, minute: m, ticks, ticksLow: s.minuteVolumeLow?.[i] ?? ticks, kite,
        ratio: kite > 0 ? r4(ticks / kite) : null, baseline: s.volumeBaseline ?? null,
      });
    });
  }
  return rows;
}

/**
 * All mornings together: per minute the median tick/Kite ratio and the share within the tolerance, the
 * 09:15–09:19 total, and a verdict. Matched only with enough stock-days and mornings, every minute's median
 * within the tolerance and most stock-minutes within it. Estimated starting baselines are left out.
 */
export function reconcileSummary(rows, rule = RECONCILE_RULE) {
  const usable = rows.filter((r) => r.ratio != null && r.baseline !== 'first window tick (estimated)');
  const minutes = MINUTES.map((m) => {
    const rs = usable.filter((r) => r.minute === m).map((r) => r.ratio);
    return {
      minute: m, samples: rs.length, medianRatio: r4(median(rs)),
      shareWithin: rs.length ? r4(rs.filter((x) => Math.abs(x - 1) <= rule.tolerance).length / rs.length) : null,
    };
  });
  const totals = new Map();
  for (const r of usable) {
    const k = `${r.date}|${r.symbol}`;
    const t = totals.get(k) ?? totals.set(k, { ticks: 0, kite: 0, minutes: 0 }).get(k);
    t.ticks += r.ticks; t.kite += r.kite; t.minutes += 1;
  }
  const complete = [...totals.values()].filter((t) => t.minutes === 5 && t.kite > 0);
  const window = { stockDays: complete.length, medianRatio: r4(median(complete.map((t) => t.ticks / t.kite))) };
  const mornings = new Set(usable.map((r) => r.date)).size;
  const problems = [];
  if (window.stockDays < rule.minStockDays) problems.push(`only ${window.stockDays} complete stock-days (need ${rule.minStockDays})`);
  if (mornings < rule.minMornings) problems.push(`only ${mornings} recorded morning(s) (need ${rule.minMornings})`);
  for (const m of minutes) {
    if (m.medianRatio == null) problems.push(`${m.minute}: no comparisons`);
    else if (Math.abs(m.medianRatio - 1) > rule.tolerance) problems.push(`${m.minute}: ticks count ${Math.round(m.medianRatio * 100)}% of Kite's bar (median)`);
    else if (m.shareWithin < rule.minShareWithin) problems.push(`${m.minute}: only ${Math.round(m.shareWithin * 100)}% of stocks within ±${rule.tolerance * 100}%`);
  }
  const first = minutes[0];
  const later = minutes.slice(1).filter((m) => m.medianRatio != null);
  const hint = first.medianRatio != null && later.length && later.every((m) => Math.abs(m.medianRatio - 1) <= rule.tolerance) && Math.abs(first.medianRatio - 1) > rule.tolerance
    ? `Only 09:15 differs (${Math.round(first.medianRatio * 100)}%): Kite's 09:15 bar likely ${first.medianRatio < 1 ? 'includes' : 'excludes'} volume the app ${first.medianRatio < 1 ? 'leaves out (the pre-open auction?)' : 'counts'}. Decide one convention before trading D.`
    : null;
  return {
    rule, mornings, minutes, window, problems, hint,
    verdict: { matched: problems.length === 0, text: problems.length ? `Not established: ${problems.join('; ')}.` : 'Tick volumes match Kite\'s minute bars within the tolerance.' },
  };
}
