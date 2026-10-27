import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './platform/index.js';
import { indiaDate, istInstant, marketDay } from './core/calendar.js';
import holidayCalendar from '../server/tv/holidays.json';
import { nextCheckDelay, ORDER_GRACE_MS, ORDER_WINDOW } from './core/orderScheduler.js';
import { tickSize } from './utils/analysis.js';
import { TradingPanel } from './TradingPanel.jsx';
import { GapEntryPanel, GapQtyHint } from './GapEntryPanel.jsx';

/** The Orders page re-sends the Kite session itself at most this often (normally the app does it). */
const SHARE_RETRY_MS = 5 * 60_000;
const QUICK_TIMES = ['09:15:00', '09:15:05', '09:20:00', '09:20:05', '09:30:00'];
const STATUS_CLASS = { scheduled: 'unchanged', placing: 'unchanged', placed: 'advance', failed: 'decline', missed: 'decline', cancelled: '' };
const rs = (n) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const istParts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).formatToParts(d).map((p) => [p.type, p.value]));
const when = (iso) => { const p = istParts(new Date(iso)); return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}:${p.second}`; };
const timeOnly = (d) => { const p = istParts(d); return `${p.hour}:${p.minute}:${p.second}`; };

/** Today if it's a trading day and the window hasn't closed, else the next trading day. */
function defaultDate(now) {
  let d = indiaDate(now);
  if (marketDay(d, holidayCalendar).open && now < istInstant(d, ORDER_WINDOW.end)) return d;
  for (let i = 0; i < 15; i++) {
    const next = new Date(`${d}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    d = next.toISOString().slice(0, 10);
    if (marketDay(d, holidayCalendar).open) return d;
  }
  return d;
}

function countdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s % 60}s`;
}

/**
 * Time-triggered orders: pick a stock, Buy or Sell, quantity, Market or
 * Limit, and the second it should be sent to Kite.
 */
/**
 * How far this PC's clock is from network time. Orders are timed on network time, so a PC clock
 * that is off is corrected here; if network time can't be read, orders use the last known offset.
 */
function ClockNote({ clock }) {
  if (!clock) return null;
  const when = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : null);
  if (!clock.synced) {
    return (
      <div className="alert warn" role="status">
        Network time is not available, so orders are timed on this PC’s clock {clock.offsetMs != null ? `corrected by its last known offset (${clock.offsetMs > 0 ? '+' : ''}${clock.offsetMs} ms)` : 'with no correction'}.
        {' '}{clock.error}
      </div>
    );
  }
  const off = clock.offsetMs;
  const big = Math.abs(off) > 250;
  return (
    <p className={`hint clock-note ${big ? 'dec-text' : ''}`} title={`Measured against ${clock.server} at ${when(clock.syncedAt)} IST (round trip ${clock.rttMs} ms). Orders are sent at network time.`}>
      This PC’s clock is {Math.abs(off)} ms {off < 0 ? 'ahead of' : off > 0 ? 'behind' : 'in line with'} network time
      {off !== 0 ? `; orders are timed ${off < 0 ? 'later' : 'earlier'} by that much to leave at the chosen second` : ''}.
      {big ? ' That is large: check the Windows date & time settings.' : ''}
    </p>
  );
}

/** Kite's own record of a placed order: received by Kite, at the exchange, fills (Kite's times are to the second). */
function KiteTimeline({ k }) {
  if (!k) return null;
  if (k.error) return <div className="hint">Kite record: {k.error}</div>;
  const hms = (ts) => (ts ? String(ts).slice(11, 19) : '—');
  const fills = k.fills ?? [];
  const fillTimes = [...new Set(fills.map((f) => hms(f.at)))];
  return (
    <div className="hint order-kite" title={`Read from Kite at ${new Date(k.checkedAt).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })} IST`}>
      Kite: received {hms(k.receivedAt)} · at the exchange {hms(k.exchangeAt)} ·{' '}
      {fills.length
        ? `filled ${k.filledQuantity ?? fills.reduce((s, f) => s + f.quantity, 0)} at ${fillTimes.join(', ')}${k.averagePrice ? `, average ${rs(k.averagePrice)}` : ''} (${fills.length} trade${fills.length === 1 ? '' : 's'})`
        : `no fills yet`}
      {' '}· {k.status ?? 'status unknown'}{k.statusMessage ? ` (${k.statusMessage})` : ''}
      {k.checkError && <div>The latest Kite check failed ({k.checkError}); the record above is from an earlier, successful check.</div>}
    </div>
  );
}

export default function OrdersPage({ stocks, settings, session, draft, onDraftUsed, onShareSession, sessionShareError }) {
  const lastShareRetry = useRef(0);
  const [now, setNow] = useState(() => new Date());
  const [orders, setOrders] = useState([]);
  const [clock, setClock] = useState(null); // network time vs this PC's clock (server/networkClock.js)
  const [scheduler, setScheduler] = useState(null); // { connected, userId }
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    symbol: '', side: 'BUY', quantity: settings.quantity || 1, orderType: 'MARKET', price: '',
    product: ['MIS', 'CNC', 'NRML'].includes(settings.product) ? settings.product : 'MIS',
    date: defaultDate(new Date()), time: '09:15:00',
  }));
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const bySymbol = useMemo(() => new Map((stocks ?? []).map((s) => [s.symbol, s])), [stocks]);
  const stock = bySymbol.get(form.symbol.trim().toUpperCase());

  // A draft from the Confirm tab fills the form once.
  useEffect(() => {
    if (!draft) return;
    // Out of hours (weekend, holiday, after the close), move to the next session's 09:20.
    const t = new Date();
    const usable = draft.date && marketDay(draft.date, holidayCalendar).open
      && new Date(`${draft.date}T${draft.time}+05:30`) < istInstant(draft.date, ORDER_WINDOW.end);
    setForm((f) => ({ ...f, ...draft, ...(usable ? {} : { date: defaultDate(t), time: '09:20:00' }) }));
    setMessage({ type: 'info', text: `Filled in from the Confirm tab: check the details, then schedule.` });
    onDraftUsed?.();
  }, [draft, onDraftUsed]);

  const refresh = useCallback(async () => {
    try {
      const r = await api.scheduledOrders.list();
      setOrders(r.orders ?? []); setClock(r.clock ?? null);
      // Safety net: the app re-sends the session when the backend reconnects; if the sender still
      // has none, try again here, but at most once every few minutes.
      const due = Date.now() - lastShareRetry.current > SHARE_RETRY_MS;
      if (r.session && !r.session.connected && session?.access_token && onShareSession && due) {
        lastShareRetry.current = Date.now();
        const s = await onShareSession({ force: true });
        setScheduler(s ?? r.session);
      } else {
        setScheduler(r.session ?? null);
      }
    } catch (e) {
      setMessage({ type: 'error', text: `Could not load scheduled orders: ${e.message}` });
    }
  }, [session, onShareSession]);

  // The countdowns tick locally; no network.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // The list is loaded only when it can have changed: on opening the page, on coming back to
  // it, and around each order's trigger time until its result is in. Adding and cancelling
  // return the new list directly.
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  useEffect(() => {
    const delay = nextCheckDelay(orders, Date.now());
    if (delay == null) return undefined;
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [orders, refresh]);

  const triggerAt = form.date && /^\d{2}:\d{2}(:\d{2})?$/.test(form.time)
    ? new Date(`${form.date}T${form.time.length === 5 ? `${form.time}:00` : form.time}+05:30`) : null;
  const priceNum = Number(form.price);
  const tick = priceNum > 0 ? tickSize(priceNum) : null;
  const summary = `${form.side} ${form.quantity} ${form.symbol.trim().toUpperCase() || '…'} at ${form.orderType === 'LIMIT' ? `limit ${form.price ? rs(priceNum) : '…'}` : 'market'} (${form.product})${triggerAt ? `, sent at ${when(triggerAt.toISOString())} IST` : ''}`;

  const schedule = async (e) => {
    e.preventDefault();
    if (!triggerAt) { setMessage({ type: 'error', text: 'Choose a date and time.' }); return; }
    if (!window.confirm(`Schedule this order?\n\n${summary}\n\nIt will be sent to Kite automatically at that time.`)) return;
    setBusy(true);
    try {
      const r = await api.scheduledOrders.add({
        symbol: form.symbol, side: form.side, quantity: Number(form.quantity), orderType: form.orderType,
        price: form.orderType === 'LIMIT' ? Number(form.price) : null, product: form.product, exchange: settings.exchange || 'NSE',
        triggerAt: triggerAt.toISOString(), marketProtection: settings.marketProtection, autoslice: settings.autoslice, tag: settings.tag,
        note: stock ? `Conviction ${stock.convictionScore ?? '—'}` : '',
      });
      setOrders(r.orders ?? []); setClock(r.clock ?? null);
      setScheduler(r.session ?? null);
      setMessage({ type: r.warnings?.length ? 'warn' : 'info', text: [`Scheduled ${r.order.id}: ${summary}.`, ...(r.warnings ?? [])].join(' ') });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (o) => {
    if (!window.confirm(`Cancel ${o.side} ${o.quantity} ${o.symbol} at ${timeOnly(new Date(o.triggerAt))}?`)) return;
    try {
      const r = await api.scheduledOrders.cancel(o.id);
      setOrders(r.orders ?? []); setClock(r.clock ?? null);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const refreshKite = async (o) => {
    try {
      const r = await api.scheduledOrders.refreshKite(o.id);
      setOrders(r.orders ?? []); setClock(r.clock ?? null);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const pending = orders.filter((o) => o.status === 'scheduled' || o.status === 'placing');
  const history = orders.filter((o) => !pending.includes(o));
  const nextMinute = () => {
    const t = new Date(Math.ceil((+now + 60_000) / 60_000) * 60_000);
    set({ date: indiaDate(t), time: timeOnly(t) });
  };
  const notConnected = !session?.access_token || !settings.kiteApiKey;

  return (
    <div className="orders-page">
      <TradingPanel />
      <GapEntryPanel />
      <div className="section-head"><h2>Scheduled orders</h2></div>
      <p className="hint">
        Pick a stock, Buy or Sell, quantity, Market or Limit, and the exact second it should be sent to Kite.
        {api.scheduledOrders.runsInBackground
          ? ' The backend sends it, so this page or browser can be closed, but the backend must be running and you must have logged in to Kite today (the token is kept in memory only).'
          : ' On the phone the app sends it: keep the app open on screen at that time.'}
        {` If it can’t be sent within ${ORDER_GRACE_MS / 1000} s of the time (machine asleep, app closed), it is marked missed and never sent late.`}
      </p>
      {notConnected ? (
        <div className="alert warn">Kite is not connected: log in to Kite in Settings, or scheduled orders will fail at their time.</div>
      ) : scheduler && !scheduler.connected ? (
        <div className="alert warn">The order sender has no Kite session yet; it gets it from this browser in a moment.</div>
      ) : (
        <div className="alert info">Kite connected{scheduler?.userId ? ` (${scheduler.userId})` : ''}: scheduled orders will be sent with this session.</div>
      )}
      {sessionShareError && (
        <div className="alert error">Could not hand the Kite session to the order sender: {sessionShareError}. Scheduled orders will fail until this works; reload the page to try again.</div>
      )}
      {message && <div className={`alert ${message.type}`}>{message.text}</div>}

      <form className="settings-card order-form" onSubmit={schedule}>
        <div className="order-grid">
          <label className="field">
            <span>Stock</span>
            <input
              list="order-symbols" value={form.symbol} placeholder="e.g. INFY" autoComplete="off"
              onChange={(e) => set({ symbol: e.target.value.toUpperCase() })} required
            />
            <datalist id="order-symbols">
              {(stocks ?? []).filter((s) => s.convictionScore != null).sort((a, b) => b.convictionScore - a.convictionScore).map((s) => (
                <option key={s.symbol} value={s.symbol}>{`${s.company} · conviction ${s.convictionScore} · ${s.pctChange > 0 ? '+' : ''}${s.pctChange}%`}</option>
              ))}
            </datalist>
            <span className="hint">
              {stock
                ? `${stock.company} · pre-open ${rs(stock.finalPrice)} (${stock.pctChange > 0 ? '+' : ''}${stock.pctChange}%)${stock.convictionScore != null ? ` · conviction ${stock.convictionScore}` : ''}`
                : form.symbol ? 'Not in the loaded pre-open (any NSE symbol works).' : 'Type or pick a symbol; gappers are listed by conviction.'}
            </span>
          </label>
          <div className="field">
            <span>Side</span>
            <div className="segmented">
              {['BUY', 'SELL'].map((s) => (
                <button key={s} type="button" className={`btn trade ${s === 'BUY' ? 'buy' : 'sell'} ${form.side === s ? 'active' : ''}`} onClick={() => set({ side: s })}>
                  {s === 'BUY' ? 'Buy' : 'Sell'}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Quantity</span>
            <input type="number" min="1" step="1" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} required />
            {stock?.finalPrice && Number(form.quantity) > 0 && <span className="hint">≈ {rs(stock.finalPrice * Number(form.quantity))} at the pre-open price</span>}
            <GapQtyHint symbol={form.symbol} side={form.side} orderType={form.orderType} triggerTime={form.time} />
          </label>
          <div className="field">
            <span>Order type</span>
            <div className="segmented">
              {['MARKET', 'LIMIT'].map((t) => (
                <button key={t} type="button" className={`btn ${form.orderType === t ? 'primary' : ''}`}
                  onClick={() => set({ orderType: t, price: t === 'LIMIT' && !form.price && stock?.finalPrice ? String(stock.finalPrice) : form.price })}>
                  {t === 'MARKET' ? 'Market' : 'Limit'}
                </button>
              ))}
            </div>
          </div>
          {form.orderType === 'LIMIT' && (
            <label className="field">
              <span>Limit price (₹)</span>
              <input type="number" min="0.01" step="0.01" value={form.price} onChange={(e) => set({ price: e.target.value })} required />
              <span className="hint">{tick ? `Tick ₹${tick}; ${form.side === 'BUY' ? 'buys at this price or lower' : 'sells at this price or higher'}.` : 'Prefilled with the pre-open price.'}</span>
            </label>
          )}
          <label className="field">
            <span>Product</span>
            <select value={form.product} onChange={(e) => set({ product: e.target.value })}>
              <option value="MIS">MIS (intraday)</option>
              <option value="CNC">CNC (delivery)</option>
              <option value="NRML">NRML</option>
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} required />
            <span className="hint">{form.date && !marketDay(form.date, holidayCalendar).open ? 'Not a trading day.' : 'Trading day.'}</span>
          </label>
          <label className="field">
            <span>Time (IST, to the second)</span>
            <input type="time" step="1" value={form.time} onChange={(e) => set({ time: e.target.value })} required />
            <span className="order-quick">
              {QUICK_TIMES.map((t) => <button key={t} type="button" className="btn ghost" onClick={() => set({ time: t })}>{t}</button>)}
              <button type="button" className="btn ghost" onClick={nextMinute}>Next minute</button>
            </span>
          </label>
        </div>
        <div className="order-submit">
          <span className="order-summary">{summary}</span>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Scheduling…' : 'Schedule order'}</button>
        </div>
      </form>

      <ClockNote clock={clock} />
      <h3 className="report-heading">Waiting ({pending.length})</h3>
      {pending.length ? (
        <div className="table-wrap">
          <table className="stock-table">
            <thead><tr><th>Sends at</th><th className="num">In</th><th>Order</th><th>Status</th><th /></tr></thead>
            <tbody>
              {pending.map((o) => (
                <tr key={o.id}>
                  <td>{when(o.triggerAt)}</td>
                  <td className="num">{countdown(new Date(o.triggerAt) - now)}</td>
                  <td>
                    <span className={o.side === 'BUY' ? 'adv-text' : 'dec-text'}>{o.side}</span> {o.quantity} <span className="mono">{o.symbol}</span>{' '}
                    {o.orderType === 'LIMIT' ? `limit ${rs(o.price)}` : 'market'} · {o.product} <span className="hint">{o.id}</span>
                  </td>
                  <td><span className={`badge ${STATUS_CLASS[o.status]}`}>{o.status === 'placing' ? 'sending…' : 'scheduled'}</span></td>
                  <td>{o.status === 'scheduled' && <button type="button" className="btn danger" onClick={() => cancel(o)}>Cancel</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="hint">No orders waiting.</p>}

      <h3 className="report-heading">History</h3>
      {history.length ? (
        <div className="table-wrap tall">
          <table className="stock-table">
            <thead><tr><th>Time</th><th>Order</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>
              {history.map((o) => (
                <tr key={o.id}>
                  <td>{when(o.triggerAt)}</td>
                  <td>
                    <span className={o.side === 'BUY' ? 'adv-text' : 'dec-text'}>{o.side}</span> {o.quantity} <span className="mono">{o.symbol}</span>{' '}
                    {o.orderType === 'LIMIT' ? `limit ${rs(o.price)}` : 'market'} · {o.product}
                  </td>
                  <td><span className={`badge ${STATUS_CLASS[o.status]}`}>{o.status}</span></td>
                  <td className="wrap-cell order-detail">
                    {o.status === 'placed' ? (
                      <>
                        {`Kite order ${o.result?.orderId ?? '—'}: sent ${o.result?.sendDelayMs ?? '?'} ms after the time, Kite confirmed in ${o.result?.kiteMs ?? '?'} ms${o.result?.attempts > 1 ? ' (retried once after a rate limit)' : ''}.`}
                        <KiteTimeline k={o.result?.kite} />
                        {o.result?.orderId && api.scheduledOrders.refreshKite && (
                          <button type="button" className="btn ghost order-kite-btn" onClick={() => refreshKite(o)} title="Read this order's history and fills from Kite (Kite keeps the day's orders only)">
                            {o.result?.kite ? 'Read again from Kite' : 'Read from Kite'}
                          </button>
                        )}
                      </>
                    ) : o.result?.error ?? (o.status === 'cancelled' ? 'Cancelled before its time.' : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="hint">Nothing yet.</p>}
    </div>
  );
}
