import { useMemo } from 'react';
import { cleanScreener, MIN_QUALITY_METRICS, ORDER_SIDES, SCREENER_GROUPS, SCREENER_LIMIT, SCREENER_METRICS, screenStocks } from './utils/screener.js';

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
  const shown = result.matched.slice(0, SCREENER_LIMIT);
  const rankedLabels = SCREENER_METRICS.filter((m) => result.rankedKeys.includes(m.key)).map((m) => m.label);

  const minGap = cfg.thresholds.minGap;
  const chips = [
    ...(minGap != null || cfg.maxGap != null ? [{
      key: 'gap',
      text: minGap != null && cfg.maxGap != null ? `Gap size ${minGap}–${cfg.maxGap} %` : minGap != null ? `Gap size ≥ ${minGap} %` : `Gap size ≤ ${cfg.maxGap} %`,
      clear: () => set({ maxGap: null, thresholds: { ...cfg.thresholds, minGap: null } }),
    }] : []),
    ...SCREENER_METRICS.filter((m) => m.key !== 'absGap' && cfg.thresholds[m.filter] != null).map((m) => ({
      key: m.filter,
      text: `${m.short}${m.sided && cfg.ordersSide !== 'gap' ? ` (${ORDER_SIDES[cfg.ordersSide].toLowerCase()})` : ''} ≥ ${cfg.thresholds[m.filter]} ${m.unit}`,
      clear: () => setThreshold(m.filter, ''),
    })),
    ...(cfg.maxRank != null ? [{ key: 'rank', text: `Top ${cfg.maxRank} by quality`, clear: () => set({ maxRank: null }) }] : []),
    ...(cfg.direction !== 'both' ? [{ key: 'dir', text: cfg.direction === 'up' ? 'Gap-ups only' : 'Gap-downs only', clear: () => set({ direction: 'both' }) }] : []),
    ...(cfg.tradeableOnly ? [{ key: 'trade', text: 'Tradeable only', clear: () => set({ tradeableOnly: false }) }] : []),
  ];

  const numberInput = (id, value, onValue, step, placeholder) => (
    <input id={id} type="number" min="0" step={step} value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onValue(e.target.value === '' ? null : Number(e.target.value))} />
  );

  // Gap size is a range: from and/or to, either side of the gap.
  const gapRow = (m) => {
    const bad = minGap != null && cfg.maxGap != null && minGap > cfg.maxGap;
    return (
      <div key={m.key} className={`sf-row ${minGap != null || cfg.maxGap != null ? 'on' : ''}`}>
        <label className="sf-label" htmlFor="sf-absGap" title={m.help}>
          {m.short} <span className="sf-info" aria-hidden="true">ⓘ</span>
        </label>
        <div className="sf-value sf-range">
          {numberInput('sf-absGap', minGap, (v) => setThreshold('minGap', v ?? ''), m.step, 'from')}
          <span className="sf-op">to</span>
          {numberInput('sf-maxGap', cfg.maxGap, (v) => set({ maxGap: v }), m.step, 'to')}
          <span className="sf-unit">%</span>
        </div>
        <span className="sf-rank-none" title="Gap size is a filter only, not part of the rank" />
        {bad && <span className="sf-warn">“From” is above “to”: nothing can match.</span>}
      </div>
    );
  };

  const filterRow = (m) => {
    if (m.key === 'absGap') return gapRow(m);
    const on = cfg.thresholds[m.filter] != null;
    return (
      <div key={m.key} className={`sf-row ${on ? 'on' : ''}`}>
        <label className="sf-label" htmlFor={`sf-${m.key}`} title={m.help}>
          {m.short} <span className="sf-info" aria-hidden="true">ⓘ</span>
        </label>
        <div className="sf-value">
          <span className="sf-op">≥</span>
          <input
            id={`sf-${m.key}`}
            type="number"
            step={m.step}
            value={cfg.thresholds[m.filter] ?? ''}
            placeholder="any"
            onChange={(e) => setThreshold(m.filter, e.target.value)}
          />
          <span className="sf-unit">{m.unit}</span>
        </div>
        {m.ranked ? (
          <button
            type="button"
            className={`sf-rank ${cfg.inRank[m.key] ? 'in' : ''}`}
            aria-pressed={cfg.inRank[m.key]}
            title={cfg.inRank[m.key] ? 'Counts in the quality rank (click to leave it out)' : 'Left out of the quality rank (click to include it)'}
            onClick={() => set({ inRank: { ...cfg.inRank, [m.key]: !cfg.inRank[m.key] } })}
          >
            ★
          </button>
        ) : <span className="sf-rank-none" title="Gap size is a filter only, not part of the rank" />}
        {m.sided && (
          <div className="sf-seg sf-sub" role="group" aria-label="Which side of the pending orders">
            {Object.entries(ORDER_SIDES).map(([k, label]) => (
              <button key={k} type="button" className={cfg.ordersSide === k ? 'active' : ''} onClick={() => set({ ordersSide: k })}
                title={k === 'gap' ? 'Buy side for gap-ups, sell side for gap-downs' : `${label} side for every stock`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="stock-screener">
      <div className="sf-head">
        <h2>Stock filter</h2>
        <div className="sf-count">
          <strong>{result.matched.length}</strong> of {result.gapped} gapped stocks match
          <span className="hint"> · {result.ranked} ranked</span>
        </div>
      </div>

      <div className="sf-groups">
        {SCREENER_GROUPS.map((g) => (
          <fieldset key={g.key} className="sf-group">
            <legend>{g.label} <span className="hint">{g.source}</span></legend>
            {SCREENER_METRICS.filter((m) => m.group === g.key).map(filterRow)}
          </fieldset>
        ))}
        <fieldset className="sf-group">
          <legend>Result</legend>
          <div className="sf-row">
            <span className="sf-label">Direction</span>
            <div className="sf-seg" role="group" aria-label="Direction">
              {[['both', 'Both'], ['up', 'Gap-ups'], ['down', 'Gap-downs']].map(([k, label]) => (
                <button key={k} type="button" className={cfg.direction === k ? 'active' : ''} onClick={() => set({ direction: k })}>{label}</button>
              ))}
            </div>
          </div>
          <div className={`sf-row ${cfg.maxRank != null ? 'on' : ''}`}>
            <label className="sf-label" htmlFor="sf-rank" title="Keep only the best N by quality rank (rank 1 = best)">
              Quality rank <span className="sf-info" aria-hidden="true">ⓘ</span>
            </label>
            <div className="sf-value">
              <span className="sf-op">top</span>
              <input
                id="sf-rank"
                type="number"
                min="1"
                step="1"
                value={cfg.maxRank ?? ''}
                placeholder="any"
                onChange={(e) => set({ maxRank: e.target.value === '' ? null : Number(e.target.value) })}
              />
              <span className="sf-unit">stocks</span>
            </div>
          </div>
          <label className={`sf-row sf-check ${cfg.tradeableOnly ? 'on' : ''}`}>
            <input type="checkbox" checked={cfg.tradeableOnly} onChange={(e) => set({ tradeableOnly: e.target.checked })} />
            <span>Tradeable only <span className="hint">(no red flags: T2T, at a circuit)</span></span>
          </label>
          <p className="hint sf-legend"><span className="sf-rank in sf-rank-demo">★</span> counts in the quality rank · ⓘ hover for details</p>
        </fieldset>
      </div>

      <div className="sf-active">
        {chips.length ? (
          <>
            {chips.map((c) => (
              <button key={c.key} type="button" className="sf-chip" onClick={c.clear} title="Remove this filter">
                {c.text} <span aria-hidden="true">×</span>
              </button>
            ))}
            <button type="button" className="btn ghost sf-clear" onClick={() => onChange(cleanScreener({ inRank: cfg.inRank, ordersSide: cfg.ordersSide }))}>
              Clear all
            </button>
          </>
        ) : <span className="hint">No filters on: every gapped stock is listed, best rank first.</span>}
      </div>

      <details className="sf-how">
        <summary>How the filter and the quality rank work</summary>
        <p className="hint">
          Type a minimum in any box; a blank box is not applied, and a stock without that reading fails the box.
          Quality is the average percentile, among all {result.gapped} gapped stocks, of the readings marked ★
          ({rankedLabels.join(', ') || 'none'}; at least {MIN_QUALITY_METRICS} needed). Rank 1 is the best, and the rank
          doesn&apos;t change as you filter. It ranks setups; it does not predict the open.
        </p>
      </details>

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
