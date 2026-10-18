import { writeFileSync } from 'node:fs';
import { sameOriginOnly } from './orderRoutes.js';
import { cleanTradingSettings } from '../src/core/tradingDesk.js';

/**
 * 09:20 trading routes (milestone 2: PAPER only; same-origin requests only).
 *   GET  /api/trading/state?ledger=day|replay      mode, ledger, decisions, settings, blockers
 *   GET  /api/trading/decision/:symbol?ledger=     the full decision for one stock
 *   PUT  /api/trading/settings                      risk, strategy and scoring settings
 *   POST /api/trading/kill        { on, ledger }    kill switch (on: cancel entries, close positions)
 *   POST /api/trading/close-all   { ledger }        square off every paper position now
 *   GET  /api/trading/log/:date                     the day's append-only event log (NDJSON)
 */
export function addTradingRoutes(app, desk, { settingsFile, log }) {
  app.use('/api/trading', sameOriginOnly);
  const ledgerOf = (req) => ((req.query.ledger ?? req.body?.ledger) === 'replay' ? 'replay' : 'day');
  app.get('/api/trading/state', (req, res) => res.set('Cache-Control', 'no-store').json(desk.view(ledgerOf(req))));
  app.get('/api/trading/decision/:symbol', (req, res) => {
    const d = desk.decisionDetail(String(req.params.symbol).toUpperCase(), ledgerOf(req));
    if (!d) return res.status(404).json({ error: 'No 09:20 decision for that stock yet.' });
    res.set('Cache-Control', 'no-store').json(d);
  });
  app.put('/api/trading/settings', (req, res) => {
    if (req.body?.mode === 'LIVE') {
      return res.status(409).json({ error: 'LIVE trading is not available: it is milestone 4, built only after paper trading has run for a meaningful period and you ask for it.' });
    }
    const saved = cleanTradingSettings(req.body ?? {});
    writeFileSync(settingsFile, JSON.stringify(saved, null, 2));
    res.json(saved);
  });
  app.post('/api/trading/kill', (req, res) => res.json(desk.kill(Boolean(req.body?.on), ledgerOf(req))));
  app.post('/api/trading/close-all', (req, res) => res.json(desk.closeAll(ledgerOf(req))));
  app.get('/api/trading/log/:date', (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
    const text = log.text(req.params.date);
    if (text == null) return res.status(404).json({ error: `No paper-trading log for ${req.params.date}.` });
    res.set({ 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="paper-${req.params.date}.ndjson"` }).send(text);
  });
}
