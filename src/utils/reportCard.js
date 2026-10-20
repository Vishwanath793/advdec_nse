import { analyze } from './analysis.js';
import { CONVICTION_FACTORS } from './conviction.js';
import { isTradeable } from './tradeability.js';

/**
 * Report card: how recorded pre-open setups actually played out.
 *
 * A trade is entered at the pre-open final price in the gap direction (buy a
 * gap-up, short a gap-down) and measured on that day's end-of-day file:
 *  - ret:    close vs entry, in the gap direction (% ; + means the gap continued)
 *  - best:   best price of the day vs entry (high for a gap-up, low for a gap-down)
 *  - worst:  worst price of the day vs entry
 *  - filled: price came back to the previous close (the gap filled)
 */

/** Top picks per day per direction in the "picks" comparison. */
export const PICKS_PER_DAY = 5;
/** A day/direction needs this many trades for its factor correlations to count. */
export const MIN_TRADES_FOR_RHO = 10;
export const CONFIRM_STATUSES = ['confirmed', 'mixed', 'failing', 'failed', 'avoid'];
export const SCORE_BANDS = [[70, 101, '70–100'], [60, 70, '60–69'], [50, 60, '50–59'], [0, 50, 'Under 50']];

const ALL_ON = Object.fromEntries(CONVICTION_FACTORS.map((f) => [f.key, { on: true, weight: f.weight }]));

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(values.length);
  for (let k = 0; k < order.length;) {
    let j = k;
    while (j + 1 < order.length && order[j + 1][0] === order[k][0]) j++;
    for (let m = k; m <= j; m++) r[order[m][1]] = (k + j) / 2; // ties share the average rank
    k = j + 1;
  }
  return r;
}

/** Spearman rank correlation (tie-aware); null when either side is constant or n < 3. */
export function spearman(x, y) {
  if (x.length < 3 || new Set(x).size < 2 || new Set(y).size < 2) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = avg(rx);
  const my = avg(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/**
 * Score one recorded day and measure each gap trade against its outcome.
 * `outcome` is that day's end-of-day file ({ SYMBOL: { high, low, close, open } }).
 */
export function dayTrades({ date, rows, masterRows, secList, context, outcome, factorSettings, confirm = null }) {
  const scored = analyze(rows, masterRows, secList, { context, convictionFactors: factorSettings }).stocks;
  const allOn = new Map(analyze(rows, masterRows, secList, { context, convictionFactors: ALL_ON }).stocks.map((s) => [s.symbol, s]));
  const trades = [];
  for (const s of scored) {
    const day = outcome?.[s.symbol];
    if (s.convictionScore == null || !s.finalPrice || !day || !(day.close > 0)) continue;
    const dir = s.status === 'advance' ? 1 : -1;
    const entry = s.finalPrice;
    const move = (price) => ((dir * (price - entry)) / entry) * 100;
    trades.push({
      date,
      symbol: s.symbol,
      dir,
      gap: s.pctChange,
      score: s.convictionScore,
      history: s.historyScore ?? null, // the separate History-layer score (utils/historyLayer.js)
      tradeable: isTradeable(s),
      factors: Object.fromEntries((allOn.get(s.symbol)?.conviction?.factors ?? []).map((f) => [f.key, f.value])),
      ret: move(day.close),
      best: move(dir > 0 ? day.high : day.low),
      worst: move(dir > 0 ? day.low : day.high),
      filled: s.prevClose != null && (dir > 0 ? day.low <= s.prevClose : day.high >= s.prevClose),
      // 9:20 confirmation, and the close measured from the 9:20 price.
      ...(confirm?.[s.symbol]?.ltp > 0 ? {
        confirm: confirm[s.symbol].status,
        ret920: ((dir * (day.close - confirm[s.symbol].ltp)) / confirm[s.symbol].ltp) * 100,
      } : {}),
    });
  }
  return trades;
}

/** Summary of a group of trades. */
export function tradeStats(trades) {
  if (!trades.length) return { n: 0, continued: null, avgRet: null, avgBest: null, avgWorst: null, filled: null };
  return {
    n: trades.length,
    continued: trades.filter((t) => t.ret > 0).length / trades.length,
    avgRet: avg(trades.map((t) => t.ret)),
    avgBest: avg(trades.map((t) => t.best)),
    avgWorst: avg(trades.map((t) => t.worst)),
    filled: trades.filter((t) => t.filled).length / trades.length,
  };
}

const topBy = (trades, key) => [...trades].sort((a, b) => key(b) - key(a) || a.symbol.localeCompare(b.symbol)).slice(0, PICKS_PER_DAY);

/**
 * Verdict for a factor from its per-day correlations: "helps" when it ranked
 * outcomes the right way on average and on most days, "hurts" when the
 * reverse, otherwise "unclear". Each day contributes up to two correlations (gap-ups
 * and gap-downs); `min` of them are needed before judging.
 */
export const MIN_RHOS_FOR_VERDICT = 10;
/** A market-wide factor's correlation across day-sides must reach this size for a verdict. */
export const MARKET_WIDE_RHO = 0.2;

/**
 * Market-wide factors (A/D, GIFT Nifty, VIX, FII/DII) give every gap-up the
 * same value on a day, so they can't rank stocks within a day. Instead each
 * day-side (that day's gap-ups, or its gap-downs) is one observation: does a
 * higher factor value go with a better average result for that side?
 */
function marketWideFactor(f, days) {
  const points = { up: [], down: [] };
  for (const d of days) {
    for (const [name, dir] of [['up', 1], ['down', -1]]) {
      const t = d.trades.filter((x) => x.dir === dir && x.factors[f.key] != null);
      if (t.length < MIN_TRADES_FOR_RHO) continue;
      points[name].push([avg(t.map((x) => x.factors[f.key])), avg(t.map((x) => x.ret))]);
    }
  }
  const all = [...points.up, ...points.down];
  const rho = spearman(all.map(([x]) => x), all.map(([, y]) => y));
  const side = (p) => ({ rho: null, days: p.length, positiveDays: null });
  let verdict = 'too few days';
  if (all.length >= MIN_RHOS_FOR_VERDICT) verdict = rho == null ? 'unclear' : rho >= MARKET_WIDE_RHO ? 'helps' : rho <= -MARKET_WIDE_RHO ? 'hurts' : 'unclear';
  return { key: f.key, label: f.label, marketWide: true, up: side(points.up), down: side(points.down), rho, verdict };
}

export function factorVerdict(rhos, min = MIN_RHOS_FOR_VERDICT) {
  if (rhos.length < min) return 'too few days';
  const mean = avg(rhos);
  const positive = rhos.filter((r) => r > 0).length / rhos.length;
  if (mean >= 0.05 && positive >= 0.6) return 'helps';
  if (mean <= -0.05 && positive <= 0.4) return 'hurts';
  return 'unclear';
}

/**
 * Build the report card from scored days: [{ date, trades }] (oldest first).
 * Correlations are taken within each day and direction, then averaged, so a
 * day when everything rose doesn't masquerade as a good factor.
 */
export function buildReportCard(days) {
  const directions = { up: 1, down: -1 };
  const all = days.flatMap((d) => d.trades);
  const byDir = (dir) => all.filter((t) => t.dir === dir);

  const perDay = days.map((d) => {
    const out = { date: d.date, trades: d.trades.length };
    for (const [name, dir] of Object.entries(directions)) {
      const t = d.trades.filter((x) => x.dir === dir);
      out[name] = {
        ...tradeStats(t),
        scoreRho: t.length >= MIN_TRADES_FOR_RHO ? spearman(t.map((x) => x.score), t.map((x) => x.ret)) : null,
        top: tradeStats(topBy(t.filter((x) => x.tradeable), (x) => x.score)),
        topPicks: topBy(t.filter((x) => x.tradeable), (x) => x.score).map((x) => ({ symbol: x.symbol, score: x.score, ret: x.ret })),
      };
    }
    return out;
  });

  const bands = {};
  const picks = {};
  for (const [name, dir] of Object.entries(directions)) {
    const t = byDir(dir);
    bands[name] = SCORE_BANDS.map(([lo, hi, label]) => ({ label, ...tradeStats(t.filter((x) => x.score >= lo && x.score < hi)) }));
    const daily = (pick) => days.flatMap((d) => pick(d.trades.filter((x) => x.dir === dir)));
    picks[name] = {
      conviction: tradeStats(daily((t2) => topBy(t2.filter((x) => x.tradeable), (x) => x.score))),
      history: tradeStats(daily((t2) => topBy(t2.filter((x) => x.tradeable && x.history != null), (x) => x.history))),
      gap: tradeStats(daily((t2) => topBy(t2, (x) => Math.abs(x.gap)))),
      all: tradeStats(t),
    };
  }

  const factors = CONVICTION_FACTORS.map((f) => {
    if (f.marketWide) return marketWideFactor(f, days);
    const out = { key: f.key, label: f.label };
    const both = [];
    for (const [name, dir] of Object.entries(directions)) {
      const rhos = [];
      for (const d of days) {
        const t = d.trades.filter((x) => x.dir === dir && x.factors[f.key] != null);
        if (t.length < MIN_TRADES_FOR_RHO) continue;
        const r = spearman(t.map((x) => x.factors[f.key]), t.map((x) => x.ret));
        if (r != null) rhos.push(r);
      }
      both.push(...rhos);
      out[name] = { rho: avg(rhos), days: rhos.length, positiveDays: rhos.filter((r) => r > 0).length };
    }
    out.rho = avg(both);
    out.verdict = factorVerdict(both);
    return out;
  });

  // 9:20 confirmation: by status, the close measured from the 9:20 price and from the pre-open price.
  const confirmed = all.filter((t) => t.confirm);
  const confirmation = {
    days: new Set(confirmed.map((t) => t.date)).size,
    statuses: CONFIRM_STATUSES.map((status) => {
      const t = confirmed.filter((x) => x.confirm === status);
      return {
        status,
        n: t.length,
        continued: t.length ? t.filter((x) => x.ret920 > 0).length / t.length : null,
        avgRet920: avg(t.map((x) => x.ret920)),
        avgRet: avg(t.map((x) => x.ret)),
      };
    }),
  };

  const scoreRhos = perDay.flatMap((d) => [d.up.scoreRho, d.down.scoreRho]).filter((r) => r != null);
  return {
    days: perDay,
    totals: { days: days.length, trades: all.length, scoreRho: avg(scoreRhos), scoreRhoDays: scoreRhos.length },
    bands,
    picks,
    factors,
    confirmation,
  };
}
