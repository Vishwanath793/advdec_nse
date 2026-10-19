import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseCSV, rowsToObjects } from './utils/csv.js';
import { analyze } from './utils/analysis.js';
import { parseMasterFile } from './utils/master.js';
import {
  BLOCKED_SCORE_CAP,
  cleanWeight,
  CONVICTION_FACTORS,
  DEFAULT_FACTOR_SETTINGS,
  factorWeights,
  MAX_FACTOR_WEIGHT,
  MIN_GAP_PCT,
  weightShares,
} from './utils/conviction.js';
import { isTradeable, roomToCircuit, MIN_ROOM_PCT } from './utils/tradeability.js';
import { HIGH_DELIVERY_X, HIGH_RVOL_X, NOTABLE_OI_PCT } from './utils/signals.js';
import { api, isNativeApp } from './platform/index.js';
import { exportFileName, stocksWorkbook } from './utils/exportStocks.js';
import { indiaDate, istInstant, marketDay } from './core/calendar.js';
import { snapshotDate } from './core/recorder.js';
import holidayCalendar from '../server/tv/holidays.json';
import { kiteLoginUrl } from './core/kite.js';
import SettingsPage from './SettingsPage.jsx';
import TvResearchPage from './TvResearchPage.jsx';
import ReportCardPage from './ReportCardPage.jsx';
import ConfirmPage from './ConfirmPage.jsx';
import OrdersPage from './OrdersPage.jsx';
import { ModeBadge } from './TradingPanel.jsx';
import { formatIST } from './NseScheduleSettings.jsx';
import { loadSettings, saveSettings, loadSession, saveSession } from './store.js';

const STOCK_COLUMNS = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'company', label: 'Company' },
  { key: 'sector', label: 'Sector' },
  { key: 'marketCap', label: 'Mkt Cap', numeric: true },
  { key: 'prevClose', label: 'Prev Close', numeric: true },
  { key: 'finalPrice', label: 'Final Price', numeric: true },
  { key: 'change', label: 'Change', numeric: true },
  { key: 'pctChange', label: '%Chg', numeric: true },
  { key: 'convictionScore', label: 'Conviction', numeric: true },
  { key: 'rvolX', label: 'Signals', numeric: true },
  { key: 'bandPct', label: 'Circuit (Lower / Upper)', numeric: true },
  { key: 'status', label: 'Status' },
];

export default function App() {
  const [page, setPage] = useState(() => {
    const hash = window.location.hash;
    if (hash === '#/tv-research' && api.features.tvResearch) return 'tv-research';
    if (hash === '#/settings') return 'settings';
    if (hash === '#/positions') return 'positions';
    if (hash === '#/report') return 'report';
    if (hash === '#/confirm') return 'confirm';
    if (hash === '#/orders') return 'orders';
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
  // { name, uploadedAt } for an uploaded list; null while using the bundled CSV.
  const [masterSource, setMasterSource] = useState(null);
  const [masterStatus, setMasterStatus] = useState(null); // { type, message }
  const [pmFileName, setPmFileName] = useState(null);
  // Where the loaded pre-open came from: the NSE snapshot or an uploaded file (date unknown, so today).
  const [dataSource, setDataSource] = useState('nse');
  const [pmRows, setPmRows] = useState(null);
  const [priceBands, setPriceBands] = useState(null); // { fetchedAt, bands, lastError? }
  const [marketContext, setMarketContext] = useState(null); // { history, events, error } from /api/nse/context
  const [marketContextError, setMarketContextError] = useState(null);
  const [priceBandError, setPriceBandError] = useState(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [sectorFilter, setSectorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [tableTradeableOnly, setTableTradeableOnly] = useState(false);
  const [expandedSector, setExpandedSector] = useState(null);
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');
  const [stockSort, setStockSort] = useState({ key: null, direction: 'asc' });
  const [nseData, setNseData] = useState(null);
  const [nseConnectionError, setNseConnectionError] = useState(null);
  const [nseFetching, setNseFetching] = useState(false);
  const [nseFetchStatus, setNseFetchStatus] = useState(null); // { type, message }
  const appliedNseSnapshot = useRef(null);
  const autoSquareOffLockRef = useRef(false);
  const fileInputRef = useRef(null);
  const masterInputRef = useRef(null);
  const stocksSectionRef = useRef(null);
  const [exportMessage, setExportMessage] = useState(null); // { type, text }
  const [orderDraft, setOrderDraft] = useState(null); // prefill for the Orders form (from the Confirm tab)
  const clearOrderDraft = useCallback(() => setOrderDraft(null), []);
  // Hand the Kite session to the scheduled-order sender. Only set here, never cleared: a browser
  // without a login must not wipe the session another one gave (logout clears it explicitly).
  // Sent when the session changes and whenever the backend (re)connects (it keeps the session in
  // memory only, so a restart loses it). No polling. A failure is shown, not retried in a loop.
  const [sessionShareError, setSessionShareError] = useState(null);
  const lastShare = useRef({ token: null, at: 0 });
  const shareKiteSession = useCallback(async ({ force = false } = {}) => {
    if (!session?.access_token || !settings.kiteApiKey) return null;
    // The page load and the backend connection both ask at start-up: send once.
    // Only a successful hand-off counts: one that failed (backend restarting) must not block the retry.
    if (!force && lastShare.current.token === session.access_token && Date.now() - lastShare.current.at < 5_000) return null;
    try {
      const status = await api.scheduledOrders.setSession({ apiKey: settings.kiteApiKey, accessToken: session.access_token, userId: session.user_id });
      lastShare.current = { token: session.access_token, at: Date.now() };
      setSessionShareError(null);
      return status;
    } catch (e) {
      setSessionShareError(e.message);
      return null;
    }
  }, [session, settings.kiteApiKey]);
  const shareKiteSessionRef = useRef(shareKiteSession);
  shareKiteSessionRef.current = shareKiteSession;
  useEffect(() => { shareKiteSession(); }, [shareKiteSession]);
  const [exportStatus, setExportStatus] = useState(null); // backend 9:30 auto-save status

  const loadBundledMaster = useCallback(() => {
    return fetch('/master_stock.csv')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setMasterRows(rowsToObjects(parseCSV(text)));
        setMasterSource(null);
        setMasterError(null);
      })
      .catch((e) => setMasterError(`Could not load master_stock.csv (${e.message})`));
  }, []);

  // Load the uploaded master list if one was saved, else the bundled CSV.
  useEffect(() => {
    api.master.get()
      .catch(() => null)
      .then((saved) => {
        if (saved?.rows?.length) {
          setMasterRows(saved.rows);
          setMasterSource({ name: saved.name, uploadedAt: saved.uploadedAt });
        } else {
          loadBundledMaster();
        }
      });
  }, [loadBundledMaster]);

  const handleMasterFile = async (file) => {
    if (!file) return;
    setMasterStatus({ type: 'info', message: `Reading ${file.name}…` });
    try {
      const rows = await parseMasterFile(file);
      const saved = await api.master.save(file.name, rows);
      setMasterRows(saved.rows);
      setMasterSource({ name: saved.name, uploadedAt: saved.uploadedAt });
      setMasterError(null);
      setMasterStatus({ type: 'info', message: `Master list updated: ${rows.length.toLocaleString()} symbols from ${file.name}.` });
    } catch (e) {
      setMasterStatus({ type: 'error', message: `Could not use ${file.name}: ${e.message}` });
    }
  };

  // Manual NSE pre-open fetch (same job as the scheduled 09:10 IST run).
  const handleNseFetchNow = async () => {
    setNseFetching(true);
    setNseFetchStatus(null);
    try {
      const payload = await api.preopen.refresh();
      setNseData((current) => ({ ...current, ...payload }));
      setNseConnectionError(null);
      setNseFetchStatus({
        type: 'info',
        message: `NSE data loaded${payload.snapshot?.marketUpdatedAt ? ` (NSE timestamp ${payload.snapshot.marketUpdatedAt} IST)` : ''}.`,
      });
    } catch (e) {
      setNseFetchStatus({ type: 'error', message: `NSE fetch failed: ${e.message} The previous data is kept.` });
    } finally {
      setNseFetching(false);
    }
  };

  const handleMasterReset = async () => {
    if (!window.confirm('Remove the uploaded master list and go back to the bundled master_stock.csv?')) return;
    try {
      await api.master.reset();
      await loadBundledMaster();
      setMasterStatus({ type: 'info', message: 'Reverted to the bundled master_stock.csv.' });
    } catch (e) {
      setMasterStatus({ type: 'error', message: `Could not reset master list: ${e.message}` });
    }
  };

  // Yesterday's range, volume, delivery and trend, corporate events and market signals,
  // as of the morning of the loaded pre-open's trading day (so Friday's pre-open viewed
  // on Saturday doesn't use Friday's close). Reloaded with each new NSE snapshot.
  const snapshotFetchedAt = nseData?.snapshot?.fetchedAt;
  const contextDate = dataSource === 'upload' ? null : snapshotDate(nseData?.snapshot, holidayCalendar);
  // Wait for the first NSE status, so the context is requested once, for the right day.
  const contextReady = dataSource === 'upload' || nseData !== null;
  useEffect(() => {
    if (!contextReady) return undefined;
    let cancelled = false;
    api.context.get(contextDate)
      .then((payload) => {
        if (cancelled) return;
        setMarketContext(payload);
        setMarketContextError(payload.error ?? null);
      })
      .catch((e) => { if (!cancelled) setMarketContextError(e.message); });
    return () => { cancelled = true; };
  }, [contextReady, contextDate, snapshotFetchedAt]);

  // NSE price bands (circuit %), refreshed once per IST day.
  useEffect(() => {
    api.priceBands.get()
      .then((payload) => {
        setPriceBands(payload);
        setPriceBandError(payload.lastError ?? null);
      })
      .catch((e) => setPriceBandError(e.message));
  }, []);

  // Re-analyze whenever the pre-open data, master list or price bands change.
  const result = useMemo(
    () => (pmRows
      ? analyze(pmRows, masterRows ?? [], priceBands, { convictionFactors: settings.convictionFactors, context: marketContext })
      : null),
    [pmRows, masterRows, priceBands, settings.convictionFactors, marketContext]
  );

  // NSE pre-open status and snapshots (backend events on the web; on the phone, local).
  useEffect(() => api.preopen.subscribe(
    (data) => {
      setNseData((current) => ({ ...current, ...data }));
      setNseConnectionError(null);
    },
    (message) => setNseConnectionError(message),
    // Connected or reconnected to the backend: it may have restarted and lost the Kite session.
    () => shareKiteSessionRef.current(),
  ), []);

  useEffect(() => {
    const snapshot = nseData?.snapshot;
    if (!masterRows || !snapshot || appliedNseSnapshot.current === snapshot.fetchedAt) return;
    appliedNseSnapshot.current = snapshot.fetchedAt;
    setPmRows(snapshot.rows);
    setDataSource('nse');
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
      else if (hash === '#/tv-research' && api.features.tvResearch) setPage('tv-research');
      else if (hash === '#/positions') setPage('positions');
      else if (hash === '#/report') setPage('report');
      else if (hash === '#/confirm') setPage('confirm');
      else if (hash === '#/orders') setPage('orders');
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

    api.kite.accountSummary({ apiKey: settings.kiteApiKey, accessToken: session.access_token })
      .then((account) => setAccountSummary(account ?? null))
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

    api.kite.positions({ apiKey: settings.kiteApiKey, accessToken: session.access_token })
      .then((data) => setPositions(Array.isArray(data) ? data : []))
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
    api.kite.createSession({ apiKey: settings.kiteApiKey, apiSecret: settings.kiteApiSecret, requestToken })
      .then((s) => {
        if (!s?.access_token) throw new Error('Token exchange failed');
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
    window.location.href = kiteLoginUrl(s.kiteApiKey);
  };

  const handleKiteLogout = () => {
    api.scheduledOrders.setSession(null).catch(() => {}); // scheduled orders can no longer be sent
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
          const rows = rowsToObjects(parseCSV(String(reader.result)));
          if (rows.length === 0) throw new Error('No data rows found in the file.');
          setPmRows(rows);
          setDataSource('upload');
          setSectorFilter('all');
          setStatusFilter('all');
          setSearch('');
          setExpandedSector(null);
        } catch (e) {
          setError(`Failed to parse ${file.name}: ${e.message}`);
          setPmRows(null);
        }
      };
      reader.onerror = () => setError(`Could not read ${file.name}`);
      reader.readAsText(file);
    },
    []
  );

  const filteredStocks = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    return result.stocks.filter((s) => {
      if (sectorFilter !== 'all' && s.sector !== sectorFilter) return false;
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (tableTradeableOnly && !isTradeable(s)) return false;
      if (q && !s.symbol.toLowerCase().includes(q) && !s.company.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [result, sectorFilter, statusFilter, search, tableTradeableOnly]);

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

  // Excel download of the table as shown (filters and sort), with the conviction breakdown.
  const tableFilters = [
    search.trim() && `search "${search.trim()}"`,
    sectorFilter !== 'all' && `sector ${sectorFilter}`,
    statusFilter !== 'all' && `${statusFilter}s only`,
    tableTradeableOnly && 'tradeable only',
  ].filter(Boolean).join(', ') || 'None (all stocks)';
  const saveStocksFile = async (stocks, filters) => {
    const at = new Date();
    const bytes = stocksWorkbook(stocks, settings.convictionFactors, { exportedAt: at, source: pmFileName ?? '', filters });
    return api.files.save(exportFileName(at), bytes);
  };
  const downloadStocks = async () => {
    try {
      const where = await saveStocksFile(sortedStocks, tableFilters);
      setExportMessage({ type: 'info', text: `Saved ${sortedStocks.length} stocks to ${where}.` });
    } catch (e) {
      setExportMessage({ type: 'error', text: `Could not save the file: ${e.message}` });
    }
  };

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

  // Top 5 gainers / losers by %change among stocks at or above the market-cap floor.
  const topMovers = useMemo(() => {
    if (!result) return null;
    const floor = Number(settings.minMarketCapCr) || 0;
    const sized = result.stocks.filter(
      (s) => s.marketCap != null && s.marketCap >= floor && s.pctChange != null
    );
    const eligible = settings.tradeableOnly ? sized.filter(isTradeable) : sized;
    const byConviction = settings.moversRankBy === 'conviction';
    // Conviction ranking: highest score first, bigger gap breaks ties.
    const rank = (a, b) => byConviction
      ? (b.convictionScore ?? -1) - (a.convictionScore ?? -1) || Math.abs(b.pctChange) - Math.abs(a.pctChange)
      : Math.abs(b.pctChange) - Math.abs(a.pctChange);
    return {
      eligible: eligible.length,
      hidden: sized.length - eligible.length,
      gainers: eligible.filter((s) => s.status === 'advance').sort(rank).slice(0, 5),
      losers: eligible.filter((s) => s.status === 'decline').sort(rank).slice(0, 5),
    };
  }, [result, settings.minMarketCapCr, settings.moversRankBy, settings.tradeableOnly]);

  // Tradeability badges shown beside a symbol; hover for the reason.
  const renderFlags = (s) =>
    s.flags?.map((f) => (
      <span key={f.key} className={`flag ${f.severity}`} title={f.detail}>
        {f.label}
      </span>
    ));

  // GIFT Nifty, India VIX and FII/DII for today (from the context), with details on hover.
  const renderMarketSignals = () => {
    const m = marketContext?.market;
    if (!m) return null;
    const fmtSigned = (n, unit = '%') => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}${unit}`;
    const crore = (n, digits = 0) => (n == null ? '—'
      : `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: digits })}`);
    const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const use = (key) => (activeWeights[key] ? `In your conviction score (weight ${activeWeights[key]}).` : 'Not in your conviction score: turn it on in "Conviction factors".');
    const tone = (v) => (v > 0 ? 'adv-text' : v < 0 ? 'dec-text' : '');
    const items = [
      m.gift
        ? {
          key: 'gift', label: 'GIFT Nifty', tone: tone(m.gift.pct),
          value: `${m.gift.last.toLocaleString('en-IN')} (${fmtSigned(m.gift.pct)})`,
          when: formatIST(m.gift.at),
          title: `GIFT Nifty (Nifty futures on NSE IX) ${m.gift.morning ? 'before the pre-open closed' : 'after the pre-open closed (no reading before 09:08 was caught)'}, ${formatIST(m.gift.at)}. `
            + `Change ${fmtSigned(m.gift.change ?? 0, '')} pts vs its previous close; Nifty 50 last closed at ${m.gift.niftyClose?.toLocaleString('en-IN') ?? '—'}. `
            + `Up favours gap-ups, down favours gap-downs. ${use('gift')}`,
        }
        : { key: 'gift', label: 'GIFT Nifty', value: '—', title: `No GIFT Nifty reading for today yet (read at 9:07 IST). ${use('gift')}` },
      m.vix
        ? {
          key: 'vix', label: 'India VIX', tone: tone(-m.vix.pct),
          value: `${m.vix.last} (${fmtSigned(m.vix.pct)})`,
          when: day(m.vix.date),
          title: `India VIX closed at ${m.vix.last} on ${day(m.vix.date)} (${fmtSigned(m.vix.pct)}). Rising fear favours gap-downs; easing fear favours gap-ups. ${use('vix')}`,
        }
        : { key: 'vix', label: 'India VIX', value: '—', title: `Yesterday's India VIX close isn't available yet (read after 15:30 and before the open). ${use('vix')}` },
      m.flows
        ? {
          key: 'flows', label: 'FII / DII', tone: tone(m.flows.fii ?? 0),
          value: `${crore(m.flows.fii)} / ${crore(m.flows.dii)} Cr`,
          when: day(m.flows.date),
          title: `Net cash-market buying on ${day(m.flows.date)}: FII ${crore(m.flows.fii, 2)} Cr, DII ${crore(m.flows.dii, 2)} Cr. `
            + `FII buying favours gap-ups, selling favours gap-downs. ${use('flows')}`,
        }
        : { key: 'flows', label: 'FII / DII', value: '—', title: `Yesterday's FII/DII figures aren't available yet (NSE publishes them in the evening). ${use('flows')}` },
    ];
    return (
      <div className="market-signals" aria-label="Market signals">
        <span className="hint">Market signals:</span>
        {items.map((i) => (
          <span key={i.key} className={`market-signal ${activeWeights[i.key] ? 'on' : ''}`} title={i.title}>
            <span className="market-signal-label">{i.label}</span>{' '}
            <strong className={i.tone}>{i.value}</strong>
            {i.when && <span className="hint"> · {i.when}</span>}
          </span>
        ))}
      </div>
    );
  };

  // Decision signals (results, relative volume, gap vs yesterday's range).
  // `compact` (top movers) shows only the notable ones.
  const renderSignals = (s, compact = false) => {
    const items = [];
    if (s.results?.length) {
      const r = s.results[0];
      items.push({ key: 'results', cls: 'good', label: 'Results', title: `${formatIST(r.at)}: ${r.text}` });
    }
    if (s.resultsDue) {
      items.push({ key: 'due', cls: 'warn', label: 'Results due', title: `Board meeting today (${s.resultsDue}): results may come during market hours.` });
    }
    if (s.rvolX != null && (!compact || s.rvolX >= HIGH_RVOL_X)) {
      const x = s.rvolX >= 10 ? Math.round(s.rvolX) : s.rvolX.toFixed(1);
      items.push({
        key: 'rvol',
        cls: s.rvolX >= HIGH_RVOL_X ? 'high' : 'muted',
        label: `Vol ${x}×`,
        title: `Pre-open quantity ${s.finalVolume?.toLocaleString('en-IN')} = ${s.rvolPct.toFixed(2)}% of its 20-day average daily volume (${Math.round(s.avgVolume).toLocaleString('en-IN')}); ${x}× the typical stock, higher than ${Math.round(s.rvolRank * 100)}% of stocks.`,
      });
    }
    if (s.delivX != null && s.delivX >= HIGH_DELIVERY_X && s.prevMovePct != null) {
      const up = s.prevMovePct >= 0;
      items.push({
        key: 'deliv',
        cls: 'good',
        label: `Deliv ${s.delivX.toFixed(1)}×`,
        title: `Yesterday ${s.prevMovePct >= 0 ? '+' : ''}${s.prevMovePct.toFixed(2)}% on ${s.delivPct.toFixed(1)}% delivery, ${s.delivX.toFixed(1)}× its usual ${s.delivAvg.toFixed(1)}%: `
          + `${up ? 'buying taken for delivery (accumulation), supports a gap-up' : 'selling taken for delivery (distribution), supports a gap-down'}.`,
      });
    }
    if (s.foBuild && s.foBuild !== 'neutral' && Math.abs(s.foOiChangePct) >= NOTABLE_OI_PCT) {
      const bullish = s.foBuild === 'long build-up' || s.foBuild === 'short covering';
      items.push({
        key: 'oi',
        cls: bullish === (s.status === 'advance') ? 'good' : 'warn',
        label: `OI ${s.foBuild}`,
        title: `Yesterday the stock's futures moved ${s.foPricePct >= 0 ? '+' : ''}${s.foPricePct.toFixed(2)}% while open interest changed ${s.foOiChangePct >= 0 ? '+' : ''}${s.foOiChangePct.toFixed(1)}% (now ${s.foOi?.toLocaleString('en-IN')} shares): ${s.foBuild}, ${bullish ? 'bullish' : 'bearish'} positioning.`,
      });
    }
    if (s.rangeBreak === 'above' || s.rangeBreak === 'below') {
      const above = s.rangeBreak === 'above';
      items.push({
        key: 'range',
        cls: 'good',
        label: above ? 'Above PDH' : 'Below PDL',
        title: `Opening ${above ? `above yesterday's high ₹${s.prevHigh}` : `below yesterday's low ₹${s.prevLow}`} (yesterday's range ₹${s.prevLow}–₹${s.prevHigh}): a true gap.`,
      });
    } else if (s.rangeBreak === 'inside' && !compact) {
      items.push({ key: 'range', cls: 'muted', label: 'Inside PD range', title: `Opening inside yesterday's range ₹${s.prevLow}–₹${s.prevHigh}.` });
    }
    if (!items.length) return compact ? null : <span className="hint">—</span>;
    return items.map((i) => (
      <span key={i.key} className={`sig ${i.cls}`} title={i.title}>{i.label}</span>
    ));
  };

  const updateSetting = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  };
  const updateMinMarketCap = (value) => updateSetting({ minMarketCapCr: Math.max(0, Number(value) || 0) });

  // The backend's 9:30 file uses the factors chosen here.
  useEffect(() => {
    if (!api.exports) return undefined;
    const timer = setTimeout(() => {
      api.exports.saveSettings(settings.convictionFactors).then(setExportStatus).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [settings.convictionFactors]);
  useEffect(() => {
    api.exports?.status().then(setExportStatus).catch(() => {});
  }, []);

  // Phone app (no backend): save the full table once per trading day after 9:30 while the app is open.
  const phoneAutoSave = useRef(null);
  phoneAutoSave.current = async () => {
    const now = new Date();
    const today = indiaDate(now);
    let done = null;
    try { done = localStorage.getItem('ad_auto_export_date'); } catch { /* storage unavailable */ }
    if (done === today || !result || !marketDay(today, holidayCalendar).open) return;
    if (now < istInstant(today, '09:30') || now > istInstant(today, '15:30')) return;
    if (snapshotDate(nseData?.snapshot, holidayCalendar) !== today || !pmFileName?.startsWith('NSE pre-open')) return;
    try {
      const where = await saveStocksFile(result.stocks, 'None (all stocks); saved automatically at 9:30');
      localStorage.setItem('ad_auto_export_date', today);
      setExportMessage({ type: 'info', text: `Saved today's 9:30 table to ${where}.` });
    } catch (e) {
      setExportMessage({ type: 'error', text: `Automatic 9:30 save failed: ${e.message}` });
    }
  };
  useEffect(() => {
    if (!isNativeApp) return undefined;
    const check = () => phoneAutoSave.current?.();
    check();
    const timer = setInterval(check, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Conviction factor on/off + weights (saved with the other settings).
  // Normalised the same way as the score (factorWeights), so the panel shows what is actually used.
  const factorSetting = (key) => {
    const s = settings.convictionFactors?.[key];
    const d = DEFAULT_FACTOR_SETTINGS[key];
    return { on: typeof s?.on === 'boolean' ? s.on : d.on, weight: cleanWeight(s?.weight) ?? d.weight };
  };
  const activeWeights = factorWeights(settings.convictionFactors);
  const activeShares = weightShares(activeWeights);
  const activeCount = Object.values(activeWeights).filter(Boolean).length;
  const checkedCount = CONVICTION_FACTORS.filter((f) => factorSetting(f.key).on).length;
  const factorsCustomised = JSON.stringify(activeWeights) !== JSON.stringify(factorWeights(DEFAULT_FACTOR_SETTINGS));
  const allFactors = (patchFor) => Object.fromEntries(CONVICTION_FACTORS.map((f) => [f.key, { ...factorSetting(f.key), ...patchFor(f) }]));
  const updateFactor = (key, patch) => updateSetting({
    convictionFactors: allFactors((f) => (f.key === key ? patch : {})),
  });
  // Turning a factor on at weight 0 would leave it ticked but ignored, so it gets its default weight back.
  const withWeight = (f) => ({ on: true, ...(factorSetting(f.key).weight > 0 ? {} : { weight: f.weight }) });
  const toggleFactor = (f, on) => updateFactor(f.key, on ? withWeight(f) : { on: false });
  const toggleAllFactors = (on) => updateSetting({ convictionFactors: allFactors((f) => (on ? withWeight(f) : { on: false })) });
  // A blank or invalid entry keeps the current weight instead of silently turning the factor off.
  const setFactorWeight = (key, value) => {
    const weight = cleanWeight(value);
    if (weight != null) updateFactor(key, { weight: Math.round(weight) });
  };

  // Conviction score cell; hover shows each factor's contribution.
  const renderConviction = (s) => {
    const c = s.conviction;
    if (!c || c.score == null) {
      const small = s.pctChange != null && s.pctChange !== 0 && Math.abs(s.pctChange) < MIN_GAP_PCT;
      return <span className="hint" title={small ? `Gap under ${MIN_GAP_PCT}%: not a gap trade, not scored` : undefined}>—</span>;
    }
    const tier = c.score >= 70 ? 'high' : c.score >= 50 ? 'mid' : 'low';
    const title = [
      `Gap-${c.direction} conviction ${c.score}/100`,
      ...(c.cappedBy && c.rawScore > c.score
        ? [`Capped at ${BLOCKED_SCORE_CAP} from ${c.rawScore}: ${c.cappedBy.join(', ')} (can't be traded intraday)`]
        : []),
      ...c.factors.map((f) => `• ${f.label} (weight ${f.weight}): ${Math.round(f.value * 100)} — ${f.detail}`),
      ...(c.missing.length ? [`Not available: ${c.missing.join(', ')}`] : []),
      ...(c.excluded.length ? [`Turned off: ${c.excluded.join(', ')}`] : []),
    ].join('\n');
    return (
      <span className={`conviction ${tier}`} title={title}>
        <span className="conviction-bar" aria-hidden="true">
          <span style={{ width: `${c.score}%` }} />
        </span>
        {c.score}
      </span>
    );
  };

  const fmtCap = (v) =>
    v == null ? '—' : v >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L Cr` : `₹${Math.round(v).toLocaleString('en-IN')} Cr`;

  const fmtPrice = (v) => `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Circuit limits cell. `side` limits it to one limit (top movers); default shows both.
  const renderCircuit = (s, side) => {
    if (s.band === 'none') {
      return <span className="hint" title="F&O stock: NSE applies dynamic price bands, not a fixed circuit">No band (F&amp;O)</span>;
    }
    if (s.upperCircuit == null) return <span className="hint">—</span>;
    const title = `${s.bandPct}% band on base price ₹${s.circuitBase}`;
    if (side) {
      // Room left to the circuit in the gap direction ("At UC/LC" shows as a symbol flag).
      const room = roomToCircuit(s);
      return (
        <span title={title}>
          {fmtPrice(side === 'upper' ? s.upperCircuit : s.lowerCircuit)}
          {room != null && (
            <span className={`hint room ${room < MIN_ROOM_PCT ? 'tight' : ''}`}> {room.toFixed(1)}% away</span>
          )}
        </span>
      );
    }
    return (
      <span title={title}>
        <span className="dec-text">{fmtPrice(s.lowerCircuit)}</span>
        {' / '}
        <span className="adv-text">{fmtPrice(s.upperCircuit)}</span>
        <span className="hint band-pct"> {s.bandPct}%</span>
      </span>
    );
  };

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
    if (stock.flags?.length) {
      const issues = stock.flags.map((f) => `• ${f.label}: ${f.detail}`).join('\n');
      if (!window.confirm(`${stock.symbol} has tradeability warnings:\n${issues}\n\nContinue with this ${action} order?`)) return;
    }
    if (!session) {
      window.alert(`${lines}\n\nConnect Kite in Settings to enable order placement.`);
      return;
    }

    api.kite.placeOrder({ apiKey: settings.kiteApiKey, accessToken: session.access_token, order: params })
      .then(() => {
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

    return api.kite.placeOrder({ apiKey: settings.kiteApiKey, accessToken: session.access_token, order: params });
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
        <a href="#/confirm" className={`nav-link ${page === 'confirm' ? 'active' : ''}`}>
          9:15 Confirm
        </a>
        <a href="#/orders" className={`nav-link ${page === 'orders' ? 'active' : ''}`}>
          Orders
        </a>
        <a href="#/positions" className={`nav-link ${page === 'positions' ? 'active' : ''}`}>
          Positions
        </a>
        <a href="#/report" className={`nav-link ${page === 'report' ? 'active' : ''}`}>
          Report card
        </a>
        {api.features.tvResearch && (
          <a href="#/tv-research" className={`nav-link ${page === 'tv-research' ? 'active' : ''}`}>TV research</a>
        )}
        <a href="#/settings" className={`nav-link ${page === 'settings' ? 'active' : ''}`}>
          Settings
        </a>
        <ModeBadge />
        <span className={`badge nav-kite ${session ? 'advance' : 'unchanged'}`}>
          {session ? `Kite: ${session.user_name || session.user_id}` : 'Kite: not connected'}
        </span>
      </nav>

      {page === 'tv-research' ? <TvResearchPage /> : page === 'orders' ? (
        <OrdersPage
          stocks={result?.stocks}
          settings={settings}
          session={session}
          draft={orderDraft}
          onDraftUsed={clearOrderDraft}
          onShareSession={shareKiteSession}
          sessionShareError={sessionShareError}
        />
      ) : page === 'confirm' ? (
        <ConfirmPage
          stocks={result?.stocks}
          date={contextDate}
          session={session}
          apiKey={settings.kiteApiKey}
          checkSettings={settings.confirmChecks}
          blend={settings.confirmBlend}
          sourcePref={settings.liveSource}
          onSettings={updateSetting}
          onSchedule={(d) => { setOrderDraft(d); window.location.hash = '#/orders'; }}
        />
      ) : page === 'report' ? (
        <ReportCardPage factorSettings={settings.convictionFactors} />
      ) : page === 'settings' ? (
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
          Scheduled NSE pre-open data or an uploaded pm.csv — sector mapping and market cap via the master stock list
        </p>
      </header>

      <div className="master-bar">
        <div>
          <strong>Master stock list:</strong>{' '}
          {masterSource ? masterSource.name : 'master_stock.csv (bundled)'}
          {masterRows && ` · ${masterRows.length.toLocaleString()} symbols`}
          {masterSource?.uploadedAt && (
            <span className="hint"> · uploaded {new Date(masterSource.uploadedAt).toLocaleString('en-IN')}</span>
          )}
        </div>
        <div className="master-actions">
          <button type="button" className="btn" onClick={() => masterInputRef.current?.click()}>
            Upload new list (.xlsx / .csv)
          </button>
          {masterSource && (
            <button type="button" className="btn ghost" onClick={handleMasterReset}>
              Use bundled list
            </button>
          )}
          <input
            ref={masterInputRef}
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              handleMasterFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <span className="hint master-format">
          Columns: Company Name, Industry, Symbol, and optionally Market Cap (Cr). The first sheet of an .xlsx is used.
        </span>
      </div>
      {masterStatus && <div className={`alert ${masterStatus.type}`}>{masterStatus.message}</div>}
      {marketContextError && (
        <div className="alert warn">
          Signals (results, ex-dates, volume, yesterday's range): {marketContextError}
          {marketContext?.history?.asOf ? ` Using end-of-day data up to ${marketContext.history.asOf}.` : ''}
        </div>
      )}
      {priceBandError && (
        <div className="alert warn">
          Circuit limits: {priceBandError}
          {priceBands ? ` Showing price bands from ${formatIST(priceBands.fetchedAt)}.` : ' The circuit column will be empty.'}
        </div>
      )}

      {masterError && (
        <div className="alert warn">
          {masterError}. You can still upload pm.csv — sectors will show as "Unknown".
        </div>
      )}

      <div className="alert info nse-bar">
        <div>
          {nseData?.config.enabled ? `Next NSE fetch: ${formatIST(nseData.nextRun)}.` : nseData ? 'Automatic NSE fetch is disabled.' : 'Loading NSE schedule…'}
          {' '}<a className="nse-settings-link" href="#/settings">Configure in Settings</a>
          {nseData?.snapshot && <div>NSE data timestamp: {nseData.snapshot.marketUpdatedAt ?? 'Not supplied'}{nseData.snapshot.marketUpdatedAt ? ' IST' : ''}. Fetched: {formatIST(nseData.snapshot.fetchedAt)}.</div>}
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={!nseData || nseFetching || nseData.running}
          onClick={handleNseFetchNow}
        >
          {nseFetching || nseData?.running ? 'Fetching…' : 'Fetch NSE data now'}
        </button>
      </div>
      {nseFetchStatus && <div role="status" className={`alert ${nseFetchStatus.type}`}>{nseFetchStatus.message}</div>}
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
              in the master stock list were excluded from the analysis.
            </div>
          )}

          {renderMarketSignals()}

          {/* Conviction factor controls */}
          <details className="conviction-settings">
            <summary>
              Conviction factors{' '}
              <span className="hint">({activeCount} of {CONVICTION_FACTORS.length} on{factorsCustomised ? ', customised' : ''})</span>
            </summary>
            <p className="hint">
              Turn factors off or change their weight. Weights are relative: the factors that are on are rescaled to
              100, shown as “share”. Changes apply instantly and are saved in this browser. Defaults: gap size 15, buy/sell
              orders 100, pre-open value 100 and relative volume 100; the rest off.
            </p>
            <label className="factor-toggle factor-all">
              <input
                type="checkbox"
                checked={checkedCount === CONVICTION_FACTORS.length}
                ref={(el) => {
                  if (el) el.indeterminate = checkedCount > 0 && checkedCount < CONVICTION_FACTORS.length;
                }}
                onChange={(e) => toggleAllFactors(e.target.checked)}
              />
              <strong>{checkedCount === CONVICTION_FACTORS.length ? 'Uncheck all' : 'Check all'}</strong>
            </label>
            <div className="factor-grid">
              {CONVICTION_FACTORS.map((f) => {
                const s = factorSetting(f.key);
                const active = activeWeights[f.key] > 0;
                return (
                  <div key={f.key} className={`factor-row ${active ? '' : 'off'}`}>
                    <label className="factor-toggle">
                      <input
                        type="checkbox"
                        checked={s.on}
                        onChange={(e) => toggleFactor(f, e.target.checked)}
                      />
                      <strong>{f.label}</strong>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max={MAX_FACTOR_WEIGHT}
                      step="5"
                      value={s.weight}
                      disabled={!s.on}
                      aria-label={`${f.label} weight`}
                      onChange={(e) => setFactorWeight(f.key, e.target.value)}
                    />
                    <input
                      type="number"
                      className="factor-weight"
                      min="0"
                      max={MAX_FACTOR_WEIGHT}
                      value={s.weight}
                      disabled={!s.on}
                      aria-label={`${f.label} weight value`}
                      onChange={(e) => setFactorWeight(f.key, e.target.value)}
                    />
                    <span className="factor-share">
                      {active ? `${activeShares[f.key]}% share` : s.on ? 'weight 0' : 'off'}
                    </span>
                    <span className="hint factor-help">{f.help}</span>
                  </div>
                );
              })}
            </div>
            <div className="factor-actions">
              <button
                type="button"
                className="btn"
                disabled={!factorsCustomised}
                onClick={() => updateSetting({ convictionFactors: DEFAULT_FACTOR_SETTINGS })}
              >
                Reset to defaults
              </button>
            </div>
            {activeCount === 0 && (
              <div className="alert warn">All factors are off, so no stock gets a conviction score.</div>
            )}
          </details>

          {/* Top gainers / losers among large stocks */}
          {topMovers && (
            <section>
              <div className="section-head">
                <h2>Top 5 Gainers &amp; Losers</h2>
                <label className="cap-filter">
                  Market cap ≥ ₹
                  <input
                    type="number"
                    min="0"
                    step="500"
                    value={settings.minMarketCapCr}
                    onChange={(e) => updateMinMarketCap(e.target.value)}
                  />
                  Cr
                </label>
                <label className="cap-filter">
                  Rank by
                  <select
                    value={settings.moversRankBy}
                    onChange={(e) => updateSetting({ moversRankBy: e.target.value })}
                  >
                    <option value="pctChange">Biggest gap</option>
                    <option value="conviction">Conviction score</option>
                  </select>
                </label>
                <label className="cap-filter" title="Hide trade-to-trade (BE/BZ) series and stocks locked at a circuit">
                  <input
                    type="checkbox"
                    checked={settings.tradeableOnly}
                    onChange={(e) => updateSetting({ tradeableOnly: e.target.checked })}
                  />
                  Tradeable only
                </label>
              </div>
              {!result.hasMarketCap ? (
                <div className="alert warn">
                  The current master list has no market-cap column. Upload a list with a "Market Cap (Cr)" column to see top movers.
                </div>
              ) : (
                <>
                  <p className="hint">
                    {topMovers.eligible.toLocaleString()} stocks meet the market-cap filter
                    {topMovers.hidden > 0 && ` (${topMovers.hidden} untradeable hidden)`}. Ranked by{' '}
                    {settings.moversRankBy === 'conviction' ? 'conviction score (hover a score for its breakdown)' : 'pre-open %change'}.
                  </p>
                  <div className="movers-grid">
                    {[
                      { label: 'Top Gainers ▲', list: topMovers.gainers, mode: 'advance', action: 'BUY' },
                      { label: 'Top Losers ▼', list: topMovers.losers, mode: 'decline', action: 'SELL' },
                    ].map(({ label, list, mode, action }) => (
                      <div key={mode} className={`bias-card ${mode}`}>
                        <div className="bias-head">
                          <strong className={mode === 'advance' ? 'adv-text' : 'dec-text'}>{label}</strong>
                        </div>
                        {list.length === 0 ? (
                          <p className="hint">No {mode === 'advance' ? 'gainers' : 'losers'} above this market cap.</p>
                        ) : (
                          <table className="bias-table">
                            <thead>
                              <tr>
                                <th>#</th>
                                <th>Symbol</th>
                                <th>Sector</th>
                                <th className="num">Mkt Cap</th>
                                <th className="num">Price</th>
                                <th className="num">%Chg</th>
                                <th className="num">Conviction</th>
                                <th className="num">{mode === 'advance' ? 'Upper Ckt' : 'Lower Ckt'}</th>
                                <th className="num">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {list.map((st, i) => (
                                <tr key={st.symbol}>
                                  <td className="hint">{i + 1}</td>
                                  <td className="mono symbol-cell" title={st.company}>
                                    {st.symbol}
                                    {renderFlags(st)}
                                    {renderSignals(st, true)}
                                  </td>
                                  <td>{st.sector}</td>
                                  <td className="num">{fmtCap(st.marketCap)}</td>
                                  <td className="num">{st.finalPrice ?? '—'}</td>
                                  <td className={`num ${mode === 'advance' ? 'adv-text' : 'dec-text'}`}>
                                    {st.pctChange.toFixed(2)}%
                                  </td>
                                  <td className="num">{renderConviction(st)}</td>
                                  <td className="num circuit-cell">
                                    {renderCircuit(st, mode === 'advance' ? 'upper' : 'lower')}
                                  </td>
                                  <td className="num">
                                    <button
                                      className={`btn trade ${mode === 'advance' ? 'buy' : 'sell'}`}
                                      onClick={() => handleTradeAction(st, action)}
                                    >
                                      {action}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {/* Stock detail */}
          <section ref={stocksSectionRef}>
            <div className="section-head">
              <h2>Stocks ({filteredStocks.length.toLocaleString()})</h2>
              <div className="export-actions">
                <button type="button" className="btn" onClick={downloadStocks} disabled={!sortedStocks.length}
                  title="Excel file of the table as shown, with every conviction factor's score and weight and the factor settings">
                  ⬇ Download (.xlsx)
                </button>
                <span className="hint">
                  {isNativeApp
                    ? 'Saved automatically at 9:30 IST on trading days while the app is open (Documents/AdvDec).'
                    : exportStatus
                      ? `Saved automatically at ${exportStatus.time} IST on trading days to ${exportStatus.dir}${exportStatus.last ? ` · last: ${exportStatus.last.file.split(/[\\/]/).pop()}` : ''}.`
                      : ''}
                </span>
              </div>
            </div>
            {exportMessage && <div className={`alert ${exportMessage.type}`}>{exportMessage.text}</div>}
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
              <label className="cap-filter">
                <input
                  type="checkbox"
                  checked={tableTradeableOnly}
                  onChange={(e) => setTableTradeableOnly(e.target.checked)}
                />
                Tradeable only
              </label>
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
                      <td className="mono symbol-cell">
                        {s.symbol}
                        {renderFlags(s)}
                      </td>
                      <td className="wrap-cell company-cell">{s.company}</td>
                      <td className="wrap-cell sector-cell">{s.sector}</td>
                      <td className="num">{fmtCap(s.marketCap)}</td>
                      <td className="num">{s.prevClose ?? '—'}</td>
                      <td className="num">{s.finalPrice ?? '—'}</td>
                      <td className={`num ${s.change > 0 ? 'adv-text' : s.change < 0 ? 'dec-text' : ''}`}>
                        {s.change ?? '—'}
                      </td>
                      <td className={`num ${s.pctChange > 0 ? 'adv-text' : s.pctChange < 0 ? 'dec-text' : ''}`}>
                        {s.pctChange ?? '—'}
                      </td>
                      <td className="num">{renderConviction(s)}</td>
                      <td className="signals-cell wrap-cell">{renderSignals(s)}</td>
                      <td className="num circuit-cell">{renderCircuit(s)}</td>
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
            <p className="hint">
              Conviction (0–100) scores how strongly the pre-open supports the gap continuing. Factors in use:{' '}
              {CONVICTION_FACTORS.filter((f) => activeWeights[f.key]).map((f) => `${f.label} ${activeWeights[f.key]}`).join(' · ') || 'none'}
              {' '}(buy/sell orders count ¼ for F&amp;O stocks); adjust them in “Conviction factors” above. Gaps
              under {MIN_GAP_PCT}% are not scored. Factors without data are left out and the rest rescaled. Hover a
              score for its breakdown. It ranks setups — it does not predict the open.
            </p>
            <p className="hint">
              Signals (hover for details): <span className="sig good">Results</span> = results announced since the
              last close; <span className="sig warn">Results due</span> = board meeting for results today;{' '}
              <span className="sig high">Vol 34×</span> = pre-open quantity vs the stock's 20-day average volume,
              as a multiple of the typical stock (highlighted at {HIGH_RVOL_X}× or more);{' '}
              <span className="sig good">Above PDH</span> / <span className="sig good">Below PDL</span> = opening
              beyond yesterday's high / low (a true gap). An <span className="flag warn">Ex-date</span> flag means
              part of the gap may be a corporate-action adjustment.
              {marketContext?.history?.asOf && ` End-of-day data up to ${marketContext.history.asOf} (${marketContext.history.days} sessions).`}
              {marketContext?.events?.fetchedAt && ` Corporate events checked ${formatIST(marketContext.events.fetchedAt)}.`}
            </p>
            <p className="hint">
              Flags beside a symbol (hover for details): <span className="flag block">red</span> = likely not
              tradeable intraday — trade-to-trade series (BE/BZ, delivery only) or locked at a circuit;{' '}
              <span className="flag warn">amber</span> = caution — NSE GSM surveillance, non-EQ series, or less
              than {MIN_ROOM_PCT}% left to the circuit. ASM surveillance is not in NSE's band list, so it isn't
              flagged here. Check your broker for the final word.
            </p>
            <p className="hint">
              Circuit = base price (prev close) ± the stock's NSE price band %, rounded to the tick
              {priceBands && ` (NSE band list fetched ${formatIST(priceBands.fetchedAt)})`}. Limits apply to the session of the loaded pre-open data. F&amp;O stocks have dynamic bands, not fixed circuits.
            </p>
          </section>

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
                    <details key={mode} className={`bias-group accordion ${mode}`}>
                      <summary className={mode === 'advance' ? 'adv-text' : 'dec-text'}>
                        {label} ({list.length})
                      </summary>
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
                    </details>
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
                          if (!isOpen) stocksSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
              Click a sector row to filter the stock list above. Click a column header to sort.
            </p>
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
