import { useEffect, useMemo, useState } from 'react';
import { api } from './platform/index.js';

/**
 * The 09:15–09:20 opening-window scanner (milestone 1: read-only features, no
 * decisions). Data comes from the backend's Kite WebSocket collector over SSE.
 */

const PHASE = {
  idle: 'Idle', closed: 'Market closed', 'needs-kite': 'Kite login needed', waiting: 'Waiting for the 09:10 pre-open',
  preparing: 'Preparing', ready: 'Ready — connects at 09:14', connecting: 'Connecting', collecting: 'Collecting',
  sealed: 'Sealed at 09:20', stopped: 'Stopped', missed: 'Window missed', error: 'Error',
};
const f2 = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
const sgn = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}`);
const tone = (n) => (n > 0 ? 'adv-text' : n < 0 ? 'dec-text' : '');
const vol = (n) => (n == null ? '—' : n >= 1e5 ? `${(n / 1e5).toFixed(2)} L` : n.toLocaleString('en-IN'));
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '');

/** Where the opening-window figures come from. */
export function SourceBadge({ source }) {
  const map = {
    websocket: ['WebSocket', 'Kite WebSocket, full mode (ticks and five-level depth)'],
    replay: ['Simulated replay', 'A recorded or simulated morning replayed through the same pipeline; not live'],
    quote: ['/quote polling', 'Kite /quote every 5 s (no tick history)'],
    nse: ['NSE fallback', 'NSE website prices: no depth, can lag a few seconds'],
  };
  const [label, title] = map[source] ?? ['No data', 'Nothing is collecting'];
  return <span className={`badge source-badge source-${source ?? 'none'}`} title={title}>{label}</span>;
}

export default function OpeningScanner() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState('conviction');
  const [check, setCheck] = useState(null); // Kite setup self-check result

  useEffect(() => {
    if (!api.opening) return undefined;
    return api.opening.subscribe((d) => { setData(d); setError(null); }, setError);
  }, []);

  // Detail refreshes with the data while a stock is open.
  useEffect(() => {
    if (!selected || !api.opening) return;
    api.opening.stock(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected, data]);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const key = { conviction: (r) => r.convictionScore ?? -1, gap: (r) => Math.abs(r.gapPct ?? 0), rvol: (r) => r.rvol ?? -1, ret: (r) => Math.abs(r.ret5Pct ?? 0) }[sort];
    return list.sort((a, b) => key(b) - key(a));
  }, [data, sort]);

  if (!api.opening) {
    return <p className="hint">On the phone, the opening window uses /quote polling below; the Kite WebSocket collector runs in the PC backend.</p>;
  }

  const st = data?.status ?? {};
  const run = async (fn) => { setBusy(true); try { await fn(); setError(null); } catch (e) { setError(e.message); } finally { setBusy(false); } };

  return (
    <section className="opening-scanner">
      <div className="section-head">
        <h3 className="report-heading">Opening window 09:15–09:20 <SourceBadge source={st.phase === 'collecting' || st.phase === 'sealed' || st.phase === 'connecting' ? st.source : null} /></h3>
        <div className="export-actions">
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by">
            <option value="conviction">By 09:08 conviction</option>
            <option value="gap">By gap size</option>
            <option value="ret">By 5-min move</option>
            <option value="rvol">By RVOL</option>
          </select>
          <button type="button" className="btn" disabled={busy} onClick={() => run(async () => setCheck(await api.opening.selfTest()))} title="Read-only check with your Kite login: instruments, historical candles, a quote and a short WebSocket connection. No orders.">
            {busy ? 'Checking…' : 'Check Kite setup'}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => run(() => api.opening.prepare())} title="Build today's universe now (after the 09:10 import)">Prepare now</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => api.opening.replay({ source: 'simulated', speed: 20 }))} title="Replay a deterministic simulated morning (13 stocks) through the same pipeline; no Kite needed">
            Replay simulated morning
          </button>
        </div>
      </div>
      <div className={`alert ${st.phase === 'error' || st.phase === 'needs-kite' ? 'warn' : 'info'}`}>
        <strong>{PHASE[st.phase] ?? st.phase ?? 'Connecting to the backend…'}</strong>
        {st.message ? ` — ${st.message}` : ''}
        {st.universe ? ` · ${st.universe.stocks} stocks, ${st.universe.indices} indices, ${st.universe.futures} futures` : ''}
        {st.ticker ? ` · WebSocket ${st.ticker.state}, ${st.ticker.ticks.toLocaleString('en-IN')} ticks` : ''}
        {st.counters ? ` · ${st.counters.counted.toLocaleString('en-IN')} in the window, ${st.counters.afterSeal.toLocaleString('en-IN')} after 09:20` : ''}
        {st.prep && st.phase === 'preparing' ? ` · history ${st.prep.done}/${st.prep.total}` : ''}
        {st.sealedAt ? ` · sealed ${time(st.sealedAt)}` : ''}
        {st.partialFrom ? ` · partial window from ${time(st.partialFrom)}` : ''}
        {!st.session && st.source !== 'replay' && st.phase !== 'closed' ? ' · Kite not connected' : ''}
      </div>
      {error && <div className="alert error">{error}</div>}
      {check && (
        <div className={`alert ${check.ok ? 'info' : 'warn'}`}>
          <strong>Kite setup {check.ok ? 'OK' : 'has problems'}</strong>
          {check.steps.map((x) => <div key={x.step}>{x.ok ? '✓' : '✗'} {x.step}: {x.detail}</div>)}
        </div>
      )}
      {data?.market && (
        <div className="market-signals">
          <span className="hint">Since the open:</span>
          {[data.market.nifty, data.market.bankNifty].filter(Boolean).map((m) => (
            <span key={m.symbol} className="market-signal"><span className="market-signal-label">{m.symbol}</span> <strong className={tone(m.pct)}>{sgn(m.pct)}%</strong></span>
          ))}
          {data.breadth?.abovePrevClosePct != null && (
            <span className="market-signal" title={data.breadth.label}>
              <span className="market-signal-label">Tracked breadth</span> {f2(data.breadth.abovePrevClosePct, 0)}% above prev close · {f2(data.breadth.aboveVwapPct, 0)}% above VWAP
            </span>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-wrap tall">
          <table className="stock-table opening-table">
            <thead>
              <tr>
                <th>#</th><th>Stock</th>
                <th className="num" title="09:08 pre-open conviction">Conv.</th>
                <th className="num" title="Official open vs previous close">Gap %</th>
                <th className="num" title="Last price vs the official open">5-min %</th>
                <th className="num" title="Volume since 09:15 (pre-open auction excluded)">Open vol</th>
                <th className="num" title="Opening volume ÷ average 09:15–09:20 volume of recent sessions">RVOL</th>
                <th className="num" title="Last price vs Kite's average traded price (day VWAP)">VWAP %</th>
                <th className="num" title="Top-5 order-book imbalance: pending orders, not trades">Imbal.</th>
                <th className="num" title="Bid-ask spread, basis points">Spread</th>
                <th className="num" title="Near-month future: OI change vs previous close">F&amp;O OI</th>
                <th className="num" title="Sector index since its open">Sector</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.symbol} className={`sector-row ${selected === r.symbol ? 'open' : ''}`} onClick={() => setSelected(selected === r.symbol ? null : r.symbol)}>
                  <td>{i + 1}</td>
                  <td className="mono">{r.symbol}</td>
                  <td className="num">{r.convictionScore ?? '—'}</td>
                  <td className={`num ${tone(r.gapPct)}`}>{sgn(r.gapPct)}</td>
                  <td className={`num ${tone(r.ret5Pct)}`}>{sgn(r.ret5Pct)}</td>
                  <td className="num">{vol(r.windowVolume)}</td>
                  <td className="num">{f2(r.rvol)}</td>
                  <td className={`num ${tone(r.vwapDistPct)}`}>{sgn(r.vwapDistPct)}</td>
                  <td className={`num ${tone(r.imbalance5)}`}>{sgn(r.imbalance5)}</td>
                  <td className="num">{f2(r.spreadBps, 1)}</td>
                  <td className="num" title={r.oiBuild ?? r.fnoMissing ?? ''}>{r.oiChangePct != null ? `${sgn(r.oiChangePct, 1)}%` : r.fnoMissing ? 'no data' : '—'}</td>
                  <td className={`num ${tone(r.sectorPct)}`} title={r.sectorIndex ?? ''}>{sgn(r.sectorPct)}</td>
                  <td>{r.stale ? <span className="badge decline" title="No tick for over 60 s, or none at all">stale</span> : <span className="hint">{r.ticks} ticks</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && detail && <OpeningDetail d={detail} onClose={() => setSelected(null)} />}
      <p className="hint">
        Read-only for now: no BUY / SELL decisions yet. Figures: gap from Kite&apos;s official open; volume since 09:15 with
        the pre-open auction excluded; VWAP is Kite&apos;s average traded price; imbalance and spread are pending orders
        in the visible five levels, not trades. Ticks stamped 09:20:00 or later never change the window. Click a stock
        for candles, the order book and F&amp;O.
      </p>
    </section>
  );
}

function OpeningDetail({ d, onClose }) {
  return (
    <div className="settings-card opening-detail">
      <div className="section-head">
        <h3 className="report-heading">{d.symbol} <span className="hint">{d.sector}</span></h3>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </div>
      <div className="opening-detail-grid">
        <div>
          <strong>1-minute candles</strong> <span className="hint">(highs/lows from sampled ticks: approximate)</span>
          <table className="bias-table">
            <thead><tr><th>Min</th><th className="num">O</th><th className="num">H</th><th className="num">L</th><th className="num">C</th><th className="num">Volume</th></tr></thead>
            <tbody>
              {d.candles.map((c, i) => (
                <tr key={i}><td>09:{15 + i}</td>{c ? <><td className="num">{f2(c.o)}</td><td className="num">{f2(c.h)}</td><td className="num">{f2(c.l)}</td><td className="num">{f2(c.c)}</td><td className="num">{vol(c.volume)}</td></> : <td colSpan={5} className="hint">no ticks</td>}</tr>
              ))}
              <tr><td><strong>5-min</strong></td><td className="num">{f2(d.candle5.o)}</td><td className="num">{f2(d.candle5.h)}</td><td className="num">{f2(d.candle5.l)}</td><td className="num">{f2(d.candle5.c)}</td><td className="num">{vol(d.candle5.volume)}</td></tr>
            </tbody>
          </table>
          <p className="hint">
            Range {f2(d.orLow)}–{f2(d.orHigh)} ({f2(d.orRangePct)}%) · close at {f2((d.closePos ?? 0) * 100, 0)}% of it · body {f2(d.bodyPct, 0)}%,
            wicks {f2(d.upperWickPct, 0)}% / {f2(d.lowerWickPct, 0)}% · ATR(14) {f2(d.atr14)} ({f2(d.orRangeAtr)}× range) ·
            VWAP {f2(d.vwap)} ({d.vwapSource ?? 'n/a'}) · prev high/low {sgn(d.distPrevHighPct)}% / {sgn(d.distPrevLowPct)}%
          </p>
        </div>
        <div>
          <strong>Order book</strong> <span className="hint">(pending orders, not trades)</span>
          {d.depth ? (
            <table className="bias-table">
              <thead><tr><th className="num">Orders</th><th className="num">Bid qty</th><th className="num">Bid</th><th className="num">Ask</th><th className="num">Ask qty</th><th className="num">Orders</th></tr></thead>
              <tbody>
                {d.depth.levels.buy.map((b, i) => {
                  const a = d.depth.levels.sell[i];
                  return <tr key={i}><td className="num">{b?.orders ?? ''}</td><td className="num">{b?.qty?.toLocaleString('en-IN') ?? ''}</td><td className="num adv-text">{f2(b?.price)}</td><td className="num dec-text">{f2(a?.price)}</td><td className="num">{a?.qty?.toLocaleString('en-IN') ?? ''}</td><td className="num">{a?.orders ?? ''}</td></tr>;
                })}
              </tbody>
            </table>
          ) : <p className="hint">No usable two-sided book (locked, or no depth received).</p>}
          {d.depth && (
            <p className="hint">
              Spread {f2(d.depth.spread)} ({f2(d.depth.spreadBps, 1)} bps; mean {f2(d.depth.spreadBpsMean, 1)}) · imbalance best {sgn(d.depth.imbalanceBest)},
              top-3 {sgn(d.depth.imbalance3)}, top-5 {sgn(d.depth.imbalance5)} (change {sgn(d.depth.imbalanceChange)}) · stability {f2(d.depth.stability)} ·
              liquidity drop {sgn(d.depth.liquidityDropPct, 0)}% · impact for ₹{d.depth.impactNotional.toLocaleString('en-IN')}: buy {f2(d.depth.impactBuyBps, 1)} / sell {f2(d.depth.impactSellBps, 1)} bps
            </p>
          )}
          <strong>F&amp;O</strong>
          <p className="hint">
            {d.fo
              ? d.fo.missing ? `${d.fo.symbol}: ${d.fo.missing} — scored on cash data only.`
                : `${d.fo.symbol}: ${f2(d.fo.ltp)}, premium ${sgn(d.fo.premiumPct)}%, OI ${d.fo.oi?.toLocaleString('en-IN')} (${sgn(d.fo.oiChangePct, 1)}% vs ${d.fo.oiBaseline}), ${d.fo.build ?? 'no reading'}${d.fo.agrees == null ? '' : d.fo.agrees ? ', agrees with spot' : ', disagrees with spot'}.`
              : 'Not an F&O stock (or futures not subscribed).'}
          </p>
          <strong>Data quality</strong>
          <p className="hint">
            {d.quality.ticks} ticks · last {d.quality.lastTickAgeSec ?? '—'} s before the reading{d.quality.stale ? ' (stale)' : ''} · duplicates {d.quality.duplicates} ·
            out of order {d.quality.outOfOrder} · resets {d.quality.resets} · volume baseline: {d.quality.volumeBaseline ?? '—'}
          </p>
        </div>
      </div>
    </div>
  );
}
