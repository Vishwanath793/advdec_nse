import { sameOriginOnly } from './orderRoutes.js';
import { simulatedMorning } from '../src/utils/simulatedMorning.js';

/**
 * Opening-window routes (milestone 1: read-only).
 *   GET  /api/opening/status          latest scanner payload
 *   GET  /api/opening/events          server-sent events: the payload on connect, then each update (≤ 1/s)
 *   GET  /api/opening/stock/:symbol   full features for one stock (candles, depth, F&O)
 *   GET  /api/opening/sealed/:date    the sealed window saved for a date
 *   POST /api/opening/prepare         build today's universe now (after the 09:10 import)
 *   POST /api/opening/replay          { source: 'simulated' | 'recorded', date?, speed? }
 */
export function addOpeningRoutes(app, collector, { tickLog, getLatest, subscribe }) {
  app.use('/api/opening', sameOriginOnly);
  app.get('/api/opening/status', (_req, res) => res.set('Cache-Control', 'no-store').json(getLatest()));
  app.get('/api/opening/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send(getLatest());
    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });
  app.get('/api/opening/stock/:symbol', (req, res) => {
    const detail = collector.stockDetail(String(req.params.symbol).toUpperCase());
    if (!detail) return res.status(404).json({ error: 'No opening-window data for that stock.' });
    res.set('Cache-Control', 'no-store').json(detail);
  });
  app.get('/api/opening/sealed/:date', async (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
    res.json({ sealed: await collector.sealedFor(req.params.date) });
  });
  app.post('/api/opening/prepare', async (_req, res) => {
    try { res.json(await collector.prepare({ force: true })); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  // Read-only Kite setup check (instruments, historical, quote, WebSocket) for the pre-market routine.
  app.post('/api/opening/selftest', async (_req, res) => {
    try { res.json(await collector.selfTest()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.post('/api/opening/replay', (req, res) => {
    const { source = 'simulated', date, speed = 20 } = req.body ?? {};
    const s = Math.min(200, Math.max(1, Number(speed) || 20));
    if (source === 'recorded') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
      const rec = tickLog.read(date);
      if (!rec) return res.status(404).json({ error: `No recorded ticks for ${date}.` });
      return res.json(collector.replay({ date, instruments: rec.meta, candidates: [], ticks: rec.ticks }, { speed: s }));
    }
    res.json(collector.replay(simulatedMorning(), { speed: s }));
  });
}
