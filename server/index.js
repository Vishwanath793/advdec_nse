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
import cron from 'node-cron';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const app = express();
// Larger master-list uploads parse their own body below.
app.use((req, res, next) => (req.path === '/api/master-stock' ? next() : express.json()(req, res, next)));

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

const preopen = createPreopenService({ file: fileURLToPath(new URL('../.data/nse-preopen.json', import.meta.url)) });
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
  try { res.json(await marketContext.get({ force: req.query.refresh === '1' })); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
// Warm the cache before the 09:10 pre-open fetch on weekdays.
cron.schedule('50 8 * * 1-5', () => {
  marketContext.get({ force: true }).catch((error) => console.error(`Market context: ${error.message}`));
}, { timezone: 'Asia/Kolkata', name: 'market-context' });

// Uploaded master stock list (parsed in the browser), persisted so it survives
// restarts. When absent, the UI falls back to the bundled public/master_stock.csv.
const masterFile = fileURLToPath(new URL('../.data/master-stock.json', import.meta.url));
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

app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT}`);
  tv.tick().catch(console.error);
});
