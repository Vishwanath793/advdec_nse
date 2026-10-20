import { KiteError } from '../src/core/kite.js';

/** HTTP status for a failed Kite call: Kite's own 4xx/5xx, else 502 (no usable response). */
export const kiteHttpStatus = (error) => (error?.status >= 400 && error?.status < 600 ? error.status : 502);

/**
 * An Express handler for a Kite call proxied from the browser: checks the required
 * body fields, runs the call, and maps errors to JSON (`unknown: true` when the
 * request may or may not have reached Kite).
 */
export const kiteRoute = (required, run) => async (req, res) => {
  const body = req.body ?? {};
  if (required.some((k) => !body[k])) {
    return res.status(400).json({ error: `${required.join(', ')} ${required.length > 1 ? 'are' : 'is'} required` });
  }
  try { return res.json(await run(body)); }
  catch (e) {
    if (e instanceof KiteError) return res.status(kiteHttpStatus(e)).json({ error: e.message, data: e.data, ...(e.unknown ? { unknown: true } : {}) });
    return res.status(502).json({ error: `Could not reach Kite: ${e.message}` });
  }
};
