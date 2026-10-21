import { istInstant } from '../core/calendar.js';

/**
 * Auction layer: inference from the NSE pre-open call auction as it forms,
 * read from Kite's /quote every few seconds between 09:00 and the close of
 * order entry (core/auctionTracker.js records it). NSE's 09:10 pre-open import
 * only has the final result; Kite shows how it got there.
 *
 * Since 7 Sep 2026 Kite's /quote updates these fields during the pre-open
 * (Zerodha's announcement on the Kite Connect forum, 5 Sep 2026; the main
 * quote docs don't list them yet):
 *   ohlc.open            indicative equilibrium price (IEP)
 *   volume               indicative matched volume
 *   buy_quantity         indicative cumulative buy quantity
 *   sell_quantity        indicative cumulative sell quantity
 *   total_imbalance_qty  indicative imbalance quantity
 * Equity cash and derivatives both have the pre-open, so near-month futures
 * and the Nifty / Bank Nifty futures are recorded too.
 *
 * Like the History layer it sits on top of the conviction score without
 * changing it: a separate Auction score, and factors that are off in the
 * conviction until added. Every threshold is a hypothesis until the report
 * card shows otherwise.
 *
 * Recorded file (auction/YYYY-MM-DD.json, written by the tracker):
 *   { version, date, keys: ["NSE:INFY", "NFO:INFY26OCTFUT", ...],
 *     meta: [[prevClose, lowerCircuit, upperCircuit], ...]   (aligned with keys)
 *     futures: { INFY: "NFO:INFY26OCTFUT", NIFTY: "NFO:NIFTY26OCTFUT", ... },
 *     snaps: [{ t: epoch ms, q: [[keyIndex, iep, volume, buyQty, sellQty, imbalanceQty], ...] }] }
 */

export const AUCTION_GROUP = 'auction';
const SOURCE = 'Kite /quote during the pre-open (09:00–09:09), recorded by the app';

export const AUCTION_FACTORS = [
  { key: 'aDrift', label: 'Gap built during the auction', help: 'How the indicative gap changed from 09:04 to the end of order entry: a gap that grew as orders came in supports it, one that shrank is against it. Full marks when it grew by its own size (or 0.5 points for small gaps).' },
  { key: 'aOrdersHeld', label: 'Gap-side orders held', help: "Share of pending orders on the gap side at the end of order entry vs its average through the auction: orders added late support the gap, orders pulled late (cancelled before the close of order entry) are against it. Full marks at 10 points above the average." },
  { key: 'aImbalance', label: 'Unmatched auction demand', help: "Kite's indicative imbalance quantity as a multiple of the matched volume, on the side with more orders: demand left unfilled at the equilibrium price supports the gap. Full marks at 1× the matched volume. The side is read from the buy/sell totals unless Kite sends a negative imbalance." },
  { key: 'aFutures', label: 'Futures auction vs cash', help: "F&O stocks: the near-month future's pre-open gap minus the stock's own gap. Futures gapping harder than the cash stock (the basis widening in the gap direction) supports it. Full marks at 0.5 points." },
  { key: 'aRoom', label: 'Room to the circuit', help: "Distance from the indicative price to Kite's circuit limit in the gap direction: a gap that is about to lock has little room to continue and may not be tradeable. Full marks at 3% or more; zero at the limit." },
  { key: 'aNifty', label: 'Nifty futures pre-open', marketWide: true, help: "The Nifty near-month future's indicative gap (Bank Nifty shown for reference): up supports gap-ups, down supports gap-downs. Full marks at ±1%." },
].map((f) => ({ ...f, weight: 20, defaultOn: false, group: AUCTION_GROUP, source: SOURCE }));

/** The early reading the drift is measured from. */
export const AUCTION_REF_TIME = '09:04';
/**
 * After the matching, Kite reports the imbalance as 0 for every stock (21 Oct
 * 2026: 774 stocks non-zero at 09:08:33, 612 at 09:08:49, 46 at 09:09:06, none
 * at 09:09:22). The imbalance is read from the close-of-entry reading: the last
 * sweep in which at least this share of the day's peak number of stocks still
 * reported one.
 */
export const CLOSE_IMBALANCE_SHARE = 0.5;

/** Time of the close-of-entry sweep (see CLOSE_IMBALANCE_SHARE), or null without imbalance data. */
export function closeOfEntryAt(snaps) {
  const counts = snaps.map((s) => (s.q ?? []).filter((r) => r[5] != null && r[5] !== 0).length);
  const peak = Math.max(0, ...counts);
  if (!peak) return null;
  for (let i = snaps.length - 1; i >= 0; i--) if (counts[i] >= peak * CLOSE_IMBALANCE_SHARE) return snaps[i].t;
  return null;
}
/** The drift needs at least this long between the early and the final reading. */
export const MIN_DRIFT_MS = 2 * 60_000;
/** Full-marks points. */
export const DRIFT_MIN_BASE_PTS = 0.5;
export const HELD_FULL_PTS = 0.1;
export const IMBALANCE_FULL_X = 1;
export const FUTURES_FULL_PTS = 0.5;
export const ROOM_FULL_PCT = 3;
export const NIFTY_FULL_PCT = 1;
export const MIN_AUCTION_FACTORS = 2;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const clampSigned = (n) => Math.max(-1, Math.min(1, n));
const signed = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const times = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
const leaning = (v) => (v >= 0.6 ? 'supports the gap' : v <= 0.4 ? 'against the gap' : 'neutral');
const hhmm = (t) => new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const gapOf = (price, close) => (price > 0 && close > 0 ? (price / close - 1) * 100 : null);

/** One instrument's readings (only those with an indicative price), oldest first. */
function seriesByKey(saved) {
  const series = saved.keys.map(() => []);
  for (const snap of saved.snaps) {
    for (const [i, iep, volume, buy, sell, imbalance] of snap.q ?? []) {
      if (series[i] && iep > 0) series[i].push({ t: snap.t, iep, volume, buy, sell, imbalance });
    }
  }
  return series;
}

/** Features for one instrument, or null without an indicative price. */
function instrumentFeatures(points, meta, ref, close) {
  if (!points.length) return null;
  const [prevClose = null, lower = null, upper = null] = meta ?? [];
  const last = points.at(-1);
  const early = [...points].reverse().find((p) => p.t <= ref);
  // Imbalance (with the volume and order totals it is compared with) from before the matching.
  const atClose = [...points].reverse().find((p) => p.t <= close) ?? last;
  const share = (p) => (p.buy + p.sell > 0 ? p.buy / (p.buy + p.sell) : null);
  const shares = points.map(share).filter((s) => s != null);
  return {
    iep: last.iep,
    prevClose,
    gap: gapOf(last.iep, prevClose),
    at: last.t,
    readings: points.length,
    earlyGap: early && last.t - early.t >= MIN_DRIFT_MS ? gapOf(early.iep, prevClose) : null,
    earlyAt: early?.t ?? null,
    buyShare: share(last),
    avgBuyShare: shares.length >= 3 ? shares.reduce((a, b) => a + b, 0) / shares.length : null,
    volume: last.volume ?? null,
    buyQty: last.buy ?? null,
    sellQty: last.sell ?? null,
    imbalance: last.imbalance ?? null,
    imbalanceAtClose: atClose.imbalance ?? null,
    volumeAtClose: atClose.volume ?? null,
    buyAtClose: atClose.buy ?? null,
    sellAtClose: atClose.sell ?? null,
    closeAt: atClose.t,
    lowerCircuit: lower,
    upperCircuit: upper,
  };
}

/**
 * The day's auction features from a recorded file: { date, from, to, snaps,
 * instruments, symbols: { SYMBOL: {...features, future} }, market: { nifty, bank } }, or null.
 */
export function auctionFeatures(saved) {
  if (!saved?.date || !Array.isArray(saved.keys) || !Array.isArray(saved.snaps) || !saved.snaps.length) return null;
  const ref = +istInstant(saved.date, AUCTION_REF_TIME);
  const close = closeOfEntryAt(saved.snaps) ?? saved.snaps.at(-1).t;
  const series = seriesByKey(saved);
  const indexOf = new Map(saved.keys.map((k, i) => [k, i]));
  const feature = (key) => {
    const i = indexOf.get(key);
    return i == null ? null : instrumentFeatures(series[i], saved.meta?.[i], ref, close);
  };
  const symbols = {};
  for (const key of saved.keys) {
    if (!key.startsWith('NSE:')) continue;
    const f = feature(key);
    if (!f) continue;
    const symbol = key.slice(4);
    const fut = saved.futures?.[symbol] ? feature(saved.futures[symbol]) : null;
    symbols[symbol] = { ...f, future: fut ? { symbol: saved.futures[symbol].slice(4), gap: fut.gap, iep: fut.iep, volume: fut.volume } : null };
  }
  const index = (name) => {
    const f = saved.futures?.[name] ? feature(saved.futures[name]) : null;
    return f ? { symbol: saved.futures[name].slice(4), gap: f.gap, iep: f.iep, prevClose: f.prevClose, at: f.at } : null;
  };
  return {
    date: saved.date,
    from: saved.snaps[0].t,
    to: saved.snaps.at(-1).t,
    snaps: saved.snaps.length,
    instruments: saved.keys.length,
    symbols,
    market: { nifty: index('NIFTY'), bank: index('BANKNIFTY') },
  };
}

/** Put each stock's auction features on it (call before scoring). */
export function attachAuction(stocks, auction) {
  for (const s of stocks) {
    const f = auction?.symbols?.[s.symbol];
    s.auction = f ? { ...f, market: auction.market } : null;
  }
  return stocks;
}

/**
 * Kite's unmatched quantity at the close of order entry, as { qty, side (+1 buy,
 * −1 sell), x (÷ matched volume), volume, at }, or null. The side is read from
 * the buy/sell totals unless Kite sends a negative imbalance. Features saved
 * before the close-of-entry reading was kept fall back to the last reading.
 */
export function auctionImbalance(a) {
  const imbalance = a?.imbalanceAtClose ?? a?.imbalance;
  const volume = a?.volumeAtClose ?? a?.volume;
  const buy = a?.buyAtClose ?? a?.buyQty;
  const sell = a?.sellAtClose ?? a?.sellQty;
  if (imbalance == null || !(volume > 0) || buy == null || sell == null) return null;
  const side = imbalance < 0 ? -1 : buy >= sell ? 1 : -1;
  return { qty: Math.abs(imbalance), side, x: Math.abs(imbalance) / volume, volume, at: a.closeAt ?? a.at };
}

/**
 * The auction factors for one stock in direction `dir` (+1 gap-up, −1 gap-down):
 * { key: { value 0..1, detail } } for the factors that have data.
 */
export function auctionLayerFactors(stock, dir) {
  const a = stock.auction;
  const out = {};
  if (!a) return out;
  const up = dir > 0;

  if (a.gap != null && a.earlyGap != null) {
    const change = a.gap - a.earlyGap;
    const value = 0.5 + 0.5 * clampSigned((dir * change) / Math.max(Math.abs(a.earlyGap), DRIFT_MIN_BASE_PTS));
    const kind = Math.abs(change) < 0.05 ? 'held steady' : dir * change > 0 ? 'built' : 'faded';
    out.aDrift = { value, detail: `Indicative gap ${signed(a.earlyGap)}% at ${hhmm(a.earlyAt)} → ${signed(a.gap)}% at ${hhmm(a.at)}: ${kind}, ${leaning(value)}` };
  }

  if (a.buyShare != null && a.avgBuyShare != null) {
    const late = a.buyShare - a.avgBuyShare;
    const value = 0.5 + 0.5 * clampSigned((dir * late) / HELD_FULL_PTS);
    const side = (s) => pct(up ? s : 1 - s);
    out.aOrdersHeld = {
      value,
      detail: `${side(a.buyShare)} of pending orders on the ${up ? 'buy' : 'sell'} side at the end vs ${side(a.avgBuyShare)} on average through the auction: ${Math.abs(late) < 0.01 ? 'unchanged' : dir * late > 0 ? 'added late' : 'pulled late'}, ${leaning(value)}`,
    };
  }

  const imb = auctionImbalance(a);
  if (imb) {
    const value = 0.5 + 0.5 * clampSigned((dir * imb.side * imb.x) / IMBALANCE_FULL_X);
    out.aImbalance = {
      value,
      detail: `${imb.qty.toLocaleString('en-IN')} unmatched on the ${imb.side > 0 ? 'buy' : 'sell'} side = ${times(imb.x)} the ${imb.volume.toLocaleString('en-IN')} matched at ${hhmm(imb.at)}: ${leaning(value)}`,
    };
  }

  const fut = a.future;
  if (fut?.gap != null && fut.volume > 0 && a.gap != null) {
    const excess = fut.gap - a.gap;
    const value = 0.5 + 0.5 * clampSigned((dir * excess) / FUTURES_FULL_PTS);
    out.aFutures = {
      value,
      detail: `${fut.symbol} pre-open ${signed(fut.gap)}% vs the stock's ${signed(a.gap)}% (${signed(excess)} pts): ${Math.abs(excess) < 0.05 ? 'in line' : dir * excess > 0 ? 'futures gap harder' : 'futures gap less'}, ${leaning(value)}`,
    };
  }

  const limit = up ? a.upperCircuit : a.lowerCircuit;
  if (limit > 0 && a.iep > 0) {
    const room = up ? (limit / a.iep - 1) * 100 : (1 - limit / a.iep) * 100;
    const value = clamp01(room / ROOM_FULL_PCT);
    out.aRoom = {
      value,
      detail: room <= 0 ? `At the ${up ? 'upper' : 'lower'} circuit ₹${limit}: no room, may be locked`
        : `${room.toFixed(2)}% from the indicative ₹${a.iep} to the ${up ? 'upper' : 'lower'} circuit ₹${limit}`,
    };
  }

  const nifty = a.market?.nifty;
  if (nifty?.gap != null) {
    const value = 0.5 + 0.5 * clampSigned((dir * nifty.gap) / NIFTY_FULL_PCT);
    const bank = a.market.bank?.gap != null ? `, Bank Nifty ${signed(a.market.bank.gap)}%` : '';
    out.aNifty = { value, detail: `${nifty.symbol} pre-open ${signed(nifty.gap)}% at ${hhmm(nifty.at)}${bank}: ${leaning(value)}` };
  }
  return out;
}

/** Factors in the separate Auction score: the stock's own, not the market-wide reading. */
const OWN_FACTORS = AUCTION_FACTORS.filter((f) => !f.marketWide);

/**
 * The separate Auction score for each scored gap (call after scoreConviction):
 * stock.auctionLayer = { score, direction, factors, missing, coverage } and stock.auctionScore.
 * Equal weights over the stock's own factors with data; null with fewer than MIN_AUCTION_FACTORS.
 */
export function applyAuctionLayer(stocks) {
  for (const s of stocks) {
    if (!s.conviction || !s.auction) { s.auctionLayer = null; s.auctionScore = null; continue; }
    const dir = s.conviction.direction === 'up' ? 1 : -1;
    const scores = auctionLayerFactors(s, dir);
    const factors = OWN_FACTORS.filter((f) => scores[f.key]).map((f) => ({ key: f.key, label: f.label, ...scores[f.key] }));
    const score = factors.length >= MIN_AUCTION_FACTORS
      ? Math.round((factors.reduce((sum, f) => sum + f.value, 0) / factors.length) * 100)
      : null;
    s.auctionLayer = {
      score,
      direction: s.conviction.direction,
      factors,
      missing: OWN_FACTORS.filter((f) => !scores[f.key]).map((f) => f.label),
      coverage: `${factors.length}/${OWN_FACTORS.length}`,
    };
    s.auctionScore = score;
  }
  return stocks;
}
