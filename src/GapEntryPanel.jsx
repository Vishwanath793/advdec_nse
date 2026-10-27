import { useEffect, useState } from 'react';
import { api } from './platform/index.js';
import { ModeBadge, useTradingView } from './TradingPanel.jsx';

/**
 * The 9:15 gap entry (PAPER) on the Orders page: the gap list, each stock's plan
 * (gap type, size factor, quantity, stop and targets), and the paper position after
 * the 09:15 market fill with its re-planned levels, current stop and exits.
 * The logic is in utils/gapExits.js and utils/paperLedger.js; nothing here sends orders.
 */

const rs = (n) => (n == null || !Number.isFinite(n) ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const f2 = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
const tone = (n) => (n > 0 ? 'adv-text' : n < 0 ? 'dec-text' : '');
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '');
const TYPE_INFO = {
  flat: 'Under 0.2 ATR: no real gap',
  normal: '0.2–0.8 ATR: full size, fixed T2',
  large: '0.8–1.5 ATR: half size, trail after T1',
  extreme: '1.5 ATR or more: quarter size, trail after T1',
};

function sourcesTitle(plan) {
  const s = plan?.sources ?? {};
  return Object.entries(s).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/** One plan row: gap, size and levels. */
function PlanCells({ plan }) {
  return (
    <>
      <td className="num">{f2(plan.gapPct)}%</td>
      <td className="num" title={TYPE_INFO[plan.type]}>{f2(plan.g)} <span className="hint">{plan.type}</span></td>
      <td className="num" title={plan.factorReasons.join('\n') || 'full size'}>×{plan.factor}{plan.factorReasons.length ? ' ⓘ' : ''}</td>
      <td className="num">{plan.qty}</td>
      <td className="num">{rs(plan.riskRs)}</td>
      <td className="num" title={plan.estimatedEntry ? 'estimate: the open plus slippage' : ''}>{f2(plan.entry)}</td>
      <td className="num">{f2(plan.sl)}</td>
      <td className="num">{f2(plan.t1)}</td>
      <td className="num">{plan.t2 != null ? f2(plan.t2) : <span className="hint">trail</span>}</td>
      <td className="num">{plan.rewardRisk != null ? f2(plan.rewardRisk) : '—'}</td>
    </>
  );
}

const PLAN_HEAD = (
  <>
    <th className="num">Gap</th><th className="num" title="Gap ÷ ATR(14)">Gap (ATR)</th><th className="num">Size</th><th className="num">Qty</th>
    <th className="num">Risk</th><th className="num">Entry (est.)</th><th className="num">Stop</th><th className="num">T1</th><th className="num">T2</th><th className="num" title="After costs, half at T1 and half at T2">R/R</th>
  </>
);

export function GapEntryPanel() {
  const [ledger, setLedger] = useState('day');
  const [view] = useTradingView(ledger);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [msg, setMsg] = useState(null);
  const [check, setCheck] = useState({ symbol: '', side: 'BUY', plan: null, error: null });

  useEffect(() => {
    if (!api.trading) return;
    api.trading.gapList().then((l) => { setSaved(l); setDraft(l); }).catch((e) => setMsg(e.message));
  }, []);
  if (!api.trading) return null;

  const st = view?.ledgerState;
  const plans = view?.gapEntries?.plans ?? [];
  const gapOrders = st?.orders?.filter((o) => o.strategy === 'gap915') ?? [];
  const posOf = (o) => st.positions.find((p) => p.id === o.id);
  const markOf = (p) => st.marks?.find((m) => m.id === p.id);
  const totals = view?.gapEntries?.totals;
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  const setRow = (i, patch) => setDraft({ ...draft, list: draft.list.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const save = async () => {
    try { const s = await api.trading.saveGapList(draft); setSaved(s); setDraft(s); setMsg('Saved. The list is planned when the collector starts the day (09:14).'); } catch (e) { setMsg(e.message); }
  };
  const runCheck = async (e) => {
    e.preventDefault();
    const symbol = check.symbol.trim().toUpperCase();
    if (!symbol) return;
    try { setCheck({ ...check, plan: await api.trading.gapPlan(symbol, check.side), error: null }); } catch (err) { setCheck({ ...check, plan: null, error: err.message }); }
  };

  return (
    <section className="settings-card trading-panel gap-entry">
      <div className="section-head">
        <h3 className="report-heading">9:15 gap entry <ModeBadge /></h3>
        <div className="export-actions">
          <select value={ledger} onChange={(e) => setLedger(e.target.value)} aria-label="Ledger">
            <option value="day">Today (paper)</option>
            <option value="replay">Simulated replay</option>
          </select>
        </div>
      </div>
      <div className="alert info">
        <strong>PAPER</strong> — each stock on the list is bought (or shorted) at market at 09:15:00 on paper, filled at the ask (bid) plus slippage.
        It always enters: the gap only changes the size. The stop and targets come from the gap and are re-planned from the fill.
        These rules and numbers are untested starting points: the report by gap type is how to tune them. A market fill at 09:15 can land
        well away from the pre-open price, and a real stop can fill worse than its price, or not at all at a circuit.
      </div>

      {draft && ledger === 'day' && (
        <details className="gap-list" open={!draft.list.length || dirty}>
          <summary>Gap list: {saved?.list.length ? saved.list.map((x) => `${x.side} ${x.symbol}`).join(', ') : 'empty'}{saved?.shadowScheduled ? ' + shadows of scheduled 09:15 orders' : ''}</summary>
          <div className="gap-list-rows">
            {draft.list.map((x, i) => (
              <div key={i} className="gap-list-row">
                <input value={x.symbol} onChange={(e) => setRow(i, { symbol: e.target.value.toUpperCase() })} placeholder="SYMBOL" aria-label="Symbol" />
                <select value={x.side} onChange={(e) => setRow(i, { side: e.target.value })} aria-label="Side">
                  <option value="BUY">Buy</option>
                  <option value="SELL">Sell (short, MIS)</option>
                </select>
                <button type="button" className="btn ghost" onClick={() => setDraft({ ...draft, list: draft.list.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            ))}
            <button type="button" className="btn ghost" disabled={draft.list.length >= 20} onClick={() => setDraft({ ...draft, list: [...draft.list, { symbol: '', side: 'BUY' }] })}>Add a stock</button>
          </div>
          <label className="hint">
            <input type="checkbox" checked={draft.shadowScheduled} onChange={(e) => setDraft({ ...draft, shadowScheduled: e.target.checked })} />{' '}
            Also paper-trade a copy of each scheduled market order sent 09:15:00–09:15:59 (read only: the real order is never changed)
          </label>
          <div><button type="button" className="btn" disabled={!dirty} onClick={save}>Save gap list</button> {msg && <span className="hint">{msg}</span>}</div>
        </details>
      )}

      {plans.length > 0 ? (
        <div className="table-wrap">
          <table className="stock-table">
            <thead><tr><th>Stock</th><th>Side</th>{PLAN_HEAD}<th>Notes</th></tr></thead>
            <tbody>
              {plans.map((x) => (
                <tr key={x.symbol}>
                  <td className="mono" title={sourcesTitle(x.plan)}>{x.symbol}{x.source !== 'list' && <span className="hint"> ({x.source})</span>}</td>
                  <td>{x.side}</td>
                  {x.plan?.ok ? <><PlanCells plan={x.plan} /><td className="hint">{x.plan.notes.join('; ')}</td></> : <td colSpan={11} className="hint">{x.error}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">{ledger === 'day' ? 'No plans yet today: they are made when the collector starts the day at 09:14 (after the 09:10 pre-open import, with a Kite login).' : 'No replay yet (Confirm page → Replay simulated morning). The simulated morning uses demo gap entries when none of your list is in it.'}</p>
      )}

      {gapOrders.length > 0 && (
        <>
          <strong>After the 09:15 fill</strong>
          <div className="table-wrap">
            <table className="stock-table">
              <thead><tr><th>Stock</th><th>Status</th><th className="num">Qty</th><th className="num">Fill</th><th className="num">Stop now</th><th className="num">T1</th><th className="num">T2</th><th>09:20 check</th><th>Exits</th><th className="num">P&amp;L</th></tr></thead>
              <tbody>
                {gapOrders.map((o) => {
                  const p = posOf(o);
                  const lv = p?.levels;
                  const pnl = p?.status === 'CLOSED' ? p.net : markOf(p ?? {})?.unrealised;
                  return (
                    <tr key={o.id}>
                      <td className="mono">{o.side} {o.symbol}</td>
                      <td title={o.reason ?? ''}>{p ? `${p.status}${p.t1Done && p.status === 'OPEN' ? ' (T1 done)' : ''}` : `${o.status}${o.reason ? ` — ${o.reason}` : ` (from ${time(o.activeFrom)})`}`}</td>
                      <td className="num">{p ? `${p.qty}/${p.entryQty}` : `0/${o.qty}`}</td>
                      <td className="num" title={o.plan ? `planned ${f2(o.plan.entry)}` : ''}>{f2(p?.avgEntry)}</td>
                      <td className="num" title={p?.stopReason ?? (lv ? 'from the fill' : '')}>{f2(p?.stop ?? o.stop)}{p?.stopReason ? <span className="hint"> ({p.stopReason})</span> : ''}</td>
                      <td className="num">{f2(lv?.t1 ?? o.target1)}</td>
                      <td className="num">{(lv ? lv.t2 : o.target2) != null ? f2(lv ? lv.t2 : o.target2) : <span className="hint">trail</span>}</td>
                      <td className="hint">{p?.check0920 ? (p.check0920.failed ? 'failed: exited' : `passed (range low ${f2(p.check0920.orLow)}, VWAP ${f2(p.check0920.vwap)})`) : '—'}</td>
                      <td>
                        {p?.exits.map((x) => `${x.qty} @ ${f2(x.price)} ${x.reason} ${time(x.at)}`).join('; ') || '—'}
                        {lv?.riskFlag && <div className="dec-text">{lv.notes.at(-1)}</div>}
                      </td>
                      <td className={`num ${tone(pnl)}`}>{rs(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {totals && <p className="hint">Gap entries today: {totals.trades} trades, W/L {totals.wins}/{totals.losses}, realised <span className={tone(totals.realised)}>{rs(totals.realised)}</span> after {rs(totals.charges)} charges. They don&apos;t use the 09:20 slots; their P&amp;L counts towards the daily loss limit.</p>}
        </>
      )}

      <form className="gap-check" onSubmit={runCheck}>
        <strong>Check a stock</strong>{' '}
        <input value={check.symbol} onChange={(e) => setCheck({ ...check, symbol: e.target.value.toUpperCase() })} placeholder="SYMBOL" aria-label="Symbol to check" />
        <select value={check.side} onChange={(e) => setCheck({ ...check, side: e.target.value })} aria-label="Side"><option value="BUY">Buy</option><option value="SELL">Sell</option></select>
        <button type="submit" className="btn ghost">Plan it now</button>
        {check.error && <span className="hint"> {check.error}</span>}
      </form>
      {check.plan && (
        <div className="table-wrap">
          <table className="stock-table">
            <thead><tr><th>Stock</th><th>From</th>{PLAN_HEAD}</tr></thead>
            <tbody><tr><td className="mono" title={sourcesTitle(check.plan)}>{check.plan.side} {check.plan.symbol}</td><td className="hint">{check.plan.from}</td><PlanCells plan={check.plan} /></tr></tbody>
          </table>
          {check.plan.notes.length > 0 && <p className="hint">{check.plan.notes.join('; ')}</p>}
        </div>
      )}
      <GapReport />
    </section>
  );
}

/** Closed gap entries from every saved paper day, summarised by gap type (for tuning the factors), with an Excel export. */
function GapReport() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.trading.gapReport().then((r) => { setReport(r); setError(null); }).catch((e) => setError(e.message));
  return (
    <details className="gap-report" onToggle={(e) => { if (e.currentTarget.open) load(); }}>
      <summary>Report by gap type (every saved paper day)</summary>
      {error && <p className="hint">{error}</p>}
      {report && (
        <>
          <div className="table-wrap">
            <table className="stock-table">
              <thead><tr><th>Gap type</th><th className="num">Trades</th><th className="num">Win rate</th><th className="num">Average R</th><th className="num">Net</th><th className="num" title="How far trades went against the entry, in ATR">Avg adverse (ATR)</th><th className="num" title="How far trades went in favour, in ATR">Avg favourable (ATR)</th></tr></thead>
              <tbody>
                {report.summary.map((s) => (
                  <tr key={s.type}>
                    <td title={TYPE_INFO[s.type]}>{s.type}</td><td className="num">{s.trades}</td><td className="num">{s.winRate != null ? `${f2(s.winRate, 0)}%` : '—'}</td>
                    <td className={`num ${tone(s.avgR)}`}>{f2(s.avgR)}</td><td className={`num ${tone(s.net)}`}>{rs(s.net)}</td><td className="num">{f2(s.avgMaeAtr)}</td><td className="num">{f2(s.avgMfeAtr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            {report.rows.length} closed gap entries. Set the stop near the adverse move of trades that worked and the target near the typical favourable move,
            once there are enough days per gap type. Excursions after a backend restart start again from the restart.{' '}
            <a className="btn ghost" href={api.trading.gapReportXlsxUrl()} download>Excel (trades + by gap type)</a>
          </p>
        </>
      )}
    </details>
  );
}

/** The gap plan's suggested quantity for a scheduled 09:15 market order (shown only; it never changes the form). */
export function GapQtyHint({ symbol, side, orderType, triggerTime }) {
  const [plan, setPlan] = useState(null);
  const sym = String(symbol ?? '').trim().toUpperCase();
  const relevant = api.trading && sym && orderType === 'MARKET' && (!triggerTime || triggerTime.startsWith('09:15'));
  useEffect(() => {
    if (!relevant) { setPlan(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => api.trading.gapPlan(sym, side).then((p) => alive && setPlan(p)).catch(() => alive && setPlan(null)), 400);
    return () => { alive = false; clearTimeout(t); };
  }, [relevant, sym, side]);
  if (!relevant || !plan?.ok) return null;
  return (
    <span className="hint" title={[...plan.factorReasons, ...plan.notes].join('\n')}>
      Gap plan: {plan.qty} shares ({plan.type} gap {f2(plan.g)} ATR, size ×{plan.factor}; stop {f2(plan.sl)}, T1 {f2(plan.t1)}{plan.t2 != null ? `, T2 ${f2(plan.t2)}` : ', then trail'})
    </span>
  );
}
