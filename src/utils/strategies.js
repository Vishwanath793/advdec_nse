/**
 * The 09:20 strategies, as pure functions of the sealed opening-window features
 * (utils/openingWindow.js). Each returns every check it made with a reason, and
 * a signal (direction, trigger, stop, targets) only when all checks pass.
 *
 * Every threshold is a research hypothesis to be tested on recorded days, not a
 * known edge. Minute candles are built from sampled ticks, so the pullback and
 * momentum checks that use them are approximate.
 */

export const DEFAULT_STRATEGY_SETTINGS = {
  orb: {
    enabled: true, allowShorts: true,
    minClosePos: 0.7, // long: close in the top 30% of the range (short: bottom 30%)
    minRvol: 1.2, minRangeAtr: 0.15, maxRangeAtr: 1.2, wideRangeAtr: 0.8,
    maxSpreadBps: 15, sectorTolerancePct: 0.1,
    target1R: 1.5, target2R: 3, // targets as multiples of the entry-to-stop risk
  },
  gapPullback: {
    enabled: true,
    minGapPct: 3.75, minPullbackPct: 0.5, maxGapRetracePct: 60, minRecovery: 0.5,
    minRecoveryVolumeRatio: 1.2, minImbalance: -0.1, maxStopPct: 3, maxSpreadBps: 20,
  },
  momentum: {
    enabled: true, allowShorts: true,
    minConsistentMinutes: 4, minRvol: 1.5, minClosePos: 0.8, maxOppositeWickPct: 25,
    maxVwapDistPct: 1.5, maxRet5Pct: 3.0, maxRangeAtr: 1.2, minStability: 0.4, minImbalance: -0.1,
    maxSpreadBps: 15, minStopAtr: 0.2, target1R: 1.5, target2R: 3,
  },
  breakHold: {
    enabled: true, mode: 'shadow', allowShorts: true, // shadow: evaluated and shown, never traded; 'paper' trades it
    minOpeningRvol: 1.5, minBreakoutRvol: 1.5, minBodyRatio: 0.6, minCloseLocation: 0.75, maxWickRatio: 0.25,
    bufferTicks: 2, bufferRangeFrac: 0.05, minSpreadSamples: 3, minBaselineSessions: 15, maxSpreadBps: 15,
    maxChaseR: 0.5, target1R: 2, target2R: 3, minFirstTargetRR: 1.5, entryDeadline: '09:21',
  },
};
/** Text settings and their allowed values (the rest are numbers or switches; entryDeadline is a time). */
export const STRATEGY_CHOICES = { mode: ['shadow', 'paper'] };

export const STRATEGY_LABEL = { orb: 'Opening-range breakout', gapPullback: 'Gap-up pullback recovery', momentum: 'Opening momentum', breakHold: '3-minute break and hold' };

const f2 = (n) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(2));
const sideWord = (dir) => (dir > 0 ? 'long' : 'short');

/** Merge user settings over the defaults (per strategy). */
export function strategySettings(input = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_STRATEGY_SETTINGS).map(([k, d]) => [k, { ...d, ...(input?.[k] ?? {}) }]));
}

function make(strategy) {
  const checks = [];
  const check = (key, label, ok, detail) => { checks.push({ key, label, ok: Boolean(ok), detail }); return Boolean(ok); };
  // Candle backtests have no order book: book checks are recorded as not tested, not as passed on made-up data.
  const untested = (key, label) => { checks.push({ key, label, ok: true, untested: true, detail: NO_BOOK }); return true; };
  check.book = (f, key, label, ok, detail) => (noBook(f) ? untested(key, label) : check(key, label, ok, detail));
  const result = (fields) => ({ strategy, label: STRATEGY_LABEL[strategy], checks, ...fields, pass: fields.applies && checks.every((c) => c.ok) && Boolean(fields.signal) });
  return { check, result };
}

const NO_BOOK = 'not tested: candle data has no order book';
const noBook = (f) => f.source === 'candles';
const sectorAgainst = (f, dir, tol) => f.market?.sector && dir * f.market.sector.pct < -tol;
const liquid = (check, f, maxBps) => check.book(f, 'spread', 'Spread and book', f.depth && f.depth.spreadBps <= maxBps,
  f.depth ? `${f2(f.depth.spreadBps)} bps (max ${maxBps})` : 'no live two-sided order book');

/** A. Opening-range breakout (long) or breakdown (short). */
export function openingRangeBreakout(f, cfg = DEFAULT_STRATEGY_SETTINGS.orb) {
  const { check, result } = make('orb');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  if (f.closePos == null || f.ret5Pct == null) return result({ applies: false, reason: 'no opening range' });
  const dir = f.closePos >= cfg.minClosePos && f.ret5Pct > 0 ? 1 : f.closePos <= 1 - cfg.minClosePos && f.ret5Pct < 0 ? -1 : 0;
  if (!dir) return result({ applies: false, reason: `close at ${Math.round(f.closePos * 100)}% of the range: not at an extreme` });
  check('close', 'Constructive first five minutes', true, `close at ${Math.round(f.closePos * 100)}% of the range, ${f2(f.ret5Pct)}% since the open`);
  if (dir < 0) check('shorts', 'Shorts allowed (MIS only)', cfg.allowShorts, cfg.allowShorts ? 'intraday short' : 'short selling turned off');
  check('rvol', 'Volume above the opening norm', f.rvol != null && f.rvol >= cfg.minRvol, f.rvol == null ? 'no historical opening-volume baseline' : `RVOL ${f2(f.rvol)} (min ${cfg.minRvol})`);
  check('vwap', `${dir > 0 ? 'Above' : 'Below'} VWAP`, f.vwap != null && dir * (f.ltp - f.vwap) > 0, `last ${f2(f.ltp)} vs VWAP ${f2(f.vwap)}`);
  check('sector', 'Sector not against', !sectorAgainst(f, dir, cfg.sectorTolerancePct), f.market?.sector ? `${f.market.sector.symbol} ${f2(f.market.sector.pct)}%` : 'no sector index (not required)');
  const rangeOk = f.orRangeAtr == null || (f.orRangeAtr >= cfg.minRangeAtr && f.orRangeAtr <= cfg.maxRangeAtr);
  check('range', 'Range width vs ATR', rangeOk, f.orRangeAtr == null ? 'ATR not available (not required)' : `${f2(f.orRangeAtr)}× ATR (allowed ${cfg.minRangeAtr}–${cfg.maxRangeAtr})`);
  liquid(check, f, cfg.maxSpreadBps);
  const range = f.orHigh - f.orLow;
  const wide = f.orRangeAtr != null && f.orRangeAtr > cfg.wideRangeAtr;
  const tick = f.tick || 0.05;
  const trigger = dir > 0 ? f.orHigh + tick : f.orLow - tick;
  const stop = wide ? (f.orHigh + f.orLow) / 2 : dir > 0 ? f.orLow : f.orHigh;
  const signal = range > 0 ? {
    direction: dir, trigger, stop,
    target1: trigger + dir * cfg.target1R * Math.abs(trigger - stop), target2: trigger + dir * cfg.target2R * Math.abs(trigger - stop),
    note: `break ${dir > 0 ? 'above' : 'below'} the 09:15–09:20 ${dir > 0 ? 'high' : 'low'}; stop at the ${wide ? 'range midpoint (wide range)' : `range ${dir > 0 ? 'low' : 'high'}`}; targets ${cfg.target1R}R and ${cfg.target2R}R`,
  } : null;
  return result({ applies: true, direction: dir, signal, summary: `${sideWord(dir)} ${dir > 0 ? 'breakout' : 'breakdown'} setup` });
}

/** B. Gap-up pullback recovery (long only). A gap alone is never a reason to buy. */
export function gapUpPullbackRecovery(f, cfg = DEFAULT_STRATEGY_SETTINGS.gapPullback) {
  const { check, result } = make('gapPullback');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  if (f.gapPct == null || f.gapPct < cfg.minGapPct) return result({ applies: false, reason: `gap ${f2(f.gapPct)}% is below ${cfg.minGapPct}%` });
  const candles = (f.candles ?? []).map((c, i) => (c ? { ...c, i } : null)).filter(Boolean);
  if (candles.length < 3) return result({ applies: true, direction: 1, signal: null, reason: 'too few minute candles' });
  // The pullback low is the window's lowest minute; the high it pulled back from is
  // the highest minute before it. A recovery may go on to make new highs.
  const trough = candles.reduce((a, c) => (c.l < a.l ? c : a));
  const before = candles.filter((c) => c.i < trough.i);
  const peak = before.length ? before.reduce((a, c) => (c.h > a.h ? c : a)) : trough;
  const recoveryCandles = candles.filter((c) => c.i > trough.i);
  check('order', 'High, then pullback, then recovery', before.length > 0 && recoveryCandles.length > 0,
    before.length ? `high in minute ${peak.i + 1}, pullback low in minute ${trough.i + 1}, ${recoveryCandles.length} minute(s) after it` : 'the low was in the first minute: no pullback');
  const pullbackPct = ((peak.h - trough.l) / peak.h) * 100;
  check('pullback', 'A real pullback from the high', pullbackPct >= cfg.minPullbackPct, `${f2(pullbackPct)}% from ${f2(peak.h)} to ${f2(trough.l)} (min ${cfg.minPullbackPct}%)`);
  const gapRetrace = f.open > f.prevClose ? ((f.open - trough.l) / (f.open - f.prevClose)) * 100 : null;
  check('gapHeld', 'Gap not filled', trough.l > f.prevClose && (gapRetrace == null || gapRetrace <= cfg.maxGapRetracePct),
    `low ${f2(trough.l)} vs previous close ${f2(f.prevClose)}; ${f2(gapRetrace)}% of the gap given back (max ${cfg.maxGapRetracePct}%)`);
  const recovery = peak.h > trough.l ? (f.ltp - trough.l) / (peak.h - trough.l) : 0;
  check('recovery', 'Recovered from the low', recovery >= cfg.minRecovery, `${Math.round(recovery * 100)}% of the pullback recovered (min ${Math.round(cfg.minRecovery * 100)}%)`);
  check('vwap', 'Back above VWAP', f.vwap != null && f.ltp > f.vwap, `last ${f2(f.ltp)} vs VWAP ${f2(f.vwap)}${f.vwapReclaim ? ' (reclaimed)' : ''}`);
  const sellMinutes = candles.filter((c) => c.i >= peak.i && c.i <= trough.i);
  const sellRate = sellMinutes.reduce((s, c) => s + c.volume, 0) / Math.max(1, sellMinutes.length);
  const buyRate = recoveryCandles.reduce((s, c) => s + c.volume, 0) / Math.max(1, recoveryCandles.length);
  const volRatio = sellRate > 0 ? buyRate / sellRate : null;
  check('volume', 'Recovery volume stronger than the selling', volRatio != null && volRatio >= cfg.minRecoveryVolumeRatio,
    volRatio == null ? 'no volume during the pullback' : `${f2(volRatio)}× the pullback's volume per minute (min ${cfg.minRecoveryVolumeRatio}); weaker means a dead-cat bounce`);
  check.book(f, 'book', 'Book not offer-heavy', f.depth != null && f.depth.imbalance5 >= cfg.minImbalance,
    f.depth ? `top-5 imbalance ${f2(f.depth.imbalance5)} (change ${f2(f.depth.imbalanceChange)}; pending orders, not trades)` : 'no order book');
  if (f.fo && !f.fo.missing) check('fo', 'Futures not in short build-up', f.fo.build !== 'short build-up', `${f.fo.build ?? 'no reading'}`);
  liquid(check, f, cfg.maxSpreadBps);
  const tick = f.tick || 0.05;
  const lastHigh = recoveryCandles.at(-1)?.h ?? f.ltp;
  const trigger = Math.max(lastHigh, f.ltp) + tick;
  const stop = trough.l - tick;
  const stopPct = ((trigger - stop) / trigger) * 100;
  check('stopWidth', 'Stop distance acceptable', stopPct <= cfg.maxStopPct, `${f2(stopPct)}% from entry to the pullback low (max ${cfg.maxStopPct}%)`);
  const R = trigger - stop;
  const signal = {
    direction: 1, trigger, stop, target1: Math.max(peak.h, trigger + R), target2: Math.max(peak.h + (peak.h - trough.l), trigger + 2 * R),
    note: 'buy a break of the recovery candle\'s high; stop below the pullback low; target 1 the day\'s high (at least 1R), target 2 a measured move (at least 2R)',
  };
  return result({ applies: true, direction: 1, signal, summary: 'gap-up recovery setup', metrics: { pullbackPct, recovery, volRatio, gapRetrace } });
}

/** C. Opening momentum, entered right after 09:20 at the live price. */
export function openingMomentum(f, cfg = DEFAULT_STRATEGY_SETTINGS.momentum) {
  const { check, result } = make('momentum');
  if (!cfg.enabled) return result({ applies: false, reason: 'turned off' });
  if (f.ret5Pct == null || f.ret5Pct === 0) return result({ applies: false, reason: 'no move since the open' });
  const dir = Math.sign(f.ret5Pct);
  const consistent = (f.minuteReturns ?? []).filter((r) => r != null && Math.sign(r) === dir).length;
  if (consistent < cfg.minConsistentMinutes - 1) return result({ applies: false, reason: `only ${consistent} of 5 minutes moved ${dir > 0 ? 'up' : 'down'}` });
  if (dir < 0) check('shorts', 'Shorts allowed (MIS only)', cfg.allowShorts, cfg.allowShorts ? 'intraday short' : 'short selling turned off');
  check('consistent', 'Consistent direction', consistent >= cfg.minConsistentMinutes, `${consistent} of 5 minutes ${dir > 0 ? 'up' : 'down'} (min ${cfg.minConsistentMinutes})`);
  check('rvol', 'Strong relative volume', f.rvol != null && f.rvol >= cfg.minRvol, f.rvol == null ? 'no historical opening-volume baseline' : `RVOL ${f2(f.rvol)} (min ${cfg.minRvol})`);
  const pos = dir > 0 ? f.closePos : 1 - f.closePos;
  check('extreme', 'Close near the range extreme', pos != null && pos >= cfg.minClosePos, `close at ${Math.round((f.closePos ?? 0) * 100)}% of the range`);
  const oppositeWick = dir > 0 ? f.upperWickPct : f.lowerWickPct;
  check('wick', 'Small rejection wick', oppositeWick != null && oppositeWick <= cfg.maxOppositeWickPct, `${f2(oppositeWick)}% of the range (max ${cfg.maxOppositeWickPct}%)`);
  const nifty = f.market?.nifty;
  check('market', 'Nifty and sector aligned', nifty && dir * nifty.pct > 0 && !(f.market?.sector && dir * f.market.sector.pct <= 0),
    `Nifty ${f2(nifty?.pct)}%${f.market?.sector ? `, ${f.market.sector.symbol} ${f2(f.market.sector.pct)}%` : ', no sector index'}`);
  check.book(f, 'book', 'Stable book on the right side', f.depth != null && dir * f.depth.imbalance5 >= cfg.minImbalance && (f.depth.stability == null || f.depth.stability >= cfg.minStability),
    f.depth ? `imbalance ${f2(f.depth.imbalance5)}, stability ${f2(f.depth.stability)} (pending orders, not trades)` : 'no order book');
  check('notExtended', 'Not overextended', f.vwapDistPct != null && dir * f.vwapDistPct <= cfg.maxVwapDistPct && dir * f.ret5Pct <= cfg.maxRet5Pct && (f.orRangeAtr == null || f.orRangeAtr <= cfg.maxRangeAtr),
    `${f2(f.vwapDistPct)}% from VWAP (max ${cfg.maxVwapDistPct}), ${f2(f.ret5Pct)}% since the open (max ${cfg.maxRet5Pct}), range ${f2(f.orRangeAtr)}× ATR`);
  liquid(check, f, cfg.maxSpreadBps);
  const last = (f.candles ?? []).filter(Boolean).at(-1);
  const entry = dir > 0 ? f.depth?.bestAsk ?? f.ltp : f.depth?.bestBid ?? f.ltp;
  let stop = dir > 0 ? Math.max(f.vwap ?? -Infinity, last?.l ?? -Infinity) : Math.min(f.vwap ?? Infinity, last?.h ?? Infinity);
  if (!Number.isFinite(stop)) stop = entry - dir * (f.atr14 ?? entry * 0.01) * 0.5;
  if (f.atr14 && dir * (entry - stop) < cfg.minStopAtr * f.atr14) stop = entry - dir * cfg.minStopAtr * f.atr14; // not inside the noise
  const R = Math.abs(entry - stop);
  const signal = {
    direction: dir, immediate: true, trigger: entry, stop, target1: entry + dir * cfg.target1R * R, target2: entry + dir * cfg.target2R * R,
    note: `enter after 09:20 at the live ask (bid for shorts); invalidation below VWAP / the last minute's low (above, for shorts); targets ${cfg.target1R}R and ${cfg.target2R}R`,
  };
  return result({ applies: true, direction: dir, signal, summary: `${sideWord(dir)} momentum setup` });
}

/*
 * D. Three-minute break and hold (docs/plan-920-volume-breakout-confirmation.md). The reference is the
 * C1–C3 range (09:15–09:18), frozen before the break; C4 (09:18–09:19) must break it with a strong candle on
 * at least 1.5× its usual same-minute volume, and C5 (09:19–09:20) must close beyond the buffered level again
 * without retesting deep inside. Every rule is a gate; Nifty, sector, OI and acceleration stay context.
 * Starts in shadow mode (evaluated and shown, never traded) until the opening-volume convention has been
 * reconciled against Kite's historical minute bars; switch it to paper in Settings.
 */
export const BREAK_HOLD_CODES = {
  shorts: 'SHORTS_OFF', history: 'INSUFFICIENT_VOLUME_HISTORY', breakoutVolume: 'WEAK_BREAKOUT_VOLUME', candle: 'WEAK_BREAKOUT_CANDLE',
  hold: 'HOLD_NOT_CONFIRMED', holdDepth: 'HOLD_TOO_DEEP', vwap: 'WRONG_SIDE_OF_VWAP', openingVolume: 'WEAK_OPENING_VOLUME',
  spreadRef: 'DATA_INSUFFICIENT', spread: 'SPREAD_TOO_WIDE', beyond: 'PRICE_BACK_INSIDE', chase: 'EXTENDED_ENTRY', obstacle: 'OBSTACLE_TOO_CLOSE',
};
const tickUp = (p, tick) => Math.round(Math.ceil(p / tick - 1e-9) * tick * 100) / 100;
const tickDown = (p, tick) => Math.round(Math.floor(p / tick + 1e-9) * tick * 100) / 100;

export function breakAndHold(f, cfg = DEFAULT_STRATEGY_SETTINGS.breakHold) {
  const { check, result } = make('breakHold');
  const done = (fields) => {
    const r = result(fields);
    const failed = r.checks.find((c) => !c.ok);
    r.code = !r.applies ? fields.code ?? null : failed ? BREAK_HOLD_CODES[failed.key] ?? 'NOT_CONFIRMED' : r.signal ? 'CONFIRMED' : 'NOT_CONFIRMED';
    if (r.pass && cfg.mode !== 'paper') { r.shadow = true; r.reason = 'confirmed in shadow mode: shown, not traded (Settings: switch D to paper)'; }
    return r;
  };
  if (!cfg.enabled) return done({ applies: false, reason: 'turned off', code: 'OFF' });
  const c = f.candles ?? [];
  if (c.length < 5 || c.slice(0, 5).some((x) => !x)) return done({ applies: false, reason: 'a minute 09:15–09:19 has no data', code: 'DATA_INSUFFICIENT' });
  const [c1, c2, c3, c4, c5] = c;
  const tick = f.tick || 0.05;
  const H3 = Math.max(c1.h, c2.h, c3.h);
  const L3 = Math.min(c1.l, c2.l, c3.l);
  const W3 = H3 - L3;
  if (!(W3 > 0)) return done({ applies: false, reason: 'no 09:15–09:18 range', code: 'DATA_INSUFFICIENT' });
  // The frozen buffer: at least two ticks, the reference spread (live only) and 5% of the reference range.
  const spread = f.spreadRef?.samples >= cfg.minSpreadSamples ? f.spreadRef.rupees : null;
  const b = tickUp(Math.max(cfg.bufferTicks * tick, spread ?? 0, cfg.bufferRangeFrac * W3), tick);
  const longT = tickUp(H3 + b, tick);
  const shortT = tickDown(L3 - b, tick);
  const metrics = { H3, L3, b, longThreshold: longT, shortThreshold: shortT, bufferSource: noBook(f) ? 'proxy (no spread in candle data)' : spread != null ? 'reference spread' : 'ticks and range only' };
  // Which high-volume candle of C1–C3 (context, never the reference).
  const mm = f.volumeBaselines?.minuteMedian ?? [];
  const firstThree = [c1, c2, c3].map((x, i) => ({ i, volume: x.volume, rvol: mm[i] > 0 ? x.volume / mm[i] : null }));
  metrics.largestVolumeMinute = firstThree.reduce((a, x) => (x.volume > a.volume ? x : a)).i + 1;
  const byRvol = firstThree.filter((x) => x.rvol != null);
  metrics.largestRvolMinute = byRvol.length ? byRvol.reduce((a, x) => (x.rvol > a.rvol ? x : a)).i + 1 : null;

  let dir = 0;
  if (c4.o <= longT && c4.c >= longT) dir = 1;
  else if (c4.o >= shortT && c4.c <= shortT) dir = -1;
  if (!dir) {
    const why = c4.o > longT || c4.o < shortT ? ['already beyond the level when 09:18 opened: outside this strategy', 'OUTSIDE_PRIMARY']
      : c4.h >= longT || c4.l <= shortT ? ['09:18 crossed the level but closed back inside', 'NO_BREAKOUT_CLOSE']
        : c5.c >= longT || c5.c <= shortT ? ['the break started in the last minute: wait (no 09:20 confirmation)', 'WAIT']
          : ['no break of the 09:15–09:18 range', 'NO_BREAK'];
    return done({ applies: false, reason: why[0], code: why[1], metrics });
  }
  const T = dir > 0 ? longT : shortT;
  const side = dir > 0 ? 'above' : 'below';
  if (dir < 0) check('shorts', 'Shorts allowed (MIS only)', cfg.allowShorts, cfg.allowShorts ? 'intraday short' : 'short selling turned off');
  const vb = f.volumeBaselines;
  const histOk = Boolean(vb && vb.sessions >= cfg.minBaselineSessions && vb.openingMedian > 0 && vb.minuteMedian?.[3] > 0);
  check('history', 'Volume history', histOk, vb ? `${vb.sessions} earlier sessions (min ${cfg.minBaselineSessions}), median opening volume ${vb.openingMedian ?? 'n/a'}` : 'no median volume baselines');
  const breakoutRvol = histOk ? c4.volume / vb.minuteMedian[3] : null;
  const openingRvol = histOk ? f.windowVolume / vb.openingMedian : null;
  check('breakoutVolume', '09:18 minute on strong volume', breakoutRvol != null && breakoutRvol >= cfg.minBreakoutRvol, `${f2(breakoutRvol)}× the usual 09:18 minute (min ${cfg.minBreakoutRvol})`);
  const r4 = c4.h - c4.l;
  const body = r4 > 0 ? (dir * (c4.c - c4.o)) / r4 : null;
  const closeLoc = r4 > 0 ? (dir > 0 ? c4.c - c4.l : c4.h - c4.c) / r4 : null;
  const wick = r4 > 0 ? (dir > 0 ? c4.h - c4.c : c4.c - c4.l) / r4 : null;
  check('candle', 'Strong breakout candle', body != null && body >= cfg.minBodyRatio && closeLoc >= cfg.minCloseLocation,
    `body ${f2(body)} of the range (min ${cfg.minBodyRatio}), close location ${f2(closeLoc)} (min ${cfg.minCloseLocation}), rejection wick ${f2(wick)}${wick > cfg.maxWickRatio ? ` (above ${cfg.maxWickRatio})` : ''}`);
  check('hold', `09:19 closes ${side} the level again`, dir * (c5.c - T) >= 0, `09:19 close ${f2(c5.c)} vs level ${f2(T)}`);
  const limit = dir > 0 ? H3 - b : L3 + b;
  check('holdDepth', 'Retest no deeper than the buffer', dir > 0 ? c5.l >= limit : c5.h <= limit, `09:19 ${dir > 0 ? 'low' : 'high'} ${f2(dir > 0 ? c5.l : c5.h)} vs ${f2(limit)}`);
  const v4 = f.minuteVwap?.[3];
  const v5 = f.minuteVwap?.[4];
  check('vwap', `09:18, 09:19 and now ${side} VWAP`, v4 != null && v5 != null && f.vwap != null && dir * (c4.c - v4) > 0 && dir * (c5.c - v5) > 0 && dir * (f.ltp - f.vwap) > 0,
    `closes ${f2(c4.c)} / ${f2(c5.c)} vs VWAP ${f2(v4)} / ${f2(v5)}; now ${f2(f.ltp)} vs ${f2(f.vwap)} (${f.vwapSource ?? 'VWAP'})`);
  check('openingVolume', 'Opening five minutes on strong volume', openingRvol != null && openingRvol >= cfg.minOpeningRvol, `${f2(openingRvol)}× the median opening (min ${cfg.minOpeningRvol})`);
  check.book(f, 'spreadRef', 'Reference spread measured before 09:18', spread != null, `${f.spreadRef?.samples ?? 0} spread samples 09:17:30–09:18 (min ${cfg.minSpreadSamples})`);
  liquid(check, f, cfg.maxSpreadBps);

  const S = dir > 0 ? tickDown(Math.min(c4.l, c5.l) - b, tick) : tickUp(Math.max(c4.h, c5.h) + b, tick);
  const structural = dir * (T - S);
  const entry = noBook(f) ? f.ltp : dir > 0 ? f.depth?.bestAsk ?? f.ltp : f.depth?.bestBid ?? f.ltp;
  check('beyond', `Price still ${side} the level`, dir * (entry - T) >= 0, `entry ${f2(entry)} vs level ${f2(T)}`);
  check('chase', 'Entry not extended', structural > 0 && dir * (entry - T) <= cfg.maxChaseR * structural,
    `${f2(dir * (entry - T))} beyond the level (max ${f2(cfg.maxChaseR * structural)}: ${cfg.maxChaseR}× the structural risk)`);
  // First target: target1R from the entry, capped before the nearest known obstacle (previous-day high/low, circuit).
  const R = dir * (entry - S);
  const obstacles = [dir > 0 ? f.prevHigh : f.prevLow, dir > 0 ? f.upperCircuit : f.lowerCircuit].filter((x) => x > 0 && dir * (x - entry) > 0);
  const nearest = obstacles.length ? (dir > 0 ? Math.min(...obstacles) : Math.max(...obstacles)) : null;
  const cap = nearest != null ? nearest - dir * b : null;
  if (cap != null) check('obstacle', 'Room before the nearest obstacle', dir * (cap - entry) > 0, `${dir > 0 ? 'previous-day high or circuit' : 'previous-day low or circuit'} at ${f2(nearest)}, less the buffer: ${f2(cap)}`);
  const capped = (p) => (cap == null ? p : dir > 0 ? Math.min(p, cap) : Math.max(p, cap));
  const target1 = capped(entry + dir * cfg.target1R * R);
  const t2 = capped(entry + dir * cfg.target2R * R);
  const target2 = dir * t2 >= dir * target1 ? t2 : target1;
  const signal = R > 0 ? {
    direction: dir, immediate: true, trigger: entry, stop: S, target1, target2,
    minFirstTargetRR: cfg.minFirstTargetRR, entryDeadline: cfg.entryDeadline,
    note: `09:15–09:18 range broken at 09:18 and held at 09:19; enter at the ${dir > 0 ? 'ask' : 'bid'} by ${cfg.entryDeadline}; stop ${dir > 0 ? 'below the 09:18–09:19 lows' : 'above the 09:18–09:19 highs'} less the buffer; target 1 ${cfg.target1R}R${cap != null ? ' (capped before the obstacle)' : ''}`,
  } : null;
  Object.assign(metrics, { breakoutRvol, openingRvol, body, closeLocation: closeLoc, wick, threshold: T, stop: S, structuralRisk: structural });
  return done({ applies: true, direction: dir, signal, summary: `${sideWord(dir)} break and hold`, metrics });
}

export const STRATEGIES = { orb: openingRangeBreakout, gapPullback: gapUpPullbackRecovery, momentum: openingMomentum, breakHold: breakAndHold };

/** Run every enabled strategy on one stock's sealed features. */
export function runStrategies(features, settings) {
  const cfg = strategySettings(settings);
  return Object.entries(STRATEGIES).map(([key, fn]) => fn(features, cfg[key]));
}
