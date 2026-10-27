import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sameOriginOnly } from './orderRoutes.js';
import { indiaDate, marketDay } from '../src/core/calendar.js';
import { liveConfirmText } from '../src/utils/liveOrders.js';
import { cleanTradingSettings } from '../src/core/tradingDesk.js';
import { buildXlsx } from '../src/utils/exportStocks.js';
import { cleanGapList, gapReportCsv, gapReportSheets, gapSummary, gapTradeRows } from '../src/utils/gapExits.js';

/**
 * 09:20 trading routes (milestone 2: PAPER only; same-origin requests only).
 *   GET  /api/trading/state?ledger=day|replay      mode, ledger, decisions, settings, blockers, gap entries
 *   GET  /api/trading/decision/:symbol?ledger=     the full decision for one stock
 *   PUT  /api/trading/settings                      risk, strategy, scoring and gap-entry settings
 *   POST /api/trading/kill        { on, ledger }    kill switch (on: cancel entries, close positions)
 *   POST /api/trading/close-all   { ledger }        square off every paper position now
 *   GET  /api/trading/log/:date                     the day's append-only event log (NDJSON)
 * LIVE gap exits (phase 2; only for scheduled 09:15 orders that opted in):
 *   GET  /api/trading/live                          switch, armed today, positions, mismatches
 *   PUT  /api/trading/live         { enabled }      the Settings switch (turning it off also disarms)
 *   POST /api/trading/live/arm     { confirm }      today's typed confirmation ("LIVE YYYY-MM-DD")
 *   POST /api/trading/live/disarm                   stop managing today (orders already at Kite stay)
 *   POST /api/trading/live/kill                     exit every live gap position now
 * 9:15 gap entries (paper):
 *   GET/PUT /api/trading/gap-list                   { list: [{ symbol, side }], shadowScheduled }
 *   GET  /api/trading/gap-plan/:symbol?side=        the gap plan for one stock now
 *   GET  /api/trading/gap-report[?format=xlsx|csv]      closed gap entries from every saved day, by gap type
 */
export function addTradingRoutes(app, desk, { settingsFile, log, gapListFile = null, paperDir = null, live = null, liveFile = null, calendar = null }) {
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

  if (live && liveFile) addLiveRoutes(app, live, { liveFile, calendar });
  if (!gapListFile) return;
  const readGapList = () => { try { return cleanGapList(JSON.parse(readFileSync(gapListFile, 'utf8'))); } catch { return cleanGapList({}); } };
  app.get('/api/trading/gap-list', (req, res) => res.set('Cache-Control', 'no-store').json(readGapList()));
  app.put('/api/trading/gap-list', (req, res) => {
    const saved = cleanGapList(req.body ?? {});
    writeFileSync(gapListFile, JSON.stringify(saved, null, 2));
    res.json(saved);
  });
  app.get('/api/trading/gap-plan/:symbol', async (req, res) => {
    const symbol = String(req.params.symbol).trim().toUpperCase();
    if (!/^[A-Z0-9&_-]{1,25}$/.test(symbol)) return res.status(400).json({ error: 'Enter a valid NSE symbol.' });
    const plan = await desk.gapPlanFor(symbol, String(req.query.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY');
    if (!plan) return res.status(404).json({ error: 'No gap plan yet: it needs today\'s 09:10 pre-open data for this stock.' });
    res.set('Cache-Control', 'no-store').json(plan);
  });
  app.get('/api/trading/gap-report', (req, res) => {
    let ledgers = [];
    try {
      ledgers = readdirSync(paperDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
        .map((f) => { try { return JSON.parse(readFileSync(`${paperDir}/${f}`, 'utf8')); } catch { return null; } }).filter(Boolean);
    } catch { /* no paper days yet */ }
    const rows = gapTradeRows(ledgers);
    const summary = gapSummary(rows);
    if (req.query.format === 'csv') {
      return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gap-entries.csv"' }).send(`\uFEFF${gapReportCsv(rows)}`);
    }
    if (req.query.format === 'xlsx') {
      const bytes = buildXlsx(gapReportSheets(rows, summary));
      return res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="gap-entries.xlsx"' }).send(Buffer.from(bytes));
    }
    res.set('Cache-Control', 'no-store').json({ rows, summary });
  });
}

/** The LIVE gap-exit switch and the daily typed confirmation (.data/gap-live.json: { enabled, armedFor }). */
function addLiveRoutes(app, live, { liveFile, calendar }) {
  const read = () => { try { return JSON.parse(readFileSync(liveFile, 'utf8')); } catch { return {}; } };
  const write = (v) => writeFileSync(liveFile, JSON.stringify(v, null, 2));
  const today = () => indiaDate(new Date());
  app.get('/api/trading/live', (req, res) => res.set('Cache-Control', 'no-store').json(live.view()));
  app.put('/api/trading/live', (req, res) => {
    const enabled = req.body?.enabled === true;
    write({ ...read(), enabled, ...(enabled ? {} : { armedFor: null }) });
    res.json(live.view());
  });
  app.post('/api/trading/live/arm', (req, res) => {
    const s = read();
    const date = today();
    if (!s.enabled) return res.status(409).json({ error: 'Turn on live gap exits first.' });
    if (calendar && !marketDay(date, calendar).open) return res.status(409).json({ error: `${date} is not a trading day.` });
    if (String(req.body?.confirm ?? '').trim() !== liveConfirmText(date)) return res.status(400).json({ error: `Type exactly: ${liveConfirmText(date)}` });
    write({ ...s, armedFor: date, armedAt: new Date().toISOString() });
    res.json(live.view());
  });
  app.post('/api/trading/live/disarm', (req, res) => { write({ ...read(), armedFor: null }); res.json(live.view()); });
  app.post('/api/trading/live/kill', async (req, res) => {
    try { res.json(await live.kill()); } catch (error) { res.status(500).json({ error: error.message }); }
  });
}
