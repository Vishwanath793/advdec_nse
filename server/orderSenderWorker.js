import { parentPort } from 'node:worker_threads';
import { createKiteClient } from '../src/core/kite.js';
import { createOrderSender } from '../src/core/orderScheduler.js';

/**
 * Worker thread that sends scheduled orders at the exact time (see
 * server/orderSender.js). It has its own event loop, so the opening's tick flood
 * on the main thread can't delay it. It warms the connection to Kite before the
 * time and checks the clock continuously for the last few milliseconds.
 * The session arrives with each job and is kept in memory only.
 */

const kite = createKiteClient();
const sender = createOrderSender({
  placeOrder: (args) => kite.placeOrder(args),
  warm: (session) => kite.profile(session),
  spin: true,
});

parentPort.on('message', async (msg) => {
  if (msg?.type !== 'send') return;
  const result = await sender.send(msg.job).catch((error) => ({
    ok: false, message: String(error?.message ?? error), status: null, errorType: null, unknown: true, at: Date.now(), attempts: 1,
  }));
  parentPort.postMessage({ type: 'result', id: msg.id, result });
});
