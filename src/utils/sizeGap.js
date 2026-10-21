import { toNumber } from './csv.js';

/**
 * Gap normalised for company size. Smaller companies gap more: on 21 Oct 2026,
 * across 2,272 NSE stocks, the median 20-session average absolute gap was 0.96%
 * under ₹1,000 Cr free-float cap, 0.46% at ₹1,000–5,000 Cr, and about 0.4% above
 * ₹5,000 Cr (flat from there). A single power law (slope −0.20 on logs) would
 * misfit that bend, so the "typical gap for this size" is taken from size peers.
 *
 *   typical gap = median of the 20-session average |gap| (NSE end-of-day files:
 *                 open vs previous close) of the SIZE_PEERS stocks nearest in
 *                 free-float market cap, compared on a log scale (₹646 Cr to
 *                 ₹10.85 L Cr spans more than three orders of magnitude)
 *   gap vs size = |today's gap| ÷ typical gap   (e.g. 3× = three times normal for that size)
 *
 * The peer pool is every stock in the pre-open feed (all of NSE, not only the
 * master list) with a free-float cap and at least MIN_GAP_DAYS of history.
 * Without enough history it falls back to today's pre-open: the median |gap|
 * of today's size peers (labelled as such).
 */

export const SIZE_PEERS = 100;
export const MIN_POOL = 200;
export const MIN_GAP_DAYS = 5;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * Build the peer pool from pre-open rows ({ SYMBOL, 'FFM CAP (₹ Crores)', '%CHANGE' })
 * and history stats ({ SYMBOL: { avgAbsGap, gapDays } }).
 * Returns { source: 'history' | 'today', points: [{ symbol, logCap, gap }] sorted by logCap } or null.
 */
export function sizePeerPool(rows, stats) {
  const fromRows = (gapOf) => rows
    .map((r) => {
      const symbol = String(r.SYMBOL ?? '').trim().toUpperCase();
      const cap = toNumber(r['FFM CAP (₹ Crores)']); // pm.csv uploads use Indian digit grouping
      const gap = gapOf(symbol, r);
      return symbol && cap > 0 && gap != null && Number.isFinite(gap) ? { symbol, logCap: Math.log(cap), gap } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.logCap - b.logCap);
  const history = fromRows((sym) => {
    const h = stats?.[sym];
    return h?.avgAbsGap > 0 && h.gapDays >= MIN_GAP_DAYS ? h.avgAbsGap : null;
  });
  if (history.length >= MIN_POOL) return { source: 'history', points: history };
  const today = fromRows((_, r) => { const g = toNumber(r['%CHANGE']); return Number.isNaN(g) ? null : Math.abs(g); });
  return today.length >= MIN_POOL ? { source: 'today', points: today } : null;
}

/**
 * The typical gap for a free-float cap: median gap of the `k` pool points nearest
 * in log cap (excluding `symbol` itself). Returns { gap, peers, fromCap, toCap } or null.
 */
export function typicalGapForSize(pool, cap, symbol = null, k = SIZE_PEERS) {
  if (!pool?.points.length || !(cap > 0)) return null;
  const pts = pool.points;
  const x = Math.log(cap);
  // First point at or above x, then widen to whichever side is nearer.
  let lo = 0;
  let hi = pts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].logCap < x) lo = mid + 1; else hi = mid; }
  let left = lo - 1;
  let right = lo;
  const picked = [];
  while (picked.length < k && (left >= 0 || right < pts.length)) {
    const takeLeft = right >= pts.length || (left >= 0 && x - pts[left].logCap <= pts[right].logCap - x);
    const p = takeLeft ? pts[left--] : pts[right++];
    if (p.symbol !== symbol) picked.push(p);
  }
  if (!picked.length) return null;
  const caps = picked.map((p) => Math.exp(p.logCap));
  return { gap: median(picked.map((p) => p.gap)), peers: picked.length, fromCap: Math.min(...caps), toCap: Math.max(...caps) };
}

/**
 * Adds to each stock: sizeGapX (|gap| ÷ typical gap for its size), sizeTypicalGap
 * and sizeGapInfo ({ source, peers, fromCap, toCap }). Null without a free-float cap or a pool.
 */
export function applySizeGap(stocks, rows, stats) {
  const pool = sizePeerPool(rows, stats);
  for (const s of stocks) {
    const t = pool && s.pctChange != null ? typicalGapForSize(pool, s.ffmCap, s.symbol) : null;
    s.sizeTypicalGap = t?.gap ?? null;
    s.sizeGapX = t?.gap > 0 ? Math.abs(s.pctChange) / t.gap : null;
    s.sizeGapInfo = t ? { source: pool.source, peers: t.peers, fromCap: t.fromCap, toCap: t.toCap } : null;
  }
  return stocks;
}
