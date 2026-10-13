/**
 * Minimal Kite Connect backend:
 *  - POST /api/kite/session  { apiKey, apiSecret, requestToken } -> creates Kite session
 *
 * The api_secret never ships to the browser's network calls directly against Kite;
 * this proxy performs the checksum + token exchange server-side.
 */
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPreopenService, validateSchedule } from './preopen.js';
import dotenv from 'dotenv';
import { createTvService } from './tv/service.js';
import { createPriceBandService } from './priceBands.js';

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

app.post('/api/kite/session', async (req, res) => {
  const { apiKey, apiSecret, requestToken } = req.body ?? {};
  if (!apiKey || !apiSecret || !requestToken) {
    return res.status(400).json({ error: 'apiKey, apiSecret and requestToken are required' });
  }

  const checksum = crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');

  try {
    const kiteRes = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Kite-Version': '3' },
      body: new URLSearchParams({
        api_key: apiKey,
        request_token: requestToken,
        checksum,
      }),
    });
    const data = await kiteRes.json();
    if (!kiteRes.ok) {
      return res.status(kiteRes.status).json({ error: data.message || 'Kite session failed', data });
    }
    return res.json({ session: data.data });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
});

app.post('/api/kite/positions', async (req, res) => {
  const { apiKey, accessToken } = req.body ?? {};
  if (!apiKey || !accessToken) {
    return res.status(400).json({ error: 'apiKey and accessToken are required' });
  }

  try {
    const kiteRes = await fetch('https://api.kite.trade/portfolio/positions', {
      method: 'GET',
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${accessToken}`,
      },
    });

    const payload = await kiteRes.json().catch(() => ({}));
    if (!kiteRes.ok) {
      return res.status(kiteRes.status).json({
        error: payload.message || 'Kite positions request failed',
        data: payload,
      });
    }

    return res.json({ positions: Array.isArray(payload.data) ? payload.data : [] });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
});

app.post('/api/kite/account-summary', async (req, res) => {
  const { apiKey, accessToken } = req.body ?? {};
  if (!apiKey || !accessToken) {
    return res.status(400).json({ error: 'apiKey and accessToken are required' });
  }

  try {
    const kiteRes = await fetch('https://api.kite.trade/margins/equity', {
      method: 'GET',
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${accessToken}`,
      },
    });

    const payload = await kiteRes.json().catch(() => ({}));
    if (!kiteRes.ok) {
      return res.status(kiteRes.status).json({
        error: payload.message || 'Kite account summary failed',
        data: payload,
      });
    }

    const data = payload.data?.equity ?? payload.data ?? {};
    const availableCash = Number(data.availablecash ?? data.available_cash ?? data.available ?? 0);
    const net = Number(data.net ?? data.equity ?? 0);
    const utilized = Number(data.utilizeddebits ?? data.utilized_margin ?? data.utilizeddebit ?? 0);
    const accountValue = Math.max(net + utilized, availableCash, 0);
    const intradayLeverage = availableCash > 0 ? accountValue / Math.max(availableCash, 1) : 0;

    return res.json({
      account: {
        availableCash,
        net,
        utilized,
        accountValue,
        intradayLeverage,
      },
    });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
});

app.post('/api/kite/order', async (req, res) => {
  const { apiKey, accessToken, order } = req.body ?? {};
  if (!apiKey || !accessToken || !order) {
    return res.status(400).json({ error: 'apiKey, accessToken and order are required' });
  }

  try {
    const form = new URLSearchParams({
      variety: order.variety ?? 'regular',
      exchange: order.exchange,
      tradingsymbol: order.tradingsymbol,
      transaction_type: order.transaction_type,
      quantity: String(order.quantity ?? 0),
      product: order.product ?? 'MIS',
      order_type: order.order_type ?? 'MARKET',
      validity: order.validity ?? 'DAY',
      ...(order.price !== undefined ? { price: String(order.price) } : {}),
      ...(order.trigger_price !== undefined ? { trigger_price: String(order.trigger_price) } : {}),
      ...(order.disclosed_quantity !== undefined ? { disclosed_quantity: String(order.disclosed_quantity) } : {}),
      ...(order.market_protection !== undefined ? { market_protection: String(order.market_protection) } : {}),
      ...(order.autoslice !== undefined ? { autoslice: String(!!order.autoslice) } : {}),
      ...(order.tag ? { tag: order.tag } : {}),
    });

    const kiteRes = await fetch('https://api.kite.trade/orders/regular', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Kite-Version': '3',
        Authorization: `token ${apiKey}:${accessToken}`,
      },
      body: form,
    });

    const payload = await kiteRes.json().catch(() => ({}));
    if (!kiteRes.ok) {
      return res.status(kiteRes.status).json({
        error: payload.message || 'Kite order failed',
        data: payload,
      });
    }

    return res.json({ order: payload.data ?? payload });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
});

app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));
const PORT = process.env.PORT || 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Backend listening on http://127.0.0.1:${PORT}`);
  tv.tick().catch(console.error);
});
