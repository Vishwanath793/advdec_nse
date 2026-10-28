import { readdirSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { indiaDate, marketDay } from '../src/core/calendar.js';
import { DEFAULT_MAX_PER_DAY, MAX_DAYS, MIN_GAP_PCT } from '../src/core/backtestData.js';
import { cleanTradingSettings } from '../src/core/tradingDesk.js';
import { exportFileName } from '../src/utils/exportStocks.js';
import { researchWorkbook } from '../src/utils/researchExport.js';
import { reconcileDay, reconcileSummary } from '../src/utils/volumeReconcile.js';
import { sameOriginOnly } from './orderRoutes.js';

/**
 * Research (milestone 3, part 2), same-origin only. One job at a time, in the background:
 *   POST /api/research/backtest  { from, to, maxPerDay?, minGapPct?, settings? }  candle backtest
 *   POST /api/research/replay    { dates?, settings? }                            recorded mornings
 *   POST /api/research/reconcile                  strategy D's volume check: recorded tick volumes vs Kite's minute bars
 *   POST /api/research/cancel
 *   GET  /api/research/status                     the job, the last results' headlines, recorded days
 *   GET  /api/research/result/:kind               the last full result (backtest | replay)
 *   GET  /api/research/export/:kind.xlsx          that result in Excel
 * Read-only: Kite historical candles and NSE end-of-day files only; nothing can place an order.
 * Jobs don't start 08:55–09:35 IST on trading days, so the opening window has the backend to itself.
 * `settings` (optional) overrides the saved trading settings for this run only; it is never saved.
 */
export const QUIET = { from: '08:55', to: '09:35' };
const KINDS = ['backtest', 'replay', 'reconcile'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const istTime = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

export function inResearchQuiet(now, calendar) {
  const t = istTime(now);
  return t >= QUIET.from && t < QUIET.to && marketDay(indiaDate(now), calendar).open;
}

export function addResearchRoutes(app, {
  store, data, calendar, session, tradingSettings, ticksDir, now = () => new Date(),
  workerUrl = new URL('./researchWorker.js', import.meta.url),
}) {
  app.use('/api/research', sameOriginOnly);
  let job = null; // { kind, state, stage, done, total, startedAt, finishedAt, error, abort, worker }

  const view = () => (job ? { kind: job.kind, state: job.state, stage: job.stage ?? null, done: job.done ?? 0, total: job.total ?? 0, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, error: job.error ?? null } : null);
  const recordedTickDays = () => {
    try { return readdirSync(ticksDir).map((f) => /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/.exec(f)?.[1]).filter(Boolean).sort(); }
    catch { return []; }
  };
  const settingsFor = (override) => {
    const s = cleanTradingSettings(override && typeof override === 'object' ? override : tradingSettings());
    return { risk: s.risk, strategies: s.strategies, scoring: s.scoring };
  };
  const headline = (r) => (r ? {
    ranAt: r.ranAt, first: r.first ?? r.days?.[0]?.date ?? null, last: r.last ?? r.days?.at(-1)?.date ?? null,
    ...(r.verdict ? { verdict: r.verdict } : {}),
  } : null);

  function compute(kind, payload, meta) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { workerData: { kind, ...payload } });
      job.worker = worker;
      worker.on('message', (m) => {
        if (m.type === 'progress') Object.assign(job, { stage: m.stage, done: m.done, total: m.total });
        else if (m.type === 'done') resolve({ ...m.result, ...meta });
        else if (m.type === 'error') reject(new Error(m.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code !== 0) reject(new Error(job.abort.signal.aborted ? 'Cancelled.' : `The research worker stopped (exit ${code}).`)); });
    });
  }

  function start(kind, run) {
    if (job?.state === 'running') { const e = new Error('A research job is already running. Wait for it or cancel it.'); e.status = 409; throw e; }
    if (inResearchQuiet(now(), calendar)) { const e = new Error(`Research waits until after ${QUIET.to} IST on trading days, so the opening window has the backend to itself.`); e.status = 503; throw e; }
    job = { kind, state: 'running', stage: 'Starting', done: 0, total: 0, startedAt: now().toISOString(), abort: new AbortController() };
    const current = job;
    run(current)
      .then(async (result) => {
        await store.write(`research/${kind}-last.json`, result);
        Object.assign(current, { state: 'done', finishedAt: now().toISOString() });
      })
      .catch((error) => Object.assign(current, { state: current.abort.signal.aborted ? 'cancelled' : 'failed', error: error.message, finishedAt: now().toISOString() }))
      .finally(() => { current.worker?.terminate(); current.worker = null; });
    return view();
  }

  const send = (res, fn) => {
    try { res.json(fn()); } catch (error) { res.status(error.status ?? 400).json({ error: error.message }); }
  };

  app.get('/api/research/status', async (_req, res) => {
    const [backtest, replay, reconcile] = await Promise.all(KINDS.map((k) => store.read(`research/${k}-last.json`)));
    res.set('Cache-Control', 'no-store').json({
      job: view(), last: { backtest: headline(backtest), replay: headline(replay), reconcile: headline(reconcile) },
      recordedTickDays: recordedTickDays(), quietNow: inResearchQuiet(now(), calendar), quiet: QUIET,
      limits: { maxDays: MAX_DAYS, maxPerDay: DEFAULT_MAX_PER_DAY, minGapPct: MIN_GAP_PCT }, kiteConnected: Boolean(session()?.accessToken),
    });
  });

  app.post('/api/research/backtest', (req, res) => send(res, () => {
    const { from, to } = req.body ?? {};
    if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '') || from > to) throw new Error('Choose a period: from and to dates (from first).');
    const sess = session();
    if (!sess?.accessToken) { const e = new Error('Connect to Kite first: the backtest downloads Kite historical candles.'); e.status = 409; throw e; }
    const maxPerDay = Math.min(50, Math.max(1, Math.round(Number(req.body.maxPerDay) || DEFAULT_MAX_PER_DAY)));
    const minGapPct = Math.min(20, Math.max(0, Number(req.body.minGapPct ?? MIN_GAP_PCT) || 0));
    const settings = settingsFor(req.body.settings);
    return start('backtest', async (j) => {
      const loaded = await data.loadDays({
        from, to, maxPerDay, minGapPct, session: sess, signal: j.abort.signal,
        onProgress: ({ stage, done, total }) => Object.assign(j, { stage, done, total }),
      });
      if (j.abort.signal.aborted) throw new Error('Cancelled.');
      if (!loaded.days.length) throw new Error(`No stock-days to test in ${from} – ${to} (no gaps of ${minGapPct}% or more with candles).`);
      return compute('backtest', { days: loaded.days, settings }, {
        ranAt: now().toISOString(), period: { from, to }, maxPerDay, minGapPct, requests: loaded.requests, skipped: loaded.skipped, settings,
      });
    });
  }));

  app.post('/api/research/replay', (req, res) => send(res, () => {
    const available = recordedTickDays();
    const asked = Array.isArray(req.body?.dates) ? req.body.dates.filter((d) => DATE_RE.test(d)) : null;
    const dates = asked?.length ? available.filter((d) => asked.includes(d)) : available;
    if (!dates.length) throw new Error('No recorded mornings yet: the collector records them on trading days from 09:15 to 09:25.');
    const settings = settingsFor(req.body?.settings);
    return start('replay', () => compute('replay', { dates, ticksDir, settings }, { ranAt: now().toISOString(), settings }));
  }));

  app.post('/api/research/reconcile', (req, res) => send(res, () => {
    const dates = recordedTickDays();
    if (!dates.length) throw new Error('No recorded mornings yet: the collector records them on trading days.');
    const sess = session();
    if (!sess?.accessToken) { const e = new Error('Connect to Kite first: the check downloads Kite\'s minute bars for the recorded mornings.'); e.status = 409; throw e; }
    return start('reconcile', async (j) => {
      const { days } = await compute('reconcileTicks', { dates, ticksDir }, {});
      const rows = [];
      let n = 0;
      const total = days.reduce((s, d) => s + d.stocks.length, 0);
      for (const d of days) {
        const candles = {};
        for (const s of d.stocks) {
          if (j.abort.signal.aborted) throw new Error('Cancelled.');
          Object.assign(j, { stage: 'Kite 1-minute bars for the recorded stocks', done: n++, total });
          candles[s.symbol] = (await data.minuteCandles(s.symbol, s.token, [d.date], sess))[d.date] ?? [];
        }
        rows.push(...reconcileDay(d.date, d.stocks, candles));
      }
      return { ranAt: now().toISOString(), dates: days.map((d) => d.date), ...reconcileSummary(rows), rows };
    });
  }));

  app.post('/api/research/cancel', (_req, res) => {
    if (job?.state === 'running') { job.abort.abort(); job.worker?.terminate(); }
    res.json({ job: view() });
  });

  app.get('/api/research/result/:kind', async (req, res) => {
    if (!KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'Unknown result.' });
    const r = await store.read(`research/${req.params.kind}-last.json`);
    if (!r) return res.status(404).json({ error: 'No result yet.' });
    res.set('Cache-Control', 'no-store').json(r);
  });

  app.get('/api/research/export/:file', async (req, res) => {
    const kind = /^(backtest|replay|reconcile)\.xlsx$/.exec(req.params.file)?.[1];
    if (!kind) return res.status(404).json({ error: 'Unknown export.' });
    const r = await store.read(`research/${kind}-last.json`);
    if (!r) return res.status(404).json({ error: 'No result yet.' });
    const bytes = researchWorkbook(kind, r);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportFileName(new Date(r.ranAt), { replay: 'Replay', reconcile: 'VolumeCheck' }[kind] ?? 'Backtest')}"`,
    }).send(Buffer.from(bytes));
  });

  return { view, close: () => job?.worker?.terminate() };
}
