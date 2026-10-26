import { analyze } from '../../../src/utils/analysis.js';
import { MIN_GAP_PCT } from '../../../src/utils/conviction.js';

/**
 * Compact, versioned summaries of recorded days for the document index: one
 * document per date, never mixing dates. The morning summary uses only that
 * morning's pre-open; the outcome summary uses that day's end-of-day file and
 * is marked retrospective (it was not known that morning).
 */
export const SUMMARY_VERSION = 1;

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const pct = (n) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${r2(n)}%`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

export function morningSummary({ date, rows, masterRows, marketUpdatedAt }) {
  const { summary, sectors, stocks } = analyze(rows, masterRows ?? [], null, {});
  const gapped = stocks.filter((s) => s.pctChange != null && Math.abs(s.pctChange) >= MIN_GAP_PCT);
  const top = (dir) => [...gapped].filter((s) => Math.sign(s.pctChange) === dir)
    .sort((a, b) => dir * (b.pctChange - a.pctChange)).slice(0, 5)
    .map((s) => `${s.symbol} ${pct(s.pctChange)} (pre-open value ₹${r2(s.valueCr) ?? 'n/a'} Cr)`).join(', ');
  const sectorLines = sectors.slice(0, 10).map((s) => `- ${s.sector}: ${s.advances} up, ${s.declines} down, ${s.unchanged} unchanged (advancing ${Math.round((s.advances / Math.max(1, s.total)) * 100)}%)`);
  return `# Pre-open summary for ${date}

## Breadth on ${date}
NSE pre-open at ${marketUpdatedAt ?? 'unknown time'} IST, over the ${summary.total} master-list stocks: ${summary.advances} advancing, ${summary.declines} declining, ${summary.unchanged} unchanged (A/D ratio ${summary.adRatio == null ? 'n/a' : summary.adRatio === Infinity ? 'all advancing' : r2(summary.adRatio)}). ${gapped.length} stocks gapped ${MIN_GAP_PCT}% or more.

## Largest gaps on ${date}
Gap-ups: ${top(1) || 'none'}.
Gap-downs: ${top(-1) || 'none'}.

## Sectors on ${date} (largest by stock count)
${sectorLines.join('\n')}
`;
}

/** `outcome` is that day's end-of-day file ({ SYMBOL: { open, high, low, close } }). */
export function outcomeSummary({ date, rows, masterRows, outcome }) {
  const { stocks } = analyze(rows, masterRows ?? [], null, {});
  const trades = [];
  for (const s of stocks) {
    const d = outcome?.[s.symbol];
    if (s.pctChange == null || Math.abs(s.pctChange) < MIN_GAP_PCT || !(s.finalPrice > 0) || !(d?.close > 0) || s.dataIssue) continue;
    const dir = s.pctChange > 0 ? 1 : -1;
    trades.push({
      dir,
      ret: (dir * (d.close - s.finalPrice)) / s.finalPrice * 100,
      filled: s.prevClose != null && (dir > 0 ? d.low <= s.prevClose : d.high >= s.prevClose),
    });
  }
  const line = (dir, label) => {
    const t = trades.filter((x) => x.dir === dir);
    if (!t.length) return `- ${label}: none with an end-of-day close.`;
    const cont = t.filter((x) => x.ret > 0).length;
    return `- ${label}: ${t.length} stocks; close beyond the pre-open price in the gap direction for ${cont} (${Math.round((cont / t.length) * 100)}%); average ${pct(t.reduce((a, x) => a + x.ret, 0) / t.length)}, median ${pct(median(t.map((x) => x.ret)))}; gap filled (back to the previous close) for ${t.filter((x) => x.filled).length}.`;
  };
  return `# Outcome summary for ${date} (retrospective)

## How ${date}'s gaps closed
Measured from the pre-open final price to that day's NSE end-of-day close, in the gap direction, for master-list stocks that gapped ${MIN_GAP_PCT}% or more. This was known only after the close; it was not available that morning.
${line(1, 'Gap-ups')}
${line(-1, 'Gap-downs')}
`;
}
