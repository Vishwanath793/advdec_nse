/**
 * The History layer's separate score in the Analyzer's stock table (see
 * utils/historyLayer.js). Display only: it changes the conviction score only
 * when its factors are added in "Conviction factors".
 */

export const HISTORY_COLUMN = {
  key: 'historyScore',
  label: 'History',
  numeric: true,
  title: "A separate 0–100 score from each stock's own last 20 sessions (NSE end-of-day files), in the direction of the gap. Not part of the conviction unless its factors are added.",
};

export function HistoryScore({ s }) {
  const h = s.historyLayer;
  if (!h) return <span className="hint">—</span>;
  if (h.score == null) {
    return <span className="hint" title={`Only ${h.coverage} history factors had data (needs 2). Missing: ${h.missing.join(', ')}`}>—</span>;
  }
  const tier = h.score >= 70 ? 'high' : h.score >= 50 ? 'mid' : 'low';
  const title = [
    `Gap-${h.direction} History score ${h.score}/100 (${h.coverage} factors, equal weights)`,
    ...h.factors.map((f) => `• ${f.label}: ${Math.round(f.value * 100)} — ${f.detail}`),
    ...(h.missing.length ? [`No data: ${h.missing.join(', ')}`] : []),
    'Not in the conviction unless added in “Conviction factors” → History layer.',
  ].join('\n');
  return (
    <span className={`conviction ${tier}`} title={title}>
      <span className="conviction-bar" aria-hidden="true">
        <span style={{ width: `${h.score}%` }} />
      </span>
      {h.score}
    </span>
  );
}
