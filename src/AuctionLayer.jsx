/**
 * The Auction layer in the Analyzer (see utils/auctionLayer.js): its separate
 * score per stock and a status line for the pre-open recorder. Display only: it
 * changes the conviction score only when its factors are added in "Conviction factors".
 */

export const AUCTION_COLUMN = {
  key: 'auctionScore',
  label: 'Auction',
  numeric: true,
  title: 'A separate 0–100 score from how the pre-open auction formed (Kite readings every 15 s from 09:00 to the close of order entry), in the direction of the gap. Not part of the conviction unless its factors are added.',
};

export function AuctionScore({ s }) {
  const a = s.auctionLayer;
  if (!a) return <span className="hint" title={s.conviction ? 'No Kite pre-open readings for this stock today.' : undefined}>—</span>;
  if (a.score == null) {
    return <span className="hint" title={`Only ${a.coverage} auction factors had data (needs 2). Missing: ${a.missing.join(', ')}`}>—</span>;
  }
  const tier = a.score >= 70 ? 'high' : a.score >= 50 ? 'mid' : 'low';
  const title = [
    `Gap-${a.direction} Auction score ${a.score}/100 (${a.coverage} factors, equal weights)`,
    ...a.factors.map((f) => `• ${f.label}: ${Math.round(f.value * 100)} — ${f.detail}`),
    ...(a.missing.length ? [`No data: ${a.missing.join(', ')}`] : []),
    'Not in the conviction unless added in “Conviction factors” → Auction layer.',
  ].join('\n');
  return (
    <span className={`conviction ${tier}`} title={title}>
      <span className="conviction-bar" aria-hidden="true">
        <span style={{ width: `${a.score}%` }} />
      </span>
      {a.score}
    </span>
  );
}

const time = (t) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`);
const PHASES = {
  idle: 'not armed yet',
  waiting: 'waiting for 09:00',
  recording: 'recording',
  done: 'done',
  missed: 'missed',
  closed: 'market closed',
  'needs-kite': 'needs Kite',
  error: 'error',
};

/** One line under the market panel: what the recorder captured this morning, and the index futures. */
export function AuctionStatus({ context }) {
  const a = context?.auction;
  const st = context?.auctionStatus;
  if (!a && !st) return null;
  const tone = st?.phase === 'needs-kite' || st?.phase === 'error' || st?.phase === 'missed' ? 'warn' : '';
  return (
    <p className={`hint auction-status ${tone}`}>
      <strong>Kite pre-open auction</strong>{' '}
      {a ? (
        <>
          {a.snaps} readings of {a.instruments} instruments, {time(a.from)}–{time(a.to)} IST
          {a.market?.nifty && <> · {a.market.nifty.symbol} {signed(a.market.nifty.gap)}</>}
          {a.market?.bank && <> · {a.market.bank.symbol} {signed(a.market.bank.gap)}</>}
        </>
      ) : <>no readings for this day</>}
      {st && st.date === context?.date && (
        <> · recorder: {PHASES[st.phase] ?? st.phase}{st.message ? ` (${st.message})` : ''}{st.errors ? ` · ${st.errors} failed request${st.errors === 1 ? '' : 's'}${st.lastError ? `: ${st.lastError}` : ''}` : ''}</>
      )}
      . Feeds the Auction score; needs a Kite login before 09:00 with the market-data subscription.
    </p>
  );
}
