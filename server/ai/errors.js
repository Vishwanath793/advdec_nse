/**
 * Errors the AI Analyst reports to the browser. `code` is stable for the UI;
 * `status` is the HTTP status. Messages never include keys or tokens.
 */
export class AiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export const STATUS = {
  invalid: 400,
  not_configured: 503,
  quiet: 503,
  busy: 429,
  budget: 429,
  rate_limited: 429,
  timeout: 504,
  cancelled: 499,
  provider: 502,
  auth: 502,
  snapshot: 409,
  stale: 409,
  unavailable: 503,
};

export const aiError = (code, message) => new AiError(code, message, STATUS[code] ?? 400);

/** Keys and tokens that must never reach the browser, a log or the index. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted key]')
    .replace(/\b(api[_-]?key|api[_-]?secret|access[_-]?token|request[_-]?token|authorization|password)\b(["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;]{6,}/gi, '$1$2[redacted]')
    .replace(/\btoken\s+[A-Za-z0-9]{6,}:[A-Za-z0-9]{12,}/gi, 'token [redacted]');
}
