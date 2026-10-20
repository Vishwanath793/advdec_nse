import { useState } from 'react';
import NseScheduleSettings from './NseScheduleSettings.jsx';
import { isNativeApp } from './platform/index.js';
import { TradingSettings } from './TradingPanel.jsx';

export default function SettingsPage({
  settings,
  onSave,
  session,
  onLogin,
  onLogout,
  status,
  accountSummary,
  accountSummaryLoading,
  accountSummaryError,
  nseData,
  nseConnectionError,
  onNseUpdate,
}) {
  const [form, setForm] = useState(settings);
  const [showSecret, setShowSecret] = useState(false);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const setNum = (key, value) => setForm((f) => ({ ...f, [key]: Number(value) }));

  const handleSave = () => onSave(form);
  const connected = !!session;

  return (
    <div className="settings-page settings-grid">
      <h2>Settings</h2>

      <NseScheduleSettings data={nseData} connectionError={nseConnectionError} onUpdate={onNseUpdate} />

      {/* Kite connection */}
      <section className="settings-card">
        <h3>Zerodha Kite Connect</h3>
        <p className="hint">
          Create an app at <a href="https://kite.trade" target="_blank" rel="noreferrer">kite.trade</a> and
          set its redirect URL to <code>{window.location.origin}/kite/callback</code>.
          {isNativeApp && ' A Kite app has one redirect URL, so use a separate Kite app for the phone if the desktop version also logs in. The API secret is stored only on this phone.'}
        </p>

        <label className="field">
          <span>API Key</span>
          <input
            type="text"
            value={form.kiteApiKey}
            onChange={(e) => set('kiteApiKey', e.target.value.trim())}
            placeholder="e.g. ab12cd34ef56gh78"
            autoComplete="off"
          />
        </label>

        <label className="field">
          <span>API Secret</span>
          <div className="secret-row">
            <input
              type={showSecret ? 'text' : 'password'}
              value={form.kiteApiSecret}
              onChange={(e) => set('kiteApiSecret', e.target.value.trim())}
              placeholder="Your Kite app secret"
              autoComplete="off"
            />
            <button type="button" className="btn ghost" onClick={() => setShowSecret((s) => !s)}>
              {showSecret ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>

        <div className="row gap">
          <button className="btn" onClick={handleSave}>
            Save settings
          </button>
          {!connected ? (
            <button
              className="btn primary"
              disabled={!form.kiteApiKey || !form.kiteApiSecret}
              onClick={() => {
                handleSave();
                onLogin(form);
              }}
            >
              Connect to Kite
            </button>
          ) : (
            <button className="btn danger" onClick={onLogout}>
              Disconnect
            </button>
          )}
        </div>

        {status?.message && (
          <div className={`alert ${status.type}`}>{status.message}</div>
        )}

        {connected && session && (
          <div className="session-box">
            <div><strong>Status:</strong> <span className="badge advance">Connected</span></div>
            <div><strong>User:</strong> {session.user_name || session.user_id}</div>
            <div><strong>User ID:</strong> {session.user_id}</div>
            <div><strong>Login time:</strong> {session.login_time || '—'}</div>
          </div>
        )}

        {connected && (
          <div className="session-box">
            <div><strong>Account value:</strong> {accountSummaryLoading ? 'Loading…' : accountSummary ? `₹${Number(accountSummary.accountValue || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</div>
            <div><strong>Available cash:</strong> {accountSummary ? `₹${Number(accountSummary.availableCash || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</div>
            <div><strong>Used margin:</strong> {accountSummary ? `₹${Number(accountSummary.utilized || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}</div>
            <div><strong>Intraday leverage:</strong> {accountSummary ? `${Number(accountSummary.intradayLeverage || 0).toFixed(2)}x` : '—'}</div>
            {accountSummaryError && <div className="alert error">{accountSummaryError}</div>}
          </div>
        )}
      </section>

      {/* Phase 2 signal rules + order params */}
      <section className="settings-card">
        <h3>Buy / Sell Order Parameters <span className="badge unchanged">Phase 2</span></h3>
        <p className="hint">
          These Kite order parameters will be sent with every BUY/SELL order placed from the
          Analyzer screen.
        </p>

        <h4 className="subhead">Kite order parameters</h4>
        <div className="grid2">
          <label className="field">
            <span>Exchange</span>
            <select value={form.exchange} onChange={(e) => set('exchange', e.target.value)}>
              <option value="NSE">NSE</option>
              <option value="BSE">BSE</option>
            </select>
          </label>
          <label className="field">
            <span>Product</span>
            <select value={form.product} onChange={(e) => set('product', e.target.value)}>
              <option value="CNC">CNC — Delivery</option>
              <option value="MIS">MIS — Intraday</option>
              <option value="NRML">NRML — F&amp;O</option>
            </select>
          </label>
          <label className="field">
            <span>Order type</span>
            <select value={form.orderType} onChange={(e) => set('orderType', e.target.value)}>
              <option value="MARKET">MARKET</option>
              <option value="LIMIT">LIMIT</option>
              <option value="SL">SL — Stop-loss limit</option>
              <option value="SL-M">SL-M — Stop-loss market</option>
            </select>
          </label>
          <label className="field">
            <span>Validity</span>
            <select value={form.validity} onChange={(e) => set('validity', e.target.value)}>
              <option value="DAY">DAY</option>
              <option value="IOC">IOC — Immediate or Cancel</option>
            </select>
          </label>
          <label className="field">
            <span>Variety</span>
            <select value={form.variety} onChange={(e) => set('variety', e.target.value)}>
              <option value="regular">Regular</option>
              <option value="amo">AMO — After-market order</option>
            </select>
          </label>
          <label className="field">
            <span>Quantity</span>
            <input
              type="number"
              min="1"
              value={form.quantity}
              onChange={(e) => setNum('quantity', e.target.value)}
            />
          </label>
          {(form.orderType === 'MARKET' || form.orderType === 'SL-M') && (
            <>
              <label className="field">
                <span>Market protection % (−1 = automatic)</span>
                <input
                  type="number"
                  min="-1"
                  max="100"
                  value={form.marketProtection}
                  onChange={(e) => setNum('marketProtection', e.target.value)}
                />
              </label>
              <label className="field checkbox">
                <span>
                  <input
                    type="checkbox"
                    checked={!!form.autoslice}
                    onChange={(e) => set('autoslice', e.target.checked)}
                  />{' '}
                  Auto-slice above freeze qty (F&amp;O only; not sent for NSE/BSE shares, where Kite rejects it)
                </span>
              </label>
            </>
          )}
          <label className="field">
            <span>Disclosed quantity (0 = off)</span>
            <input
              type="number"
              min="0"
              value={form.disclosedQuantity}
              onChange={(e) => setNum('disclosedQuantity', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Order tag (max 20 chars)</span>
            <input
              type="text"
              maxLength={20}
              value={form.tag}
              onChange={(e) => set('tag', e.target.value.replace(/[^A-Za-z0-9]/g, ''))}
            />
          </label>
          <label className="field">
            <span>Max loss before square-off (₹)</span>
            <input
              type="number"
              min="0"
              step="100"
              value={form.maxLoss}
              onChange={(e) => setNum('maxLoss', e.target.value)}
            />
          </label>
          {(form.orderType === 'LIMIT' || form.orderType === 'SL') && (
            <label className="field">
              <span>Limit price offset % {form.orderType === 'LIMIT' ? '(BUY above / SELL below ref)' : ''}</span>
              <input
                type="number"
                step="0.05"
                value={form.priceOffsetPct}
                onChange={(e) => setNum('priceOffsetPct', e.target.value)}
              />
            </label>
          )}
          {(form.orderType === 'SL' || form.orderType === 'SL-M') && (
            <label className="field">
              <span>Trigger price offset %</span>
              <input
                type="number"
                step="0.05"
                value={form.triggerOffsetPct}
                onChange={(e) => setNum('triggerOffsetPct', e.target.value)}
              />
            </label>
          )}
        </div>

        <button className="btn" onClick={handleSave}>
          Save settings
        </button>
      </section>

      <TradingSettings />
    </div>
  );
}
