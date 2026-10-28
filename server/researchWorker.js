import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest } from '../src/utils/backtestRunner.js';
import { replayRecordedDay, replayReport, SEAL_GRACE_MS } from '../src/utils/tickReplay.js';
import { createOpeningWindow } from '../src/utils/openingWindow.js';
import { createTickLog } from './tickLog.js';

/**
 * Research computations off the main thread (milestone 3), so the order scheduler,
 * cron jobs and SSE never wait on them. Pure calculations only: nothing here can
 * reach Kite or place an order.
 *   { kind: 'backtest', days, settings }      candle backtest (utils/backtestRunner.js)
 *   { kind: 'replay', dates, ticksDir, settings }  recorded mornings (utils/tickReplay.js)
 *   { kind: 'reconcileTicks', dates, ticksDir }     each recorded morning's per-minute tick volumes (strategy D §5.2)
 */
const { kind, settings } = workerData;
const progress = (stage, done, total) => parentPort.postMessage({ type: 'progress', stage, done, total });
try {
  if (kind === 'backtest') {
    const result = runBacktest(workerData.days, settings, { onProgress: (done, total) => progress('Running the strategies', done, total) });
    parentPort.postMessage({ type: 'done', result });
  } else if (kind === 'reconcileTicks') {
    const log = createTickLog(workerData.ticksDir);
    const days = [];
    for (const [i, date] of workerData.dates.entries()) {
      progress('Rebuilding recorded mornings', i, workerData.dates.length);
      const rec = log.read(date);
      if (!rec?.ticks?.length) continue;
      const w = createOpeningWindow({ date, instruments: rec.meta });
      for (const { tick, receivedAt } of [...rec.ticks].sort((a, b) => a.receivedAt - b.receivedAt)) w.ingest(tick, receivedAt);
      const sealed = w.seal(w.sealAt + SEAL_GRACE_MS);
      days.push({
        date,
        stocks: sealed.stocks.filter((s) => s.minuteVolume).map((s) => ({
          symbol: s.symbol, token: s.token, minuteVolume: s.minuteVolume, minuteVolumeLow: s.minuteVolumeLow ?? s.minuteVolume, volumeBaseline: s.quality?.volumeBaseline ?? null,
        })),
      });
    }
    parentPort.postMessage({ type: 'done', result: { days } });
  } else if (kind === 'replay') {
    const log = createTickLog(workerData.ticksDir);
    const results = [];
    for (const [i, date] of workerData.dates.entries()) {
      progress('Replaying recorded mornings', i, workerData.dates.length);
      const rec = log.read(date);
      const provisional = { ...settings, strategies: { ...settings.strategies, breakHold: { ...settings.strategies?.breakHold, volumeMatched: true } } };
      if (rec?.ticks?.length) results.push(replayRecordedDay(rec, provisional));
    }
    parentPort.postMessage({ type: 'done', result: replayReport(results) });
  } else throw new Error(`Unknown research job: ${kind}`);
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
}
