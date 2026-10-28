import { breakAndHold, DEFAULT_STRATEGY_SETTINGS, strategySettings } from './strategies.js';
import { evaluateVariants, laterBarsFromCandles } from './breakoutConfirmation.js';
import { summarize } from './backtestStats.js';

/**
 * Strategy D research on candle days (docs/plan-920-volume-breakout-confirmation.md §15). Pure.
 *  - Pattern study: from the first executable price after confirmation (the next minute's open), does +1R
 *    come before −1R within 15 minutes? A minute that reaches both is "ambiguous" (the order inside a bar
 *    is unknown); neither is "expired". Also the maximum favourable/adverse excursion (R), a return into the
 *    reference range within 5 minutes, and the confirmation-to-entry delay.
 *  - The same for the primary, its ablations (volume-only = no hold; no volume gates; two-bar hold; mean
 *    instead of median baselines) and the later variants (full range, retest, other references).
 *  - Predeclared sensitivities and ablations of the trading study (costs, sizing, limits) for D alone, and a
 *    chronological development/test split with a per-session interval (signals on one morning are correlated).
 * Minute candles can't show the order inside a minute or the book; results are evidence, not proof.
 */

export const STUDY = { horizonMin: 15, returnToRangeMin: 5 };
export const STUDY_ROWS = [
  { key: 'primary', label: 'D primary: 3-minute break at 09:18, hold at 09:19' },
  { key: 'noHold', label: 'Ablation: volume-only (09:18 break, no hold; entry 09:19)' },
  { key: 'noVolume', label: 'Ablation: break and hold without the volume gates' },
  { key: 'twoBarHold', label: 'Sensitivity: two hold bars (09:19 and 09:20; entry 09:21)' },
  { key: 'mean', label: 'Sensitivity: mean instead of median volume baselines' },
  { key: 'fullRange', label: 'Variant: full five-minute range, close and hold (shadow)' },
  { key: 'retest', label: 'Variant: retest of the 3-minute level (shadow)' },
  { key: 'c1', label: 'Reference: the 09:15 candle (shadow)' },
  { key: 'rvolLeader', label: 'Reference: the highest-RVOL candle of 09:15–09:17 (shadow)' },
];
/** Predeclared ranges (§15), one parameter at a time around the defaults, never a combinatorial search. */
export const D_SWEEPS = [
  { key: 'rvol', label: 'Opening and 09:18 RVOL', values: [1.2, 1.5, 2], apply: (c, v) => ({ ...c, minOpeningRvol: v, minBreakoutRvol: v }) },
  { key: 'body', label: 'Breakout body fraction', values: [0.5, 0.6, 0.7], apply: (c, v) => ({ ...c, minBodyRatio: v }) },
  { key: 'closeLocation', label: 'Breakout close location', values: [0.7, 0.75, 0.8], apply: (c, v) => ({ ...c, minCloseLocation: v }) },
  { key: 'buffer', label: 'Buffer: share of the range', values: [0.025, 0.05, 0.075], apply: (c, v) => ({ ...c, bufferRangeFrac: v }) },
  { key: 'firstTarget', label: 'Net reward/risk to target 1', values: [1.5, 2], apply: (c, v) => ({ ...c, minFirstTargetRR: v }) },
];

const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const addMin = (hm, n) => { const [h, m] = hm.split(':').map(Number); const t = h * 60 + m + n; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * One signal's outcome. `signal`: { direction, entryAt 'HH:MM' (first executable minute), stop, confirmedAt,
 * rangeHigh, rangeLow }; `candles`: the day's 1-minute candles.
 */
export function studyOutcome(signal, candles, { horizonMin = STUDY.horizonMin, returnToRangeMin = STUDY.returnToRangeMin } = {}) {
  const byMin = new Map();
  for (const c of candles ?? []) { const k = ist.format(new Date(c[0])); if (!byMin.has(k)) byMin.set(k, c); }
  const first = byMin.get(signal.entryAt);
  if (!first) return { outcome: 'no entry bar' };
  const d = signal.direction;
  const entry = first[1];
  const R = d * (entry - signal.stop);
  if (!(R > 0)) return { outcome: 'entry beyond the stop' };
  let outcome = 'expired';
  let mfe = 0;
  let mae = 0;
  let back = false;
  for (let i = 0; i < horizonMin; i++) {
    const c = byMin.get(addMin(signal.entryAt, i));
    if (!c) continue;
    const [, , h, l] = c;
    const fav = d > 0 ? h - entry : entry - l;
    const adv = d > 0 ? entry - l : h - entry;
    mfe = Math.max(mfe, fav / R);
    mae = Math.max(mae, adv / R);
    if (i < returnToRangeMin && signal.rangeHigh != null && (d > 0 ? l < signal.rangeHigh : h > signal.rangeLow)) back = true;
    if (outcome === 'expired') {
      const up = fav >= R;
      const down = adv >= R;
      if (up && down) outcome = 'ambiguous';
      else if (up) outcome = 'win';
      else if (down) outcome = 'loss';
    }
  }
  const delay = signal.confirmedAt ? (Number(signal.entryAt.slice(3)) + Number(signal.entryAt.slice(0, 2)) * 60) - (Number(signal.confirmedAt.slice(3)) + Number(signal.confirmedAt.slice(0, 2)) * 60) : null;
  return { outcome, entry, R: r2(R), mfeR: r2(mfe), maeR: r2(mae), returnedToRange: back, delayMin: delay };
}

/** Per study row: signals, wins, losses, ambiguous, expired, win share (decided only), MFE/MAE, return-to-range, by side. */
export function studyTable(results) {
  return STUDY_ROWS.map((row) => {
    const rs = results.filter((x) => x.key === row.key && ['win', 'loss', 'ambiguous', 'expired'].includes(x.outcome));
    const count = (o, side) => rs.filter((x) => x.outcome === o && (side == null || x.direction === side)).length;
    const decided = count('win') + count('loss');
    return {
      ...row, signals: rs.length, wins: count('win'), losses: count('loss'), ambiguous: count('ambiguous'), expired: count('expired'),
      winShare: decided ? r2(count('win') / decided) : null,
      long: { signals: rs.filter((x) => x.direction > 0).length, wins: count('win', 1) }, short: { signals: rs.filter((x) => x.direction < 0).length, wins: count('win', -1) },
      avgMfeR: r2(avg(rs.map((x) => x.mfeR))), avgMaeR: r2(avg(rs.map((x) => x.maeR))),
      returnToRange: rs.length ? r2(rs.filter((x) => x.returnedToRange).length / rs.length) : null,
      avgDelayMin: r2(avg(rs.map((x) => x.delayMin).filter((x) => x != null))),
    };
  });
}

/** Every study signal on one prepared day (features + candles), using `cfg` for D. */
export function daySignals(day, cfg) {
  const out = [];
  for (const f of day.features) {
    if (f.candles?.length !== 5 || f.candles.some((c) => !c)) continue;
    const candles = day.candles[f.symbol] ?? [];
    const push = (key, s) => s && out.push({ key, date: day.date, symbol: f.symbol, ...s, ...studyOutcome(s, candles) });
    const rangeOf = (r) => ({ rangeHigh: r?.metrics?.H3 ?? null, rangeLow: r?.metrics?.L3 ?? null });
    const p = breakAndHold(f, { ...cfg, mode: 'paper', requireVolumeMatch: false });
    const confirmed = (r) => r.pattern?.state === 'CONFIRMED';
    if (confirmed(p)) push('primary', { direction: p.direction, stop: p.metrics.stop, entryAt: '09:20', confirmedAt: '09:20', ...rangeOf(p) });
    // Volume-only: the 09:18 break with its volume and candle gates, no hold; stop beyond 09:18's extreme.
    const nh = breakAndHold(f, { ...cfg, mode: 'paper', requireVolumeMatch: false }, { skip: ['hold', 'holdDepth', 'vwap', 'beyond', 'chase', 'obstacle', 'spread'] });
    if (nh.applies && nh.checks.filter((c) => !c.skipped).every((c) => c.ok)) {
      const c4 = f.candles[3];
      push('noHold', { direction: nh.direction, stop: nh.direction > 0 ? c4.l - nh.metrics.b : c4.h + nh.metrics.b, entryAt: '09:19', confirmedAt: '09:19', ...rangeOf(nh) });
    }
    const nv = breakAndHold(f, { ...cfg, mode: 'paper', requireVolumeMatch: false }, { skip: ['breakoutVolume', 'openingVolume', 'history'] });
    if (nv.pattern?.state === 'CONFIRMED' || (nv.applies && nv.checks.every((c) => c.ok || c.skipped))) push('noVolume', { direction: nv.direction, stop: nv.metrics.stop, entryAt: '09:20', confirmedAt: '09:20', ...rangeOf(nv) });
    const later = laterBarsFromCandles(candles);
    if (confirmed(p) && later[0]) {
      const T = p.metrics.threshold;
      const lim = p.direction > 0 ? p.metrics.H3 - p.metrics.b : p.metrics.L3 + p.metrics.b;
      const holds = p.direction * (later[0].c - T) >= 0 && (p.direction > 0 ? later[0].l >= lim : later[0].h <= lim);
      if (holds) push('twoBarHold', { direction: p.direction, stop: p.metrics.stop, entryAt: '09:21', confirmedAt: '09:21', ...rangeOf(p) });
    }
    const pm = breakAndHold(f, { ...cfg, mode: 'paper', requireVolumeMatch: false }, { statistic: 'mean' });
    if (confirmed(pm)) push('mean', { direction: pm.direction, stop: pm.metrics.stop, entryAt: '09:20', confirmedAt: '09:20', ...rangeOf(pm) });
    const v = evaluateVariants(f, later, cfg);
    for (const key of ['fullRange', 'retest', 'c1', 'rvolLeader']) {
      const x = v[key];
      if (x.state !== 'CONFIRMED') continue;
      push(key, { direction: x.direction, stop: x.stop, entryAt: x.entryAt, confirmedAt: x.confirmedAt, rangeHigh: x.reference?.high ?? x.reference?.level ?? null, rangeLow: x.reference?.low ?? x.reference?.level ?? null });
    }
  }
  return out;
}

/** Per-session mean of net P&L with a rough 95% interval (sessions, not trades, are the independent units). */
export function sessionInterval(trades) {
  const byDay = new Map();
  for (const t of trades.filter((x) => x.status === 'CLOSED')) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net);
  const xs = [...byDay.values()];
  if (xs.length < 2) return { sessions: xs.length, meanPerSession: r2(avg(xs)), low: null, high: null };
  const m = avg(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  const half = (1.96 * sd) / Math.sqrt(xs.length);
  return { sessions: xs.length, meanPerSession: r2(m), low: r2(m - half), high: r2(m + half) };
}

/**
 * Everything for the Research page. `prepared`: dayFeatures() output; `runD(days, settings)`: D-alone trades
 * (backtestRunner's runVariant for 'breakHold'); `settings`: { risk, strategies, scoring }.
 */
export function breakHoldResearch(prepared, settings, runD) {
  const cfg = strategySettings(settings?.strategies ?? {}).breakHold ?? DEFAULT_STRATEGY_SETTINGS.breakHold;
  const signals = prepared.flatMap((d) => daySignals(d, cfg));
  const withD = (c) => ({ ...settings, strategies: { ...settings?.strategies, breakHold: c } });
  const sweeps = D_SWEEPS.map((sw) => ({
    key: sw.key, label: sw.label,
    values: sw.values.map((value) => ({ value, summary: summarize(runD(prepared, withD(sw.apply(cfg, value)))) })),
  }));
  // Chronological: 60 sessions to develop, the next 20 untouched (or 75/25 on shorter periods).
  const n = prepared.length;
  const cut = n >= 80 ? 60 : Math.floor(n * 0.75);
  const dev = runD(prepared.slice(0, cut), settings);
  const test = runD(prepared.slice(cut), settings);
  return {
    study: STUDY, table: studyTable(signals),
    signals: signals.map(({ key, date, symbol, direction, outcome, entry, R, mfeR, maeR, returnedToRange, entryAt }) => ({ key, date, symbol, direction, outcome, entry, R, mfeR, maeR, returnedToRange, entryAt })),
    sweeps,
    split: n >= 4 ? {
      rule: n >= 80 ? '60 development sessions, then 20 untouched' : `${cut} development sessions, then ${n - cut} untouched (fewer than 80 days)`,
      devDays: `${prepared[0].date} – ${prepared[cut - 1].date}`, testDays: `${prepared[cut]?.date ?? '—'} – ${prepared.at(-1).date}`,
      dev: summarize(dev), test: summarize(test), devSessions: sessionInterval(dev), testSessions: sessionInterval(test),
    } : { skipped: 'needs at least 4 days' },
    note: 'Defaults stay unless they hold up out of sample and across the nearby values; with few trades the evidence is inconclusive.',
  };
}
