import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './platform/index.js';
import { indiaDate, istInstant } from './core/calendar.js';
import holidayCalendar from '../server/tv/holidays.json';
import {
  CONFIRM_END, CONFIRM_LATE, CONFIRM_START, CONFIRMED_SCORE, confirmationPhase, confirmationReading, confirmFromQuotes,
  FAILING_SCORE, indexInstruments, MARKET_INDEX, minutesSinceOpen, POLL_FAST_MS, POLL_SLOW_MS, quoteKey, readQuote,
  STATUS_LABEL, CHECK_TIERS, CONFIRM_CHECKS, checkWeights, cleanCheckWeight, DEFAULT_CHECK_SETTINGS, DEFAULT_TRADE_BLEND,
  MAX_CHECK_WEIGHT, tradeScore,
} from './utils/confirmation.js';
import { weightShares } from './utils/conviction.js';
import { isTradeable } from './utils/tradeability.js';
import OpeningScanner, { SourceBadge } from './OpeningScanner.jsx';

const STATUS_ORDER = { confirmed: 0, mixed: 1, failing: 2, avoid: 3, failed: 4, 'no-data': 5 };
const STATUS_CLASS = { confirmed: 'advance', mixed: 'unchanged', failing: 'decline', failed: 'decline', avoid: 'decline', 'no-data': '' };
const CHECK_MARK = { pass: '✓', neutral: '•', fail: '✗', warn: '⚠' };
const rs = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`);
const time = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
const LIMITS = [10, 20, 50, 0];
/** After Kite refuses quotes, use NSE and try Kite again after this long (or after a new login). */
const KITE_RETRY_MS = 10 * 60_000;
const SOURCES = [['auto', 'Auto (Kite, else NSE)'], ['kite', 'Kite only'], ['nse', 'NSE only']];

/**
 * 9:15–9:20 confirmation (Kite live quotes): which gaps are holding after the
 * open. The 9:20 reading is saved (opening range frozen) for the report card,
 * and later prices are compared with that range for the entry.
 */
export default function ConfirmPage({ stocks, date, session, apiKey, checkSettings, blend, sourcePref, onSettings, onSchedule }) {
  const [quotes, setQuotes] = useState({});
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(null); // the 9:20 reading for `date`
  const [limit, setLimit] = useState(10);
  const [tradeableOnly, setTradeableOnly] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const busy = useRef(false);

  const today = indiaDate(now);
  const phase = confirmationPhase(now, date, holidayCalendar, today);
  const connected = Boolean(session?.access_token && apiKey);
  const gappers = useMemo(() => (stocks ?? []).filter((s) => s.convictionScore != null), [stocks]);

  useEffect(() => {
    setSaved(null);
    if (!date) return;
    api.confirm.get(date).then(setSaved).catch(() => {});
  }, [date]);

  // Price source: Kite when it works; otherwise NSE's website. In "auto", a Kite refusal (no
  // market-data permission, expired login) switches to NSE and Kite is tried again only after
  // KITE_RETRY_MS or a new login, not on every refresh.
  const pref = ['auto', 'kite', 'nse'].includes(sourcePref) ? sourcePref : 'auto';
  const kiteBlockedUntil = useRef(0);
  const [kiteNote, setKiteNote] = useState(null); // why Kite isn't being used
  const [source, setSource] = useState(null); // 'kite' | 'nse' for the prices shown
  useEffect(() => { kiteBlockedUntil.current = 0; setKiteNote(null); }, [session?.access_token, apiKey, pref]);
  const canFetch = gappers.length > 0 && (pref !== 'kite' || connected);
  const noteShown = pref === 'nse' ? 'chosen in Prices' : !connected ? 'Kite is not connected' : kiteNote;

  const fetchQuotes = useCallback(async () => {
    if (!canFetch || busy.current) return;
    busy.current = true;
    setLoading(true);
    // Nifty 50 and the sector indices too, for the market and sector checks.
    const instruments = [...indexInstruments(gappers), ...gappers.map((s) => quoteKey(s.symbol))];
    try {
      let fresh = null;
      let from = 'nse';
      if (pref !== 'nse' && connected && (pref === 'kite' || Date.now() >= kiteBlockedUntil.current)) {
        try {
          fresh = await api.kite.quote({ apiKey, accessToken: session.access_token, instruments });
          from = 'kite';
          setKiteNote(null);
        } catch (e) {
          if (pref === 'kite') throw e;
          kiteBlockedUntil.current = Date.now() + KITE_RETRY_MS;
          setKiteNote(/insufficient permission/i.test(e.message)
            ? 'Kite has no market-data permission for this app'
            : `Kite quotes failed (${e.message})`);
        }
      }
      if (!fresh) fresh = (await api.live.quote(instruments)).quotes;
      const at = new Date();
      setQuotes(fresh);
      setSource(from);
      setUpdatedAt(at);
      setError(null);
      // From 9:20 on the trading day itself, keep the first reading (once).
      if (confirmationPhase(at, date, holidayCalendar, indiaDate(at)) === 'set' && !saved) {
        const reading = confirmationReading(gappers, fresh, at, date, { checkSettings, blend: Math.min(1, Math.max(0, (Number(blend) || 0) / 100)) });
        if (Object.keys(reading.readings).length) {
          await api.confirm.save(reading).catch(() => {});
          setSaved(await api.confirm.get(date).catch(() => reading));
        }
      }
    } catch (e) {
      // Kite's PermissionException: the Kite Connect plan has no market data.
      setError(/insufficient permission/i.test(e.message)
        ? 'Kite: refused live quotes ("Insufficient permission for that call"). Your Kite Connect app\'s plan doesn\'t include market data. '
          + 'Enable a plan with live market data on developers.kite.trade and log in again, or choose Auto / NSE as the price source.'
        : `${pref === 'kite' ? 'Kite' : 'Prices'}: ${e.message}`);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [canFetch, pref, connected, gappers, apiKey, session, date, saved, checkSettings, blend]);

  // Clock and polling: every 5 s from 9:14 to 9:25, then every 15 s until the close.
  useEffect(() => {
    const tick = () => {
      const t = new Date();
      setNow(t);
      if (document.visibilityState !== 'visible' || !date || date !== indiaDate(t)) return;
      const p = confirmationPhase(t, date, holidayCalendar, indiaDate(t));
      const warm = t >= new Date(+istInstant(date, CONFIRM_START) - 60_000);
      if ((p === 'before' && warm) || p === 'forming') fetchQuotes();
      else if (p === 'set') {
        const fast = t < istInstant(date, CONFIRM_LATE);
        if (fast || !updatedAt || t - updatedAt >= POLL_SLOW_MS) fetchQuotes();
      }
    };
    const timer = setInterval(tick, POLL_FAST_MS);
    return () => clearInterval(timer);
  }, [date, fetchQuotes, updatedAt]);

  // One fetch when the page opens (or Kite connects), whatever the time.
  useEffect(() => { fetchQuotes(); }, [canFetch, pref, connected, gappers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const minutes = date ? minutesSinceOpen(now, date) : 5;
  const blendShare = Math.min(1, Math.max(0, (Number(blend) || 0) / 100));
  const rows = useMemo(() => gappers.map((s) => {
    const q = readQuote(quotes[quoteKey(s.symbol)]);
    const frozen = saved?.readings?.[s.symbol];
    // After 9:20 the result is the saved 9:20 one; the plan uses its frozen range.
    const live = confirmFromQuotes(s, quotes, { minutes, checkSettings, range: frozen ? { high: frozen.high, low: frozen.low } : null });
    const result = frozen ? { status: frozen.status, score: frozen.score } : live;
    return { s, q, live, result, frozen, trade: tradeScore(s.convictionScore, result.score, blendShare) };
  }), [gappers, quotes, saved, minutes, checkSettings, blendShare]);

  // Nifty 50 first, then the sector indices that have quotes.
  const indexChips = useMemo(() => indexInstruments(gappers).map((key) => {
    const q = readQuote(quotes[key]);
    return q ? { key, name: key.replace(/^NSE:/, ''), q, pct: ((q.ltp - q.open) / q.open) * 100 } : null;
  }).filter(Boolean).sort((a, b) => (a.key === MARKET_INDEX ? -1 : b.key === MARKET_INDEX ? 1 : 0)), [gappers, quotes]);

  // Checks the price source can't do, shown greyed out (not scored).
  const naMarks = (live, group) => (live.unavailable ?? []).filter((u) => u.group === group).map((u) => (
    <span key={u.key} className="check na" title={`${u.label}: needs Kite market data, skipped (not scored)`}>–</span>
  ));

  const section = (dir) => {
    const list = rows
      .filter((r) => (dir > 0 ? r.s.status === 'advance' : r.s.status === 'decline'))
      .filter((r) => !tradeableOnly || isTradeable(r.s))
      .sort((a, b) => b.s.convictionScore - a.s.convictionScore);
    const shown = limit ? list.slice(0, limit) : list;
    // Tradeable results by trade score; Avoid, gap filled and no quote at the bottom.
    const blocked = (r) => (['avoid', 'failed', 'no-data'].includes(r.result.status) ? STATUS_ORDER[r.result.status] : 0);
    return shown.sort((a, b) => blocked(a) - blocked(b) || (b.trade ?? -1) - (a.trade ?? -1) || b.s.convictionScore - a.s.convictionScore);
  };

  // Orders-tab prefill: side from the gap; a limit at the entry for a confirmed setup, else market;
  // 09:20:00 if that is still ahead today, otherwise the next minute.
  const draftFor = (s, live, up) => {
    const t = new Date();
    const at920 = istInstant(indiaDate(t), CONFIRM_END);
    const next = t < at920 ? at920 : new Date(Math.ceil((+t + 60_000) / 60_000) * 60_000);
    const limit = live.plan && live.status === 'confirmed';
    return {
      symbol: s.symbol,
      side: up ? 'BUY' : 'SELL',
      orderType: limit ? 'LIMIT' : 'MARKET',
      price: limit ? String(live.plan.entry) : '',
      date: indiaDate(next),
      time: next.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Kolkata' }),
    };
  };

  // Check weights panel.
  const weights = checkWeights(checkSettings);
  const shares = weightShares(weights);
  const checkSetting = (key) => {
    const s = checkSettings?.[key];
    const d = DEFAULT_CHECK_SETTINGS[key];
    return { on: typeof s?.on === 'boolean' ? s.on : d.on, weight: cleanCheckWeight(s?.weight) ?? d.weight };
  };
  const allChecks = (patchFor) => Object.fromEntries(CONFIRM_CHECKS.map((c) => [c.key, { ...checkSetting(c.key), ...patchFor(c) }]));
  const restoreWeight = (c) => ({ on: true, ...(checkSetting(c.key).weight > 0 ? {} : { weight: c.weight }) });
  const setCheck = (key, patch) => onSettings({ confirmChecks: allChecks((c) => (c.key === key ? patch : {})) });
  const checkedCount = CONFIRM_CHECKS.filter((c) => checkSetting(c.key).on).length;
  const customised = JSON.stringify(weights) !== JSON.stringify(checkWeights(DEFAULT_CHECK_SETTINGS))
    || Math.round(blendShare * 100) !== Math.round(DEFAULT_TRADE_BLEND * 100);

  const banner = pref === 'kite' && !connected
    ? { type: 'warn', text: 'Price source is “Kite only” but Kite is not connected: log in to Kite in Settings, or choose Auto or NSE.' }
    : !gappers.length
      ? { type: 'info', text: 'Load the pre-open first (9:10 fetch or Fetch now on the Analyzer page).' }
      : phase === 'closed'
        ? { type: 'info', text: date !== today
          ? `The loaded pre-open is from ${date}. The live checks run on that trading day; ${saved ? 'showing its saved 9:20 reading' : 'no 9:20 reading was saved for it'}. Quotes below are the latest session's prices.`
          : 'Not a trading day.' }
        : phase === 'before'
          ? { type: 'info', text: `Waiting for the open at ${CONFIRM_START}. Prices refresh every 5 s from 9:14; the result is kept at ${CONFIRM_END}.` }
          : phase === 'forming'
            ? { type: 'info', text: `Opening range forming (${CONFIRM_START}–${CONFIRM_END}): results so far, refreshing every 5 s. The 9:20 reading is saved automatically.` }
            : phase === 'set' && saved?.late
              ? { type: 'warn', text: `This page first got prices at ${time(saved.at)}, after ${CONFIRM_LATE}: the range is the day's range then, not 9:15–9:20, and the report card leaves it out.` }
              : phase === 'set'
                ? { type: 'info', text: saved ? `Result kept at ${time(saved.at)}. Prices keep updating: an entry triggers on a break of the 9:15–9:20 range.` : 'Fetching the first reading…' }
                : { type: 'info', text: 'Market closed for the day. The saved 9:20 reading is shown.' };

  const renderTable = (dir) => {
    const list = section(dir);
    const up = dir > 0;
    return (
      <div className={`bias-card ${up ? 'advance' : 'decline'} confirm-card`}>
        <strong>{up ? 'Gap-ups (buy if it holds)' : 'Gap-downs (short if it holds)'}</strong>
        {!list.length ? <p className="hint">No {up ? 'gap-ups' : 'gap-downs'}{tradeableOnly ? ' (tradeable)' : ''} in the loaded pre-open.</p> : (
          <table className="bias-table confirm-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num" title="Conviction score at 9:08">Conv.</th>
                <th className="num" title="Pre-open price (9:08)">Pre-open</th>
                <th className="num">Open</th>
                <th className="num" title="Last traded price; % vs the pre-open price">Last</th>
                <th className="num" title={`Day's range so far; frozen at ${CONFIRM_END}`}>Range</th>
                <th title="Score checks: open, opening range, VWAP, gap not filled, volume, order book, yesterday's high/low, Nifty 50, stronger than Nifty, sector index (hover each)">Signals</th>
                <th title="Safety checks (not scored): room to the circuit, bid-ask spread, recent trade, stop distance, not chasing. A ✗ means Avoid.">Safety</th>
                <th>Result</th>
                <th className="num" title="Trade score: the confirmation blended with the 9:08 conviction (set the blend in Confirmation weights)">Trade</th>
                <th title={`Entry on a break of the ${CONFIRM_START}–${CONFIRM_END} range, stop at its other side`}>Entry / stop</th>
                <th title="Schedule a Buy/Sell for a chosen time on the Orders tab (pre-filled)" />
              </tr>
            </thead>
            <tbody>
              {list.map(({ s, q, live, result, frozen, trade }) => (
                <tr key={s.symbol}>
                  <td className="mono" title={s.company}>{s.symbol}</td>
                  <td className="num">{s.convictionScore}</td>
                  <td className="num">{rs(s.finalPrice)}</td>
                  <td className="num">{rs(q?.open)}</td>
                  <td className="num">
                    {rs(q?.ltp)}{' '}
                    {q && s.finalPrice ? <span className={(q.ltp - s.finalPrice) * dir > 0 ? 'adv-text' : 'dec-text'}>{pct(((q.ltp - s.finalPrice) / s.finalPrice) * 100)}</span> : null}
                  </td>
                  <td className="num">{live.range ? `${rs(live.range.low)}–${rs(live.range.high)}` : '—'}{frozen ? '' : <span className="hint">{phase === 'forming' ? ' (forming)' : ''}</span>}</td>
                  <td className="confirm-checks">
                    {live.checks.map((c) => (
                      <span key={c.key} className={`check ${c.result}`} title={`${c.label}: ${c.detail}`}>{CHECK_MARK[c.result]}</span>
                    ))}
                    {naMarks(live, 'signal')}
                  </td>
                  <td className="confirm-checks">
                    {live.safety.map((c) => (
                      <span key={c.key} className={`check ${c.result}`} title={`${c.label}: ${c.detail}`}>{CHECK_MARK[c.result]}</span>
                    ))}
                    {naMarks(live, 'safety')}
                  </td>
                  <td>
                    <span
                      className={`badge ${STATUS_CLASS[result.status] ?? ''}`}
                      title={[
                        `${STATUS_LABEL[result.status] ?? result.status}${result.score != null ? ` (${result.score}/100)` : ''}${frozen ? ' at 9:20' : phase === 'forming' ? ' so far' : ''}`,
                        ...(live.avoidReason ? [`Avoid now: ${live.avoidReason}`] : []),
                        ...(!frozen && (phase === 'closed' || phase === 'after') ? ['From the latest prices, not the 9:15–9:20 window: no 9:20 reading was saved.'] : []),
                        `Confirmed at ${CONFIRMED_SCORE}+, failing at ${FAILING_SCORE} or below; a filled gap fails outright; a safety ✗ means Avoid.`,
                        'Signals:',
                        ...live.checks.map((c) => `${CHECK_MARK[c.result]} ${c.label}: ${c.detail}`),
                        ...(live.safety.length ? ['Safety:', ...live.safety.map((c) => `${CHECK_MARK[c.result]} ${c.label}: ${c.detail}`)] : []),
                        ...(live.unavailable?.length ? [`Skipped with NSE prices (need Kite market data): ${live.unavailable.map((u) => u.label).join(', ')}`] : []),
                      ].join('\n')}
                    >
                      {STATUS_LABEL[result.status] ?? result.status}{result.score != null ? ` ${result.score}` : ''}
                    </span>
                    {/* The 9:20 result can be fine while the stock is unsafe now (e.g. hit the circuit later). */}
                    {frozen && live.avoidReason && result.status !== 'avoid' && (
                      <span className="badge decline confirm-trig" title={`Now: ${live.avoidReason}`}>avoid now</span>
                    )}
                  </td>
                  <td className="num" title={trade != null ? `${Math.round(blendShare * 100)}% confirmation ${result.score} + ${100 - Math.round(blendShare * 100)}% conviction ${s.convictionScore}` : undefined}>
                    {trade != null ? <span className={`conviction ${trade >= 70 ? 'high' : trade >= 50 ? 'mid' : 'low'}`}><span className="conviction-bar" aria-hidden="true"><span style={{ width: `${trade}%` }} /></span>{trade}</span> : '—'}
                  </td>
                  <td className="confirm-plan">
                    {live.plan && result.status === 'confirmed' && !live.avoidReason ? (
                      <span title={`Enter on a ${up ? 'break above' : 'break below'} ₹${rs(live.plan.entry)}; stop ₹${rs(live.plan.stop)} (${live.plan.riskPct.toFixed(2)}% risk).`}>
                        {up ? '↑' : '↓'} {rs(live.plan.entry)} / {rs(live.plan.stop)}{' '}
                        <span className="hint">{live.plan.riskPct.toFixed(1)}%</span>
                        {live.plan.triggered && <span className="badge advance confirm-trig">triggered</span>}
                        {live.safety.filter((c) => c.result === 'warn').map((c) => (
                          <span key={c.key} className="check warn" title={`${c.label}: ${c.detail}`}>⚠</span>
                        ))}
                      </span>
                    ) : <span className="hint">{live.avoidReason ? `Avoid: ${live.avoidReason}` : '—'}</span>}
                  </td>
                  <td>
                    <button type="button" className="btn ghost confirm-schedule" title="Schedule this trade for a chosen time (Orders tab)" onClick={() => onSchedule?.(draftFor(s, live, up))}>
                      ⏱ Schedule
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <div className="confirm-page">
      <div className="section-head">
        <h2>9:15–9:20 confirmation</h2>
        <div className="export-actions">
          <label className="cap-filter">
            Show top
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {LIMITS.map((n) => <option key={n} value={n}>{n ? `${n} by conviction` : 'all'}</option>)}
            </select>
          </label>
          <label className="cap-filter">
            <input type="checkbox" checked={tradeableOnly} onChange={(e) => setTradeableOnly(e.target.checked)} />
            Tradeable only
          </label>
          <label className="cap-filter" title="Where live prices come from. Auto uses Kite when it has market data, otherwise NSE's website.">
            Prices
            <select value={pref} onChange={(e) => onSettings({ liveSource: e.target.value })}>
              {SOURCES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="btn" onClick={fetchQuotes} disabled={!canFetch || loading}>
            {loading ? 'Updating…' : 'Refresh prices'}
          </button>
        </div>
      </div>
      <OpeningScanner />

      <h3 className="report-heading">Confirmation checks <SourceBadge source={source === 'kite' ? 'quote' : source} /></h3>
      <p className="hint">
        After the open, each gap is checked with live prices (Kite, or NSE’s website as a fallback). <strong>Signals</strong>: holding the
        open, position in the opening range, VWAP, gap not filled, volume against a normal day, order book, beyond
        yesterday’s high/low, Nifty 50 and the sector index since their open, and strength against Nifty.{' '}
        <strong>Safety</strong> (✗ on the circuit or spread means Avoid): room to the circuit, bid-ask spread, a recent trade,
        stop distance, and not chasing past the entry. ✓ pass · • neutral · ⚠ caution · ✗ fail. Hover a mark or a
        result for details. {updatedAt && `Prices at ${time(updatedAt)}.`}
      </p>
      <details className="conviction-settings">
        <summary>
          Confirmation weights{' '}
          <span className="hint">({checkedCount} of {CONFIRM_CHECKS.length} checks on{customised ? ', customised' : ''})</span>
        </summary>
        <p className="hint">
          Each check counts by its importance (pass full, neutral or caution half, fail zero). Defaults: more important
          {' '}{CHECK_TIERS.high.weight}, core price action {CHECK_TIERS.core.weight}, moderately important
          {' '}{CHECK_TIERS.moderate.weight}. A filled gap, or a ✗ on the circuit or spread, overrides the score while
          that check is on. Saved in this browser.
        </p>
        <label className="factor-toggle factor-all">
          <input
            type="checkbox"
            checked={checkedCount === CONFIRM_CHECKS.length}
            ref={(el) => { if (el) el.indeterminate = checkedCount > 0 && checkedCount < CONFIRM_CHECKS.length; }}
            onChange={(e) => onSettings({ confirmChecks: allChecks((c) => (e.target.checked ? restoreWeight(c) : { on: false })) })}
          />
          <strong>{checkedCount === CONFIRM_CHECKS.length ? 'Uncheck all' : 'Check all'}</strong>
        </label>
        {Object.entries(CHECK_TIERS).map(([tier, t]) => (
          <div key={tier} className="factor-grid confirm-tier">
            <div className="subhead">{t.label}</div>
            {CONFIRM_CHECKS.filter((c) => c.tier === tier).map((c) => {
              const s = checkSetting(c.key);
              const active = weights[c.key] > 0;
              return (
                <div key={c.key} className={`factor-row ${active ? '' : 'off'}`}>
                  <label className="factor-toggle">
                    <input type="checkbox" checked={s.on} onChange={(e) => setCheck(c.key, e.target.checked ? restoreWeight(c) : { on: false })} />
                    <strong>{c.label}</strong>
                  </label>
                  <input
                    type="range" min="0" max={MAX_CHECK_WEIGHT} step="0.5" value={s.weight} disabled={!s.on}
                    aria-label={`${c.label} weight`}
                    onChange={(e) => setCheck(c.key, { weight: cleanCheckWeight(e.target.value) ?? s.weight })}
                  />
                  <input
                    type="number" className="factor-weight" min="0" max={MAX_CHECK_WEIGHT} step="0.5" value={s.weight} disabled={!s.on}
                    aria-label={`${c.label} weight value`}
                    onChange={(e) => { const w = cleanCheckWeight(e.target.value); if (w != null) setCheck(c.key, { weight: w }); }}
                  />
                  <span className="factor-share">{active ? `${shares[c.key]}% share` : s.on ? 'weight 0' : 'off'}</span>
                  <span className="hint factor-help">{c.group === 'safety' ? 'Safety check' : 'Signal'}</span>
                </div>
              );
            })}
          </div>
        ))}
        <div className="factor-row confirm-blend">
          <label className="factor-toggle"><strong>Trade score blend</strong></label>
          <input
            type="range" min="0" max="100" step="5" value={Math.round(blendShare * 100)}
            aria-label="Share of the trade score from the 9:20 confirmation"
            onChange={(e) => onSettings({ confirmBlend: Number(e.target.value) })}
          />
          <span className="factor-share">{Math.round(blendShare * 100)}% / {100 - Math.round(blendShare * 100)}%</span>
          <span className="hint factor-help">
            Trade score = {Math.round(blendShare * 100)}% the 9:20 confirmation + {100 - Math.round(blendShare * 100)}%
            {' '}the 9:08 conviction. It ranks the tables.
          </span>
        </div>
        <div className="factor-actions">
          <button
            type="button" className="btn" disabled={!customised}
            onClick={() => onSettings({ confirmChecks: DEFAULT_CHECK_SETTINGS, confirmBlend: DEFAULT_TRADE_BLEND * 100 })}
          >
            Reset to defaults
          </button>
        </div>
      </details>
      <div className={`alert ${banner.type}`}>{banner.text}</div>
      {error && <div className="alert error">{error}</div>}
      {source && !error && (
        <div className={`alert ${source === 'nse' ? 'warn' : 'info'} price-source`}>
          {source === 'kite'
            ? 'Prices: Kite live quotes (all 15 checks).'
            : `Prices: NSE website${noteShown ? ` (${noteShown})` : ''}. Order book, bid-ask spread and recent trade need Kite market data, so they are skipped and not scored; room to the circuit uses the app’s own limits. NSE prices can be a few seconds behind.`}
        </div>
      )}
      {indexChips.length > 0 && (
        <div className="market-signals" aria-label="Indices since the open">
          <span className="hint">Since the open:</span>
          {indexChips.map((c) => (
            <span key={c.key} className="market-signal" title={`${c.name}: last ${c.q.ltp.toLocaleString('en-IN')}, open ${c.q.open.toLocaleString('en-IN')}. Gap-ups need this rising, gap-downs falling.`}>
              <span className="market-signal-label">{c.name}</span>{' '}
              <strong className={c.pct > 0 ? 'adv-text' : c.pct < 0 ? 'dec-text' : ''}>{pct(c.pct)}</strong>
            </span>
          ))}
        </div>
      )}
      {canFetch && (
        <div className="movers-grid">
          {renderTable(1)}
          {renderTable(-1)}
        </div>
      )}
    </div>
  );
}
