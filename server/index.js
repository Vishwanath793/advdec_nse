/**
 * Minimal Kite Connect backend:
 *  - POST /api/kite/session  { apiKey, apiSecret, requestToken } -> creates Kite session
 *
 * The api_secret never ships to the browser's network calls directly against Kite;
 * this proxy performs the checksum + token exchange server-side.
 */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPreopenService, validateSchedule } from './preopen.js';
import dotenv from 'dotenv';
import { createTvService } from './tv/service.js';
import { createPriceBandService } from './priceBands.js';
import { createMarketContextService } from './marketContext.js';
import { createKiteClient, KiteError } from '../src/core/kite.js';
import { kiteRoute } from './kiteRoute.js';
import { createRecorder } from '../src/core/recorder.js';
import { createAutoExport } from './autoExport.js';
import { createOrderScheduler } from '../src/core/orderScheduler.js';
import { createThreadSender } from './orderSender.js';
import { createNetworkClock } from './networkClock.js';
import { createNseLiveService } from '../src/core/nseLive.js';
import { createOpeningCollector } from '../src/core/openingCollector.js';
import { createInstrumentService } from '../src/core/instruments.js';
import { createHistoryService } from '../src/core/kiteHistory.js';
import { createAuctionTracker } from '../src/core/auctionTracker.js';
import { snapshotDate } from '../src/core/recorder.js';
import { analyze } from '../src/utils/analysis.js';
import { createTickLog } from './tickLog.js';
import { addOpeningRoutes } from './openingRoutes.js';
import { createEventLog } from './eventLog.js';
import { addTradingRoutes } from './tradingRoutes.js';
import { cleanTradingSettings, createTradingDesk } from '../src/core/tradingDesk.js';
import { createGapLiveExits } from '../src/core/gapLiveExits.js';
import { createGapFallback } from '../src/core/gapInputs.js';
import { addOrderRoutes, sameOriginOnly } from './orderRoutes.js';
import { indiaDate, istInstant } from '../src/core/calendar.js';
import { gapEntriesFor } from '../src/utils/gapExits.js';
import { parseCSV, rowsToObjects } from '../src/utils/csv.js';
import { fsStore } from './fsStore.js';
import { readCalendar } from './tv/calendar.js';
import { createAiService } from './ai/service.js';
import { createSnapshotService } from './ai/snapshots.js';
import { addAiRoutes } from './ai/routes.js';
import cron from 'node-cron';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const app = express();
// Larger master-list uploads parse their own body below.
// 1 MB: a 9:20 confirmation reading for every gapped stock is larger than the 100 KB default.
app.use((req, res, next) => (req.path === '/api/master-stock' ? next() : express.json({ limit: '1mb' })(req, res, next)));

const tv = createTvService({ root: fileURLToPath(new URL('../.data/tv', import.meta.url)) });
app.use('/api/tv', (req, res, next) => {
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  let origin;
  try { origin = req.headers.origin ? new URL(req.headers.origin).hostname : req.hostname; }
  catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  if (!local.has(req.hostname) || !local.has(origin)) return res.status(403).json({ error: 'TV research is available on localhost only.' });
  res.set('Cache-Control', 'no-store'); next();
});
app.get('/api/tv', (_req, res) => res.json(tv.status()));
app.put('/api/tv/schedule', (req, res) => {
  try { res.json(tv.update(req.body.enabled)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/tv/run', (req, res) => {
  try {
    const pending = tv.run(req.body.date);
    pending.catch(error => console.error('TV research:', error.message));
    res.status(202).json({ accepted: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/tv/artifacts/:date/:filename', (req, res) => {
  try { res.download(tv.artifact(req.params.date, req.params.filename)); }
  catch (error) { res.status(404).json({ error: error.message }); }
});

// Each successful fetch is archived by the daily recorder (set up below).
const preopen = createPreopenService({
  file: fileURLToPath(new URL('../.data/nse-preopen.json', import.meta.url)),
  onSnapshot: async (snapshot) => {
    await recorder.record(snapshot);
    // Today's candidates are in: build the opening-window universe (09:08–09:20 only).
    openingCollector.wake().catch((error) => console.error(`Opening window: ${error.message}`));
  },
});
app.get('/api/nse/preopen', (_req, res) => {
  res.set('Cache-Control', 'no-store').json(preopen.status());
});
app.get('/api/nse/preopen/events', (_req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 10000\n\n');
  const unsubscribe = preopen.subscribe((update) => res.write(`data: ${JSON.stringify(update)}\n\n`));
  // Tiny keep-alive comments keep the single connection open; no data fetch.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
  res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});
app.put('/api/nse/schedule', (req, res) => {
  try { validateSchedule(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  try { res.json(preopen.update(req.body)); }
  catch (error) { res.status(500).json({ error: `Could not save schedule: ${error.message}` }); }
});
app.post('/api/nse/preopen/refresh', async (_req, res) => {
  try {
    await preopen.refresh();
    res.json(preopen.status());
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

const priceBands = createPriceBandService({ file: fileURLToPath(new URL('../.data/nse-price-bands.json', import.meta.url)) });
app.get('/api/nse/price-bands', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await priceBands.get({ force: req.query.refresh === '1' })); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

// Live prices from NSE's website, for the 9:15 confirmation when Kite has no market data.
const nseLive = createNseLiveService();
app.post('/api/nse/live', async (req, res) => {
  const instruments = req.body?.instruments;
  if (instruments != null && (!Array.isArray(instruments) || instruments.length > 2000 || instruments.some((i) => typeof i !== 'string'))) {
    return res.status(400).json({ error: 'instruments must be a list like ["NSE:INFY"].' });
  }
  try { res.set('Cache-Control', 'no-store').json(await nseLive.quote(instruments ?? null)); }
  catch (error) { res.status(502).json({ error: error.message }); }
});

// Yesterday's range, average volume and today's corporate events (results, ex-dates).
const marketContext = createMarketContextService({ dir: fileURLToPath(new URL('../.data', import.meta.url)) });
app.get('/api/nse/context', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // ?date=YYYY-MM-DD: context as of that trading day's morning (the loaded pre-open's day).
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  try { res.json(await withPreopenBaseline(await marketContext.get({ force: req.query.refresh === '1', date }))); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
// Warm the cache before the 09:10 pre-open fetch on weekdays.
cron.schedule('50 8 * * 1-5', () => {
  marketContext.get({ force: true }).catch((error) => console.error(`Market context: ${error.message}`));
}, { timezone: 'Asia/Kolkata', name: 'market-context' });
// Market signals at the right moments (each reading is kept by date):
//  09:07  GIFT Nifty just before the pre-open closes (09:08), used by the 09:10 fetch;
//  16:00  India VIX close for the day;
//  19:30 and 21:00  FII/DII flows, which NSE publishes in the evening.
// They are used for the next trading day's conviction, after the pre-open closes.
for (const [time, name] of [['7 9', 'gift-nifty'], ['0 16', 'vix-close'], ['30 19', 'fii-dii'], ['0 21', 'fii-dii-late']]) {
  cron.schedule(`${time} * * 1-5`, () => {
    marketContext.refreshMarket().catch((error) => console.error(`Market signals (${name}): ${error.message}`));
  }, { timezone: 'Asia/Kolkata', name: `market-${name}` });
}

// Uploaded master stock list (parsed in the browser), persisted so it survives
// restarts. When absent, the UI falls back to the bundled public/master_stock.csv.
const masterFile = fileURLToPath(new URL('../.data/master-stock.json', import.meta.url));

// Daily recorder and report card (shared with the Android app in src/core/recorder.js).
function currentMasterRows() {
  try { return JSON.parse(readFileSync(masterFile, 'utf8')).rows; }
  catch {
    const csv = readFileSync(fileURLToPath(new URL('../public/master_stock.csv', import.meta.url)), 'utf8');
    return rowsToObjects(parseCSV(csv));
  }
}
const calendar = readCalendar();
const recorder = createRecorder({
  store: fsStore(fileURLToPath(new URL('../.data', import.meta.url))),
  calendar,
  context: marketContext,
  inputs: async () => ({
    masterRows: currentMasterRows(),
    secList: await priceBands.get().catch(() => null),
    ...await marketContext.get().then((c) => ({ events: c.events, market: c.market })).catch(() => ({})),
  }),
});
/**
 * Add the recorded pre-open baseline (research columns) and that morning's Kite
 * auction readings (Auction layer) to a market context.
 */
async function withPreopenBaseline(context) {
  if (!context?.date) return context;
  return {
    ...context,
    preopen: await recorder.preopenBaseline(context.date).catch(() => null),
    auction: await auctionTracker.features(context.date).catch(() => null),
    auctionStatus: auctionTracker.status(),
  };
}
// Record the saved snapshot too, in case it was fetched before the recorder existed.
recorder.record(preopen.status().snapshot)
  .then((r) => r.recorded && console.log(`Recorded pre-open for ${r.date}`))
  .catch((error) => console.error(`Recorder: ${error.message}`));
app.get('/api/report-card/status', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await recorder.status()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
// The 9:20 confirmation reading (opening range and checks), saved by the Confirm page.
app.get('/api/confirm/:date', async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  try { res.set('Cache-Control', 'no-store').json({ reading: await recorder.confirmation(req.params.date) }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.put('/api/confirm', async (req, res) => {
  try { res.json(await recorder.saveConfirmation(req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/report-card', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await recorder.report(req.body?.factorSettings ?? null)); }
  catch (error) { res.status(500).json({ error: `Could not build the report card: ${error.message}` }); }
});
// Stocks table saved as Excel at 9:30 IST on trading days (to Downloads, or EXPORT_DIR).
const autoExport = createAutoExport({
  dataDir: fileURLToPath(new URL('../.data', import.meta.url)),
  calendar,
  inputs: async () => ({
    snapshot: preopen.status().snapshot,
    masterRows: currentMasterRows(),
    secList: await priceBands.get().catch(() => null),
    context: await marketContext.get().then(withPreopenBaseline).catch(() => null),
  }),
});
const runAutoExport = () => autoExport.run()
  .then((r) => r.saved && console.log(`Saved the Stocks table to ${r.file}`))
  .catch((error) => console.error(`Auto export: ${error.message}`));
// Every 5 minutes in market hours: writes once at 9:30, or as soon as possible after a late start.
cron.schedule('*/5 9-15 * * 1-5', runAutoExport, { timezone: 'Asia/Kolkata', name: 'auto-export' });
runAutoExport();
app.get('/api/export/status', (_req, res) => res.set('Cache-Control', 'no-store').json(autoExport.status()));
app.put('/api/export/settings', (req, res) => {
  try { res.json(autoExport.saveSettings(req.body?.factorSettings ?? null)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

// Download today's end-of-day file in the evening, so the outcome is kept even if nobody opens the report.
cron.schedule('45 18 * * 1-5', () => {
  marketContext.day(indiaDate(new Date())).catch((error) => console.error(`End-of-day file: ${error.message}`));
}, { timezone: 'Asia/Kolkata', name: 'end-of-day' });
app.get('/api/master-stock', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.type('json').send(readFileSync(masterFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'No uploaded master list.' });
    res.status(500).json({ error: `Could not read master list: ${error.message}` });
  }
});
app.put('/api/master-stock', express.json({ limit: '10mb' }), (req, res) => {
  const { name, rows } = req.body ?? {};
  if (typeof name !== 'string' || !Array.isArray(rows) || rows.length === 0
      || !rows.every((r) => r && typeof r === 'object' && typeof r.Symbol === 'string' && r.Symbol.trim())) {
    return res.status(400).json({ error: 'Provide a file name and rows that each have a Symbol.' });
  }
  const saved = { name, uploadedAt: new Date().toISOString(), rows };
  try {
    mkdirSync(dirname(masterFile), { recursive: true });
    writeFileSync(`${masterFile}.tmp`, JSON.stringify(saved));
    renameSync(`${masterFile}.tmp`, masterFile);
    res.json(saved);
  } catch (error) {
    res.status(500).json({ error: `Could not save master list: ${error.message}` });
  }
});
app.delete('/api/master-stock', (_req, res) => {
  rmSync(masterFile, { force: true });
  res.status(204).end();
});

// Kite Connect proxy (logic shared with the Android app in src/core/kite.js).
app.use('/api/kite', sameOriginOnly);
const kite = createKiteClient();

// Time-triggered orders ("BUY 10 INFY at market at 09:15:00"), sent to Kite by the
// backend at the chosen second. The Kite token is held in memory only: the
// browser hands it over whenever it has a session (PUT /api/orders/session).
// Network time, so a timed order leaves at real 09:15:00 even when this PC's clock is off (server/networkClock.js).
const networkClock = createNetworkClock().start();
const orderScheduler = createOrderScheduler({
  store: fsStore(fileURLToPath(new URL('../.data', import.meta.url))),
  calendar,
  placeOrder: (args) => kite.placeOrder(args),
  // LIVE gap exits for opted-in 09:15 orders (sent only when armed; sized at 09:14 if asked; then followed at Kite).
  gapExits: {
    status: (date) => gapLive.status(date),
    size: async (o) => {
      const p = await tradingDesk.gapPlanFor(o.symbol, o.side);
      return p?.ok ? { quantity: p.qty, reason: `${p.type} gap ${p.g} ATR, size ×${p.factor}${p.factorReasons.length ? ` (${p.factorReasons.join('; ')})` : ''}` } : null;
    },
    onPlaced: (o) => gapLive.track(o),
  },
  clockOffsetMs: () => networkClock.offsetMs(),
  clockStatus: () => networkClock.status(),
  // Sent from a worker thread at the exact time, away from the opening's tick flood.
  sender: createThreadSender(),
  // Kite's own record (received, at the exchange, fills) for each placed order.
  orderDetails: async (args) => {
    const [history, trades] = await Promise.all([kite.orderHistory(args), kite.orderTrades(args)]);
    return { history, trades };
  },
});
orderScheduler.load().catch((error) => console.error(`Scheduled orders: ${error.message}`));
// The Kite session handed over by the browser (memory only), also for one-off reads such as a gap plan's ATR.
let kiteSession = null;
addOrderRoutes(app, orderScheduler, {
  onSession: (s) => {
    kiteSession = s?.accessToken && s?.apiKey ? { apiKey: s.apiKey, accessToken: s.accessToken } : null;
    openingCollector.setSession(s); auctionTracker.setSession(s); gapLive.setSession(s);
  },
});

// Opening window 09:15–09:20 (Kite WebSocket) and the 09:20 decision with paper trading (milestone 2).
const dataDir = fileURLToPath(new URL('../.data', import.meta.url));
const readJsonFile = (name) => { try { return JSON.parse(readFileSync(`${dataDir}/${name}`, 'utf8')); } catch { return null; } };
const tickLog = createTickLog(`${dataDir}/ticks`);
const instrumentService = createInstrumentService({ store: fsStore(dataDir), kite });
const historyService = createHistoryService({ store: fsStore(dataDir), kite, calendar });
// Pre-open auction readings 09:00–09:09 (Kite /quote, read-only) for the Auction layer.
const auctionTracker = createAuctionTracker({
  store: fsStore(dataDir), kite, instruments: instrumentService, calendar,
  symbols: () => currentMasterRows().map((r) => r.Symbol),
});
const wakeAuction = () => auctionTracker.wake().catch((error) => console.error(`Auction tracker: ${error.message}`));
cron.schedule('58 8 * * 1-5', wakeAuction, { timezone: 'Asia/Kolkata', name: 'auction-tracker' });
wakeAuction();
const openingSubscribers = new Set();
let openingLatest = { status: { phase: 'idle' }, rows: [] };
// The scanner payload carries the trading view of the ledger it shows (the replay's, during a replay).
const withTrading = (payload) => ({ ...payload, trading: tradingDesk.view(payload.status?.source === 'replay' ? 'replay' : 'day'), gapLive: gapLive.view() });
const broadcastOpening = () => {
  const payload = withTrading(openingLatest);
  for (const send of openingSubscribers) { try { send(payload); } catch { openingSubscribers.delete(send); } }
};
const paperLog = createEventLog(`${dataDir}/paper`);
// 9:15 gap entries (paper): the saved list plus, when on, read-only shadows of scheduled 09:15 market orders.
const gapEntries = async (date) => gapEntriesFor(date, readJsonFile('gap915-list.json'), await orderScheduler.list().catch(() => []), {
  from: +istInstant(date, '09:15'), to: +istInstant(date, '09:16'),
});
let gapSymbols = []; // refreshed with the candidates, so the collector subscribes to them
const preopenStocks = async () => {
  const snapshot = preopen.status().snapshot;
  if (!snapshot) return null;
  const context = await marketContext.get().then(withPreopenBaseline).catch(() => null);
  const { stocks } = analyze(snapshot.rows, currentMasterRows(), await priceBands.get().catch(() => null), {
    convictionFactors: readJsonFile('export-settings.json')?.factorSettings ?? null, context,
  });
  return { stocks, snapshotDate: snapshotDate(snapshot, calendar) };
};
const tradingDesk = createTradingDesk({
  store: fsStore(dataDir), log: paperLog, calendar,
  settings: () => readJsonFile('trading-settings.json') ?? {},
  onUpdate: () => broadcastOpening(),
  gapList: gapEntries,
  // A stock outside today's opening universe: its 09:10 pre-open row, with the ATR estimated.
  // A stock outside today's opening universe (e.g. opted in after 09:10): its pre-open row, plus Kite's ATR fetched for it.
  gapFallback: createGapFallback({ preopenStocks, instruments: instrumentService, history: historyService, session: () => kiteSession }),
});
const openingCollector = createOpeningCollector({
  store: fsStore(dataDir),
  kite,
  instruments: instrumentService,
  history: historyService,
  calendar,
  tickLog,
  // The 9:15 gap-entry stocks are always watched, whatever their gap or conviction.
  settings: () => {
    const s = readJsonFile('opening-settings.json') ?? {};
    return { ...s, watchlist: [...(s.watchlist ?? []), ...gapSymbols] };
  },
  // Candidates: today's 09:10 pre-open analysed as in the browser (factors from the browser's last choice).
  getCandidates: async (date) => {
    // Paper gap entries, plus today's scheduled orders with live gap exits (their ticks drive the live exits).
    const optedIn = (await orderScheduler.list().catch(() => [])).filter((o) => o.exits === 'gap' && indiaDate(new Date(o.triggerAt)) === date && o.status !== 'cancelled');
    gapSymbols = [...new Set([...(await gapEntries(date).catch(() => [])).map((e) => e.symbol), ...optedIn.map((o) => o.symbol)])];
    return preopenStocks();
  },
  // The paper desk, plus the live gap exits (live ticks and the seal only; never a replay).
  trading: {
    onStart: (...a) => tradingDesk.onStart(...a),
    onSeal: async (sealed, o) => { const r = await tradingDesk.onSeal(sealed, o); if (!o?.replay) gapLive.onSeal(sealed); return r; },
    onTicks: (ticks, receivedAt, o) => { tradingDesk.onTicks(ticks, receivedAt, o); if (!o?.replay) gapLive.onTicks(ticks); },
    onReplayEnd: () => tradingDesk.onReplayEnd(),
    keepTokens: () => [...new Set([...tradingDesk.keepTokens(), ...gapLive.tokens()])],
  },
  onUpdate: (payload) => {
    openingLatest = payload;
    broadcastOpening();
  },
});
tradingDesk.attach({ follow: openingCollector.follow, unfollow: openingCollector.unfollow });
// LIVE gap exits: switch + today's typed confirmation in .data/gap-live.json; events in .data/live/.
const gapLive = createGapLiveExits({
  kite, log: createEventLog(`${dataDir}/live`), instruments: instrumentService,
  settings: () => {
    const t = cleanTradingSettings(readJsonFile('trading-settings.json') ?? {});
    return { ...(readJsonFile('gap-live.json') ?? {}), gapExits: t.gapExits, risk: t.risk };
  },
  planFor: (symbol, side) => tradingDesk.gapPlanFor(symbol, side),
  onUpdate: () => broadcastOpening(),
  follow: (tokens) => openingCollector.follow(tokens),
});
addOpeningRoutes(app, openingCollector, {
  tickLog,
  getLatest: () => withTrading(openingLatest),
  subscribe: (send) => { openingSubscribers.add(send); return () => openingSubscribers.delete(send); },
});
app.put('/api/opening/settings', (req, res) => {
  const minGapPct = Number(req.body?.minGapPct);
  const watchlist = Array.isArray(req.body?.watchlist) ? req.body.watchlist.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z0-9&_-]{1,25}$/.test(x)).slice(0, 200) : [];
  const saved = { minGapPct: Number.isFinite(minGapPct) && minGapPct >= 0 && minGapPct <= 20 ? minGapPct : 0.5, watchlist };
  writeFileSync(`${dataDir}/opening-settings.json`, JSON.stringify(saved, null, 2));
  res.json(saved);
});
// Each trading morning: arm the day (and again just before connecting, in case the import was late).
addTradingRoutes(app, tradingDesk, {
  settingsFile: `${dataDir}/trading-settings.json`, log: paperLog, gapListFile: `${dataDir}/gap915-list.json`, paperDir: `${dataDir}/paper`,
  live: gapLive, liveFile: `${dataDir}/gap-live.json`, calendar,
});
const wakeOpening = () => openingCollector.wake()
  .then(() => tradingDesk.wake({ sealedFor: openingCollector.sealedFor }))
  .catch((error) => console.error(`Opening window: ${error.message}`));
for (const time of ['0 9', '12 9']) {
  cron.schedule(`${time} * * 1-5`, wakeOpening, { timezone: 'Asia/Kolkata', name: `opening-${time}` });
}
wakeOpening();
app.post('/api/kite/session', kiteRoute(['apiKey', 'apiSecret', 'requestToken'], async (b) => ({ session: await kite.createSession(b) })));
app.post('/api/kite/positions', kiteRoute(['apiKey', 'accessToken'], async (b) => ({ positions: await kite.positions(b) })));
app.post('/api/kite/account-summary', kiteRoute(['apiKey', 'accessToken'], async (b) => ({ account: await kite.accountSummary(b) })));
app.post('/api/kite/order', kiteRoute(['apiKey', 'accessToken', 'order'], async (b) => ({ order: await kite.placeOrder(b) })));
// Live quotes for the 9:15–9:20 confirmation step ({ instruments: ["NSE:INFY", ...] }).
app.post('/api/kite/quote', kiteRoute(['apiKey', 'accessToken', 'instruments'], async (b) => {
  if (!Array.isArray(b.instruments)) throw new KiteError('instruments must be a list like ["NSE:INFY"].', 400);
  return { quotes: await kite.quote(b) };
}));

// AI Analyst (read-only research; server/ai). Runs without AI credentials ("AI not configured").
const aiService = createAiService({
  store: fsStore(dataDir),
  dataDir,
  repoRoot: fileURLToPath(new URL('..', import.meta.url)),
  calendar,
  snapshots: createSnapshotService({
    preopen, recorder, marketContext, priceBands, calendar, store: fsStore(dataDir),
    contextFor: (date) => marketContext.get({ date }).then(withPreopenBaseline),
    masterRows: currentMasterRows,
  }),
});
addAiRoutes(app, aiService);
// Keep the document index current (free keyword index; embeddings only with the mock or when asked).
// It runs in a worker thread and never in the pre-open or opening window.
const indexAi = () => aiService.startIndexing({ embed: process.env.AI_PROVIDER === 'mock' || process.env.AI_AUTO_EMBED === '1' })
  .catch((error) => console.log(`AI index: ${error.message}`));
setTimeout(indexAi, 30_000).unref();
cron.schedule('45 19 * * *', indexAi, { timezone: 'Asia/Kolkata', name: 'ai-index' });

app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
// Kite's login redirect (the redirect URL shown in Settings): serve the app, which exchanges the request token.
app.get('/kite/callback', (_req, res) => res.sendFile(fileURLToPath(new URL('../dist/index.html', import.meta.url))));
// Errors (e.g. malformed JSON) as JSON, without stack traces.
app.use((error, _req, res, _next) => {
  const raw = error.status ?? error.statusCode ?? 500;
  const status = raw >= 400 && raw < 600 ? raw : 500;
  res.status(status).json({ error: status === 400 ? 'The request body is not valid JSON.' : error.message });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT}`);
  tv.tick().catch(console.error);
});
