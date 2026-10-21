import { Worker } from 'node:worker_threads';

/**
 * The backend's order sender: forwards each job to a worker thread
 * (server/orderSenderWorker.js) that sends it to Kite at the exact time, and
 * resolves with the worker's result. Same interface as createOrderSender
 * (src/core/orderScheduler.js): `send({ order, session, due, grace })`.
 *
 * If the worker dies with orders in flight, those orders may or may not have
 * reached Kite, so they resolve as failed with "check the order book" and are
 * never resent. The next order starts a new worker.
 */

export const SENDER_STOPPED_MESSAGE = 'The order sender stopped while sending this order: it may or may not have reached Kite. Check your Kite order book before placing it again.';

export function createThreadSender({ workerUrl = new URL('./orderSenderWorker.js', import.meta.url), WorkerImpl = Worker } = {}) {
  let worker = null;
  let nextId = 1;
  const pending = new Map(); // id -> resolve

  function failPending() {
    for (const resolve of pending.values()) {
      resolve({ ok: false, message: SENDER_STOPPED_MESSAGE, status: null, errorType: null, unknown: true, at: Date.now(), attempts: 1 });
    }
    pending.clear();
  }

  function start() {
    const w = new WorkerImpl(workerUrl);
    w.on('message', (msg) => {
      if (msg?.type !== 'result') return;
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
      if (!pending.size) w.unref?.(); // idle: don't hold the process open
    });
    const down = () => { if (worker === w) { worker = null; failPending(); } };
    w.on('error', (error) => { console.error(`Order sender: ${error.message}`); down(); });
    w.on('exit', down);
    return w;
  }

  return {
    send(job) {
      worker ??= start();
      worker.ref?.(); // an order is in flight
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ type: 'send', id, job });
      });
    },
    async close() {
      const w = worker;
      worker = null;
      if (w) await w.terminate();
      failPending();
    },
  };
}
