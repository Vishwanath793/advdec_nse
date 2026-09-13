import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCSV, rowsToObjects } from './utils/csv.js';
import { analyze } from './utils/analysis.js';
import SettingsPage from './SettingsPage.jsx';
import TvResearchPage from './TvResearchPage.jsx';
import { formatIST } from './NseScheduleSettings.jsx';
import { loadSettings, saveSettings, loadSession, saveSession } from './store.js';

const STOCK_COLUMNS = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'company', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'prevClose', label: 'Prev Close', numeric: true },
  { key: 'finalPrice', label: 'Final Price', numeric: true },
  { key: 'change', label: 'Change', numeric: true },
  { key: 'pctChange', label: '%Chg', numeric: true },
  { key: 'status', label: 'Status' },
];

export default function App() {
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash === '#/tv-research') return 'tv-research';
    if (hash === '#/settings') return 'settings';
    if (hash === '#/positions') return 'positions';
    return 'analyze';
  });
  const [settings, setSettings] = useState(loadSettings);
  const [session, setSession] = useState(loadSession);
  const [accountSummary, setAccountSummary] = useState(null);
  const [accountSummaryLoading, setAccountSummaryLoading] = useState(false);
  const [accountSummaryError, setAccountSummaryError] = useState(null);
  const [positions, setPositions] = useState([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState(null);
  const [kiteStatus, setKiteStatus] = useState(null); // { type: 'info'|'error', message }
  const [masterRows, setMasterRows] = useState(null);
  const [masterError, setMasterError] = useState(null);
  const [pmFileName, setPmFileName] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [sectorFilter, setSectorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedSector, setExpandedSector] = useState(null);
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');
  const [stockSort, setStockSort] = useState({ key: null, direction: 'asc' });
  const [nseData, setNseData] = useState(null);
  const [nseConnectionError, setNseConnectionError] = useState(null);
  const appliedNseSnapshot = useRef(null);
  const autoSquareOffLockRef = useRef(false);
  const fileInputRef = useRef(null);

  // Load the bundled master stock list on start.
  useEffect(() => {
    fetch('/master_stock.csv')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => setMasterRows(rowsToObjects(parseCSV(text))))
      .catch((e) => setMasterError(`Could not load master_stock.csv (${e.message})`));
  }, []);

  useEffect(() => {
    let events;
    // Defer connection until after React StrictMode's setup/cleanup check.
    const startup = setTimeout(() => {
      events = new EventSource('/api/nse/preopen/events');
      events.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setNseData((current) => ({ ...current, ...data }));
          setNseConnectionError(null);
        } catch {
          setNseConnectionError('Could not read the NSE update. Reload the page to reconnect.');
        }
      };
      events.onerror = () => setNseConnectionError('NSE updates disconnected. Reconnecting to the backend…');
    }, 0);
    return () => { clearTimeout(startup); events?.close(); };
  }, []);

  useEffect(() => {
    const snapshot = nseData?.snapshot;
    if (!masterRows || !snapshot || appliedNseSnapshot.current === snapshot.fetchedAt) return;
    appliedNseSnapshot.current = snapshot.fetchedAt;
    setResult(analyze(snapshot.rows, masterRows));
    setPmFileName(`NSE pre-open · ${snapshot.marketUpdatedAt ?? formatIST(snapshot.fetchedAt)}`);
    setError(null);
    setSectorFilter('all');
    setStatusFilter('all');
    setSearch('');
    setExpandedSector(null);
  }, [masterRows, nseData]);

  // Hash-based navigation.
  useEffect(() => {
    const onHash = () => {
      const hash = window.location.hash;
      if (hash === '#/settings') setPage('settings');
      else if (hash === '#/tv-research') setPage('tv-research');
      else if (hash === '#/positions') setPage('positions');
      else setPage('analyze');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!session?.access_token || !settings.kiteApiKey) {
      setAccountSummary(null);
      return;
    }

    setAccountSummaryLoading(true);
    setAccountSummaryError(null);

    fetch('/api/kite/account-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: settings.kiteApiKey,
        accessToken: session.access_token,
      }),
    })
      .then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(payload.error || payload.message || 'Could not load account summary');
        }
        setAccountSummary(payload.account ?? null);
      })
      .catch((e) => {
        setAccountSummary(null);
        setAccountSummaryError(e.message || 'Could not load account summary');
      })
      .finally(() => setAccountSummaryLoading(false));
  }, [session, settings.kiteApiKey]);

  useEffect(() => {
    if (page !== 'positions' || !session?.access_token || !settings.kiteApiKey) {
      if (page !== 'positions') setPositions([]);
      return;
    }

    setPositionsLoading(true);
    setPositionsError(null);

    fetch('/api/kite/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: settings.kiteApiKey,
        accessToken: session.access_token,
      }),
    })
      .then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(payload.error || payload.message || 'Could not load positions');
        }
        const data = Array.isArray(payload.positions) ? payload.positions : [];
        setPositions(data);
      })
      .catch((e) => {
        setPositions([]);
        setPositionsError(e.message || 'Could not load positions');
      })
      .finally(() => setPositionsLoading(false));
  }, [page, session, settings.kiteApiKey]);

  // Handle the Kite redirect: /kite/callback?request_token=...&status=success
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get('request_token');
    if (!requestToken) return;

    // Clean the URL immediately so a refresh doesn't retry the same token.
    window.history.replaceState({}, '', window.location.origin + '/#/settings');
    setPage('settings');

    if (params.get('status') !== 'success') {
      setKiteStatus({ type: 'error', message: `Kite login ${params.get('status') || 'failed'}.` });
      return;
    }
    if (!settings.kiteApiKey || !settings.kiteApiSecret) {
      setKiteStatus({ type: 'error', message: 'Save your API key & secret before connecting.' });
      return;
    }

    setKiteStatus({ type: 'info', message: 'Exchanging request token…' });
    fetch('/api/kite/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: settings.kiteApiKey,
        apiSecret: settings.kiteApiSecret,
        requestToken,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Token exchange failed');
        return data.session;
      })
      .then((s) => {
        setSession(s);
        saveSession(s);
        setKiteStatus({ type: 'info', message: `Connected as ${s.user_name || s.user_id}.` });
      })
      .catch((e) => setKiteStatus({ type: 'error', message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveSettings = (s) => {
    setSettings(s);
    saveSettings(s);
    setKiteStatus({ type: 'info', message: 'Settings saved.' });
  };

  const handleKiteLogin = (s) => {
    window.location.href = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(s.kiteApiKey)}`;
  };

  const handleKiteLogout = () => {
    setSession(null);
    saveSession(null);
    setKiteStatus({ type: 'info', message: 'Disconnected.' });
  };

  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      setError(null);
      setPmFileName(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const pmRows = rowsToObjects(parseCSV(String(reader.result)));
          if (pmRows.length === 0) throw new Error('No data rows found in the file.');
          setResult(analyze(pmRows, masterRows ?? []));
          setSectorFilter('all');
          setStatusFilter('all');
          setSearch('');
          setExpandedSector(null);
        } catch (e) {
          setError(`Failed to parse ${file.name}: ${e.message}`);
          setResult(null);
        }
      };
      reader.onerror = () => setError(`Could not read ${file.name}`);
      reader.readAsText(file);
    },
    [masterRows]
  );

  const filteredStocks = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    return result.stocks.filter((s) => {
      if (sectorFilter !== 'all' && s.sector !== sectorFilter) return false;
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (q && !s.symbol.toLowerCase().includes(q) && !s.company.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [result, sectorFilter, statusFilter, search]);

  const sortedStocks = useMemo(() => {
    if (!stockSort.key) return filteredStocks;
    const { key, direction } = stockSort;
    return [...filteredStocks].sort((a, b) => {
      const left = a[key];
      const right = b[key];
      const leftMissing = left == null || left === '' || left === '—' || Number.isNaN(left);
      const rightMissing = right == null || right === '' || right === '—' || Number.isNaN(right);
      // Keep missing values last in either direction.
      if (leftMissing || rightMissing) return Number(leftMissing) - Number(rightMissing);
      const comparison = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'en', { sensitivity: 'base', numeric: true });
      return direction === 'asc' ? comparison : -comparison;
    });
  }, [filteredStocks, stockSort]);

  const toggleStockSort = (key) => {
    setStockSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  };

  const getSectorVal = useCallback((s, key) => {
    switch (key) {
      case 'advPct':
        return s.total ? s.advances / s.total : 0;
      case 'decPct':
        return s.total ? s.declines / s.total : 0;
      case 'ratio':
        return s.declines > 0 ? s.advances / s.declines : s.advances > 0 ? Infinity : -1;
      default:
        return s[key]; // total, advances, declines, unchanged
    }
  }, []);

  const sortedSectors = useMemo(() => {
    if (!result) return [];
    return [...result.sectors].sort((a, b) => {
      const diff = getSectorVal(a, sortKey) - getSectorVal(b, sortKey);
      return sortDir === 'asc' ? diff : -diff;
    });
  }, [result, sortKey, sortDir, getSectorVal]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIndicator = (key) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const { summary } = result ?? {};
  const advPct = summary && summary.total ? (summary.advances / summary.total) * 100 : 0;
  const decPct = summary && summary.total ? (summary.declines / summary.total) * 100 : 0;

  // Sector bias: a sector qualifies when its advance share > 65% (bullish) or its
  // decline share > 65% (bearish). For each qualifying sector, list the 3 lowest
  // FFM-cap stocks on the dominant side. Strongest-bias sectors first.
  const bias = useMemo(() => {
    if (!result || !summary || summary.total === 0) return null;
    const capAsc = (a, b) => (a.ffmCap ?? Infinity) - (b.ffmCap ?? Infinity);

    const sectors = result.sectors
      .map((s) => {
        const advShare = s.total ? s.advances / s.total : 0;
        const decShare = s.total ? s.declines / s.total : 0;
        const mode = advShare > 0.65 ? 'advance' : decShare > 0.65 ? 'decline' : null;
        if (!mode) return null;
        return {
          ...s,
          mode,
          share: mode === 'advance' ? advShare : decShare,
          stocks: result.stocks
            .filter((st) => st.sector === s.sector && st.status === mode)
            .sort(capAsc)
            .slice(0, 3),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.share - a.share || b.total - a.total);

    return { advanceSectors: sectors.filter((s) => s.mode === 'advance'),
             declineSectors: sectors.filter((s) => s.mode === 'decline') };
  }, [result, summary]);

  const fmtCap = (v) =>
    v == null ? '—' : v >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L Cr` : `₹${Math.round(v).toLocaleString('en-IN')} Cr`;

  // Phase 2: place order via Kite when session exists; for now confirm intent.
  const buildOrderParams = (stock, action) => {
    const refPrice = stock.finalPrice ?? stock.prevClose;
    const isBuy = action === 'BUY';
    const round2 = (n) => Math.round(n * 100) / 100;
    const params = {
      exchange: settings.exchange,
      tradingsymbol: stock.symbol,
      transaction_type: action,
      quantity: settings.quantity,
      product: settings.product,
      order_type: settings.orderType,
      validity: settings.validity,
      variety: settings.variety,
    };
    if (settings.orderType === 'LIMIT' || settings.orderType === 'SL') {
      // BUY slightly above ref, SELL slightly below ref to improve fill odds.
      params.price = round2(refPrice * (1 + (isBuy ? 1 : -1) * settings.priceOffsetPct / 100));
    }
    if (settings.orderType === 'SL' || settings.orderType === 'SL-M') {
      params.trigger_price = round2(refPrice * (1 + (isBuy ? 1 : -1) * settings.triggerOffsetPct / 100));
    }
    // Regulatory protection for market orders (Kite v3): converts to limit
    // within LPP range; -1 = automatic per Zerodha guidelines.
    if (settings.orderType === 'MARKET' || settings.orderType === 'SL-M') {
      params.market_protection = settings.marketProtection;
      params.autoslice = settings.autoslice;
    }
    if (settings.disclosedQuantity > 0) params.disclosed_quantity = settings.disclosedQuantity;
    if (settings.tag) params.tag = settings.tag;
    return params;
  };

  const handleTradeAction = (stock, action) => {
    const params = buildOrderParams(stock, action);
    const lines = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join('\n');
    if (!session) {
      window.alert(`${lines}\n\nConnect Kite in Settings to enable order placement.`);
      return;
    }

    fetch('/api/kite/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: settings.kiteApiKey,
        accessToken: session.access_token,
        order: params,
      }),
    })
      .then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(payload.error || payload.message || 'Order failed');
        }
        window.alert(`Order placed successfully.\n${lines}`);
      })
      .catch((e) => {
        window.alert(`Order failed\n${e.message}\n\n${lines}`);
      });
  };

  const submitOrder = (params) => {
    if (!session) {
      window.alert(`${Object.entries(params).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nConnect Kite in Settings to enable order placement.`);
      return Promise.reject(new Error('Kite session missing'));
    }

    return fetch('/api/kite/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: settings.kiteApiKey,
        accessToken: session.access_token,
        order: params,
      }),
    }).then(async (r) => {
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(payload.error || payload.message || 'Order failed');
      }
      return payload;
    });
  };

  const handleSquareOffPosition = (position) => {
    const qty = Number(position.quantity ?? 0);
    const transaction_type = qty > 0 ? 'SELL' : qty < 0 ? 'BUY' : null;
    const quantity = Math.abs(qty);

    if (!transaction_type || quantity <= 0) {
      window.alert('Position quantity is zero; nothing to square off.');
      return;
    }

    const params = {
      exchange: position.exchange,
      tradingsymbol: position.tradingsymbol,
      transaction_type,
      quantity,
      product: position.product ?? settings.product,
      order_type: settings.orderType,
      validity: settings.validity,
      variety: settings.variety,
      ...(settings.orderType === 'LIMIT' || settings.orderType === 'SL'
        ? { price: Number(position.last_price ?? 0) }
        : {}),
      ...(settings.orderType === 'MARKET' || settings.orderType === 'SL-M'
        ? {
            market_protection: settings.marketProtection,
            autoslice: settings.autoslice,
          }
        : {}),
      ...(settings.disclosedQuantity > 0 ? { disclosed_quantity: settings.disclosedQuantity } : {}),
      ...(settings.tag ? { tag: settings.tag } : {}),
    };

    const lines = Object.entries(params).map(([k, v]) => `${k}: ${v}`).join('\n');
    submitOrder(params)
      .then(() => {
        window.alert(`Square off placed successfully.\n${lines}`);
      })
      .catch((e) => {
        window.alert(`Square off failed\n${e.message}\n\n${lines}`);
      });
  };

  const handleSquareOffAll = () => {
    if (!positions || positions.length === 0) return;
    const items = positions.filter((p) => Number(p.quantity ?? 0) !== 0);
    if (items.length === 0) return;

    Promise.all(items.map((position) => {
      const qty = Number(position.quantity ?? 0);
      const transaction_type = qty > 0 ? 'SELL' : qty < 0 ? 'BUY' : null;
      const quantity = Math.abs(qty);
      if (!transaction_type || quantity <= 0) return Promise.resolve();

      const params = {
        exchange: position.exchange,
        tradingsymbol: position.tradingsymbol,
        transaction_type,
        quantity,
        product: position.product ?? settings.product,
        order_type: settings.orderType,
        validity: settings.validity,
        variety: settings.variety,
        ...(settings.orderType === 'LIMIT' || settings.orderType === 'SL'
          ? { price: Number(position.last_price ?? 0) }
          : {}),
        ...(settings.orderType === 'MARKET' || settings.orderType === 'SL-M'
          ? {
              market_protection: settings.marketProtection,
              autoslice: settings.autoslice,
            }
          : {}),
        ...(settings.disclosedQuantity > 0 ? { disclosed_quantity: settings.disclosedQuantity } : {}),
        ...(settings.tag ? { tag: settings.tag } : {}),
      };
      return submitOrder(params);
    }))
      .then(() => {
        autoSquareOffLockRef.current = false;
        setKiteStatus({ type: 'info', message: 'Auto square-off triggered and orders sent.' });
      })
      .catch((e) => {
        autoSquareOffLockRef.current = false;
        setKiteStatus({ type: 'error', message: `Auto square-off failed: ${e.message}` });
      });
  };

  useEffect(() => {
    if (!positions || positions.length === 0) {
      autoSquareOffLockRef.current = false;
      return;
    }

    if (!settings.maxLoss || settings.maxLoss <= 0) {
      autoSquareOffLockRef.current = false;
      return;
    }

    const totalLoss = positions.reduce((sum, p) => sum + (Number(p.pnl ?? 0) || 0), 0);
    const shouldSquareOff = totalLoss <= -settings.maxLoss;

    if (shouldSquareOff && !autoSquareOffLockRef.current) {
      autoSquareOffLockRef.current = true;
      setKiteStatus({ type: 'info', message: `Max loss trigger reached: ₹${Math.abs(totalLoss).toLocaleString('en-IN', { maximumFractionDigits: 2 })}. Square-off started.` });
      handleSquareOffAll();
    }

    if (!shouldSquareOff) {
      autoSquareOffLockRef.current = false;
    }
  }, [positions, settings.maxLoss]);

  return (
    <div className="page">
      <nav className="nav">
        <a href="#/" className={`nav-link ${page === 'analyze' ? 'active' : ''}`}>
          Analyzer
        </a>
        <a href="#/positions" className={`nav-link ${page === 'positions' ? 'active' : ''}`}>
          Positions
        </a>
        <a href="#/tv-research" className={`nav-link ${page === 'tv-research' ? 'active' : ''}`}>TV research</a>
        <a href="#/settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`}>
          Settings
        </a>
        <span className={`badge nav-kite ${session ? 'advance' : 'unchanged'}`}>
          {session ? `Kite: ${session.user_name || session.user_id}` : 'Kite: not connected'}
        </span>
      </nav>

      {page === 'tv-research' ? <TvResearchPage /> : page === 'settings' ? (
        <SettingsPage
          settings={settings}
          onSave={handleSaveSettings}
          session={session}
          onLogin={handleKiteLogin}
          onLogout={handleKiteLogout}
          status={kiteStatus}
          accountSummary={accountSummary}
          accountSummaryLoading={accountSummaryLoading}
          accountSummaryError={accountSummaryError}
          nseData={nseData}
          nseConnectionError={nseConnectionError}
          onNseUpdate={(data) => { setNseData(data); setNseConnectionError(null); }}
        />
      ) : page === 'positions' ? (
        <div className="settings-page">
          <h2>Positions</h2>
          {!session ? (
            <div className="alert info">Connect Kite in Settings to view your open positions.</div>
          ) : positionsLoading ? (
            <div className="alert info">Loading positions…</div>
          ) : positionsError ? (
            <div className="alert error">{positionsError}</div>
          ) : positions.length === 0 ? (
            <div className="alert info">No open positions found.</div>
          ) : (
            <div className="table-wrap tall">
              <table className="stock-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Exchange</th>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Avg.</th>
                    <th className="num">LTP</th>
                    <th className="num">P&L</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos, idx) => {
                    const qty = Number(pos.quantity ?? 0);
                    const average = Number(pos.average_price ?? 0);
                    const ltp = Number(pos.last_price ?? 0);
                    const pnl = Number(pos.pnl ?? 0);
                    const net = Number(pos.net ?? 0);
                    return (
                      <tr key={`${pos.tradingsymbol || 'pos'}-${idx}`}>
                        <td className="mono">{pos.tradingsymbol}</td>
                        <td>{pos.exchange}</td>
                        <td>{pos.product}</td>
                        <td className="num">{qty}</td>
                        <td className="num">₹{average.toFixed(2)}</td>
                        <td className="num">₹{ltp.toFixed(2)}</td>
                        <td className={`num ${pnl >= 0 ? 'adv-text' : 'dec-text'}`}>
                          ₹{pnl.toFixed(2)}
                        </td>
                        <td className={`num ${net >= 0 ? 'adv-text' : 'dec-text'}`}>
                          {net}
                        </td>
                        <td className="num">
                          <button
                            className="btn danger"
                            onClick={() => handleSquareOffPosition(pos)}
                          >
                            Square Off
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <>
      <header className="header">
        <h1>Pre-Market Advance / Decline Analyzer</h1>
        <p className="subtitle">
          Scheduled NSE pre-open data or an uploaded pm.csv — sector mapping via master_stock.csv
          {masterRows && ` (${masterRows.length.toLocaleString()} symbols loaded)`}
        </p>
      </header>

      {masterError && (
        <div className="alert warn">
          {masterError}. You can still upload pm.csv — sectors will show as "Unknown".
        </div>
      )}

      <div className="alert info">
        {nseData?.config.enabled ? `Next NSE fetch: ${formatIST(nseData.nextRun)}.` : nseData ? 'Automatic NSE fetch is disabled.' : 'Loading NSE schedule…'}
        {' '}<a className="nse-settings-link" href="#/settings">Configure in Settings</a>
        {nseData?.snapshot && <div>NSE data timestamp: {nseData.snapshot.marketUpdatedAt ?? 'Not supplied'}{nseData.snapshot.marketUpdatedAt ? ' IST' : ''}. Fetched: {formatIST(nseData.snapshot.fetchedAt)}.</div>}
      </div>
      {(nseConnectionError || nseData?.lastError) && <div className="alert warn">{nseConnectionError || nseData.lastError}</div>}

      <div
        className={`dropzone ${dragOver ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
      >
        <div className="dropzone-inner">
          <span className="drop-icon">📤</span>
          <strong>{pmFileName ? pmFileName : 'Drop pm.csv here or click to upload'}</strong>
          <span className="hint">NSE pre-market open file (CSV)</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>

      {error && <div className="alert error">{error}</div>}

      {result && summary && (
        <>
          {/* Summary cards */}
          <section className="cards">
            <div className="card total">
              <span className="card-label">Total Stocks</span>
              <span className="card-value">{summary.total.toLocaleString()}</span>
            </div>
            <div className="card adv">
              <span className="card-label">Advances</span>
              <span className="card-value">{summary.advances.toLocaleString()}</span>
              <span className="card-sub">{advPct.toFixed(1)}%</span>
            </div>
            <div className="card dec">
              <span className="card-label">Declines</span>
              <span className="card-value">{summary.declines.toLocaleString()}</span>
              <span className="card-sub">{decPct.toFixed(1)}%</span>
            </div>
            <div className="card unch">
              <span className="card-label">Unchanged</span>
              <span className="card-value">{summary.unchanged.toLocaleString()}</span>
            </div>
            <div className="card ratio">
              <span className="card-label">A/D Ratio</span>
              <span className="card-value">
                {summary.adRatio === null
                  ? '—'
                  : summary.adRatio === Infinity
                    ? '∞'
                    : summary.adRatio.toFixed(2)}
              </span>
              <span className="card-sub">
                {summary.adRatio !== null && summary.adRatio !== Infinity
                  ? summary.adRatio >= 1
                    ? 'Bullish breadth'
                    : 'Bearish breadth'
                  : ''}
              </span>
            </div>
          </section>

          {/* Overall breadth bar */}
          <div className="breadth-bar" title="Overall market breadth">
            <div className="seg adv" style={{ width: `${advPct}%` }} />
            <div className="seg dec" style={{ width: `${decPct}%` }} />
            <div className="seg unch" style={{ width: `${100 - advPct - decPct}%` }} />
          </div>

          {summary.skipped > 0 && (
            <div className="alert info">
              {summary.skipped.toLocaleString()} symbol{summary.skipped > 1 ? 's' : ''} not present
              in master_stock.csv were excluded from the analysis.
            </div>
          )}

          {/* Sector bias spotlight */}
          {bias && (bias.advanceSectors.length > 0 || bias.declineSectors.length > 0) && (
            <section>
              <h2>Sector Bias (breadth &gt; 65%)</h2>
              <p className="hint">
                Sectors where more than 65% of stocks move one way — 3 lowest FFM-cap
                stocks from the dominant side, strongest bias first.
              </p>
              {[
                { label: 'Advance-dominated ▲', list: bias.advanceSectors, mode: 'advance' },
                { label: 'Decline-dominated ▼', list: bias.declineSectors, mode: 'decline' },
              ].map(
                ({ label, list, mode }) =>
                  list.length > 0 && (
                    <div key={mode} className="bias-group">
                      <h3 className={mode === 'advance' ? 'adv-text' : 'dec-text'}>
                        {label} ({list.length})
                      </h3>
                      <div className="bias-grid">
                        {list.map((s) => (
                          <div key={s.sector} className={`bias-card ${mode}`}>
                            <div className="bias-head">
                              <strong>{s.sector}</strong>
                              <span className={`badge ${mode}`}>
                                {mode === 'advance'
                                  ? `${s.advances}/${s.total} adv`
                                  : `${s.declines}/${s.total} dec`}
                              </span>
                            </div>
                            <table className="bias-table">
                              <thead>
                                <tr>
                                  <th>Symbol</th>
                                  <th className="num">%Chg</th>
                                  <th className="num">FFM Cap</th>
                                  <th className="num">Action</th>
                                </tr>
                              </thead>
                              <tbody>
                                {s.stocks.map((st) => (
                                  <tr key={st.symbol}>
                                    <td className="mono">{st.symbol}</td>
                                    <td
                                      className={`num ${mode === 'advance' ? 'adv-text' : 'dec-text'}`}
                                    >
                                      {st.pctChange ?? '—'}
                                    </td>
                                    <td className="num">{fmtCap(st.ffmCap)}</td>
                                    <td className="num">
                                      <button
                                        className={`btn trade ${mode === 'advance' ? 'buy' : 'sell'}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleTradeAction(st, mode === 'advance' ? 'BUY' : 'SELL');
                                        }}
                                      >
                                        {mode === 'advance' ? 'BUY' : 'SELL'}
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
              )}
            </section>
          )}

          {/* Sector-wise table */}
          <section>
            <h2>Sector-wise Advance / Decline</h2>
            <div className="table-wrap">
              <table className="sector-table">
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th className="num sortable" onClick={() => toggleSort('total')}>
                      Total{sortIndicator('total')}
                    </th>
                    <th className="num sortable adv-text" onClick={() => toggleSort('advances')}>
                      Adv{sortIndicator('advances')}
                    </th>
                    <th className="num sortable adv-text" onClick={() => toggleSort('advPct')}>
                      Adv %{sortIndicator('advPct')}
                    </th>
                    <th className="num sortable dec-text" onClick={() => toggleSort('declines')}>
                      Dec{sortIndicator('declines')}
                    </th>
                    <th className="num sortable dec-text" onClick={() => toggleSort('decPct')}>
                      Dec %{sortIndicator('decPct')}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort('unchanged')}>
                      Unch{sortIndicator('unchanged')}
                    </th>
                    <th className="num sortable" onClick={() => toggleSort('ratio')}>
                      A/D{sortIndicator('ratio')}
                    </th>
                    <th className="bar-col">Breadth</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSectors.map((s) => {
                    const ratio =
                      s.declines > 0 ? s.advances / s.declines : s.advances > 0 ? Infinity : null;
                    const a = s.total ? (s.advances / s.total) * 100 : 0;
                    const d = s.total ? (s.declines / s.total) * 100 : 0;
                    const isOpen = expandedSector === s.sector;
                    return (
                      <tr
                        key={s.sector}
                        className={`sector-row ${isOpen ? 'open' : ''}`}
                        onClick={() => {
                          setExpandedSector(isOpen ? null : s.sector);
                          setSectorFilter(isOpen ? 'all' : s.sector);
                        }}
                      >
                        <td>{s.sector}</td>
                        <td className="num">{s.total}</td>
                        <td className="num adv-text">{s.advances}</td>
                        <td className="num adv-text">{a.toFixed(1)}%</td>
                        <td className="num dec-text">{s.declines}</td>
                        <td className="num dec-text">{d.toFixed(1)}%</td>
                        <td className="num">{s.unchanged}</td>
                        <td className="num">
                          {ratio === null ? '—' : ratio === Infinity ? '∞' : ratio.toFixed(2)}
                        </td>
                        <td className="bar-col">
                          <div className="mini-bar">
                            <div className="seg adv" style={{ width: `${a}%` }} />
                            <div className="seg dec" style={{ width: `${d}%` }} />
                            <div className="seg unch" style={{ width: `${100 - a - d}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              Click a sector row to filter the stock list below. Click a column header to sort.
            </p>
          </section>

          {/* Stock detail */}
          <section>
            <h2>Stocks ({filteredStocks.length.toLocaleString()})</h2>
            <div className="filters">
              <input
                type="search"
                placeholder="Search symbol or company…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
                <option value="all">All sectors</option>
                {result.sectors.map((s) => (
                  <option key={s.sector} value={s.sector}>
                    {s.sector} ({s.total})
                  </option>
                ))}
              </select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All</option>
                <option value="advance">Advances</option>
                <option value="decline">Declines</option>
                <option value="unchanged">Unchanged</option>
              </select>
            </div>
            <div className="table-wrap tall">
              <table className="stock-table">
                <thead>
                  <tr>
                    {STOCK_COLUMNS.map(({ key, label, numeric }) => (
                      <th
                        key={key}
                        scope="col"
                        className={numeric ? 'num sortable' : 'sortable'}
                        aria-sort={stockSort.key === key
                          ? (stockSort.direction === 'asc' ? 'ascending' : 'descending')
                          : 'none'}
                      >
                        <button
                          type="button"
                          className="stock-sort-button"
                          onClick={() => toggleStockSort(key)}
                          aria-label={`Sort by ${label} ${stockSort.key === key && stockSort.direction === 'asc' ? 'descending' : 'ascending'}`}
                        >
                          {label}
                          <span className="sort-indicator" aria-hidden="true">
                            {stockSort.key === key ? (stockSort.direction === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedStocks.map((s) => (
                    <tr key={s.symbol}>
                      <td className="mono">{s.symbol}</td>
                      <td>{s.company}</td>
                      <td>{s.sector}</td>
                      <td className="num">{s.prevClose ?? '—'}</td>
                      <td className="num">{s.finalPrice ?? '—'}</td>
                      <td className={`num ${s.change > 0 ? 'adv-text' : s.change < 0 ? 'dec-text' : ''}`}>
                        {s.change ?? '—'}
                      </td>
                      <td className={`num ${s.pctChange > 0 ? 'adv-text' : s.pctChange < 0 ? 'dec-text' : ''}`}>
                        {s.pctChange ?? '—'}
                      </td>
                      <td>
                        <span className={`badge ${s.status}`}>
                          {s.status === 'advance' ? '▲ Adv' : s.status === 'decline' ? '▼ Dec' : '● Unch'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
        </>
      )}

      <footer className="footer">
        Classification: CHANGE &gt; 0 → Advance, CHANGE &lt; 0 → Decline, else Unchanged.
      </footer>
    </div>
  );
}
