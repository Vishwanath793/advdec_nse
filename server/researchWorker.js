import { parentPort, workerData } from 'node:worker_threads';
import { runBacktest } from '../src/utils/backtestRunner.js';
import { replayRecordedDay, replayReport } from '../src/utils/tickReplay.js';
import { createTickLog } from './tickLog.js';

/**
 * Research computations off the main thread (milestone 3), so the order scheduler,
 * cron jobs and SSE never wait on them. Pure calculations only: nothing here can
 * reach Kite or place an order.
 *   { kind: 'backtest', days, settings }      candle backtest (utils/backtestRunner.js)
 *   { kind: 'replay', dates, ticksDir, settings }  recorded mornings (utils/tickReplay.js)
 */
const { kind, settings } = workerData;
const progress = (stage, done, total) => parentPort.postMessage({ type: 'progress', stage, done, total });
try {
  if (kind === 'backtest') {
    const result = runBacktest(workerData.days, settings, { onProgress: (done, total) => progress('Running the strategies', done, total) });
    parentPort.postMessage({ type: 'done', result });
  } else if (kind === 'replay') {
    const log = createTickLog(workerData.ticksDir);
    const results = [];
    for (const [i, date] of workerData.dates.entries()) {
      progress('Replaying recorded mornings', i, workerData.dates.length);
      const rec = log.read(date);
      if (rec?.ticks?.length) results.push(replayRecordedDay(rec, settings));
    }
    parentPort.postMessage({ type: 'done', result: replayReport(results) });
  } else throw new Error(`Unknown research job: ${kind}`);
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
}
