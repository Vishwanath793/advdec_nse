import { useEffect, useState } from 'react';
import { api } from './platform/index.js';
import { CONVICTION_FACTORS, factorWeights } from './utils/conviction.js';
import { MARKET_WIDE_RHO, MIN_RHOS_FOR_VERDICT, PICKS_PER_DAY } from './utils/reportCard.js';
import { STATUS_LABEL } from './utils/confirmation.js';

const share = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const rho = (x) => (x == null ? '—' : x.toFixed(2));
const fmtDate = (iso) => new Date(`${iso}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function Move({ value }) {
  if (value == null) return <span className="hint">—</span>;
  return <span className={value > 0 ? 'adv-text' : value < 0 ? 'dec-text' : ''}>{`${value > 0 ? '+' : ''}${value.toFixed(2)}%`}</span>;
}

function StatsCells({ s }) {
  return (
    <>
      <td className="num">{s.n}</td>
      <td className="num">{share(s.continued)}</td>
      <td className="num"><Move value={s.avgRet} /></td>
      <td className="num"><Move value={s.avgBest} /></td>
      <td className="num"><Move value={s.avgWorst} /></td>
      <td className="num">{share(s.filled)}</td>
    </>
  );
}

const STATS_HEAD = (
  <>
    <th className="num">Trades</th>
    <th className="num" title="Closed beyond the entry in the gap direction">Continued</th>
    <th className="num" title="Entry at the pre-open price, exit at the close">Avg close</th>
    <th className="num" title="Best price of the day vs entry">Avg best</th>
    <th className="num" title="Worst price of the day vs entry">Avg worst</th>
    <th className="num" title="Price came back to the previous close">Gap filled</th>
  </>
);

const DIRECTIONS = [['up', 'Gap-ups (buy at the open)'], ['down', 'Gap-downs (short at the open)']];

const VERDICT_CLASS = { helps: 'advance', hurts: 'decline', unclear: 'unchanged', 'too few days': 'unchanged' };

/**
 * How recorded pre-open setups played out, re-scored with the current
 * conviction factors (changing them on the Analyzer page updates this page).
 */
export default function ReportCardPage({ factorSettings }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const settingsKey = JSON.stringify(factorSettings ?? null);

  useEffect(() => {
    let cancelled = false;
    // Short delay so dragging a weight slider doesn't re-score on every step.
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const next = await api.reportCard.get(JSON.parse(settingsKey));
        if (!cancelled) { setReport(next); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settingsKey, reloadKey]);

  const weights = factorWeights(factorSettings);
  const scoredDays = report?.totals?.days ?? 0;

  return (
    <div className="report-card">
      <div className="section-head">
        <h2>Report card</h2>
        <button type="button" className="btn" disabled={loading} onClick={() => setReloadKey((k) => k + 1)}>
          {loading ? 'Scoring…' : 'Refresh'}
        </button>
      </div>
      <p className="hint">
        Every trading day’s pre-open is recorded automatically when it is fetched (9:10 or <em>Fetch now</em>), and
        the day’s result is added from NSE’s end-of-day file after {`18:30`} IST. Each recorded day is re-scored with
        your current conviction factors ({CONVICTION_FACTORS.filter((f) => weights[f.key]).map((f) => f.label).join(', ') || 'none on'}),
        so changing them on the Analyzer page shows how they would have done. Trades are entered at the pre-open
        price in the gap direction.
      </p>

      {error && <div className="alert error">{error}</div>}
      {!report && !error && <div className="alert info">Loading the report card…</div>}

      {report && (
        <>
          <section className="cards">
            <div className="card total">
              <span className="card-label">Days recorded</span>
              <span className="card-value">{report.recorded}</span>
              <span className="card-sub">{report.first ? `${fmtDate(report.first)} – ${fmtDate(report.latest)}` : 'none yet'}</span>
            </div>
            <div className="card ratio">
              <span className="card-label">Days scored</span>
              <span className="card-value">{scoredDays}</span>
              <span className="card-sub">{report.totals.trades.toLocaleString('en-IN')} gap trades</span>
            </div>
            <div className="card adv">
              <span className="card-label">Conviction vs result</span>
              <span className="card-value">{rho(report.totals.scoreRho)}</span>
              <span className="card-sub" title="Average rank correlation between score and close result, per day and direction. Above 0: higher scores did better.">rank correlation, 1 = perfect</span>
            </div>
            <div className="card unch">
              <span className="card-label">Top {PICKS_PER_DAY} shorts continued</span>
              <span className="card-value">{share(report.picks.down.conviction.continued)}</span>
              <span className="card-sub">longs {share(report.picks.up.conviction.continued)}</span>
            </div>
          </section>

          {report.pending.map((p) => (
            <div key={p.date} className="alert info">{fmtDate(p.date)} is recorded; its result is pending. {p.reason}</div>
          ))}
          {report.skipped.map((p) => (
            <div key={p.date} className="alert warn">{fmtDate(p.date)} can’t be scored: {p.reason}</div>
          ))}

          {scoredDays === 0 ? (
            <div className="alert info">
              No scored days yet. Leave the app’s 9:10 fetch on: each trading day is recorded and scored once the
              evening end-of-day file is out. Factor verdicts need about {Math.ceil(MIN_RHOS_FOR_VERDICT / 2)} days;
              re-check the weights after about 20.
            </div>
          ) : (
            <>
              <h3 className="report-heading">Top picks vs the rest</h3>
              <div className="movers-grid">
                {DIRECTIONS.map(([key, label]) => (
                  <div key={key} className={`bias-card ${key === 'up' ? 'advance' : 'decline'}`}>
                    <strong>{label}</strong>
                    <table className="bias-table">
                      <thead><tr><th>Each day</th>{STATS_HEAD}</tr></thead>
                      <tbody>
                        <tr><td>Top {PICKS_PER_DAY} by conviction (tradeable)</td><StatsCells s={report.picks[key].conviction} /></tr>
                        {report.picks[key].history && <tr><td title="The separate History-layer score: each stock against its own last 20 sessions">Top {PICKS_PER_DAY} by History score (tradeable)</td><StatsCells s={report.picks[key].history} /></tr>}
                        {report.picks[key].auction?.n > 0 && <tr><td title="The separate Auction-layer score: how the pre-open auction formed (Kite readings 09:00–09:09)">Top {PICKS_PER_DAY} by Auction score (tradeable)</td><StatsCells s={report.picks[key].auction} /></tr>}
                        <tr><td>Top {PICKS_PER_DAY} by gap size</td><StatsCells s={report.picks[key].gap} /></tr>
                        <tr><td>All scored gappers</td><StatsCells s={report.picks[key].all} /></tr>
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              <h3 className="report-heading">By conviction score</h3>
              <div className="movers-grid">
                {DIRECTIONS.map(([key, label]) => (
                  <div key={key} className={`bias-card ${key === 'up' ? 'advance' : 'decline'}`}>
                    <strong>{label}</strong>
                    <table className="bias-table">
                      <thead><tr><th>Score</th>{STATS_HEAD}</tr></thead>
                      <tbody>
                        {report.bands[key].map((b) => (
                          <tr key={b.label}><td>{b.label}</td><StatsCells s={b} /></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              <h3 className="report-heading">9:15–9:20 confirmation</h3>
              {report.confirmation?.days ? (
                <div className="table-wrap">
                  <table className="stock-table">
                    <thead>
                      <tr>
                        <th>Result at 9:20</th>
                        <th className="num">Trades</th>
                        <th className="num" title="Closed beyond the 9:20 price in the gap direction">Continued after 9:20</th>
                        <th className="num" title="Entry at the 9:20 price, exit at the close">Avg close (from 9:20)</th>
                        <th className="num" title="Entry at the pre-open price, exit at the close">Avg close (from pre-open)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.confirmation.statuses.map((c) => (
                        <tr key={c.status}>
                          <td>{STATUS_LABEL[c.status]}</td>
                          <td className="num">{c.n}</td>
                          <td className="num">{share(c.continued)}</td>
                          <td className="num"><Move value={c.avgRet920} /></td>
                          <td className="num"><Move value={c.avgRet} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">
                  No 9:20 readings yet. Open the “9:15 Confirm” tab with Kite connected on a trading morning; the
                  reading is saved at 9:20 and scored here once the day’s end-of-day file is out.
                </p>
              )}
              {report.confirmation?.days > 0 && (
                <p className="hint">From {report.confirmation.days} day{report.confirmation.days === 1 ? '' : 's'} with an on-time 9:20 reading.</p>
              )}

              <h3 className="report-heading">Which factors work</h3>
              <p className="hint">
                For each day, stocks are ranked by the factor and by their result; the rank correlation (−1 to 1) is
                averaged over days. Above 0 means the factor pointed the right way. Every factor is measured, on or
                off. A verdict needs {MIN_RHOS_FOR_VERDICT} day-sides (a day gives one for gap-ups and one for
                gap-downs) with at least 10 trades each. Market-wide factors (A/D, GIFT Nifty, VIX, FII/DII) are the
                same for every stock on a day, so they are compared across days instead, and need a correlation of
                ±{MARKET_WIDE_RHO} for a verdict.
              </p>
              <div className="table-wrap">
                <table className="stock-table">
                  <thead>
                    <tr>
                      <th>Factor</th>
                      <th>In your score</th>
                      <th className="num">Gap-ups</th>
                      <th className="num">Gap-downs</th>
                      <th className="num">Overall</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.factors.map((f) => (
                      <tr key={f.key}>
                        <td>{f.label}</td>
                        <td>{weights[f.key] ? `on (${weights[f.key]})` : <span className="hint">off</span>}</td>
                        {f.marketWide ? (
                          <td className="num" colSpan={2} title="Same value for every stock on a day, so it's judged across days: does a better reading go with a better average result for that day's gap-ups (or gap-downs)?">
                            <span className="hint">across days: {f.up.days + f.down.days} day-sides</span>
                          </td>
                        ) : (
                          <>
                            <td className="num" title={`${f.up.positiveDays} of ${f.up.days} days above 0`}>{rho(f.up.rho)} <span className="hint">({f.up.days}d)</span></td>
                            <td className="num" title={`${f.down.positiveDays} of ${f.down.days} days above 0`}>{rho(f.down.rho)} <span className="hint">({f.down.days}d)</span></td>
                          </>
                        )}
                        <td className="num">{rho(f.rho)}</td>
                        <td><span className={`badge ${VERDICT_CLASS[f.verdict]}`}>{f.verdict}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h3 className="report-heading">Day by day</h3>
              <div className="table-wrap tall">
                <table className="stock-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="num">Gap-ups</th>
                      <th className="num">Continued</th>
                      <th className="num" title="Score vs result rank correlation">Score ρ</th>
                      <th className="wrap-cell">Top {PICKS_PER_DAY} longs (close)</th>
                      <th className="num">Gap-downs</th>
                      <th className="num">Continued</th>
                      <th className="num">Score ρ</th>
                      <th className="wrap-cell">Top {PICKS_PER_DAY} shorts (close)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...report.days].reverse().map((d) => (
                      <tr key={d.date}>
                        <td>{fmtDate(d.date)}</td>
                        {['up', 'down'].map((key) => [
                          <td key={`${key}n`} className="num">{d[key].n}</td>,
                          <td key={`${key}c`} className="num">{share(d[key].continued)}</td>,
                          <td key={`${key}r`} className="num">{rho(d[key].scoreRho)}</td>,
                          <td key={`${key}p`} className="wrap-cell report-picks">
                            {d[key].topPicks.length ? d[key].topPicks.map((p) => (
                              <span key={p.symbol} className="report-pick" title={`Conviction ${p.score}`}>
                                <span className="mono">{p.symbol}</span> <Move value={p.ret} />
                              </span>
                            )) : <span className="hint">—</span>}
                          </td>,
                        ])}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
