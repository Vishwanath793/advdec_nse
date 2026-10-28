import { useEffect, useState } from 'react';
import { api } from './platform/index.js';
import { MAX_FACTOR_WEIGHT, OPENING_FACTORS, OPENING_GROUPS } from './utils/confirmation.js';
import { DEFAULT_SCORING_SETTINGS } from './utils/decision.js';
import { DEFAULT_RISK_SETTINGS } from './utils/risk.js';
import { DEFAULT_STRATEGY_SETTINGS } from './utils/strategies.js';

/**
 * The 09:20 trading UI (milestone 2: PAPER only).
 *   ModeBadge        BACKTEST / PAPER / LIVE, on every page
 *   TradingPanel     capital, mode, positions, pending entries, P&L, the day's trades, daily-loss bar, kill switch
 *   TradingSettings  risk limits, charges, every strategy threshold, score weights per factor and group,
 *                    tiers, the factors' pass/warn lines, the opening universe (Settings page)
 */

const rs = (n) => (n == null || !Number.isFinite(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const f2 = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
const tone = (n) => (n > 0 ? 'adv-text' : n < 0 ? 'dec-text' : '');
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '');

const MODE_INFO = {
  BACKTEST: 'Research on past data: nothing is traded.',
  PAPER: 'Paper trading: simulated fills at the live bid/ask plus slippage. No real orders are sent.',
  LIVE: 'Live trading: real orders.',
};

export function ModeBadge() {
  const [mode, setMode] = useState(api.trading ? null : 'PAPER');
  useEffect(() => {
    if (!api.trading) return undefined;
    let alive = true;
    const load = () => api.trading.state().then((s) => { if (alive) setMode(s.mode); }).catch(() => { if (alive) setMode(null); });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const m = mode ?? 'PAPER';
  const title = api.trading ? MODE_INFO[m] : 'The phone never places orders; paper trading runs in the PC backend.';
  return <span className={`badge mode-badge mode-${m.toLowerCase()}`} title={title}>{mode ? m : 'PAPER?'}</span>;
}

/** The trading view from the scanner's SSE payload (it includes `trading`), or polled when that isn't open. */
export function useTradingView(ledger) {
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!api.trading) return undefined;
    let alive = true;
    const load = () => api.trading.state(ledger).then((v) => { if (alive) { setView(v); setError(null); } }).catch((e) => alive && setError(e.message));
    load();
    const unsubscribe = api.opening?.subscribe((d) => {
      if (!alive || !d.trading) return;
      if (d.trading.ledger === ledger) setView(d.trading);
    }, () => {});
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); unsubscribe?.(); };
  }, [ledger]);
  return [view, setView, error];
}

export function TradingPanel() {
  const [ledger, setLedger] = useState('day');
  const [view, setView, loadError] = useTradingView(ledger);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!api.trading) {
    return <div className="alert info">Paper trading runs in the PC backend; the phone never places orders.</div>;
  }
  const st = view?.ledgerState;
  const r = view?.settings?.risk;
  const act = async (fn) => { setBusy(true); try { setView(await fn()); setError(null); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const open = st?.positions.filter((p) => p.status === 'OPEN') ?? [];
  const pending = st?.orders.filter((o) => o.open && !st.positions.some((p) => p.id === o.id && p.status === 'OPEN')) ?? [];
  const closed = st?.positions.filter((p) => p.status === 'CLOSED') ?? [];
  const lossUsed = st && view.dailyLossLimit ? Math.max(0, Math.min(1, -Math.min(0, st.realised + Math.min(0, st.unrealised ?? 0)) / view.dailyLossLimit)) : 0;
  const mark = (p) => st.marks?.find((m) => m.id === p.id);

  return (
    <section className="settings-card trading-panel">
      <div className="section-head">
        <h3 className="report-heading">09:20 trading <ModeBadge /></h3>
        <div className="export-actions">
          <select value={ledger} onChange={(e) => setLedger(e.target.value)} aria-label="Ledger">
            <option value="day">Today (paper)</option>
            <option value="replay">Simulated replay</option>
          </select>
          <button type="button" className={`btn ${st?.killSwitch ? '' : 'danger'}`} disabled={busy || !st}
            onClick={() => act(() => api.trading.kill(!st.killSwitch, ledger))}
            title="On: cancels pending paper entries, closes open paper positions at the bid/ask and blocks new trades today">
            {st?.killSwitch ? 'Kill switch ON — turn off' : 'Kill switch'}
          </button>
          <button type="button" className="btn ghost" disabled={busy || !open.length} onClick={() => act(() => api.trading.closeAll(ledger))}>Square off all</button>
          {ledger === 'day' && st?.date && <a className="btn ghost" href={api.trading.logUrl(st.date)} download>Event log</a>}
        </div>
      </div>
      {(error || loadError) && <div className="alert error">{error || loadError}</div>}
      <div className="alert info">
        <strong>PAPER</strong> — simulated fills at the live bid/ask plus {r?.slippageBps ?? '—'} bps slippage, never at the last price; no orders go to Kite.
        A stop or target in paper is no promise of the same fill live. LIVE trading is not built yet (milestone 4).
      </div>
      {view?.reconcile?.mismatches?.length > 0 && (
        <div className="alert warn"><strong>Reconciled after a restart:</strong> {view.reconcile.mismatches.join('; ')} — the event log was used.</div>
      )}
      {r && (
        <div className="trading-stats">
          <span>Capital <strong>{rs(r.capital)}</strong></span>
          <span>Risk/trade <strong>{r.riskPerTradePct}%</strong> ({rs((r.capital * r.riskPerTradePct) / 100)})</span>
          <span>Realised <strong className={tone(st?.realised)}>{rs(st?.realised ?? 0)}</strong></span>
          <span>Unrealised <strong className={tone(st?.unrealised)}>{rs(st?.unrealised ?? 0)}</strong> <span className="hint">(at bid/ask)</span></span>
          <span>Charges <strong>{rs(st?.charges ?? 0)}</strong></span>
          <span title="09:20 trades; the 9:15 gap entries don't use these slots">Trades <strong>{(st?.trades ?? 0) - (st?.gap?.trades ?? 0)}</strong>/{r.maxTradesPerDay} · W/L {st?.wins ?? 0}/{st?.losses ?? 0}</span>
          <span title="09:20 positions and entries; the 9:15 gap entries don't use these slots">Open <strong>{[...open, ...pending].filter((x) => x.strategy !== 'gap915').length}</strong>/{r.maxOpenPositions}</span>
        </div>
      )}
      {r && (
        <div className="loss-bar" title={`Daily loss limit ${rs(view.dailyLossLimit)} (${r.dailyLossPct}% of capital)`}>
          <div className={`loss-bar-fill ${lossUsed >= 1 ? 'full' : ''}`} style={{ width: `${lossUsed * 100}%` }} />
          <span className="loss-bar-label">Daily loss used: {f2(lossUsed * 100, 0)}% of {rs(view.dailyLossLimit)}</span>
        </div>
      )}
      {view?.blockers?.length > 0 && <div className="alert warn">No new trades: {view.blockers.join('; ')}</div>}
      {!st?.decidedAt && <p className="hint">No 09:20 decision {ledger === 'day' ? 'today yet' : 'in this replay yet (Confirm page → Replay simulated morning)'}.</p>}
      {st?.decidedAt && (
        <p className="hint">Decided at {time(st.decidedAt)}{st.decision?.partial ? ' (partial window)' : ''}: {st.decision?.rows.filter((x) => x.decision !== 'NO TRADE').map((x) => `${x.decision} ${x.symbol}`).join(', ') || 'NO TRADE on every stock'}.</p>
      )}

      {(open.length > 0 || pending.length > 0) && (
        <div className="table-wrap">
          <table className="stock-table">
            <thead><tr><th>Stock</th><th>Side</th><th>Strategy</th><th>Status</th><th className="num">Qty</th><th className="num">Entry</th><th className="num">Stop</th><th className="num">T1</th><th className="num">T2</th><th className="num">Mark</th><th className="num">P&amp;L</th></tr></thead>
            <tbody>
              {open.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.symbol}</td><td>{p.side}</td><td>{p.strategy}</td><td>OPEN{p.t1Done ? ' (T1 done)' : ''}</td>
                  <td className="num">{p.qty}/{p.entryQty}</td><td className="num">{f2(p.avgEntry)}</td><td className="num" title={p.stopReason ?? ''}>{f2(p.stop)}</td>
                  <td className="num">{f2(p.target1)}</td><td className="num">{f2(p.target2)}</td><td className="num">{f2(mark(p)?.mark)}</td>
                  <td className={`num ${tone(mark(p)?.unrealised)}`}>{rs(mark(p)?.unrealised)}</td>
                </tr>
              ))}
              {pending.map((o) => (
                <tr key={o.id}>
                  <td className="mono">{o.symbol}</td><td>{o.side}</td><td>{o.strategy}</td><td>{o.status === 'TRIGGERED' ? 'triggered, waiting within the limit' : o.immediate ? 'entering at the touch' : `pending (expires ${time(o.expiresAt)})`}</td>
                  <td className="num">{o.filledQty}/{o.qty}</td><td className="num" title={`maximum entry ${o.maxEntry}`}>{f2(o.trigger)}</td><td className="num">{f2(o.stop)}</td>
                  <td className="num">{f2(o.target1)}</td><td className="num">{f2(o.target2)}</td><td className="num">—</td><td className="num">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {st?.orders?.length > 0 && (
        <>
          <strong>Today&apos;s orders and trades</strong>
          <div className="table-wrap">
            <table className="stock-table">
              <thead><tr><th>Stock</th><th>Side</th><th>Order</th><th className="num">Filled</th><th className="num">Avg entry</th><th>Exits</th><th className="num">Gross</th><th className="num">Charges</th><th className="num">Net</th></tr></thead>
              <tbody>
                {st.orders.map((o) => {
                  const p = closed.find((x) => x.id === o.id) ?? open.find((x) => x.id === o.id);
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.symbol}</td><td>{o.side}</td>
                      <td title={o.reason ?? ''}>{o.status}{o.reason ? ` — ${o.reason}` : ''}</td>
                      <td className="num">{o.filledQty}/{o.qty}</td><td className="num">{f2(o.avgPrice)}</td>
                      <td>{p?.exits.map((x) => `${x.qty} @ ${f2(x.price)} ${x.reason} ${time(x.at)}`).join('; ') || '—'}</td>
                      <td className={`num ${tone(p?.gross)}`}>{rs(p?.gross)}</td><td className="num">{rs(p?.charges)}</td><td className={`num ${tone(p?.net)}`}>{rs(p?.net)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export const STRATEGY_FIELDS = {
  orb: [
    ['minRvol', 'Min RVOL'], ['minClosePos', 'Min close position (0–1)'], ['minRangeAtr', 'Min range × ATR'], ['maxRangeAtr', 'Max range × ATR'],
    ['wideRangeAtr', 'Wide range × ATR (stop at the midpoint)'], ['sectorTolerancePct', 'Sector may be against by (%)'], ['maxSpreadBps', 'Max spread (bps)'],
    ['target1R', 'Target 1 (R)'], ['target2R', 'Target 2 (R)'],
  ],
  gapPullback: [
    ['minGapPct', 'Min gap %'], ['minPullbackPct', 'Min pullback %'], ['maxGapRetracePct', 'Max gap given back %'], ['minRecovery', 'Min recovery (0–1)'],
    ['minRecoveryVolumeRatio', 'Recovery vs pullback volume'], ['minImbalance', 'Min book imbalance'], ['maxStopPct', 'Max stop %'], ['maxSpreadBps', 'Max spread (bps)'],
  ],
  momentum: [
    ['minRvol', 'Min RVOL'], ['minConsistentMinutes', 'Min consistent minutes'], ['minClosePos', 'Min close position (0–1)'], ['maxOppositeWickPct', 'Max rejection wick %'],
    ['maxVwapDistPct', 'Max distance from VWAP %'], ['maxRet5Pct', 'Max 5-min move %'], ['maxRangeAtr', 'Max range × ATR'], ['minStability', 'Min book stability (0–1)'],
    ['minImbalance', 'Min book imbalance'], ['minStopAtr', 'Min stop × ATR'], ['maxSpreadBps', 'Max spread (bps)'], ['target1R', 'Target 1 (R)'], ['target2R', 'Target 2 (R)'],
  ],
  breakHold: [
    ['minOpeningRvol', 'Min opening RVOL (median)'], ['minBreakoutRvol', 'Min 09:18-minute RVOL (median)'], ['minBodyRatio', 'Min breakout body (0–1)'],
    ['minCloseLocation', 'Min breakout close location (0–1)'], ['maxWickRatio', 'Rejection wick shown above (0–1)'], ['bufferTicks', 'Buffer: at least ticks'],
    ['bufferRangeFrac', 'Buffer: at least × the 3-minute range'], ['minSpreadSamples', 'Min spread samples before 09:18'], ['minBaselineSessions', 'Min earlier sessions'],
    ['maxSpreadBps', 'Max spread (bps)'], ['maxChaseR', 'Max chase (× structural risk)'], ['target1R', 'Target 1 (R, before obstacles)'], ['target2R', 'Target 2 (R)'],
    ['minFirstTargetRR', 'Min reward/risk to target 1 (after costs)'], ['maxQuoteAgeSec', 'Max quote / last-trade age (s)'],
    ['maxBarEndGapSec', 'Max gap before each minute\'s end (s)'], ['maxObservationGapSec', 'Max gap between ticks (s)'],
  ],
};

/** A strategy's switches and text settings: shorts, D's shadow/paper mode and its entry deadline. */
export function StrategyExtras({ cfg, set }) {
  return (
    <>
      {'allowShorts' in cfg && (
        <label className="field-inline"><input type="checkbox" checked={cfg.allowShorts} onChange={(e) => set('allowShorts', e.target.checked)} /> Allow shorts (MIS intraday only)</label>
      )}
      {'mode' in cfg && (
        <label className="field-inline">Mode
          <select value={cfg.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="shadow">Shadow: evaluate and show, never trade</option>
            <option value="paper">Paper: trade it on paper</option>
          </select>
        </label>
      )}
      {'requireVolumeMatch' in cfg && (
        <label className="field-inline" title="The brief's release prerequisite: live tick volume must match Kite's minute bars (Report card → Research → volume check)">
          <input type="checkbox" checked={cfg.requireVolumeMatch} onChange={(e) => set('requireVolumeMatch', e.target.checked)} /> Paper only after the volume check matched
        </label>
      )}
      {'entryDeadline' in cfg && (
        <label className="field-inline">No entry from (IST)<input type="time" value={cfg.entryDeadline} onChange={(e) => set('entryDeadline', e.target.value)} /></label>
      )}
    </>
  );
}
const THRESHOLD_FIELDS = [
  ['holdOpenFlatPct', 'Holding the open: flat within ±%'], ['closePosGood', 'Close position: pass at (0–1)'], ['closePosOk', 'Close position: warn at (0–1)'],
  ['maxWickPct', 'Candle: max rejection wick %'], ['consistentGood', 'Consistent minutes: pass at'], ['consistentOk', 'Consistent minutes: warn at'],
  ['setupWarnRatio', 'Strategy checks: warn at share passing'], ['minRangeAtr', 'Range: min × ATR'], ['maxRangeAtr', 'Range: max × ATR'],
  ['gapHeldMinPct', 'Gap-not-filled factor from gap %'], ['rvolGood', 'RVOL: pass at'], ['rvolOk', 'RVOL: warn at'],
  ['volAccelGood', 'Volume building: pass at'], ['volAccelOk', 'Volume building: warn at'], ['imbalanceGood', 'Imbalance: pass at'], ['imbalanceOk', 'Imbalance: warn at'],
  ['spreadGoodBps', 'Spread: pass up to (bps)'], ['stabilityGood', 'Book stability: pass at'], ['stabilityOk', 'Book stability: warn at'],
  ['liquidityDropWarnPct', 'Liquidity: pass above change %'], ['liquidityDropFailPct', 'Liquidity: warn above change %'],
  ['impactGoodBps', 'Impact cost: pass up to (bps)'], ['impactOkBps', 'Impact cost: warn up to (bps)'],
  ['indexMovePct', 'Nifty/sector: flat within ±%'], ['relStrengthPct', 'Relative strength: flat within ±%'], ['minCircuitRoomPct', 'Min room to the circuit %'],
  ['minTicks', 'Min ticks in the window (else rejected)'],
];
const CHARGE_FIELDS = [
  ['brokeragePct', 'Brokerage %'], ['brokerageCapPerOrder', 'Brokerage cap per order (₹)'], ['sttSellPct', 'STT on sells %'], ['exchangePct', 'NSE transaction %'],
  ['sebiPerCrore', 'SEBI per crore (₹)'], ['stampBuyPct', 'Stamp duty on buys %'], ['gstPct', 'GST %'],
];
const TIER_FIELDS = [['strong', 'Strong from'], ['watchlist', 'Watchlist from'], ['weak', 'Weak from']];

/** The opening universe (collector): minimum 09:10 gap, watchlist, futures. Saved separately; applies from the next preparation. */
function UniverseSettings() {
  const [u, setU] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.opening?.settings?.().then((v) => setU({ ...v, watchlistText: (v.watchlist ?? []).join(', ') })).catch((e) => setMsg(e.message)); }, []);
  if (!api.opening?.settings) return null;
  if (!u) return msg ? <p className="hint">{msg}</p> : null;
  const save = async () => {
    try {
      const v = await api.opening.saveSettings({ minGapPct: u.minGapPct, includeFutures: u.includeFutures, watchlist: u.watchlistText.split(/[\s,]+/).filter(Boolean) });
      setU({ ...v, watchlistText: v.watchlist.join(', ') });
      setMsg('Saved. They apply from the next preparation (after the 09:10 import).');
    } catch (e) { setMsg(e.message); }
  };
  return (
    <>
      <h4>Opening universe (what the 09:15 collector subscribes to)</h4>
      <div className="trading-grid">
        <label className="field-inline">Min 09:10 gap %<input type="number" step="any" value={u.minGapPct} onChange={(e) => setU({ ...u, minGapPct: e.target.value })} /></label>
        <label className="field-inline">Watchlist (always included)<input type="text" value={u.watchlistText} placeholder="INFY, TCS" onChange={(e) => setU({ ...u, watchlistText: e.target.value })} /></label>
        <label className="field-inline"><input type="checkbox" checked={u.includeFutures} onChange={(e) => setU({ ...u, includeFutures: e.target.checked })} /> Add each F&amp;O stock&apos;s near-month future</label>
      </div>
      <button type="button" className="btn" onClick={save}>Save the universe</button>
      {msg && <p className="hint">{msg}</p>}
    </>
  );
}

/** Score weights per factor and group, tiers and the pass/warn lines (utils/confirmation.js). */
function ScoreFields({ sc, set }) {
  const custom = sc.preset === 'custom';
  const factor = (k, patch) => set({ ...sc, factors: { ...sc.factors, [k]: { ...sc.factors[k], ...patch } } });
  return (
    <>
      <h4>Score</h4>
      <div className="trading-grid">
        <label className="field-inline">Weights
          <select value={sc.preset} onChange={(e) => set({ ...sc, preset: e.target.value })}>
            <option value="unit">Every factor counts by its own weight (default: all 1)</option>
            <option value="research">Research groups: price 20, range 20, RVOL 20, depth 15, F&amp;O 10, sector 10, feasibility 5</option>
            <option value="custom">My own group weights (below)</option>
          </select>
        </label>
        <label className="field-inline">Minimum score to trade<input type="number" value={sc.minScore} onChange={(e) => set({ ...sc, minScore: e.target.value })} /></label>
        {TIER_FIELDS.map(([k, label]) => (
          <label key={k} className="field-inline">{`Tier: ${label}`}<input type="number" value={sc.tiers[k]} onChange={(e) => set({ ...sc, tiers: { ...sc.tiers, [k]: e.target.value } })} /></label>
        ))}
      </div>
      <p className="hint">Tiers are labels, not probabilities. A hard rejection (stale data, no book, circuit, 09:10 block) always wins over the score.</p>
      <details className="score-details">
        <summary>Group weights{custom ? '' : ' (used with “my own group weights”)'}</summary>
        <div className="trading-grid">
          {OPENING_GROUPS.map((g) => (
            <label key={g.key} className="field-inline">{g.label}<input type="number" step="any" min="0" disabled={!custom} value={sc.groupWeights[g.key]} onChange={(e) => set({ ...sc, groupWeights: { ...sc.groupWeights, [g.key]: e.target.value } })} /></label>
          ))}
        </div>
      </details>
      <details className="score-details">
        <summary>Factors: switch off or weight each one (within its group)</summary>
        <table className="factor-table">
          <thead><tr><th>Group</th><th>Factor</th><th>On</th><th>Weight (0–{MAX_FACTOR_WEIGHT})</th></tr></thead>
          <tbody>
            {OPENING_FACTORS.map((x) => (
              <tr key={x.key}>
                <td className="hint">{OPENING_GROUPS.find((g) => g.key === x.group)?.label}</td>
                <td>{x.label}</td>
                <td><input type="checkbox" checked={sc.factors[x.key].on} onChange={(e) => factor(x.key, { on: e.target.checked })} aria-label={`${x.label} on`} /></td>
                <td><input type="number" step="any" min="0" max={MAX_FACTOR_WEIGHT} value={sc.factors[x.key].weight} disabled={!sc.factors[x.key].on} onChange={(e) => factor(x.key, { weight: e.target.value })} aria-label={`${x.label} weight`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details className="score-details">
        <summary>Pass / warn lines for each factor</summary>
        <div className="trading-grid">
          {THRESHOLD_FIELDS.map(([k, label]) => (
            <label key={k} className="field-inline">{label}<input type="number" step="any" value={sc.thresholds[k]} onChange={(e) => set({ ...sc, thresholds: { ...sc.thresholds, [k]: e.target.value } })} /></label>
          ))}
        </div>
      </details>
    </>
  );
}
const RISK_FIELDS = [
  ['capital', 'Capital (₹)'], ['riskPerTradePct', 'Risk per trade %'], ['dailyLossPct', 'Daily loss limit %'], ['maxOpenPositions', 'Max open positions'],
  ['maxTradesPerDay', 'Max trades a day'], ['minRewardRisk', 'Min reward/risk (after costs)'], ['maxConsecutiveLosses', 'Stop after losses in a row'],
  ['misLeverage', 'MIS leverage (check your broker)'], ['slippageBps', 'Paper slippage (bps)'], ['maxSlippageBps', 'Max entry slippage (bps)'], ['maxSpreadBps', 'Max spread (bps)'],
];
export const STRATEGY_LABELS = {
  orb: 'A. Opening-range breakout / breakdown', gapPullback: 'B. Gap-up pullback recovery (≥ 3.75% gap)', momentum: 'C. Opening momentum',
  breakHold: 'D. 3-minute break and hold (09:15–09:18 range, broken at 09:18, held at 09:19)',
};

const GAP_FIELDS = [
  ['noiseAtr', 'Noise stop floor (× ATR)'], ['gapLineBufferAtr', 'Buffer below the half-gap (× ATR)'], ['wideStopAtr', 'Large/extreme stop (× ATR)'], ['maxStopAtr', 'Widest stop (× ATR)'],
  ['t1R', 'Target 1 (R)'], ['t2R', 'Target 2 cap (R)'], ['rangeAtr', 'Day range for T2 room (× ATR)'], ['circuitTicks', 'Ticks inside the circuit'],
  ['nearCircuitPct', 'Near the circuit (%)'], ['nearCircuitFactor', 'Near-circuit size ×'], ['weakRrFactor', 'Weak reward/risk size ×'], ['minFactor', 'Smallest size ×'],
  ['tightenBufferAtr', '09:20 buffer below the range (× ATR)'], ['timeStopR', 'Time stop: exit under (R)'], ['trailAtr', 'ATR trail (× ATR)'],
];

/** The LIVE gap-exit switch (phase 2); the daily typed arming is on the Orders page's gap card. */
function LiveGapSwitch() {
  const [v, setV] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.trading?.live?.state().then(setV).catch((e) => setMsg(e.message)); }, []);
  if (!api.trading?.live || !v) return msg ? <p className="hint">{msg}</p> : null;
  const toggle = async (enabled) => {
    if (enabled && !window.confirm('Turn on LIVE gap exits? Scheduled 09:15 market orders that opt in will get real SL-M and target orders at Kite, on the days you arm it with the typed confirmation.')) return;
    try { setV(await api.trading.live.setEnabled(enabled)); setMsg(null); } catch (e) { setMsg(e.message); }
  };
  return (
    <div className="field">
      <label><input type="checkbox" checked={v.enabled} onChange={(e) => toggle(e.target.checked)} /> <strong>LIVE gap exits</strong> <span className="badge mode-badge mode-live">LIVE</span></label>
      <p className="hint">
        For your own scheduled 09:15 market orders that tick “live gap exits”: after the fill, a real SL-M rests at Kite and the targets are sent as
        LIMIT IOC orders, with the same rules as the paper gap entry. It also needs a typed confirmation each trading day (Orders page), a valid
        Kite login and your whitelisted static IP. Unarmed, an opted-in order is not sent at all. Never from the phone.
        {v.enabled ? (v.armed ? ` Armed for ${v.armedFor}.` : ' Not armed today.') : ''}
      </p>
      {msg && <p className="hint">{msg}</p>}
    </div>
  );
}

/** The 9:15 gap-entry settings (utils/gapExits.js), inside the trading settings. */
function GapExitFields({ g, set }) {
  const field = (k, v) => set({ ...g, [k]: v });
  return (
    <>
      <h4>9:15 gap entry (paper; live exits below)</h4>
      <LiveGapSwitch />
      <p className="hint">
        Market entry at 09:15 for the stocks on the Orders page&apos;s gap list. It always enters; the gap (in ATR) sets the size.
        These are untested starting values: the report by gap type is how to tune them.
      </p>
      <div className="trading-grid">
        {['flat', 'normal', 'large'].map((k) => (
          <label key={k} className="field-inline">{`${k[0].toUpperCase()}${k.slice(1)} gap below (× ATR)`}<input type="number" step="any" value={g.bands[k]} onChange={(e) => set({ ...g, bands: { ...g.bands, [k]: e.target.value } })} /></label>
        ))}
        {['flat', 'normal', 'large', 'extreme'].map((k) => (
          <label key={k} className="field-inline">{`Size × for ${k} gaps`}<input type="number" step="any" value={g.sizeFactor[k]} onChange={(e) => set({ ...g, sizeFactor: { ...g.sizeFactor, [k]: e.target.value } })} /></label>
        ))}
        {GAP_FIELDS.map(([k, label]) => (
          <label key={k} className="field-inline">{label}<input type="number" step="any" value={g[k]} onChange={(e) => field(k, e.target.value)} /></label>
        ))}
        <label className="field-inline">Time stop (IST)<input type="time" value={g.timeStopAt} onChange={(e) => field('timeStopAt', e.target.value)} /></label>
        <label className="field-inline">Trail the second half
          <select value={g.trail} onChange={(e) => field('trail', e.target.value)}>
            <option value="5min">Below the last completed 5-minute bar (approximate: built from ticks)</option>
            <option value="atr">ATR distance from the best price</option>
          </select>
        </label>
      </div>
    </>
  );
}

export function TradingSettings() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { api.trading?.state().then((v) => setS(v.settings)).catch((e) => setMsg(e.message)); }, []);
  if (!api.trading) return null;
  if (!s) return <section className="settings-card"><h3>09:20 trading (paper)</h3><p className="hint">{msg ?? 'Loading…'}</p></section>;
  const setRisk = (k, v) => setS({ ...s, risk: { ...s.risk, [k]: v } });
  const setStrat = (g, k, v) => setS({ ...s, strategies: { ...s.strategies, [g]: { ...s.strategies[g], [k]: v } } });
  const setCharge = (k, v) => setS({ ...s, risk: { ...s.risk, charges: { ...s.risk.charges, [k]: v } } });
  const restore = () => {
    if (!window.confirm('Put the risk, charges, score and strategy settings back to their defaults? (Not saved until you press Save.)')) return;
    setS({ ...s, risk: DEFAULT_RISK_SETTINGS, scoring: DEFAULT_SCORING_SETTINGS, strategies: DEFAULT_STRATEGY_SETTINGS });
  };
  const save = async () => {
    try { const saved = await api.trading.saveSettings(s); setS(saved); setMsg('Saved. They apply from the next decision.'); } catch (e) { setMsg(e.message); }
  };
  return (
    <section className="settings-card trading-settings">
      <h3>09:20 trading (paper)</h3>
      <div className="field">
        <label>Mode</label>
        <div><ModeBadge /> <label className="hint"><input type="checkbox" checked={false} disabled /> LIVE trading</label></div>
        <p className="hint">
          LIVE is not available yet. It comes in milestone 4, only after paper trading has run for a meaningful period and
          you ask for it. Even then it will need this switch and a typed confirmation each trading day, a whitelisted static IP
          (Kite accepts live orders only from one), and a valid Kite login.
        </p>
      </div>
      <h4>Risk</h4>
      <div className="trading-grid">
        {RISK_FIELDS.map(([k, label]) => (
          <label key={k} className="field-inline">{label}<input type="number" step="any" value={s.risk[k]} onChange={(e) => setRisk(k, e.target.value)} /></label>
        ))}
        <label className="field-inline">Entries cancelled after (IST)<input type="time" value={s.risk.entryUntil} onChange={(e) => setRisk('entryUntil', e.target.value)} /></label>
        <label className="field-inline">Square-off (IST)<input type="time" value={s.risk.squareOffAt} onChange={(e) => setRisk('squareOffAt', e.target.value)} /></label>
      </div>
      <details className="score-details">
        <summary>Charges (Zerodha intraday equity; checked {s.risk.charges.checked})</summary>
        <div className="trading-grid">
          {CHARGE_FIELDS.map(([k, label]) => (
            <label key={k} className="field-inline">{label}<input type="number" step="any" value={s.risk.charges[k]} onChange={(e) => setCharge(k, e.target.value)} /></label>
          ))}
          <label className="field-inline">Checked on<input type="date" value={s.risk.charges.checked} onChange={(e) => setCharge('checked', e.target.value)} /></label>
        </div>
        <p className="hint">Source: {s.risk.charges.source}. Update these when Zerodha&apos;s charges page changes; plans, paper fills and backtests use them.</p>
      </details>
      <ScoreFields sc={s.scoring} set={(scoring) => setS({ ...s, scoring })} />
      {Object.entries(STRATEGY_FIELDS).map(([g, fields]) => (
        <div key={g}>
          <h4><label><input type="checkbox" checked={s.strategies[g].enabled} onChange={(e) => setStrat(g, 'enabled', e.target.checked)} /> {STRATEGY_LABELS[g]}</label></h4>
          <div className="trading-grid">
            {fields.map(([k, label]) => (
              <label key={k} className="field-inline">{label}<input type="number" step="any" value={s.strategies[g][k]} onChange={(e) => setStrat(g, k, e.target.value)} /></label>
            ))}
            <StrategyExtras cfg={s.strategies[g]} set={(k, v) => setStrat(g, k, v)} />
          </div>
        </div>
      ))}
      <p className="hint">
        Every threshold is a hypothesis to test on recorded days, not a known edge. D starts in shadow mode: its spec makes paper trading wait
        until the opening-volume convention (live cumulative volume vs Kite&apos;s historical minute bars) has been checked on several mornings.
      </p>
      {s.gapExits && <GapExitFields g={s.gapExits} set={(g) => setS({ ...s, gapExits: g })} />}
      <div className="ai-row">
        <button type="button" className="btn" onClick={save}>Save trading settings</button>
        <button type="button" className="btn" onClick={restore}>Restore the defaults</button>
      </div>
      {msg && <p className="hint">{msg}</p>}
      <UniverseSettings />
    </section>
  );
}
