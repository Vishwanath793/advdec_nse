import { breakAndHold, DEFAULT_STRATEGY_SETTINGS } from './strategies.js';

/**
 * Strategy D's later variants (docs/plan-920-volume-breakout-confirmation.md §9), each with its own identity,
 * reference and expiry, and all shadow-only: evaluated and recorded, never traded. They need bars after 09:20,
 * so they are judged once those bars are complete (the trading desk at 09:25:30 from the recorded ticks, or
 * candle research). None of them can turn a failed primary hold into a success.
 *   fullRange   the 09:15–09:20 range, frozen at 09:20; a breakout bar from 09:20 and a hold bar after it
 *               (earliest confirmation 09:22), confirmed before the deadline (09:25), else EXPIRED
 *   retest      after a valid 09:18 breakout: up to two quiet pullback bars into the buffered level and one
 *               recovery bar, before the deadline
 *   c1, rvolLeader   the primary rules on another frozen reference (§9.3), as comparisons
 * Pure: bars in, states out.
 */

export const VARIANT_LABEL = {
  fullRange: 'Full five-minute range, close and hold', retest: 'Retest of the 3-minute level',
  c1: '09:15-candle reference', rvolLeader: 'Highest-RVOL-candle reference',
};
export const DEFAULT_VARIANT_SETTINGS = { deadline: '09:25', maxPullbacks: 2, maxPullbackParticipation: 0.7, minRecoveryBody: 0.5, minRecoveryRvol: 1.2 };
const LATER = ['09:20', '09:21', '09:22', '09:23', '09:24'];
const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const hhmm = (minutesAfter0920) => { const t = 20 + minutesAfter0920; return `09:${String(t).padStart(2, '0')}`; };
const tickUp = (p, tick) => Math.round(Math.ceil(p / tick - 1e-9) * tick * 100) / 100;
const tickDown = (p, tick) => Math.round(Math.floor(p / tick + 1e-9) * tick * 100) / 100;

/** The five bars 09:20–09:24 from one instrument's recorded ticks (sampled LTP, cumulative volume, Kite's average price). */
export function laterBarsFromTicks(ticks) {
  const bars = LATER.map(() => null);
  let lastVolume = null;
  for (const t of [...ticks].filter((x) => x.exchangeTime && x.ltp > 0).sort((a, b) => a.exchangeTime - b.exchangeTime)) {
    const m = ist.format(new Date(t.exchangeTime));
    const i = LATER.indexOf(m);
    const inc = t.volume != null && lastVolume != null && t.volume > lastVolume ? t.volume - lastVolume : 0;
    if (t.volume != null) lastVolume = t.volume;
    if (i < 0) continue;
    const b = (bars[i] ??= { o: t.ltp, h: t.ltp, l: t.ltp, c: t.ltp, volume: 0, vwap: null, approximate: true });
    b.h = Math.max(b.h, t.ltp);
    b.l = Math.min(b.l, t.ltp);
    b.c = t.ltp;
    b.volume += inc;
    if (t.avgPrice > 0) b.vwap = t.avgPrice;
  }
  return bars;
}

/** The five bars 09:20–09:24 from a day's 1-minute candles ([Date|ms, o, h, l, c, v]); VWAP computed from 09:15. */
export function laterBarsFromCandles(candles) {
  const bars = LATER.map(() => null);
  let pv = 0;
  let vol = 0;
  for (const c of [...(candles ?? [])].sort((a, b) => +new Date(a[0]) - +new Date(b[0]))) {
    const m = ist.format(new Date(c[0]));
    if (m < '09:15' || m > '09:24') continue;
    pv += ((c[2] + c[3] + c[4]) / 3) * c[5];
    vol += c[5];
    const i = LATER.indexOf(m);
    if (i >= 0) bars[i] = { o: c[1], h: c[2], l: c[3], c: c[4], volume: c[5], vwap: vol ? pv / vol : null, approximate: false };
  }
  return bars;
}

const out = (variant, fields) => ({ variant, label: VARIANT_LABEL[variant], shadow: true, direction: null, confirmedAt: null, entryAt: null, stop: null, threshold: null, ...fields });
const body = (b, dir) => (b.h > b.l ? (dir * (b.c - b.o)) / (b.h - b.l) : null);
const closeLoc = (b, dir) => (b.h > b.l ? (dir > 0 ? b.c - b.l : b.h - b.c) / (b.h - b.l) : null);

/** §9.1: the full five-minute range, close and hold (earliest confirmation 09:22). */
export function fullRangeVariant(f, later, cfg = DEFAULT_STRATEGY_SETTINGS.breakHold, v = DEFAULT_VARIANT_SETTINGS) {
  const c = f.candles ?? [];
  if (c.length < 5 || c.some((x) => !x)) return out('fullRange', { state: 'DATA_INSUFFICIENT', code: 'DATA_INSUFFICIENT' });
  const tick = f.tick || 0.05;
  const H5 = Math.max(...c.map((x) => x.h));
  const L5 = Math.min(...c.map((x) => x.l));
  if (!(H5 > L5)) return out('fullRange', { state: 'DATA_INSUFFICIENT', code: 'DATA_INSUFFICIENT' });
  const spread = f.spreadRef5?.samples >= cfg.minSpreadSamples ? f.spreadRef5.rupees : null;
  const b = tickUp(Math.max(cfg.bufferTicks * tick, spread ?? 0, cfg.bufferRangeFrac * (H5 - L5)), tick);
  const longT = tickUp(H5 + b, tick);
  const shortT = tickDown(L5 - b, tick);
  const vb = f.volumeBaselines;
  const reference = { type: 'C1-C5', high: H5, low: L5, buffer: b, longThreshold: longT, shortThreshold: shortT, frozenAt: '09:20' };
  if (!(vb?.openingMedian > 0) || vb.sessions < cfg.minBaselineSessions) return out('fullRange', { state: 'DATA_INSUFFICIENT', code: 'INSUFFICIENT_VOLUME_HISTORY', reference });
  const openingRvol = f.windowVolume / vb.openingMedian;
  if (!(openingRvol >= cfg.minOpeningRvol)) return out('fullRange', { state: 'INVALIDATED', code: 'WEAK_OPENING_VOLUME', reference, openingRvol });
  for (let k = 0; k < LATER.length; k++) {
    const B = later?.[k];
    if (!B) return out('fullRange', { state: 'DATA_INSUFFICIENT', code: 'DATA_INSUFFICIENT', reference, detail: `no ${LATER[k]} bar` });
    const dir = B.o <= longT && B.c >= longT ? 1 : B.o >= shortT && B.c <= shortT ? -1 : 0;
    if (!dir) {
      if (B.o > longT || B.o < shortT) return out('fullRange', { state: 'INVALIDATED', code: 'OUTSIDE_PRIMARY', reference, detail: `${LATER[k]} opened beyond the level` });
      if (B.h >= longT || B.l <= shortT) return out('fullRange', { state: 'INVALIDATED', code: 'NO_BREAKOUT_CLOSE', reference, detail: `${LATER[k]} crossed and closed back inside` });
      continue;
    }
    const T = dir > 0 ? longT : shortT;
    const confirmAt = hhmm(k + 2); // the hold bar's end
    if (confirmAt >= v.deadline) return out('fullRange', { state: 'EXPIRED', code: 'DEADLINE', direction: dir, threshold: T, reference, detail: `the hold would complete at ${confirmAt}, at or after ${v.deadline}` });
    const H = later[k + 1];
    if (!H) return out('fullRange', { state: 'DATA_INSUFFICIENT', code: 'DATA_INSUFFICIENT', direction: dir, threshold: T, reference });
    const base = vb.minuteMedian?.[5 + k];
    const rvol = base > 0 ? B.volume / base : null;
    const fail = rvol == null ? ['DATA_INSUFFICIENT', 'INSUFFICIENT_VOLUME_HISTORY']
      : rvol < cfg.minBreakoutRvol ? ['INVALIDATED', 'WEAK_BREAKOUT_VOLUME']
        : !(body(B, dir) >= cfg.minBodyRatio && closeLoc(B, dir) >= cfg.minCloseLocation) ? ['INVALIDATED', 'WEAK_BREAKOUT_CANDLE']
          : !(B.vwap != null && dir * (B.c - B.vwap) > 0 && H.vwap != null && dir * (H.c - H.vwap) > 0) ? ['INVALIDATED', 'WRONG_SIDE_OF_VWAP']
            : dir * (H.c - T) < 0 ? ['INVALIDATED', 'HOLD_NOT_CONFIRMED']
              : (dir > 0 ? H.l < H5 - b : H.h > L5 + b) ? ['INVALIDATED', 'HOLD_TOO_DEEP'] : null;
    const evidence = { breakout: { at: LATER[k], ...B, minuteRvol: rvol, bodyRatio: body(B, dir), closeLocation: closeLoc(B, dir) }, hold: { at: LATER[k + 1], ...H } };
    if (fail) return out('fullRange', { state: fail[0], code: fail[1], direction: dir, threshold: T, reference, openingRvol, evidence });
    const stop = dir > 0 ? tickDown(Math.min(B.l, H.l) - b, tick) : tickUp(Math.max(B.h, H.h) + b, tick);
    return out('fullRange', { state: 'CONFIRMED', code: 'CONFIRMED', direction: dir, threshold: T, stop, confirmedAt: confirmAt, entryAt: confirmAt, reference, openingRvol, evidence });
  }
  return out('fullRange', { state: 'EXPIRED', code: 'NO_BREAK', reference });
}

/** §9.2: retest of the primary 3-minute level after a valid 09:18 breakout. */
export function retestVariant(f, later, cfg = DEFAULT_STRATEGY_SETTINGS.breakHold, v = DEFAULT_VARIANT_SETTINGS) {
  const p = breakAndHold(f, { ...cfg, mode: 'shadow', requireVolumeMatch: false });
  const ok = (key) => p.checks.find((x) => x.key === key)?.ok === true;
  if (!p.applies || !ok('candle') || !ok('breakoutVolume') || !ok('history')) return out('retest', { state: 'INVALIDATED', code: 'NO_VALID_BREAKOUT', detail: p.reason ?? p.code });
  const dir = p.direction;
  const tick = f.tick || 0.05;
  const { b, H3, L3, breakoutRvol } = p.metrics;
  const level = dir > 0 ? H3 : L3;
  const zone = [level - b, level + b];
  const mm = f.volumeBaselines?.minuteMedian ?? [];
  // The bars after the breakout: 09:19 (C5), then 09:20 onwards, each completed before the deadline.
  const bars = [{ ...f.candles[4], vwap: f.minuteVwap?.[4] ?? null, at: '09:19', end: '09:20', base: mm[4] },
    ...LATER.map((m, k) => (later?.[k] ? { ...later[k], at: m, end: hhmm(k + 1), base: mm[5 + k] } : null))];
  const pulls = [];
  const reference = { type: 'C1-C3 retest zone', level, buffer: b, zone };
  for (const bar of bars) {
    if (!bar) return out('retest', { state: 'DATA_INSUFFICIENT', code: 'DATA_INSUFFICIENT', direction: dir, reference });
    if (bar.end >= v.deadline) break;
    const rvol = bar.base > 0 ? bar.volume / bar.base : null;
    const touches = dir > 0 ? bar.l <= zone[1] && bar.h >= zone[0] : bar.h >= zone[0] && bar.l <= zone[1];
    const violates = dir > 0 ? bar.l < zone[0] || bar.c < level : bar.h > zone[1] || bar.c > level;
    const meanPull = pulls.length ? pulls.reduce((s, x) => s + (x.rvol ?? 0), 0) / pulls.length : null;
    const last = pulls.at(-1);
    const recovery = last && (dir > 0 ? bar.c > zone[1] && bar.c > last.h : bar.c < zone[0] && bar.c < last.l)
      && body(bar, dir) >= v.minRecoveryBody && rvol != null && rvol >= v.minRecoveryRvol && rvol > meanPull;
    if (recovery) {
      const ratio = breakoutRvol > 0 ? meanPull / breakoutRvol : null;
      if (ratio == null || ratio > v.maxPullbackParticipation) return out('retest', { state: 'INVALIDATED', code: 'PULLBACK_TOO_ACTIVE', direction: dir, reference, detail: `pullback participation ${ratio?.toFixed(2)} (max ${v.maxPullbackParticipation})` });
      const extreme = dir > 0 ? Math.min(...pulls.map((x) => x.l)) : Math.max(...pulls.map((x) => x.h));
      const stop = dir > 0 ? tickDown(extreme - b, tick) : tickUp(extreme + b, tick);
      return out('retest', {
        state: 'CONFIRMED', code: 'RETEST', direction: dir, threshold: dir > 0 ? zone[1] : zone[0], stop, confirmedAt: bar.end, entryAt: bar.end, reference,
        evidence: { pullbacks: pulls, recovery: { ...bar, rvol }, participationRatio: ratio },
      });
    }
    if (violates) return out('retest', { state: 'INVALIDATED', code: 'RETURNED_INTO_RANGE', direction: dir, reference, detail: `${bar.at} went back into the range` });
    if (touches) {
      if (pulls.length >= v.maxPullbacks) return out('retest', { state: 'INVALIDATED', code: 'TOO_MANY_PULLBACKS', direction: dir, reference });
      pulls.push({ ...bar, rvol });
    } else if (pulls.length) {
      return out('retest', { state: 'INVALIDATED', code: 'WEAK_RECOVERY', direction: dir, reference, detail: `${bar.at} left the zone without a qualifying recovery` });
    }
  }
  return out('retest', { state: 'EXPIRED', code: pulls.length ? 'NO_RECOVERY' : 'NO_RETEST', direction: dir, reference });
}

/** §9.3: the primary rules on another frozen reference, confirmed (or not) at 09:20. */
export function altReferenceVariant(f, kind, cfg = DEFAULT_STRATEGY_SETTINGS.breakHold) {
  const r = breakAndHold(f, { ...cfg, mode: 'shadow', requireVolumeMatch: false }, { reference: kind });
  const confirmed = r.pattern?.state === 'CONFIRMED';
  return out(kind, {
    state: r.pattern?.state ?? 'INVALIDATED', code: r.code, direction: r.direction ?? null, threshold: r.metrics?.threshold ?? null,
    stop: r.metrics?.stop ?? null, confirmedAt: confirmed ? '09:20' : null, entryAt: confirmed ? '09:20' : null,
    reference: r.evidence?.reference ?? null,
  });
}

/** Every variant for one stock. `later`: the five bars 09:20–09:24 (laterBarsFromTicks / laterBarsFromCandles). */
export function evaluateVariants(f, later, cfg = DEFAULT_STRATEGY_SETTINGS.breakHold, v = DEFAULT_VARIANT_SETTINGS) {
  return {
    symbol: f.symbol,
    fullRange: fullRangeVariant(f, later, cfg, v), retest: retestVariant(f, later, cfg, v),
    c1: altReferenceVariant(f, 'c1', cfg), rvolLeader: altReferenceVariant(f, 'rvolLeader', cfg),
  };
}

