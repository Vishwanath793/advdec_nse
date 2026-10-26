import express from 'express';
import { sameOriginOnly } from '../orderRoutes.js';
import { redactSecrets } from './errors.js';

/**
 * /api/ai routes (same-origin only, never cached). Read-only research: none of
 * them touches orders, positions, the scheduler or any setting outside .data/ai.
 *   GET    /api/ai/status            configuration (no key), index, usage, quiet windows
 *   GET    /api/ai/snapshots         snapshots that can be asked about
 *   POST   /api/ai/ask               one question (cancelled when the browser disconnects)
 *   GET    /api/ai/source/:chunkId   one indexed document chunk, by id only
 *   POST   /api/ai/index             { embed } update the document index (worker thread)
 *   POST   /api/ai/index/cancel
 *   DELETE /api/ai/index/doc/:docId  drop one document from the index
 */
const CHUNK_ID = /^[a-z]+:[A-Za-z0-9._/:@&_-]{1,160}(#[a-z0-9-]{1,60}\.\d{1,4}(~\d{1,3})?)?$/;

export function addAiRoutes(app, service) {
  const router = express.Router();
  router.use(sameOriginOnly);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const send = (res, error) => {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: redactSecrets(error?.message ?? 'AI Analyst error.'), code: error?.code ?? 'error' });
  };
  const route = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (error) {
      if (!res.headersSent && !res.writableEnded) send(res, error);
    }
  };

  router.get('/status', route(() => service.status()));
  router.get('/snapshots', route(async () => ({ snapshots: await service.snapshots() })));
  router.post('/ask', express.json({ limit: '256kb' }), route(async (req, res) => {
    const controller = new AbortController();
    // The browser's Cancel (or closing the tab) aborts the provider call.
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    return service.ask(req.body, { signal: controller.signal });
  }));
  router.get('/source/:chunkId', route((req) => {
    const id = String(req.params.chunkId);
    if (!CHUNK_ID.test(id) || id.includes('..')) throw Object.assign(new Error('Invalid source id.'), { status: 400, code: 'invalid' });
    return service.source(id);
  }));
  router.post('/index', route((req) => service.startIndexing({ embed: req.body?.embed === true })));
  router.post('/index/cancel', route(() => service.cancelIndexing()));
  router.delete('/index/doc/:docId', route((req) => {
    const id = String(req.params.docId);
    if (!/^[a-z]+:[A-Za-z0-9._/:_-]{1,160}$/.test(id) || id.includes('..')) throw Object.assign(new Error('Invalid document id.'), { status: 400, code: 'invalid' });
    return service.removeDoc(id);
  }));
  app.use('/api/ai', router);
}
