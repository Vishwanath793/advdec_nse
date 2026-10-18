import { istInstant, marketDay } from '../core/calendar.js';
import { tickSize } from './analysis.js';

/**
 * 9:15–9:20 confirmation: after the open, does the gap hold, and can it be
 * traded? Each gapped stock's live Kite quote is checked in two groups:
 *
 *  Signals (they make the score): holding the open, position in the opening
 *  range, VWAP, gap not filled, volume, order book, beyond yesterday's
 *  high/low, Nifty 50 since its open, the sector index since its open, and
 *  strength relative to Nifty.
 *
 *  Safety (they don't change the score; a hard failure means "Avoid"): room
 *  to the circuit limit, bid-ask spread, a recent trade, how wide the stop
 *  is, and whether price has already run far past the entry.
 *
 * The 9:20 reading is kept (opening range frozen) and later prices are
 * compared with that range for the entry.
 */

export const CONFIRM_START = '09:15';
export const CONFIRM_END = '09:20';
/** A first reading after this still counts, but is marked late (range wider than 9:15–9:20). */
export const CONFIRM_LATE = '09:25';
export const MARKET_CLOSE = '15:30';
/** Quote refresh while the page is open: fast until 9:25, then slower until the close. */
export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 15_000;
/** By 9:20, a normal stock trades roughly 5–8% of its daily volume; above 10% is strong. */
export const VOLUME_STRONG_SHARE = 0.10;
export const VOLUME_WEAK_SHARE = 0.05;
export const CONFIRMED_SCORE = 70;
export const FAILING_SCORE = 40;
/** Index or relative move since the open (%) that counts as agreeing / disagreeing. */
export const INDEX_MOVE_PCT = 0.1;
export const REL_STRENGTH_PCT = 0.2;
/** Safety limits. */
export const MIN_CIRCUIT_ROOM_PCT = 2; // less room than this to the circuit: avoid
export const SPREAD_WARN_PCT = 0.15;
export const SPREAD_AVOID_PCT = 0.4;
export const STALE_TRADE_SECONDS = 60;
export const WIDE_STOP_PCT = 2.5;
export const CHASE_PCT = 1; // price already this far beyond the entry: don't chase

export const quoteKey = (symbol) => `NSE:${symbol}`;

/**
 * Every check, with its importance. Weights by tier (defaults; changeable on
 * the Confirm page): more important 3, core price action 2, moderately
 * important 1. Safety checks count in the score too (a caution counts half).
 */
export const CHECK_TIERS = {
  high: { label: 'More important', weight: 3 },
  core: { label: 'Core price action', weight: 2 },
  moderate: { label: 'Moderately important', weight: 1 },
};
export const CONFIRM_CHECKS = [
  { key: 'pdhl', label: "Beyond yesterday's high/low", group: 'signal', tier: 'high' },
  { key: 'circuit', label: 'Room to the circuit', group: 'safety', tier: 'high' },
  { key: 'spread', label: 'Bid-ask spread', group: 'safety', tier: 'high' },
  { key: 'fresh', label: 'Recent trade', group: 'safety', tier: 'high' },
  { key: 'stop', label: 'Stop distance', group: 'safety', tier: 'high' },
  { key: 'chase', label: 'Not chasing', group: 'safety', tier: 'high' },
  { key: 'open', label: 'Holding the open', group: 'signal', tier: 'core' },
  { key: 'range', label: 'In the opening range', group: 'signal', tier: 'core' },
  { key: 'vwap', label: 'VWAP side', group: 'signal', tier: 'core' },
  { key: 'gap', label: 'Gap not filled', group: 'signal', tier: 'core' },
  { key: 'volume', label: 'Volume', group: 'signal', tier: 'core' },
  { key: 'book', label: 'Order book', group: 'signal', tier: 'core' },
  { key: 'market', label: 'Nifty 50 agrees', group: 'signal', tier: 'moderate' },
  { key: 'sector', label: 'Sector index agrees', group: 'signal', tier: 'moderate' },
  { key: 'relative', label: 'Stronger than Nifty', group: 'signal', tier: 'moderate' },
].map((c) => ({ ...c, weight: CHECK_TIERS[c.tier].weight }));
export const MAX_CHECK_WEIGHT = 10;
export const DEFAULT_CHECK_SETTINGS = Object.fromEntries(CONFIRM_CHECKS.map((c) => [c.key, { on: true, weight: c.weight }]));
/** Share of the trade score that comes from the 9:20 confirmation (the rest is the 9:08 conviction). */
export const DEFAULT_TRADE_BLEND = 0.6;
const RESULT_POINTS = { pass: 1, neutral: 0.5, warn: 0.5, fail: 0 };

/** A usable check weight (0..MAX_CHECK_WEIGHT), or null for blank/invalid values. */
export function cleanCheckWeight(value) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_CHECK_WEIGHT, Math.max(0, n)) : null;
}

/** Checks that need Kite market data; skipped (not scored) with NSE prices. */
export const NSE_UNAVAILABLE = [
  { key: 'book', label: 'Order book', group: 'signal' },
  { key: 'spread', label: 'Bid-ask spread', group: 'safety' },
  { key: 'fresh', label: 'Recent trade', group: 'safety' },
];

/** Effective weight per check from settings ({ key: { on, weight } }); off or 0 means not counted. */
export function checkWeights(settings) {
  return Object.fromEntries(CONFIRM_CHECKS.map((c) => {
    const s = settings?.[c.key];
    const on = typeof s?.on === 'boolean' ? s.on : true;
    return [c.key, on ? cleanCheckWeight(s?.weight) ?? c.weight : 0];
  }));
}

/** Kite index instruments: Nifty 50, and a sector index per master-list industry. */
export const MARKET_INDEX = 'NSE:NIFTY 50';
export const SECTOR_INDEX = {
  'Financial Services': 'NSE:NIFTY FIN SERVICE',
  'Information Technology': 'NSE:NIFTY IT',
  'Automobile and Auto Components': 'NSE:NIFTY AUTO',
  Healthcare: 'NSE:NIFTY PHARMA',
  'Fast Moving Consumer Goods': 'NSE:NIFTY FMCG',
  'Metals & Mining': 'NSE:NIFTY METAL',
  Realty: 'NSE:NIFTY REALTY',
  'Oil Gas & Consumable Fuels': 'NSE:NIFTY ENERGY',
  Power: 'NSE:NIFTY ENERGY',
  'Media Entertainment & Publication': 'NSE:NIFTY MEDIA',
  'Capital Goods': 'NSE:NIFTY INFRA',
  Construction: 'NSE:NIFTY INFRA',
  'Construction Materials': 'NSE:NIFTY INFRA',
  'Consumer Durables': 'NSE:NIFTY CONSR DURBL',
};
export const sectorIndexKey = (sector) => SECTOR_INDEX[sector] ?? null;
/** Nifty 50 plus the sector indices of these stocks. */
export const indexInstruments = (stocks) => [MARKET_INDEX, ...new Set(stocks.map((s) => sectorIndexKey(s.sector)).filter(Boolean))];

const istTime = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
const rs = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n, digits = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`;
/** Kite's "2026-10-19 09:19:58" (IST) -> Date. */
const kiteTime = (text) => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(text ?? ''));
  return m ? new Date(`${m[1]}T${m[2]}+05:30`) : null;
};

/**
 * Where trading day `date` is at instant `now`:
 *  'closed'  not a trading day, or `date` isn't today (quotes are a past session's);
 *  'before'  before 9:15;  'forming'  9:15–9:20;  'set'  9:20–15:30;  'after'  after the close.
 */
export function confirmationPhase(now, date, calendar, today) {
  if (!date || date !== today || !marketDay(date, calendar).open) return 'closed';
  if (now < istInstant(date, CONFIRM_START)) return 'before';
  if (now < istInstant(date, CONFIRM_END)) return 'forming';
  if (now <= istInstant(date, MARKET_CLOSE)) return 'set';
  return 'after';
}

/** Minutes since 9:15 on `date` (0..), for scaling the volume check before 9:20. */
export const minutesSinceOpen = (now, date) => Math.max(0, (now - istInstant(date, CONFIRM_START)) / 60_000);

/** The fields used here from a Kite quote (stock or index); null before the first trade. */
export function readQuote(q) {
  if (!q) return null;
  const ltp = Number(q.last_price);
  const open = Number(q.ohlc?.open);
  if (!(ltp > 0) || !(open > 0)) return null;
  const bid = Number(q.depth?.buy?.[0]?.price) || null;
  const ask = Number(q.depth?.sell?.[0]?.price) || null;
  return {
    ltp,
    open,
    high: Number(q.ohlc?.high) || ltp,
    low: Number(q.ohlc?.low) || ltp,
    prevClose: Number(q.ohlc?.close) || null,
    vwap: Number(q.average_price) || null,
    volume: Number(q.volume) || 0,
    buyQty: Number(q.buy_quantity) || 0,
    sellQty: Number(q.sell_quantity) || 0,
    upperLimit: Number(q.upper_circuit_limit) || null,
    lowerLimit: Number(q.lower_circuit_limit) || null,
    bid,
    ask,
    lastTradeAt: kiteTime(q.last_trade_time),
    // NSE fallback quotes have no order book, bid/ask or last-trade time.
    source: q.source === 'nse' ? 'nse' : 'kite',
    hasDepth: Boolean(q.depth),
    quoteAt: kiteTime(q.timestamp),
  };
}

const grade = (value, passAt, failAt) => (value >= passAt ? 'pass' : value <= failAt ? 'fail' : 'neutral');
const fromOpen = (q) => ((q.ltp - q.open) / q.open) * 100;

/**
 * Check one gapped stock against its quote (from readQuote).
 * Options: `minutes` since 9:15; `range` a frozen opening range { high, low };
 * `market` / `sector` index quotes (from readQuote) and `sectorIndex` (name).
 * Returns { status, score, checks, safety, range, plan }: checks/safety are
 * [{ key, label, result, detail }]; safety results are pass / warn / fail.
 */
export function confirmSetup(stock, q, {
  minutes = 5, range = null, market = null, sector = null, sectorIndex = null, checkSettings = null,
} = {}) {
  const dir = stock.status === 'advance' ? 1 : stock.status === 'decline' ? -1 : 0;
  if (!dir || !q) return { status: 'no-data', score: null, checks: [], safety: [], range: null, plan: null, avoidReason: null };
  const up = dir > 0;
  const high = range?.high ?? q.high;
  const low = range?.low ?? q.low;
  const prevClose = q.prevClose ?? stock.prevClose;
  const checks = [];
  const add = (key, label, result, detail) => checks.push({ key, label, result, detail });

  // --- The stock itself ---
  const move = fromOpen(q);
  add('open', 'Holding the open', grade(dir * move, 0.1, -0.1), `Last ${rs(q.ltp)} vs open ${rs(q.open)} (${signed(move)}%)`);

  if (high > low) {
    const pos = (q.ltp - low) / (high - low);
    add('range', 'In the opening range', grade(up ? pos : 1 - pos, 0.6, 0.4),
      `At ${Math.round(pos * 100)}% of the range ${rs(low)}–${rs(high)} (${pos >= 0.6 ? 'near the high' : pos <= 0.4 ? 'near the low' : 'middle'})`);
  }

  if (q.vwap) {
    const diff = ((q.ltp - q.vwap) / q.vwap) * 100;
    add('vwap', up ? 'Above VWAP' : 'Below VWAP', grade(dir * diff, 0.05, -0.05), `Last ${rs(q.ltp)} vs VWAP ${rs(q.vwap)} (${signed(diff)}%)`);
  }

  if (prevClose) {
    const filled = up ? low <= prevClose : high >= prevClose;
    add('gap', 'Gap not filled', filled ? 'fail' : 'pass', filled
      ? `Gap filled: the ${up ? 'low' : 'high'} reached yesterday's close ${rs(prevClose)}`
      : `${up ? 'Low' : 'High'} ${rs(up ? low : high)} stayed ${up ? 'above' : 'below'} yesterday's close ${rs(prevClose)}`);
  }

  if (stock.avgVolume) {
    const share = q.volume / stock.avgVolume;
    const scale = Math.min(1, Math.max(minutes, 0.5) / 5);
    add('volume', 'Volume', grade(share, VOLUME_STRONG_SHARE * scale, VOLUME_WEAK_SHARE * scale),
      `${q.volume.toLocaleString('en-IN')} shares = ${(share * 100).toFixed(1)}% of a normal day (20-day average) so far`);
  }

  if (q.buyQty + q.sellQty > 0) {
    const buyShare = q.buyQty / (q.buyQty + q.sellQty);
    const inDir = up ? buyShare : 1 - buyShare;
    add('book', 'Order book', grade(inDir, 0.55, 0.45), `${Math.round(inDir * 100)}% of pending quantity is ${up ? 'buy' : 'sell'} orders`);
  }

  const level = up ? stock.prevHigh : stock.prevLow;
  if (level) {
    const beyond = up ? q.ltp > level : q.ltp < level;
    add('pdhl', up ? "Above yesterday's high" : "Below yesterday's low", beyond ? 'pass' : 'neutral', beyond
      ? `Last ${rs(q.ltp)} is ${up ? 'above' : 'below'} yesterday's ${up ? 'high' : 'low'} ${rs(level)}: a true breakout`
      : `Still inside yesterday's range (${up ? 'high' : 'low'} ${rs(level)})`);
  }

  // --- The market and the sector ---
  if (market) {
    const m = fromOpen(market);
    add('market', 'Nifty 50 agrees', grade(dir * m, INDEX_MOVE_PCT, -INDEX_MOVE_PCT),
      `Nifty 50 ${signed(m)}% since its open (${market.ltp.toLocaleString('en-IN')})`);
    const rel = dir * (move - m);
    add('relative', 'Stronger than Nifty', grade(rel, REL_STRENGTH_PCT, -REL_STRENGTH_PCT),
      `Stock ${signed(move)}% vs Nifty ${signed(m)}% since the open: ${rel >= REL_STRENGTH_PCT ? 'leading' : rel <= -REL_STRENGTH_PCT ? 'lagging' : 'in line'} in the gap direction`);
  }
  if (sector) {
    const sm = fromOpen(sector);
    add('sector', 'Sector index agrees', grade(dir * sm, INDEX_MOVE_PCT, -INDEX_MOVE_PCT),
      `${(sectorIndex ?? 'Sector index').replace(/^NSE:/, '')} ${signed(sm)}% since its open`);
  }


  // --- Entry plan: a break of the opening range in the gap direction, stop at its other side ---
  const tick = tickSize(q.ltp);
  const entry = Math.round((up ? high + tick : low - tick) * 100) / 100;
  const stop = up ? low : high;
  const plan = high > low ? {
    entry,
    stop,
    riskPct: (Math.abs(entry - stop) / entry) * 100,
    triggered: up ? q.ltp >= entry : q.ltp <= entry,
  } : null;

  // --- Safety: can it be traded sensibly right now? ---
  const safety = [];
  const safe = (key, label, result, detail) => safety.push({ key, label, result, detail });
  const limit = up ? (q.upperLimit ?? stock.upperCircuit) : (q.lowerLimit ?? stock.lowerCircuit);
  if (limit) {
    const room = (dir * (limit - q.ltp) / q.ltp) * 100;
    safe('circuit', 'Room to the circuit', room < MIN_CIRCUIT_ROOM_PCT ? 'fail' : 'pass', room <= 0
      ? `At the ${up ? 'upper' : 'lower'} circuit ${rs(limit)}: locked, an order may not fill`
      : `${room.toFixed(2)}% to the ${up ? 'upper' : 'lower'} circuit ${rs(limit)}${room < MIN_CIRCUIT_ROOM_PCT ? ': too little room for the move' : ''}`);
  }
  if (q.bid && q.ask && q.ask >= q.bid) {
    const spread = ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100;
    safe('spread', 'Bid-ask spread', spread >= SPREAD_AVOID_PCT ? 'fail' : spread >= SPREAD_WARN_PCT ? 'warn' : 'pass',
      `Bid ${rs(q.bid)} / ask ${rs(q.ask)}: ${spread.toFixed(2)}% spread${spread >= SPREAD_WARN_PCT ? ', costly to enter and exit' : ''}`);
  } else if (q.hasDepth) {
    safe('spread', 'Bid-ask spread', 'warn', `No ${!q.bid ? 'buyers' : 'sellers'} in the order book right now`);
  }
  if (q.lastTradeAt && q.quoteAt) {
    const age = (q.quoteAt - q.lastTradeAt) / 1000;
    safe('fresh', 'Recent trade', age > STALE_TRADE_SECONDS ? 'warn' : 'pass',
      age > STALE_TRADE_SECONDS ? `Last trade ${Math.round(age)} s before the quote: thinly traded, price may be stale` : `Last trade ${Math.max(0, Math.round(age))} s ago`);
  }
  if (plan) {
    safe('stop', 'Stop distance', plan.riskPct > WIDE_STOP_PCT ? 'warn' : 'pass',
      `Entry ${rs(plan.entry)}, stop ${rs(plan.stop)}: ${plan.riskPct.toFixed(2)}% risk${plan.riskPct > WIDE_STOP_PCT ? ', wide: use a smaller quantity' : ''}`);
    const past = (dir * (q.ltp - plan.entry) / plan.entry) * 100;
    if (plan.triggered) {
      safe('chase', 'Not chasing', past > CHASE_PCT ? 'warn' : 'pass',
        past > CHASE_PCT ? `Already ${past.toFixed(2)}% past the entry: wait for a pullback towards ${rs(plan.entry)}` : `${past.toFixed(2)}% past the entry`);
    }
  }

  // Weighted score over every check that's on (signals and safety): pass 1, neutral/caution ½, fail 0.
  const weights = checkWeights(checkSettings);
  for (const c of [...checks, ...safety]) c.weight = weights[c.key] ?? 0;
  const counted = [...checks, ...safety].filter((c) => c.weight > 0);
  const total = counted.reduce((s, c) => s + c.weight, 0);
  const score = total ? Math.round((counted.reduce((s, c) => s + c.weight * RESULT_POINTS[c.result], 0) / total) * 100) : null;

  // A filled gap, or a hard safety failure (circuit, spread), overrides the score while that check is on.
  const gapFailed = checks.some((c) => c.key === 'gap' && c.result === 'fail' && c.weight > 0);
  const unsafe = safety.filter((c) => c.result === 'fail' && c.weight > 0);
  const status = gapFailed ? 'failed'
    : unsafe.length ? 'avoid'
      : score == null ? 'no-data'
        : score >= CONFIRMED_SCORE ? 'confirmed' : score <= FAILING_SCORE ? 'failing' : 'mixed';
  // Checks this price source can't do (NSE has no order book, bid/ask or last-trade time).
  const unavailable = q.source === 'nse' ? NSE_UNAVAILABLE : [];
  return { status, score, checks, safety, range: { high, low }, plan, unavailable, avoidReason: unsafe.map((c) => c.label).join(', ') || null };
}

/**
 * The trade score for the 9:15–9:20 entry: the 9:20 confirmation blended
 * with the 9:08 conviction. `blend` is the confirmation's share (0..1).
 */
export function tradeScore(conviction, confirmation, blend = DEFAULT_TRADE_BLEND) {
  if (confirmation == null) return null;
  if (conviction == null) return confirmation;
  const b = Math.min(1, Math.max(0, Number.isFinite(Number(blend)) ? Number(blend) : DEFAULT_TRADE_BLEND));
  return Math.round(b * confirmation + (1 - b) * conviction);
}

/** confirmSetup with the index quotes picked from a quotes map ({ "NSE:…": kite quote }). */
export function confirmFromQuotes(stock, quotes, options = {}) {
  const sectorIndex = sectorIndexKey(stock.sector);
  return confirmSetup(stock, readQuote(quotes[quoteKey(stock.symbol)]), {
    ...options,
    market: readQuote(quotes[MARKET_INDEX]),
    sector: sectorIndex ? readQuote(quotes[sectorIndex]) : null,
    sectorIndex,
  });
}

/**
 * The reading to keep at 9:20 for every scored stock with a quote: price
 * levels and the result (the opening range is the day's high/low at that time).
 */
export function confirmationReading(stocks, quotes, now, date, { checkSettings = null, blend = DEFAULT_TRADE_BLEND } = {}) {
  const minutes = minutesSinceOpen(now, date);
  const readings = {};
  for (const s of stocks) {
    const q = readQuote(quotes[quoteKey(s.symbol)]);
    if (!q || s.convictionScore == null) continue;
    const c = confirmFromQuotes(s, quotes, { minutes, checkSettings });
    readings[s.symbol] = {
      ltp: q.ltp, open: q.open, high: q.high, low: q.low, vwap: q.vwap, volume: q.volume, status: c.status, score: c.score,
      source: q.source,
      tradeScore: tradeScore(s.convictionScore, c.score, blend),
    };
  }
  const nifty = readQuote(quotes[MARKET_INDEX]);
  return {
    date, at: now.toISOString(), late: istTime(now) > CONFIRM_LATE, readings,
    source: Object.values(readings).some((x) => x.source === 'nse') ? 'nse' : 'kite',
    market: nifty ? { ltp: nifty.ltp, open: nifty.open, pct: fromOpen(nifty) } : null,
  };
}

export const STATUS_LABEL = {
  confirmed: 'Confirmed', mixed: 'Mixed', failing: 'Failing', failed: 'Gap filled', avoid: 'Avoid', 'no-data': 'No quote',
};

/*
 * ── 09:20 opening-window score (milestone 2) ────────────────────────────────
 * The same idea as confirmSetup (pass 1, neutral/caution ½, fail 0, weighted),
 * computed from the sealed Kite WebSocket features for one direction and one
 * strategy. Factors are grouped; the group weights are a preset:
 *   unit      every available factor counts the same (the default, like the checks above)
 *   research  price action 20, opening-range setup 20, relative volume 20,
 *             depth 15, F&O 10, sector/benchmark 10, feasibility 5
 * Factors whose data is missing are left out (never invented) and the
 * remaining weights are rescaled; `coverage` says how much was scored.
 * A hard rejection always wins over the score.
 */
export const OPENING_GROUPS = [
  { key: 'price', label: 'Price action', research: 20 },
  { key: 'range', label: 'Opening-range setup', research: 20 },
  { key: 'volume', label: 'Relative volume', research: 20 },
  { key: 'depth', label: 'Market depth', research: 15 },
  { key: 'fo', label: 'F&O', research: 10 },
  { key: 'market', label: 'Sector and benchmark', research: 10 },
  { key: 'feasibility', label: 'Feasibility', research: 5 },
];
export const SCORE_PRESETS = { unit: 'Every factor counts the same', research: 'Research group weights (20/20/20/15/10/10/5)' };
export const DEFAULT_SCORE_PRESET = 'unit';
/** Optional reading of a score. Trading needs at least `minScore` (CONFIRMED_SCORE by default). */
export const SCORE_TIERS = [
  { key: 'strong', label: 'Strong', min: 85 },
  { key: 'watchlist', label: 'Watchlist', min: CONFIRMED_SCORE },
  { key: 'weak', label: 'Weak', min: 50 },
  { key: 'reject', label: 'Reject', min: -Infinity },
];
export const scoreTier = (score) => (score == null ? null : SCORE_TIERS.find((t) => score >= t.min).key);
export const MIN_OPENING_TICKS = 5;

const SRC = {
  ws: 'Kite WebSocket (full mode), 09:15–09:20',
  ohlc: 'Kite WebSocket: the day open/high/low at 09:20',
  candles: 'Minute candles built from sampled ticks (approximate)',
  vwap: 'Kite average traded price (the day VWAP Kite reports)',
  depth: 'Kite five-level market depth (pending orders, not trades)',
  hist: 'Kite historical candles (opening volume averaged over up to 10 days; ATR 14 days)',
  prev: 'NSE previous-day high/low/close (Kite close when they differ)',
  fo: 'Kite WebSocket: near-month future price and open interest',
  index: 'Kite WebSocket: index ticks since 09:15',
  circuit: 'Kite /quote circuit limits (checked before the open)',
  plan: 'Trade plan: tick-rounded levels, slippage and Zerodha charges',
};
const pctTxt = (n) => (n == null || !Number.isFinite(n) ? 'n/a' : `${n.toFixed(2)}%`);
const numTxt = (n, d = 2) => (n == null || !Number.isFinite(n) ? 'n/a' : n.toFixed(d));

/** Every factor for one direction. Each is { group, key, label, result (null = unavailable), detail, source }. */
export function openingFactors(f, { direction, strategy = null, plan = null, minRewardRisk = 1.5, maxSpreadBps = 25 } = {}) {
  const dir = direction > 0 ? 1 : -1;
  const out = [];
  const add = (group, key, label, result, detail, source) => out.push({ group, key, label, result, detail, source });
  const band = (v, good, ok) => (v == null ? null : v >= good ? 'pass' : v >= ok ? 'warn' : 'fail');
  const side = (v, flat = 0) => (v == null ? null : v > flat ? 'pass' : v >= -flat ? 'neutral' : 'fail');

  // Price action
  add('price', 'holdOpen', 'Holding the open', f.ltp != null && f.open ? side((dir * (f.ltp - f.open) / f.open) * 100, 0.05) : null,
    `last ${numTxt(f.ltp)} vs open ${numTxt(f.open)} (${pctTxt(f.ret5Pct)})`, SRC.ohlc);
  const pos = f.closePos == null ? null : dir > 0 ? f.closePos : 1 - f.closePos;
  add('price', 'closePos', 'Close near the range extreme', band(pos, 0.7, 0.4), pos == null ? 'no range' : `close at ${Math.round(f.closePos * 100)}% of the 09:15–09:20 range`, SRC.ohlc);
  const wick = dir > 0 ? f.upperWickPct : f.lowerWickPct;
  add('price', 'candle', 'Five-minute candle', f.bodyPct == null || wick == null ? null : dir * (f.ltp - f.open) <= 0 ? 'fail' : wick <= 30 ? 'pass' : 'warn',
    `body ${pctTxt(f.bodyPct)} of the range, ${dir > 0 ? 'upper' : 'lower'} wick ${pctTxt(wick)}`, SRC.ohlc);
  add('price', 'vwap', `${dir > 0 ? 'Above' : 'Below'} VWAP`, f.vwap ? (dir * (f.ltp - f.vwap) > 0 ? 'pass' : 'fail') : null,
    `${pctTxt(f.vwapDistPct)} from VWAP ${numTxt(f.vwap)}; crossed ${f.vwapCrosses ?? 0} times`, SRC.vwap);
  const mr = (f.minuteReturns ?? []).filter((r) => r != null);
  const same = mr.filter((r) => Math.sign(r) === dir).length;
  add('price', 'consistency', 'Consistent minutes', mr.length ? (same >= 4 ? 'pass' : same >= 3 ? 'warn' : 'fail') : null, `${same} of ${mr.length} minutes ${dir > 0 ? 'up' : 'down'}`, SRC.candles);

  // Opening-range setup
  if (strategy) {
    const done = strategy.checks.filter((c) => c.ok).length;
    const ratio = strategy.checks.length ? done / strategy.checks.length : 0;
    add('range', 'setup', `${strategy.label} checks`, strategy.pass ? 'pass' : ratio >= 0.7 ? 'warn' : 'fail', `${done} of ${strategy.checks.length} checks pass`, 'The strategy rules (utils/strategies.js)');
  }
  add('range', 'rangeAtr', 'Range width vs ATR', f.orRangeAtr == null ? null : f.orRangeAtr >= 0.15 && f.orRangeAtr <= 1.2 ? 'pass' : 'fail', `${numTxt(f.orRangeAtr)}× the 14-day ATR`, SRC.hist);
  const beyond = dir > 0 ? f.distPrevHighPct : f.distPrevLowPct;
  add('range', 'prevDay', `Beyond the previous day ${dir > 0 ? 'high' : 'low'}`, beyond == null ? null : dir * beyond > 0 ? 'pass' : 'neutral',
    `${pctTxt(beyond)} from the previous day ${dir > 0 ? 'high' : 'low'}`, SRC.prev);
  if (f.gapPct != null && Math.sign(f.gapPct) === dir && Math.abs(f.gapPct) >= 0.25) {
    add('range', 'gapHeld', 'Gap not filled', dir * (f.ltp - f.prevClose) > 0 ? 'pass' : 'fail', `gap ${pctTxt(f.gapPct)}, last ${numTxt(f.ltp)} vs previous close ${numTxt(f.prevClose)}`, SRC.prev);
  }

  // Relative volume
  add('volume', 'rvol', 'Relative volume', band(f.rvol, 1.5, 1), f.rvol == null ? 'no historical 09:15–09:20 volume' : `${numTxt(f.rvol)}× the usual opening volume`, SRC.hist);
  add('volume', 'volAccel', 'Volume building', band(f.volAccel, 1.1, 0.8), `${numTxt(f.volAccel)}× (last two minutes vs the first three)`, SRC.candles);

  // Depth
  const d = f.depth;
  add('depth', 'imbalance', 'Book on the right side', d ? band(dir * d.imbalance5, 0.1, -0.1) : null, d ? `top-5 imbalance ${numTxt(d.imbalance5)}` : 'no order book', SRC.depth);
  add('depth', 'spread', 'Spread', d ? (d.spreadBps <= 10 ? 'pass' : d.spreadBps <= maxSpreadBps ? 'warn' : 'fail') : null,
    d ? `${numTxt(d.spreadBps, 1)} bps (mean ${numTxt(d.spreadBpsMean, 1)})` : 'no order book', SRC.depth);
  add('depth', 'stability', 'Book stability', d ? band(d.stability, 0.6, 0.4) : null, d ? `stability ${numTxt(d.stability)}` : 'no order book', SRC.depth);
  add('depth', 'liquidityDrop', 'Liquidity not draining', d?.liquidityDropPct == null ? null : d.liquidityDropPct >= -30 ? 'pass' : d.liquidityDropPct >= -60 ? 'warn' : 'fail',
    `top-5 value ${pctTxt(d?.liquidityDropPct)} vs the window median`, SRC.depth);
  const impact = d ? (dir > 0 ? d.impactBuyBps : d.impactSellBps) : null;
  add('depth', 'impact', 'Impact cost', impact == null ? null : impact <= 10 ? 'pass' : impact <= 25 ? 'warn' : 'fail',
    `${numTxt(impact, 1)} bps to ${dir > 0 ? 'buy' : 'sell'} ₹${(d?.impactNotional ?? 0).toLocaleString('en-IN')}`, SRC.depth);

  // F&O (only stocks with a future, and only from real data)
  const fo = f.fo && !f.fo.missing ? f.fo : null;
  const goodBuild = dir > 0 ? ['long build-up', 'short covering'] : ['short build-up', 'long unwinding'];
  add('fo', 'build', 'Futures open interest', fo?.build == null ? null : fo.build === goodBuild[0] ? 'pass' : fo.build === goodBuild[1] || fo.build === 'neutral' ? 'warn' : 'fail',
    fo ? `${fo.build ?? 'no reading'} (OI ${pctTxt(fo.oiChangePct)})` : f.fo?.missing ?? 'not an F&O stock', SRC.fo);
  add('fo', 'futAgrees', 'Future moving the same way', fo?.agrees == null ? null : fo.agrees ? 'pass' : 'fail', fo ? `future ${pctTxt(fo.retPct)}` : 'n/a', SRC.fo);

  // Sector and benchmark
  const m = f.market ?? {};
  add('market', 'nifty', 'Nifty 50 agrees', m.nifty ? side(dir * m.nifty.pct, INDEX_MOVE_PCT) : null, m.nifty ? `Nifty 50 ${pctTxt(m.nifty.pct)} since 09:15` : 'no Nifty ticks', SRC.index);
  add('market', 'sector', 'Sector index agrees', m.sector ? side(dir * m.sector.pct, INDEX_MOVE_PCT) : null, m.sector ? `${m.sector.symbol} ${pctTxt(m.sector.pct)}` : 'no sector index for this stock', SRC.index);
  add('market', 'relative', 'Relative strength vs Nifty', m.relVsNiftyPct == null ? null : side(dir * m.relVsNiftyPct, REL_STRENGTH_PCT), `${pctTxt(m.relVsNiftyPct)} vs Nifty`, SRC.index);

  // Feasibility
  const limit = dir > 0 ? f.upperCircuit : f.lowerCircuit;
  const room = limit && f.ltp ? (dir * (limit - f.ltp) / f.ltp) * 100 : null;
  add('feasibility', 'circuitRoom', 'Room to the circuit', room == null ? null : room >= MIN_CIRCUIT_ROOM_PCT ? 'pass' : 'fail', `${pctTxt(room)} to ₹${limit ?? 'n/a'}`, SRC.circuit);
  add('feasibility', 'rewardRisk', 'Reward/risk after costs', plan?.rewardRisk == null ? null : plan.rewardRisk >= minRewardRisk ? 'pass' : 'fail',
    plan ? `${numTxt(plan.rewardRisk)} (min ${minRewardRisk})` : 'no plan', SRC.plan);
  add('feasibility', 'fresh', 'Fresh data', f.quality ? (f.quality.stale ? 'fail' : 'pass') : null, f.quality ? `last tick ${f.quality.lastTickAgeSec ?? 'n/a'} s before 09:20` : 'n/a', SRC.ws);
  return out;
}

/** The 09:20 score for one direction (and strategy, when given): { score, tier, preset, groups, factors, coverage }. */
export function scoreOpening(f, options = {}) {
  const preset = options.preset === 'research' ? 'research' : 'unit';
  const factors = openingFactors(f, options);
  const available = factors.filter((x) => x.result != null);
  const groups = OPENING_GROUPS.map((g) => {
    const own = available.filter((x) => x.group === g.key);
    const score = own.length ? own.reduce((s, x) => s + RESULT_POINTS[x.result], 0) / own.length : null;
    return { key: g.key, label: g.label, weight: preset === 'research' ? g.research : own.length, factors: own.length, score: score == null ? null : Math.round(score * 100) };
  });
  const counted = groups.filter((g) => g.score != null && g.weight > 0);
  const total = counted.reduce((s, g) => s + g.weight, 0);
  const score = total ? Math.round(counted.reduce((s, g) => s + g.weight * g.score, 0) / total) : null;
  const full = preset === 'research' ? OPENING_GROUPS.reduce((s, g) => s + g.research, 0) : factors.length;
  const coverage = full ? Math.round(((preset === 'research' ? total : available.length) / full) * 100) : 0;
  return { score, tier: scoreTier(score), preset, groups, factors, coverage };
}

/**
 * Reasons that rule a stock out at 09:20 whatever its score (fail closed):
 * stale or too little data, no two-sided book, at a circuit limit, a partial
 * window, and the 09:10 tradeability blocks.
 */
export function openingRejections(f, { direction = 0, partial = false } = {}) {
  const reasons = [];
  if (partial) reasons.push('the window was only partly collected (backend started after 09:15)');
  if (!f.quality || f.quality.ticks < MIN_OPENING_TICKS) reasons.push(`too few ticks (${f.quality?.ticks ?? 0})`);
  if (f.quality?.stale) reasons.push(`stale: last tick ${f.quality.lastTickAgeSec ?? '?'} s before 09:20`);
  if (!f.depth || !(f.depth.bestBid > 0) || !(f.depth.bestAsk > 0)) reasons.push('no live two-sided order book');
  if (f.upperCircuit && f.ltp >= f.upperCircuit && direction >= 0) reasons.push('at the upper circuit');
  if (f.lowerCircuit && f.ltp <= f.lowerCircuit && direction <= 0) reasons.push('at the lower circuit');
  for (const flag of f.flags ?? []) if (flag.severity === 'block') reasons.push(`${flag.label}: ${flag.detail ?? 'blocked at 09:10'}`);
  return reasons;
}
