import { parentPort } from 'node:worker_threads';
import { createOrderSender } from '../../src/core/orderScheduler.js';

// Test stand-in for server/orderSenderWorker.js: the same sender, with a fake Kite
// (no network). Symbol CRASH makes the worker exit mid-send; SLOW never answers.
const sender = createOrderSender({
  placeOrder: async ({ order }) => {
    if (order.tradingsymbol === 'CRASH') process.exit(1);
    if (order.tradingsymbol === 'SLOW') await new Promise(() => {});
    return { order_id: `fake-${order.tradingsymbol}` };
  },
  spin: true,
});
parentPort.on('message', async (msg) => {
  if (msg?.type !== 'send') return;
  parentPort.postMessage({ type: 'result', id: msg.id, result: await sender.send(msg.job) });
});
