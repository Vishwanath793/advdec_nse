import { useCallback, useEffect, useState } from 'react';
import { api } from './platform/index.js';
import { STRATEGY_FIELDS, STRATEGY_LABELS, StrategyExtras } from './TradingPanel.jsx';
import { indiaDate } from './core/calendar.js';

/**
 * Research (milestone 3) on the Report card page: candle backtests on Kite
 * historical candles and tick replay of recorded mornings, both run by the
 * backend in the background. BACKTEST mode: nothing is traded. Hidden on the
 * phone (no backend).
 */

const rs = (n) => (n == null ? '—' : n === Infinity ? '∞' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const f2 = (n) => (n == null ? '—' : n === Infinity ? '∞' : Number(n).toFixed(2));
const pctTxt = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const tone = (n) => (n > 0 ? 'adv-text' : n < 0 ? 'dec-text' : '');
const addDays = (iso, n) => indiaDate(new Date(Date.parse(`${iso}T12:00:00+05:30`) + n * 86_400_000));

const TAB_LABEL = { backtest: 'Candle backtest', replay: 'Tick replay', reconcile: 'Volume check' };
const STAT_HEADERS = ['Trades', 'Win rate', 'Avg win', 'Avg loss', 'Profit factor', 'Net after costs', 'Max drawdown', 'Expectancy', 'Exp. R', 'Avg R:R', 'Losing streak'];
function StatCells({ s }) {
  return (
    <>
      <td>{s.trades}</td><td>{pctTxt(s.winRate)}</td><td>{rs(s.avgWin)}</td><td>{rs(s.avgLoss)}</td><td>{f2(s.profitFactor)}</td>
      <td className={tone(s.net)}>{rs(s.net)}</td><td>{rs(s.maxDrawdown)}</td><td className={tone(s.expectancy)}>{rs(s.expectancy)}</td>
      <td>{f2(s.expectancyR)}</td><td>{f2(s.avgRewardRisk)}</td><td>{s.longestLosingStreak}</td>
    </>
  );
}
function StatTable({ first, rows }) {
  return (
    <div className="table-wrap">
      <table className="research-table">
        <thead><tr>{first.map((h) => <th key={h}>{h}</th>)}{STAT_HEADERS.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map(({ key, cells, s }) => <tr key={key}>{cells.map((c, i) => <td key={i}>{c}</td>)}<StatCells s={s} /></tr>)}</tbody>
      </table>
    </div>
  );
}

const BREAKDOWNS = { strategy: 'Strategy', gap: 'Gap size', rvol: 'RVOL', sector: 'Sector', regime: 'Market regime' };
function Breakdowns({ b }) {
  const [by, setBy] = useState('strategy');
  if (!b) return null;
  return (
    <div className="ai-section">
      <h4>Breakdown by{' '}
        <select value={by} onChange={(e) => setBy(e.target.value)}>{Object.entries(BREAKDOWNS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </h4>
      {b[by]?.length ? <StatTable first={[BREAKDOWNS[by]]} rows={b[by].map((g) => ({ key: g.key, cells: [g.key], s: g }))} /> : <p className="hint">No closed trades.</p>}
    </div>
  );
}

function Trades({ trades, notFilled }) {
  const [all, setAll] = useState(false);
  const shown = all ? trades : trades.slice(0, 50);
  return (
    <details className="score-details">
      <summary>Trades ({trades.length}){notFilled?.length ? ` · not filled: ${notFilled.length}` : ''}</summary>
      <div className="table-wrap">
        <table className="research-table">
          <thead><tr><th>Date</th><th>Stock</th><th>Strategy</th><th>Side</th><th>Score</th><th>Qty</th><th>Entry</th><th>Exits</th><th>Net</th><th>R</th><th>Gap %</th><th>RVOL</th></tr></thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={`${t.date}-${t.symbol}-${t.strategy}-${i}`}>
                <td>{t.date}</td><td className="mono">{t.symbol}</td><td>{t.strategy}</td><td>{t.side}</td><td>{t.score ?? '—'}</td><td>{t.qty}</td><td>{t.entry}</td>
                <td className="hint">{(t.exits ?? []).map((x) => `${x.qty}@${x.price} ${x.kind}`).join(', ')}</td>
                <td className={tone(t.net)}>{rs(t.net)}</td><td>{f2(t.r)}</td><td>{f2(t.gapPct)}</td><td>{f2(t.rvol)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && trades.length > 50 && <button type="button" className="btn" onClick={() => setAll(true)}>Show all {trades.length}</button>}
      {notFilled?.length > 0 && <p className="hint">Not filled: {notFilled.slice(0, 30).map((t) => `${t.date} ${t.symbol} (${t.status}${t.reason ? `: ${t.reason}` : ''})`).join('; ')}{notFilled.length > 30 ? '…' : ''}</p>}
    </details>
  );
}

function BacktestResult({ r }) {
  const sk = r.skipped ?? {};
  const skippedText = [
    sk.noEndOfDay?.length ? `${sk.noEndOfDay.length} days without an NSE end-of-day file` : null,
    sk.noStocks?.length ? `${sk.noStocks.length} days with no gaps` : null,
    sk.noToken?.length ? `${sk.noToken.length} stocks not in Kite's instruments (${sk.noToken.slice(0, 8).join(', ')}${sk.noToken.length > 8 ? '…' : ''})` : null,
    sk.noCandles?.length ? `${sk.noCandles.length} stock-days without candles` : null,
  ].filter(Boolean);
  return (
    <>
      <p className="hint">
        {r.first} – {r.last}: {r.days} trading days ({r.recordedDays} recorded), {r.stocksTested} stock-days, top {r.maxPerDay} gaps of {r.minGapPct}%+ a day.
        {' '}Run {new Date(r.ranAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}; {r.requests} Kite requests (cached candles cost none).
        {skippedText.length ? ` Skipped: ${skippedText.join('; ')}.` : ''}
      </p>
      <div className="ai-section">
        <h4>Strategies compared</h4>
        <StatTable first={['Variant']} rows={r.variants.map((v) => ({ key: v.key, cells: [v.label], s: v.summary }))} />
      </div>
      <Breakdowns b={r.breakdowns} />
      <div className="ai-section">
        <h4>Slippage sensitivity (combined)</h4>
        <StatTable first={['Slippage']} rows={r.slippage.map((x) => ({ key: x.bps, cells: [`${x.bps} bps`], s: x.summary }))} />
      </div>
      <div className="ai-section">
        <h4>Parameter ranges (combined): look for a stable region, not the best single value</h4>
        <StatTable first={['Parameter', 'Value']} rows={r.sweeps.flatMap((sw) => sw.values.map((x) => ({ key: `${sw.key}-${x.value}`, cells: [sw.label, x.value], s: x.summary })))} />
      </div>
      <div className="ai-section">
        <h4>Out of sample and walk-forward</h4>
        {r.oos?.skipped ? <p className="hint">Out-of-sample split: {r.oos.skipped}.</p> : (
          <StatTable first={['Part']} rows={[{ key: 'in', cells: [`In sample (before ${r.oos.split})`], s: r.oos.inSample }, { key: 'out', cells: [`Out of sample (from ${r.oos.split})`], s: r.oos.outOfSample }]} />
        )}
        {r.walkForward?.skipped ? <p className="hint">Walk-forward: {r.walkForward.skipped}.</p> : (
          <>
            <div className="table-wrap">
              <table className="research-table">
                <thead><tr><th>Train</th><th>Test</th><th>Chosen {r.walkForward.parameter}</th><th>Why</th><th>Test trades</th><th>Test net</th><th>Fixed setting net</th></tr></thead>
                <tbody>{r.walkForward.steps.map((s) => <tr key={s.testDays}><td>{s.trainDays}</td><td>{s.testDays}</td><td>{s.chosen}</td><td className="hint">{s.chosenBecause}</td><td>{s.test.trades}</td><td className={tone(s.test.net)}>{rs(s.test.net)}</td><td className={tone(s.fixed.net)}>{rs(s.fixed.net)}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="hint">Walk-forward out of sample: {r.walkForward.outOfSample.trades} trades, net {rs(r.walkForward.outOfSample.net)}; with the fixed setting: {rs(r.walkForward.fixedOutOfSample.net)}.</p>
          </>
        )}
      </div>
      <BreakHoldResearch d={r.dResearch} />
      <Trades trades={r.trades} notFilled={r.notFilled} />
    </>
  );
}

/** Strategy D's study (§15): outcomes from the first executable price after confirmation, sensitivities, split. */
function BreakHoldResearch({ d }) {
  if (!d) return null;
  const sp = d.split ?? {};
  return (
    <div className="ai-section">
      <h4>Strategy D study: does +1R come before −1R within {d.study.horizonMin} minutes of the first executable price?</h4>
      <div className="table-wrap">
        <table className="research-table">
          <thead><tr><th>Row</th><th>Signals</th><th>+1R first</th><th>−1R first</th><th>Ambiguous</th><th>Expired</th><th>Win share</th><th>Long</th><th>Short</th><th>MFE R</th><th>MAE R</th><th>Back in range ≤{d.study.returnToRangeMin} min</th></tr></thead>
          <tbody>
            {d.table.map((x) => (
              <tr key={x.key}><td>{x.label}</td><td>{x.signals}</td><td>{x.wins}</td><td>{x.losses}</td><td>{x.ambiguous}</td><td>{x.expired}</td><td>{pctTxt(x.winShare)}</td>
                <td>{x.long.wins}/{x.long.signals}</td><td>{x.short.wins}/{x.short.signals}</td><td>{f2(x.avgMfeR)}</td><td>{f2(x.avgMaeR)}</td><td>{pctTxt(x.returnToRange)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Ambiguous: one minute reached both +1R and −1R (the order inside a candle is unknown). Win share counts decided signals only.</p>
      <h4>D alone, trading study: predeclared ranges (look for stability, not the best value)</h4>
      <StatTable first={['Parameter', 'Value']} rows={d.sweeps.flatMap((sw) => sw.values.map((x) => ({ key: `${sw.key}-${x.value}`, cells: [sw.label, x.value], s: x.summary })))} />
      {sp.skipped ? <p className="hint">Development/test split: {sp.skipped}.</p> : (
        <>
          <StatTable first={['Part', 'Days']} rows={[{ key: 'dev', cells: ['Development', sp.devDays], s: sp.dev }, { key: 'test', cells: ['Untouched test', sp.testDays], s: sp.test }]} />
          <p className="hint">
            {sp.rule}. Net per session: development {rs(sp.devSessions.meanPerSession)} ({rs(sp.devSessions.low)} to {rs(sp.devSessions.high)}),
            test {rs(sp.testSessions.meanPerSession)} ({rs(sp.testSessions.low)} to {rs(sp.testSessions.high)}), 95% across sessions. {d.note}
          </p>
        </>
      )}
    </div>
  );
}

function ReplayResult({ r }) {
  return (
    <>
      <p className="hint">{r.days.length} recorded morning(s): {r.days.map((d) => d.date).join(', ')}. Run {new Date(r.ranAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.</p>
      <StatTable first={['Day']} rows={[{ key: 'all', cells: ['All'], s: r.summary }, ...r.days.map((d) => ({ key: d.date, cells: [d.date], s: d.summary }))]} />
      <Breakdowns b={r.breakdowns} />
      <Trades trades={r.trades} notFilled={r.notFilled} />
    </>
  );
}

/** Strategy D's volume check (§5.2): recorded tick volumes per minute vs Kite's 1-minute bars. */
function ReconcileResult({ r }) {
  return (
    <>
      <div className={`alert ${r.verdict.matched ? 'info' : 'warn'}`}>{r.verdict.text}{r.hint ? ` ${r.hint}` : ''}</div>
      <p className="hint">
        {r.mornings} recorded morning(s): {r.dates.join(', ')}. Run {new Date(r.ranAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.
        {' '}{r.window.stockDays} complete stock-days; 09:15–09:19 total, ticks ÷ Kite median {f2(r.window.medianRatio)}.
        Rule: every minute&apos;s median within ±{r.rule.tolerance * 100}%, {r.rule.minStockDays}+ stock-days, {r.rule.minMornings}+ mornings.
        Until it matches, strategy D in paper mode stays DATA_INSUFFICIENT (Settings can switch that requirement off).
      </p>
      <div className="table-wrap">
        <table className="research-table">
          <thead><tr><th>Minute</th><th>Comparisons</th><th>Median ticks ÷ Kite</th><th>Within tolerance</th></tr></thead>
          <tbody>{r.minutes.map((m) => <tr key={m.minute}><td>{m.minute}</td><td>{m.samples}</td><td>{f2(m.medianRatio)}</td><td>{pctTxt(m.shareWithin)}</td></tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

/** Per-run overrides: the score and strategy thresholds (never saved; Settings keeps the paper-trading ones). */
function Overrides({ o, set }) {
  const strat = (g, k, v) => set({ ...o, strategies: { ...o.strategies, [g]: { ...o.strategies[g], [k]: v } } });
  return (
    <details className="score-details">
      <summary>Settings for this run (start from your trading settings; changes here are not saved)</summary>
      <div className="trading-grid">
        <label className="field-inline">Weights
          <select value={o.scoring.preset} onChange={(e) => set({ ...o, scoring: { ...o.scoring, preset: e.target.value } })}>
            <option value="unit">Every factor by its own weight</option><option value="research">Research groups</option><option value="custom">My own group weights</option>
          </select>
        </label>
        <label className="field-inline">Minimum score<input type="number" value={o.scoring.minScore} onChange={(e) => set({ ...o, scoring: { ...o.scoring, minScore: e.target.value } })} /></label>
        <label className="field-inline">Min reward/risk (after costs)<input type="number" step="any" value={o.risk.minRewardRisk} onChange={(e) => set({ ...o, risk: { ...o.risk, minRewardRisk: e.target.value } })} /></label>
        <label className="field-inline">Slippage (bps)<input type="number" step="any" value={o.risk.slippageBps} onChange={(e) => set({ ...o, risk: { ...o.risk, slippageBps: e.target.value } })} /></label>
      </div>
      {Object.entries(STRATEGY_FIELDS).map(([g, fields]) => (o.strategies[g] ? (
        <div key={g}>
          <h4><label><input type="checkbox" checked={o.strategies[g].enabled} onChange={(e) => strat(g, 'enabled', e.target.checked)} /> {STRATEGY_LABELS[g]}</label></h4>
          <div className="trading-grid">
            {fields.map(([k, label]) => <label key={k} className="field-inline">{label}<input type="number" step="any" value={o.strategies[g][k]} onChange={(e) => strat(g, k, e.target.value)} /></label>)}
            <StrategyExtras cfg={o.strategies[g]} set={(k, v) => strat(g, k, v)} />
          </div>
        </div>
      ) : null))}
    </details>
  );
}

export default function ResearchPanel() {
  const today = indiaDate();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ from: addDays(today, -45), to: addDays(today, -1), maxPerDay: 15, minGapPct: 0.5 });
  const [overrides, setOverrides] = useState(null);
  const [tab, setTab] = useState('backtest');
  const [results, setResults] = useState({});

  const refresh = useCallback(() => api.research.status().then((s) => { setStatus(s); return s; }).catch((e) => setError(e.message)), []);
  const loadResult = useCallback((kind) => api.research.result(kind).then((r) => setResults((x) => ({ ...x, [kind]: r }))).catch(() => {}), []);
  useEffect(() => {
    if (!api.research) return;
    refresh();
    loadResult('backtest');
    loadResult('replay');
    loadResult('reconcile');
    api.trading?.state().then((s) => setOverrides({ risk: s.settings.risk, scoring: s.settings.scoring, strategies: s.settings.strategies })).catch(() => {});
  }, [refresh, loadResult]);
  const running = status?.job?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(async () => {
      const s = await refresh();
      if (s?.job && s.job.state !== 'running' && s.job.state === 'done') { loadResult(s.job.kind); setTab(s.job.kind); }
    }, 1500);
    return () => clearInterval(t);
  }, [running, refresh, loadResult]);

  if (!api.research) return null;
  const go = async (fn) => { setError(null); try { await fn(); await refresh(); } catch (e) { setError(e.message); } };
  const runBacktest = () => go(() => api.research.backtest({ ...form, settings: overrides }));
  const runReplay = () => go(() => api.research.replay({ settings: overrides }));
  const runReconcile = () => go(() => api.research.reconcile());
  const job = status?.job;
  const r = results[tab];

  return (
    <section className="research-panel">
      <div className="section-head">
        <h2>Research <span className="badge mode-badge mode-backtest" title="Research on past data: nothing is traded.">BACKTEST</span></h2>
      </div>
      <p className="hint">
        The 09:20 strategies on past data, with costs and slippage, nothing traded. <strong>Candle backtest</strong>: Kite historical 1-minute
        candles for the stocks that gapped each day (from NSE&apos;s end-of-day files); depth, F&amp;O and circuit checks can&apos;t be tested
        on candles. <strong>Tick replay</strong>: the mornings the collector recorded (09:15–09:25), the only test of the order-book rules.
        Results are hypotheses on a small sample, not a forecast.
      </p>
      <div className="trading-grid">
        <label className="field-inline">From<input type="date" value={form.from} max={form.to} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
        <label className="field-inline">To<input type="date" value={form.to} max={addDays(today, -1)} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
        <label className="field-inline">Stocks a day (biggest gaps)<input type="number" min="1" max="50" value={form.maxPerDay} onChange={(e) => setForm({ ...form, maxPerDay: e.target.value })} /></label>
        <label className="field-inline">Min gap %<input type="number" step="any" min="0" value={form.minGapPct} onChange={(e) => setForm({ ...form, minGapPct: e.target.value })} /></label>
      </div>
      <p className="hint">At most {status?.limits?.maxDays ?? 60} trading days a run (the latest are kept). Candles are cached in .data/candles, so a second run of the same period needs no Kite calls.</p>
      {overrides && <Overrides o={overrides} set={setOverrides} />}
      <div className="ai-row">
        <button type="button" className="btn" disabled={running || status?.quietNow || !status?.kiteConnected} onClick={runBacktest}
          title={!status?.kiteConnected ? 'Connect to Kite first (historical candles)' : ''}>Run candle backtest</button>
        <button type="button" className="btn" disabled={running || status?.quietNow || !status?.recordedTickDays?.length} onClick={runReplay}>
          Replay recorded mornings ({status?.recordedTickDays?.length ?? 0})
        </button>
        <button type="button" className="btn" disabled={running || status?.quietNow || !status?.recordedTickDays?.length || !status?.kiteConnected} onClick={runReconcile}
          title="Strategy D: compare recorded tick volumes with Kite's 1-minute bars (needs a Kite login)">Check D&apos;s volumes against Kite</button>
        {running && <button type="button" className="btn" onClick={() => go(() => api.research.cancel())}>Cancel</button>}
      </div>
      {status && !status.kiteConnected && <p className="hint">Kite isn&apos;t connected: the candle backtest needs a Kite login (Settings). Tick replay doesn&apos;t.</p>}
      {status?.quietNow && <p className="hint">Research waits until after {status.quiet.to} IST on trading days, so the opening window has the backend to itself.</p>}
      {job && (
        <div className={`alert ${job.state === 'failed' ? 'error' : 'info'}`}>
          {{ replay: 'Tick replay', reconcile: 'Volume check' }[job.kind] ?? 'Candle backtest'}: {job.state}{job.state === 'running' ? ` — ${job.stage ?? ''} ${job.total ? `${job.done}/${job.total}` : ''}` : ''}{job.error ? ` — ${job.error}` : ''}
          {job.state === 'running' && job.total > 0 && <progress value={job.done} max={job.total} style={{ marginLeft: 8 }} />}
        </div>
      )}
      {error && <div className="alert error">{error}</div>}

      <div className="ai-row">
        {['backtest', 'replay', 'reconcile'].map((k) => (
          <button key={k} type="button" className={`btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{TAB_LABEL[k]}{results[k] ? '' : ' (none yet)'}</button>
        ))}
        {r && <a className="btn" href={api.research.exportUrl(tab)} download>Export to Excel</a>}
      </div>
      {r ? (tab === 'backtest' ? <BacktestResult r={r} /> : tab === 'replay' ? <ReplayResult r={r} /> : <ReconcileResult r={r} />) : <p className="hint">No {TAB_LABEL[tab].toLowerCase()} has been run yet.</p>}
      {r?.limitations?.length > 0 && (
        <details className="score-details">
          <summary>Limitations</summary>
          <ul className="hint">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
