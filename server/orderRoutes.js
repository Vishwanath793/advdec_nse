/**
 * Routes that can move money (scheduled orders and the Kite proxy) only
 * accept same-origin requests: a page from another site the user happens to
 * visit must not be able to reach them on this machine. Requests without an
 * Origin header (curl, same-origin GETs) are allowed.
 */
export function sameOriginOnly(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next();
  let originHost;
  try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: 'Invalid origin.' }); }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (originHost !== host) return res.status(403).json({ error: 'Requests from other sites are not allowed.' });
  return next();
}

/** Scheduled-order routes on `app` for the shared order scheduler. */
/** `onSession(session|null)` also receives the Kite session (the opening-window collector uses it). */
export function addOrderRoutes(app, scheduler, { onSession = () => {} } = {}) {
  app.use('/api/orders', sameOriginOnly);
  const payload = async () => ({ orders: await scheduler.list(), session: scheduler.sessionStatus(), clock: scheduler.clock?.() ?? null });
  app.get('/api/orders/scheduled', async (_req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await payload()); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.post('/api/orders/scheduled', async (req, res) => {
    try {
      const { order, warnings } = await scheduler.add(req.body?.order);
      res.status(201).json({ order, warnings, ...(await payload()) });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.delete('/api/orders/scheduled/:id', async (req, res) => {
    try { await scheduler.cancel(req.params.id); res.json(await payload()); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  // Read Kite's own record (received, at the exchange, fills) of a placed order now.
  app.post('/api/orders/scheduled/:id/kite', async (req, res) => {
    try { await scheduler.refreshKite(req.params.id); res.json(await payload()); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  // The Kite session for sending, held in memory only; {} clears it.
  app.put('/api/orders/session', (req, res) => {
    const { apiKey, accessToken, userId } = req.body ?? {};
    const valid = typeof apiKey === 'string' && typeof accessToken === 'string' && apiKey && accessToken;
    const session = valid ? { apiKey, accessToken, userId } : null;
    onSession(session);
    res.json(scheduler.setSession(session));
  });
}
