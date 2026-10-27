import { useEffect, useState } from 'react';
import { api } from './platform/index.js';

/**
 * The 09:20 trading UI (milestone 2: PAPER only).
 *   ModeBadge        BACKTEST / PAPER / LIVE, on every page
 *   TradingPanel     capital, mode, positions, pending entries, P&L, the day's trades, daily-loss bar, kill switch
 *   TradingSettings  risk limits, strategy thresholds, the score preset (Settings page)
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

const STRATEGY_FIELDS = {
  orb: [['minRvol', 'Min RVOL'], ['minClosePos', 'Min close position (0–1)'], ['minRangeAtr', 'Min range × ATR'], ['maxRangeAtr', 'Max range × ATR'], ['maxSpreadBps', 'Max spread (bps)'], ['target1R', 'Target 1 (R)'], ['target2R', 'Target 2 (R)']],
  gapPullback: [['minGapPct', 'Min gap %'], ['minPullbackPct', 'Min pullback %'], ['maxGapRetracePct', 'Max gap given back %'], ['minRecovery', 'Min recovery (0–1)'], ['minRecoveryVolumeRatio', 'Recovery vs pullback volume'], ['maxStopPct', 'Max stop %']],
  momentum: [['minRvol', 'Min RVOL'], ['minConsistentMinutes', 'Min consistent minutes'], ['maxVwapDistPct', 'Max distance from VWAP %'], ['maxRet5Pct', 'Max 5-min move %'], ['maxSpreadBps', 'Max spread (bps)'], ['target1R', 'Target 1 (R)'], ['target2R', 'Target 2 (R)']],
};
const RISK_FIELDS = [
  ['capital', 'Capital (₹)'], ['riskPerTradePct', 'Risk per trade %'], ['dailyLossPct', 'Daily loss limit %'], ['maxOpenPositions', 'Max open positions'],
  ['maxTradesPerDay', 'Max trades a day'], ['minRewardRisk', 'Min reward/risk (after costs)'], ['maxConsecutiveLosses', 'Stop after losses in a row'],
  ['misLeverage', 'MIS leverage (check your broker)'], ['slippageBps', 'Paper slippage (bps)'], ['maxSlippageBps', 'Max entry slippage (bps)'], ['maxSpreadBps', 'Max spread (bps)'],
];
const LABELS = { orb: 'A. Opening-range breakout / breakdown', gapPullback: 'B. Gap-up pullback recovery (≥ 3.75% gap)', momentum: 'C. Opening momentum' };

const GAP_FIELDS = [
  ['noiseAtr', 'Noise stop floor (× ATR)'], ['gapLineBufferAtr', 'Buffer below the half-gap (× ATR)'], ['wideStopAtr', 'Large/extreme stop (× ATR)'], ['maxStopAtr', 'Widest stop (× ATR)'],
  ['t1R', 'Target 1 (R)'], ['t2R', 'Target 2 cap (R)'], ['rangeAtr', 'Day range for T2 room (× ATR)'], ['circuitTicks', 'Ticks inside the circuit'],
  ['nearCircuitPct', 'Near the circuit (%)'], ['nearCircuitFactor', 'Near-circuit size ×'], ['weakRrFactor', 'Weak reward/risk size ×'], ['minFactor', 'Smallest size ×'],
  ['tightenBufferAtr', '09:20 buffer below the range (× ATR)'], ['timeStopR', 'Time stop: exit under (R)'], ['trailAtr', 'ATR trail (× ATR)'],
];

/** The 9:15 gap-entry settings (utils/gapExits.js), inside the trading settings. */
function GapExitFields({ g, set }) {
  const field = (k, v) => set({ ...g, [k]: v });
  return (
    <>
      <h4>9:15 gap entry (paper)</h4>
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
      <h4>Score</h4>
      <div className="trading-grid">
        <label className="field-inline">Weights
          <select value={s.scoring.preset} onChange={(e) => setS({ ...s, scoring: { ...s.scoring, preset: e.target.value } })}>
            <option value="unit">Every factor counts the same (default)</option>
            <option value="research">Research groups: price 20, range 20, RVOL 20, depth 15, F&amp;O 10, sector 10, feasibility 5</option>
          </select>
        </label>
        <label className="field-inline">Minimum score to trade<input type="number" value={s.scoring.minScore} onChange={(e) => setS({ ...s, scoring: { ...s.scoring, minScore: e.target.value } })} /></label>
      </div>
      <p className="hint">Tiers: 85+ strong, 70–84 watchlist, 50–69 weak, below 50 reject. A hard rejection (stale data, no book, circuit, 09:10 block) always wins over the score.</p>
      {Object.entries(STRATEGY_FIELDS).map(([g, fields]) => (
        <div key={g}>
          <h4><label><input type="checkbox" checked={s.strategies[g].enabled} onChange={(e) => setStrat(g, 'enabled', e.target.checked)} /> {LABELS[g]}</label></h4>
          <div className="trading-grid">
            {fields.map(([k, label]) => (
              <label key={k} className="field-inline">{label}<input type="number" step="any" value={s.strategies[g][k]} onChange={(e) => setStrat(g, k, e.target.value)} /></label>
            ))}
            {'allowShorts' in s.strategies[g] && (
              <label className="field-inline"><input type="checkbox" checked={s.strategies[g].allowShorts} onChange={(e) => setStrat(g, 'allowShorts', e.target.checked)} /> Allow shorts (MIS intraday only)</label>
            )}
          </div>
        </div>
      ))}
      <p className="hint">Every threshold is a hypothesis to test on recorded days, not a known edge.</p>
      {s.gapExits && <GapExitFields g={s.gapExits} set={(g) => setS({ ...s, gapExits: g })} />}
      <button type="button" className="btn" onClick={save}>Save trading settings</button>
      {msg && <p className="hint">{msg}</p>}
    </section>
  );
}
