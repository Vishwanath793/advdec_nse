import { coverage, MIN_RESEARCH_DAYS, RESEARCH_DAYS } from './utils/research.js';

/**
 * "How unusual vs the last 20 sessions" research columns for the Analyzer's
 * stock and sector tables, and the market-wide panel (India VIX, FII/DII).
 * Display only: none of these are in the conviction score (see utils/research.js).
 */

/** Ratios at or above this are highlighted as unusual. */
const UNUSUAL_X = 2;

export const RESEARCH_COLUMNS = [
  { key: 'preRvolX', label: 'Pre-open RVOL', title: "Today's matched pre-open quantity ÷ its average over the recorded pre-open days (up to 20)" },
  { key: 'preValueX', label: 'Pre-open value ×', title: "Today's pre-open traded value ÷ its average over the recorded pre-open days (up to 20)" },
  { key: 'gapX', label: 'Gap ×', title: "|Today's gap %| ÷ the stock's average |open vs previous close| over 20 sessions (direction: %Chg)" },
  { key: 'delivQtyX', label: 'Deliv qty ×', title: "Yesterday's delivered shares ÷ the average of the 20 sessions before" },
  { key: 'rsSectorPct', label: 'RS vs sector', title: '20-session return minus the median 20-session return of its sector (stocks in today\'s pre-open), in points' },
  { key: 'rsNiftyPct', label: 'RS vs Nifty', title: '20-session return minus the Nifty 50\'s, in points' },
  { key: 'oiRank', label: 'OI change rank', title: "Yesterday's absolute futures OI change % as a percentile of the 20 sessions before (OI summed over expiries, so roll-overs cancel out)" },
].map((c) => ({ ...c, numeric: true, research: true }));

const fmtX = (x) => (x == null ? '—' : `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`);
const fmtPts = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`);
const qty = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const sessions = (days) => `${coverage(days)} sessions`;
const tooFew = (days, what) => `Not enough history: ${coverage(days)} ${what} (needs ${MIN_RESEARCH_DAYS}).`;

function XCell({ x, title, days, what }) {
  return (
    <td className={`num research-cell ${x != null && x >= UNUSUAL_X ? 'unusual' : ''}`} title={x == null ? tooFew(days, what) : `${title} (${sessions(days)})`}>
      {fmtX(x)}{x != null && days < RESEARCH_DAYS && <span className="hint"> {coverage(days)}</span>}
    </td>
  );
}

/** One stock's research cells, in RESEARCH_COLUMNS order. */
export function ResearchCells({ s }) {
  const d = s.researchDays ?? {};
  const tone = (n) => (n > 0 ? 'adv-text' : n < 0 ? 'dec-text' : '');
  return (
    <>
      <XCell x={s.preRvolX} days={d.preopen} what="recorded pre-open days"
        title={`Pre-open quantity ${qty(s.finalVolume)} vs its average ${qty(s.preAvgVolume)}`} />
      <XCell x={s.preValueX} days={d.preopen} what="recorded pre-open days"
        title={`Pre-open value ₹${s.valueCr?.toFixed(2) ?? '—'} Cr vs its average ₹${s.preAvgValueCr?.toFixed(2) ?? '—'} Cr`} />
      <XCell x={s.gapX} days={d.gap} what="sessions with an open and previous close"
        title={`${s.pctChange > 0 ? 'Gap-up' : s.pctChange < 0 ? 'Gap-down' : 'No gap'} of ${Math.abs(s.pctChange ?? 0).toFixed(2)}% vs its average absolute gap of ${s.avgAbsGap?.toFixed(2) ?? '—'}%`} />
      <XCell x={s.delivQtyX} days={d.deliv} what="sessions with delivery data"
        title={`Delivered ${qty(s.delivQty)} shares yesterday vs its average ${qty(s.avgDelivQty)} (delivery % ${s.delivPct?.toFixed(1) ?? '—'}, usual ${s.delivAvg?.toFixed(1) ?? '—'})`} />
      <td className={`num research-cell ${tone(s.rsSectorPct)}`}
        title={s.rsSectorPct == null ? 'Needs the stock\'s 20-session return and 3 or more stocks with one in its sector.' : `20 sessions: stock ${fmtPts(s.ret20)}%, ${s.sector} median ${fmtPts(s.sectorRet20)}%`}>
        {fmtPts(s.rsSectorPct)}
      </td>
      <td className={`num research-cell ${tone(s.rsNiftyPct)}`} title={s.rsNiftyPct == null ? 'Needs the stock\'s and the Nifty 50\'s 20-session returns.' : `20 sessions: stock ${fmtPts(s.ret20)}%, Nifty 50 ${fmtPts(s.ret20 - s.rsNiftyPct)}%`}>
        {fmtPts(s.rsNiftyPct)}
      </td>
      <td className={`num research-cell ${s.oiRank != null && s.oiRank >= 0.9 ? 'unusual' : ''}`}
        title={s.oiRank == null ? (s.foOiChangePct == null ? 'Not an F&O stock, or no F&O file.' : tooFew(d.oi, 'F&O sessions')) : `OI ${fmtPts(s.foOiChangePct)}% yesterday: larger than ${Math.round(s.oiRank * 100)}% of the previous ${sessions(d.oi)}`}>
        {s.oiRank == null ? '—' : `${Math.round(s.oiRank * 100)}%`}
      </td>
    </>
  );
}

/** Sector advancing % vs its usual at the same pre-open time (percentage points). */
export function SectorBreadthCell({ s }) {
  const v = s.advVsUsualPp;
  return (
    <td className={`num research-cell ${v > 0 ? 'adv-text' : v < 0 ? 'dec-text' : ''}`}
      title={v == null ? tooFew(s.breadthDays, 'recorded pre-open days') : `Advancing ${((s.advances / s.total) * 100).toFixed(1)}% today vs ${s.usualAdvPct.toFixed(1)}% on average (${sessions(s.breadthDays)})`}>
      {v == null ? '—' : `${fmtPts(v)} pp`}
    </td>
  );
}

const crore = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`);
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');

function FlowRow({ label, f }) {
  return (
    <tr>
      <td>{label}</td>
      <td className={`num ${f.latest > 0 ? 'adv-text' : f.latest < 0 ? 'dec-text' : ''}`}>{crore(f.latest)}</td>
      <td className="num" title={f.z == null ? tooFew(f.days, 'earlier stored sessions') : `Mean of the ${f.days} sessions before: ${crore(f.mean)}`}>
        {f.z == null ? '—' : fmtPts(f.z)}
      </td>
      <td className="num" title={`${f.days5}/5 sessions with data`}>{crore(f.sum5)}</td>
      <td className="num" title={`${f.days20}/20 sessions with data`}>{crore(f.sum20)}</td>
      <td className="num">{f.days20 ? `${f.buyDays}/${f.days20}` : '—'}</td>
    </tr>
  );
}

/** Market-wide comparisons: India VIX vs its 20-session average, Nifty's 20-session return, FII/DII flow history. */
export function MarketResearch({ context }) {
  const ix = context?.history?.indices;
  const fh = context?.market?.flowHistory;
  const pre = context?.preopen;
  if (!ix && !fh) return null;
  const vix = ix?.vix;
  return (
    <details className="market-research">
      <summary>Compared with the last {RESEARCH_DAYS} sessions <span className="hint">(research; not in the score)</span></summary>
      <div className="market-research-grid">
        <div>
          <strong>India VIX</strong>{' '}
          {vix ? (
            <span title={`Close ${vix.last} on ${day(ix.asOf)} ÷ the average of the ${vix.days} closes before (${vix.avg?.toFixed(2) ?? '—'})`}>
              {vix.last} on {day(ix.asOf)}: <strong className={vix.x > 1 ? 'dec-text' : 'adv-text'}>{fmtX(vix.x)}</strong> its {sessions(vix.days)} average
              {vix.percentile != null && <>, higher than {Math.round(vix.percentile * 100)}% of them</>}
            </span>
          ) : <span className="hint">no index file yet</span>}
          <br />
          <strong>Nifty 50</strong>{' '}
          {ix?.nifty?.ret20 != null ? <span>{fmtPts(ix.nifty.ret20)}% over 20 sessions (the "RS vs Nifty" baseline)</span> : <span className="hint">20-session return not available</span>}
          <p className="hint">
            Source: NSE daily index file (ind_close_all). Pre-open baselines: {pre?.days ? `${pre.days} recorded day${pre.days === 1 ? '' : 's'} (${day(pre.from)}–${day(pre.to)})` : 'no recorded days yet'};
            they grow by one each trading morning the app records.
          </p>
        </div>
        {fh && (
          <div>
            <strong>FII / DII net flows</strong> <span className="hint">on {day(fh.date)} · {fh.agreement ?? 'no reading'}</span>
            <table className="bias-table">
              <thead><tr><th /><th className="num">Net</th><th className="num" title="(latest − mean of the 20 sessions before) ÷ standard deviation. Positive can mean less selling than usual: read it with the amount.">20-day z</th><th className="num">5-day sum</th><th className="num">20-day sum</th><th className="num">Buying days</th></tr></thead>
              <tbody>
                <FlowRow label="FII/FPI" f={fh.fii} />
                <FlowRow label="DII" f={fh.dii} />
              </tbody>
            </table>
            <p className="hint">
              {fh.scope}. Market-wide context, not evidence that institutions bought a particular stock. The app stores one reading
              per evening, so the history covers only the days it has seen.
            </p>
          </div>
        )}
      </div>
    </details>
  );
}
