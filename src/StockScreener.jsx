import { useMemo } from 'react';
import { cleanScreener, MIN_QUALITY_METRICS, ORDER_SIDES, SCREENER_LIMIT, SCREENER_METRICS, screenStocks } from './utils/screener.js';

/**
 * Analyzer: the stock filter (replaces the old "Sector Bias" spotlight). Every
 * threshold is typed in by hand and a blank one is not applied; the quality
 * rank compares each gapped stock with the others (see utils/screener.js).
 * `settings` is the saved filter (settings.screener); `onChange(next)` saves it.
 */

const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
const tone = (v) => (v > 0 ? 'adv-text' : v < 0 ? 'dec-text' : '');
const signedCell = (v, d) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`);
const times = (v) => (v == null ? '—' : `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`);

export default function StockScreener({ stocks, settings, onChange, onTrade }) {
  const cfg = cleanScreener(settings);
  const result = useMemo(() => screenStocks(stocks, cfg), [stocks, JSON.stringify(cfg)]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => onChange({ ...cfg, ...patch });
  const setThreshold = (key, value) => set({ thresholds: { ...cfg.thresholds, [key]: value === '' ? null : Number(value) } });
  const active = SCREENER_METRICS.filter((m) => cfg.thresholds[m.filter] != null).length + (cfg.maxRank != null ? 1 : 0)
    + (cfg.direction !== 'both' ? 1 : 0) + (cfg.tradeableOnly ? 1 : 0);
  const shown = result.matched.slice(0, SCREENER_LIMIT);
  const rankedLabels = SCREENER_METRICS.filter((m) => result.rankedKeys.includes(m.key)).map((m) => m.label);

  return (
    <section className="stock-screener">
      <h2>Stock filter</h2>
      <p className="hint">
        Type a minimum in any box (blank = not applied). A stock without the reading fails that box. Quality is the
        average percentile, among all {result.gapped} gapped stocks, of the readings ticked “in rank”
        ({rankedLabels.join(', ') || 'none'}; at least {MIN_QUALITY_METRICS} needed); rank 1 is the best. It ranks
        setups — it does not predict the open.
      </p>
      <div className="screener-filters">
        {SCREENER_METRICS.map((m) => (
          <label key={m.key} className="screener-filter">
            <span>{m.filterLabel}</span>
            <span className="screener-input">
              <input
                type="number"
                step={m.step}
                value={cfg.thresholds[m.filter] ?? ''}
                placeholder="any"
                onChange={(e) => setThreshold(m.filter, e.target.value)}
              />
              {m.sided && (
                <select value={cfg.ordersSide} onChange={(e) => set({ ordersSide: e.target.value })} title="Which side's share of pending pre-open quantity the minimum applies to">
                  {Object.entries(ORDER_SIDES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              )}
              {m.ranked && (
                <label className="hint" title="Include this reading in the quality rank">
                  <input
                    type="checkbox"
                    checked={cfg.inRank[m.key]}
                    onChange={(e) => set({ inRank: { ...cfg.inRank, [m.key]: e.target.checked } })}
                  />
                  in rank
                </label>
              )}
            </span>
          </label>
        ))}
        <label className="screener-filter">
          <span>Quality rank ≤ (top N)</span>
          <span className="screener-input">
            <input
              type="number"
              min="1"
              step="1"
              value={cfg.maxRank ?? ''}
              placeholder="any"
              onChange={(e) => set({ maxRank: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </span>
        </label>
        <label className="screener-filter">
          <span>Direction</span>
          <select value={cfg.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="both">Gap-ups and gap-downs</option>
            <option value="up">Gap-ups only</option>
            <option value="down">Gap-downs only</option>
          </select>
        </label>
        <label className="screener-filter screener-check">
          <input type="checkbox" checked={cfg.tradeableOnly} onChange={(e) => set({ tradeableOnly: e.target.checked })} />
          <span>Tradeable only (no red flags)</span>
        </label>
      </div>
      <div className="screener-summary">
        <strong>{result.matched.length}</strong> of {result.gapped} gapped stocks match
        {active ? ` (${active} filter${active === 1 ? '' : 's'} on)` : ' (no filters on)'} · {result.ranked} ranked
        {active > 0 && (
          <button type="button" className="btn ghost" onClick={() => onChange(cleanScreener({ inRank: cfg.inRank }))}>
            Clear filters
          </button>
        )}
      </div>
      {shown.length > 0 ? (
        <div className="table-wrap tall">
          <table className="stock-table screener-table">
            <thead>
              <tr>
                <th className="num" title="Quality rank among all gapped stocks (1 = best)">Rank</th>
                <th>Symbol</th>
                <th>Sector</th>
                <th className="num">%Chg</th>
                <th className="num" title="Average percentile of the readings in the rank (0–100)">Quality</th>
                <th className="num" title="Pre-open quantity vs its 20-day average daily volume, as a multiple of the typical stock">Rel. vol</th>
                <th className="num" title="Share of pending pre-open buy + sell quantity on the gap side (buy for gap-ups, sell for gap-downs)">Buy/sell orders</th>
                <th className="num" title="Pre-open traded value; the percentile is the share of all stocks it beats">Pre-open value</th>
                <th className="num">Deliv %</th>
                <th className="num" title="Yesterday's delivered shares ÷ the 20-session average">Deliv qty ×</th>
                <th className="num" title="Indicative gap change from 09:04 to the end of order entry, in the gap direction (Kite pre-open readings)">Auction build</th>
                <th className="num" title="Gap-side share of pending orders at the end of order entry minus its average through the auction (points)">Orders held</th>
                <th className="num" title="Kite's imbalance quantity ÷ matched volume; positive when the unmatched side is the gap side">Unmatched</th>
                <th className="num" title="Near-month future's pre-open gap minus the stock's, in the gap direction (points; F&amp;O only)">Futures vs cash</th>
                <th className="num">Conviction</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ stock: s, metrics: m, quality, qualityParts, rank }) => {
                const up = m.dir > 0;
                return (
                  <tr key={s.symbol}>
                    <td className="num">{rank ?? '—'}</td>
                    <td className="mono symbol-cell">
                      {s.symbol}
                      {(s.flags ?? []).map((f) => <span key={f.key ?? f.label} className={`flag ${f.severity}`} title={f.detail}>{f.label}</span>)}
                    </td>
                    <td className="wrap-cell sector-cell">{s.sector}</td>
                    <td className={`num ${up ? 'adv-text' : 'dec-text'}`}>{s.pctChange}</td>
                    <td className="num" title={`${qualityParts} of ${result.rankedKeys.length} readings in the rank had data`}>
                      {quality ?? '—'}{quality != null && qualityParts < result.rankedKeys.length && <span className="hint"> {qualityParts}/{result.rankedKeys.length}</span>}
                    </td>
                    <td className="num">{times(m.rvolX)}</td>
                    <td className="num" title={m.buyPct == null ? '' : `Pending pre-open quantity: ${Math.round(m.buyPct)}% buy, ${Math.round(m.sellPct)}% sell`}>
                      {m.buyPct == null ? '—' : cfg.ordersSide === 'buy' ? `${Math.round(m.buyPct)}% buy`
                        : cfg.ordersSide === 'sell' ? `${Math.round(m.sellPct)}% sell` : `${Math.round(m.ordersPct)}% ${up ? 'buy' : 'sell'}`}
                    </td>
                    <td className="num" title={m.valuePct == null ? '' : `Higher than ${Math.round(m.valuePct)}% of stocks`}>
                      {s.valueCr == null ? '—' : `₹${s.valueCr.toFixed(2)} Cr`}{m.valuePct != null && <span className="hint"> · {Math.round(m.valuePct)}%</span>}
                    </td>
                    <td className="num">{fmt(m.delivPct)}</td>
                    <td className="num">{times(m.delivQtyX)}</td>
                    <td className={`num ${tone(m.driftPts)}`}>{signedCell(m.driftPts, 2)}</td>
                    <td className={`num ${tone(m.heldPts)}`}>{signedCell(m.heldPts, 1)}</td>
                    <td className={`num ${tone(m.imbalanceX)}`}>{m.imbalanceX == null ? '—' : `${signedCell(m.imbalanceX, 2)}×`}</td>
                    <td className={`num ${tone(m.futuresPts)}`}>{signedCell(m.futuresPts, 2)}</td>
                    <td className="num">{s.convictionScore ?? '—'}</td>
                    <td className="num">
                      <button type="button" className={`btn trade ${up ? 'buy' : 'sell'}`} onClick={() => onTrade(s, up ? 'BUY' : 'SELL')}>
                        {up ? 'BUY' : 'SELL'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">No stock passes every filter that is on.</p>
      )}
      {result.matched.length > SCREENER_LIMIT && <p className="hint">Showing the first {SCREENER_LIMIT} by rank.</p>}
      <p className="hint">
        Sources: gap, orders and value from NSE&apos;s pre-open; relative volume against the 20-day average volume;
        delivery % and delivery quantity from NSE&apos;s end-of-day files; auction build, orders held, unmatched demand and futures vs cash from the Kite pre-open readings
        the app records (09:00–09:09; blank on days without them). BUY/SELL places the order straight away, as in the
        top movers.
      </p>
    </section>
  );
}
