import { useEffect, useMemo, useState } from 'react';
import { api } from './platform/index.js';
import OpeningChart from './OpeningChart.jsx';

/**
 * The 09:15–09:20 opening-window scanner and the 09:20 decisions (paper).
 * Data comes from the backend's Kite WebSocket collector over SSE; the payload
 * carries the trading view of the ledger shown (the replay's during a replay).
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
const DECISION_CLASS = { BUY: 'advance', SELL: 'decline', 'NO TRADE': 'unchanged' };
const STRAT = { orb: 'A · ORB', gapPullback: 'B · Gap pullback', momentum: 'C · Momentum', breakHold: 'D · Break and hold' };
const RESULT_MARK = { pass: '✓', warn: '~', neutral: '·', fail: '✗' };
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
  const [sort, setSort] = useState('score');
  const [decision, setDecision] = useState(null);
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

  const ledger = data?.trading?.ledger ?? 'day';
  const decidedAt = data?.trading?.ledgerState?.decidedAt ?? null;
  useEffect(() => {
    if (!selected || !api.trading) { setDecision(null); return; }
    api.trading.decision(selected, ledger).then(setDecision).catch(() => setDecision(null));
  }, [selected, ledger, decidedAt]);
  const decisions = useMemo(() => new Map((data?.trading?.decisions ?? []).map((x) => [x.symbol, x])), [data]);

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    const traded = (r) => (decisions.get(r.symbol)?.decision ?? 'NO TRADE') !== 'NO TRADE';
    const key = {
      score: (r) => (decisions.has(r.symbol) ? (traded(r) ? 1000 : 0) + (decisions.get(r.symbol).score ?? 0) : r.convictionScore ?? -1),
      conviction: (r) => r.convictionScore ?? -1, gap: (r) => Math.abs(r.gapPct ?? 0), rvol: (r) => r.rvol ?? -1, ret: (r) => Math.abs(r.ret5Pct ?? 0) }[sort];
    return list.sort((a, b) => key(b) - key(a));
  }, [data, sort, decisions]);

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
            <option value="score">By 09:20 decision and score</option>
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
                <th className="num" title="Opening volume ÷ average 09:15–09:20 volume of the last 20 sessions (Kite 1-minute candles)">RVOL</th>
                <th className="num research-col" title="Research: 09:15–09:20 traded value ÷ its 20-session average for the same window">Value ×</th>
                <th className="num research-col" title="Research: first-five-minute high–low range % ÷ its 20-session average">Range ×</th>
                <th className="num research-col" title="Research: |gap from the official open| ÷ the stock's average absolute gap over 20 sessions">Gap ×</th>
                <th className="num" title="Last price vs Kite's average traded price (day VWAP)">VWAP %</th>
                <th className="num" title="Top-5 order-book imbalance: pending orders, not trades">Imbal.</th>
                <th className="num" title="Bid-ask spread, basis points">Spread</th>
                <th className="num" title="Near-month future: OI change vs previous close">F&amp;O OI</th>
                <th className="num" title="Sector index since its open">Sector</th>
                <th>Data</th>
                <th className="num" title="09:20 score (0–100) for the chosen strategy and direction; tiers 85+ strong, 70–84 watchlist, 50–69 weak">Score</th>
                <th>Strategy</th>
                <th>Decision</th>
                <th>Reasons</th>
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
                  <td className="num" title={r.baselineDays != null ? `${r.baselineDays}/20 sessions in the baseline` : ''}>{f2(r.rvol)}</td>
                  <td className="num">{f2(r.rvalue)}</td>
                  <td className="num">{f2(r.rangeX)}</td>
                  <td className="num">{f2(r.gapX)}</td>
                  <td className={`num ${tone(r.vwapDistPct)}`}>{sgn(r.vwapDistPct)}</td>
                  <td className={`num ${tone(r.imbalance5)}`}>{sgn(r.imbalance5)}</td>
                  <td className="num">{f2(r.spreadBps, 1)}</td>
                  <td className="num" title={r.oiBuild ?? r.fnoMissing ?? ''}>{r.oiChangePct != null ? `${sgn(r.oiChangePct, 1)}%` : r.fnoMissing ? 'no data' : '—'}</td>
                  <td className={`num ${tone(r.sectorPct)}`} title={r.sectorIndex ?? ''}>{sgn(r.sectorPct)}</td>
                  <td>{r.stale ? <span className="badge decline" title="No tick for over 60 s, or none at all">stale</span> : <span className="hint">{r.ticks} ticks</span>}</td>
                  <DecisionCells x={decisions.get(r.symbol)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.trading?.gapReport?.length > 0 && (
        <p className="hint gap-report">
          <strong>Gap-ups of 3.75% or more (strategy B, reported separately):</strong>{' '}
          {data.trading.gapReport.map((g) => `${g.symbol} +${f2(g.gapPct, 1)}%: ${g.verdict}${g.decision && g.decision !== 'NO TRADE' ? ` (${g.decision})` : ''}`).join(' · ')}
        </p>
      )}
      <BreakHoldTable rows={data?.trading?.decisions ?? []} onPick={setSelected} />
      {selected && detail && <OpeningDetail d={detail} decision={decision} gap={gapLevels(data?.trading?.ledgerState, selected)} onClose={() => setSelected(null)} />}
      <p className="hint">
        Decisions are made once at 09:20 and traded on paper only (simulated fills at the bid/ask plus slippage);
        the default is NO TRADE. Figures: gap from Kite&apos;s official open; volume since 09:15 with
        the pre-open auction excluded; VWAP is Kite&apos;s average traded price; imbalance and spread are pending orders
        in the visible five levels, not trades. Ticks stamped 09:20:00 or later never change the window. Click a stock
        for candles, the order book and F&amp;O.
      </p>
    </section>
  );
}

/** Strategy D's line per stock: pattern state and execution kept apart (docs/plan-920-volume-breakout-confirmation.md §11). */
function BreakHoldTable({ rows, onPick }) {
  const shown = rows.filter((r) => r.pattern && !['NO_BREAK', 'OFF', null].includes(r.pattern.code));
  if (!shown.length) return null;
  return (
    <details className="score-details" open>
      <summary>D · 3-minute break and hold: {shown.length} stock(s) with a break, a wait or a data problem{shown.some((r) => r.pattern.shadow) ? ' (shadow mode: shown, not traded)' : ''}</summary>
      <div className="table-wrap">
        <table className="research-table">
          <thead><tr><th>Stock</th><th>State</th><th>Code</th><th>Side</th><th>Level</th><th>09:18 RVOL</th><th>Opening RVOL</th><th>Hold</th><th>Data</th><th>Decision</th><th>Blocker / next event</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const p = r.pattern;
              return (
                <tr key={r.symbol} onClick={() => onPick(r.symbol)} style={{ cursor: 'pointer' }}>
                  <td className="mono">{r.symbol}</td><td>{p.state}</td><td className="hint">{p.code}</td><td>{p.direction}</td>
                  <td title={p.reference ?? ''}>{p.level != null ? `${f2(p.level)} (±${f2(p.buffer)})` : '—'}</td>
                  <td>{f2(p.breakoutRvol)}</td><td>{f2(p.openingRvol)}</td><td>{p.hold ?? '—'}</td>
                  <td className="hint" title={p.dataMode ?? ''}>{p.label ?? (p.dataMode?.startsWith('sampled') ? 'sampled' : p.dataMode ? 'candles' : '—')}</td>
                  <td>{p.shadow ? 'shadow' : p.execution}</td><td className="hint">{p.blocker ?? p.nextEvent ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Confirmed means the pattern passed on sampled prices; it isn't a fill, and doesn&apos;t mean the move continues. D ranks by reward/risk to target 1, then 09:18 RVOL (capped at 3), then spread: a selection rule, not a probability.</p>
    </details>
  );
}

/** D's evidence for one stock: the five minutes with volume, the frozen level and buffer, the audit fields. */
function BreakHoldEvidence({ p }) {
  const ev = p.evidence ?? {};
  const m = p.metrics ?? {};
  const base = ev.volume?.minuteBaseline;
  return (
    <details>
      <summary>D · 3-minute break and hold: {p.state} ({p.code}){p.shadow ? ', shadow mode' : ''}</summary>
      <p className="hint">
        Reference {ev.reference?.label ?? '—'}: {f2(m.L3)}–{f2(m.H3)}, frozen at {ev.reference?.frozenAt ?? '09:18'}; buffer ₹{f2(m.b)} ({m.bufferSource});
        levels {f2(m.longThreshold)} / {f2(m.shortThreshold)}. Data: {ev.dataMode}. Version {ev.strategyVersion}, settings {ev.settingsHash}.
        {p.nextEvent ? ` Next: ${p.nextEvent}.` : ''}
      </p>
      {ev.highVolumeReference && (
        <table className="research-table">
          <thead><tr><th>Minute</th><th>High</th><th>Low</th><th>Volume</th><th>RVOL</th><th>09:18 closed beyond</th></tr></thead>
          <tbody>
            {ev.highVolumeReference.candles.map((c) => <tr key={c.minute}><td>{c.minute}</td><td>{c.high}</td><td>{c.low}</td><td>{vol(c.volume)}</td><td>{f2(c.rvol)}</td><td>{c.brokenBy0918 ?? '—'}</td></tr>)}
            {ev.breakout && <tr><td>09:18 (break)</td><td>{ev.breakout.ohlcv[1]}</td><td>{ev.breakout.ohlcv[2]}</td><td>{vol(ev.breakout.ohlcv[4])}{ev.breakout.volumeLowerBound !== ev.breakout.ohlcv[4] ? ` (≥ ${vol(ev.breakout.volumeLowerBound)})` : ''}</td><td>{f2(ev.breakout.minuteRvol)}{base ? ` vs ${vol(base)}` : ''}</td><td>body {f2(ev.breakout.bodyRatio)}, close {f2(ev.breakout.closeLocation)}</td></tr>}
            {ev.hold && <tr><td>09:19 (hold)</td><td>{ev.hold.ohlcv[1]}</td><td>{ev.hold.ohlcv[2]}</td><td>{vol(ev.hold.ohlcv[4])}</td><td /><td>{ev.hold.accepted ? 'held' : 'not held'} (limit {f2(ev.hold.depthLimit)})</td></tr>}
          </tbody>
        </table>
      )}
      <p className="hint">Raw-volume leader {ev.highVolumeReference?.rawLeader ?? '—'}, RVOL leader {ev.highVolumeReference?.normalizedLeader ?? '—'}: context, not extra confirmations.</p>
    </details>
  );
}

function DecisionCells({ x }) {
  if (!x) return <><td className="num">—</td><td /><td /><td /></>;
  return (
    <>
      <td className="num" title={x.tier ?? ''}>{x.score ?? '—'}</td>
      <td>{x.strategy ? STRAT[x.strategy] : '—'}</td>
      <td><span className={`badge ${DECISION_CLASS[x.decision]}`}>{x.decision}</span></td>
      <td className="reasons-cell" title={x.reasons.join('\n')}>{x.reasons[0] ?? (x.rank ? `ranked ${x.rank}` : '')}</td>
    </>
  );
}

function DecisionDetail({ x }) {
  const p = x.plan;
  return (
    <div className="decision-detail">
      <p>
        <span className={`badge ${DECISION_CLASS[x.decision]}`}>{x.decision}</span>{' '}
        {x.strategyLabel ? <strong>{x.strategyLabel}</strong> : 'No strategy setup'} · score <strong>{x.score ?? '—'}</strong> ({x.tier ?? 'n/a'}; {x.coverage}% of the factors had data)
        {x.rank ? ` · ranked ${x.rank}` : ''}
      </p>
      {x.reasons.length > 0 && <ul className="reasons">{x.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {p && (
        <p className="hint">
          {p.side} {p.qty} (half at T1: {p.firstExitQty}) · trigger {f2(p.trigger)} (expected fill {f2(p.expectedEntry)}, max {f2(p.maxEntry)}) · stop {f2(p.stop)} ·
          T1 {f2(p.target1)} · T2 {f2(p.target2)} · risk ₹{f2(p.riskAmount, 0)} · costs ₹{f2(p.costs.total)} · reward/risk after costs {f2(p.rewardRisk)}
          {x.signalNote ? <><br />{x.signalNote}</> : null}
        </p>
      )}
      <table className="bias-table score-table">
        <thead><tr><th>Group</th><th className="num">Weight</th><th className="num">Score</th></tr></thead>
        <tbody>{x.groups.map((g) => <tr key={g.key}><td>{g.label}</td><td className="num">{g.weight}</td><td className="num">{g.score ?? 'no data'}</td></tr>)}</tbody>
      </table>
      <details>
        <summary>Every factor and where it comes from</summary>
        <table className="bias-table">
          <tbody>
            {x.factors.map((f) => (
              <tr key={f.key}>
                <td>{f.result ? RESULT_MARK[f.result] : '–'}</td><td>{f.label}{f.off ? ' (switched off: not scored)' : f.weight != null && f.weight !== 1 ? ` (weight ${f.weight})` : ''}</td><td>{f.result == null ? `not scored: ${f.detail}` : f.detail}</td><td className="hint">{f.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {x.pattern?.evidence && <BreakHoldEvidence p={x.pattern} />}
      <details>
        <summary>Strategy checks</summary>
        {x.strategies.map((s) => (
          <div key={s.strategy}>
            <strong>{s.label}</strong>: {s.applies ? (s.pass ? (s.shadow ? 'confirmed (shadow mode: shown, not traded)' : 'setup valid') : 'setup not valid') : `not applicable (${s.reason})`}
            {s.code && <span className="hint"> · {s.code}</span>}
            {s.applies && <ul className="reasons">{s.checks.map((c) => <li key={c.key}>{c.ok ? '✓' : '✗'} {c.label}: {c.detail}</li>)}</ul>}
          </div>
        ))}
      </details>
    </div>
  );
}

/** A stock's 9:15 gap entry in the ledger: the fill and current levels (or the plan before the fill). */
function gapLevels(st, symbol) {
  const p = st?.positions?.find((x) => x.symbol === symbol && x.strategy === 'gap915');
  if (p) return { entry: p.avgEntry, stop: p.stop, target1: p.t1Done ? null : p.target1, target2: p.target2 };
  const o = st?.orders?.find((x) => x.symbol === symbol && x.strategy === 'gap915' && x.open);
  return o ? { entry: o.plan?.entry, stop: o.stop, target1: o.target1, target2: o.target2 } : null;
}

function OpeningDetail({ d, decision, gap, onClose }) {
  return (
    <div className="settings-card opening-detail">
      <div className="section-head">
        <h3 className="report-heading">{d.symbol} <span className="hint">{d.sector}</span></h3>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
      </div>
      <OpeningChart d={d} plan={decision?.plan ?? null} gap={gap} />
      {gap && <p className="hint">9:15 gap entry (paper): fill {gap.entry ?? '—'}, stop {gap.stop ?? '—'}, T1 {gap.target1 ?? 'done'}, T2 {gap.target2 ?? 'trail'}.</p>}
      {decision ? <DecisionDetail x={decision} /> : <p className="hint">No 09:20 decision for this stock yet.</p>}
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
          {d.research && (
            <p className="hint">
              <strong>Vs the last 20 sessions</strong> (research, not scored; {d.research.baselineDays ?? 0}/20 sessions of Kite 1-minute candles):
              volume {f2(d.rvol)}× · value ₹{vol(Math.round(d.research.windowValue))} vs ₹{vol(d.research.avgValue == null ? null : Math.round(d.research.avgValue))} ({f2(d.research.rvalue)}×) ·
              range {f2(d.orRangePct)}% vs {f2(d.research.avgRangePct)}% ({f2(d.research.rangeX)}×) ·
              gap {sgn(d.gapPct)}% vs an average {f2(d.research.avgAbsGap)}% ({f2(d.research.gapX)}×, NSE end-of-day files). Value today uses sampled 1-minute candles, so it is approximate.
            </p>
          )}
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
