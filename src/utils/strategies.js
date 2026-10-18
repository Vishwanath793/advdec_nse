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
};

export const STRATEGY_LABEL = { orb: 'Opening-range breakout', gapPullback: 'Gap-up pullback recovery', momentum: 'Opening momentum' };

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

export const STRATEGIES = { orb: openingRangeBreakout, gapPullback: gapUpPullbackRecovery, momentum: openingMomentum };

/** Run every enabled strategy on one stock's sealed features. */
export function runStrategies(features, settings) {
  const cfg = strategySettings(settings);
  return Object.entries(STRATEGIES).map(([key, fn]) => fn(features, cfg[key]));
}
