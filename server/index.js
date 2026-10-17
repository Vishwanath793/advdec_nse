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
import { createRecorder } from '../src/core/recorder.js';
import { createAutoExport } from './autoExport.js';
import { createOrderScheduler } from '../src/core/orderScheduler.js';
import { indiaDate } from '../src/core/calendar.js';
import { parseCSV, rowsToObjects } from '../src/utils/csv.js';
import { fsStore } from './fsStore.js';
import { readCalendar } from './tv/calendar.js';
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
  onSnapshot: (snapshot) => recorder.record(snapshot),
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

// Yesterday's range, average volume and today's corporate events (results, ex-dates).
const marketContext = createMarketContextService({ dir: fileURLToPath(new URL('../.data', import.meta.url)) });
app.get('/api/nse/context', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // ?date=YYYY-MM-DD: context as of that trading day's morning (the loaded pre-open's day).
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  try { res.json(await marketContext.get({ force: req.query.refresh === '1', date })); }
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
    context: await marketContext.get().catch(() => null),
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
const kite = createKiteClient();

// Time-triggered orders ("BUY 10 INFY at market at 09:15:00"), sent to Kite by the
// backend at the chosen second. The Kite token is held in memory only: the
// browser hands it over whenever it has a session (PUT /api/orders/session).
const orderScheduler = createOrderScheduler({
  store: fsStore(fileURLToPath(new URL('../.data', import.meta.url))),
  calendar,
  placeOrder: (args) => kite.placeOrder(args),
});
orderScheduler.load().catch((error) => console.error(`Scheduled orders: ${error.message}`));
const orderPayload = async () => ({ orders: await orderScheduler.list(), session: orderScheduler.sessionStatus() });
app.get('/api/orders/scheduled', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await orderPayload()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/orders/scheduled', async (req, res) => {
  try {
    const { order, warnings } = await orderScheduler.add(req.body?.order);
    res.status(201).json({ order, warnings, ...(await orderPayload()) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/orders/scheduled/:id', async (req, res) => {
  try { await orderScheduler.cancel(req.params.id); res.json(await orderPayload()); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.put('/api/orders/session', (req, res) => {
  const { apiKey, accessToken, userId } = req.body ?? {};
  res.json(orderScheduler.setSession(apiKey && accessToken ? { apiKey, accessToken, userId } : null));
});
const kiteRoute = (required, run) => async (req, res) => {
  const body = req.body ?? {};
  if (required.some((k) => !body[k])) {
    return res.status(400).json({ error: `${required.join(', ')} ${required.length > 1 ? 'are' : 'is'} required` });
  }
  try { return res.json(await run(body)); }
  catch (e) {
    if (e instanceof KiteError) return res.status(e.status).json({ error: e.message, data: e.data });
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
};
app.post('/api/kite/session', kiteRoute(['apiKey', 'apiSecret', 'requestToken'], async (b) => ({ session: await kite.createSession(b) })));
app.post('/api/kite/positions', kiteRoute(['apiKey', 'accessToken'], async (b) => ({ positions: await kite.positions(b) })));
app.post('/api/kite/account-summary', kiteRoute(['apiKey', 'accessToken'], async (b) => ({ account: await kite.accountSummary(b) })));
app.post('/api/kite/order', kiteRoute(['apiKey', 'accessToken', 'order'], async (b) => ({ order: await kite.placeOrder(b) })));
// Live quotes for the 9:15–9:20 confirmation step ({ instruments: ["NSE:INFY", ...] }).
app.post('/api/kite/quote', kiteRoute(['apiKey', 'accessToken', 'instruments'], async (b) => {
  if (!Array.isArray(b.instruments)) throw new KiteError('instruments must be a list like ["NSE:INFY"].', 400);
  return { quotes: await kite.quote(b) };
}));

app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT}`);
  tv.tick().catch(console.error);
});
