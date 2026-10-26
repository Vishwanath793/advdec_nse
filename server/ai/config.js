/**
 * AI Analyst configuration, read from the backend's environment (.env).
 * Independent of TV research (OPENAI_API_KEY / OPENAI_MODEL are not read here).
 *
 *   AI_PROVIDER            off (default) | openai | mock (offline, no network, no cost)
 *   AI_API_KEY             provider key (server only; never sent to the browser)
 *   AI_MODEL               generation model (default gpt-6.1-sol)
 *   AI_EMBEDDING_MODEL     embedding model (default text-embedding-3-small); "none" = keyword-only
 *   AI_MAX_OUTPUT_TOKENS   per answer (default 1800)
 *   AI_EVIDENCE_TOKENS     evidence budget per question (default 6000, estimated)
 *   AI_TIMEOUT_MS          per provider call (default 45000)
 *   AI_MAX_CONCURRENT      questions at once (default 2)
 *   AI_DAILY_TOKEN_BUDGET  input + output + embedding tokens per IST day (default 300000)
 *   AI_DAILY_CALL_BUDGET   provider calls per IST day (default 300)
 *   AI_PRICE_INPUT_PER_1M, AI_PRICE_OUTPUT_PER_1M, AI_PRICE_EMBEDDING_PER_1M, AI_PRICE_CURRENCY
 *                          optional prices; without them no cost is estimated
 *   AI_TV_RESEARCH         1 = also index completed TV research summaries (default off)
 *   AI_QUIET_WINDOW        HH:mm-HH:mm IST on trading days when questions wait (default 09:13-09:31; "off")
 */

const int = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const price = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};
const timeWindow = (v, d) => {
  if (v === 'off') return null;
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(v ?? '');
  return m ? { from: m[1], to: m[2] } : d;
};

export const DEFAULT_AI_MODEL = 'gpt-6.1-sol';
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
/** Indexing (ingestion and embeddings) never runs in this IST window on trading days. */
export const INDEX_QUIET_WINDOW = { from: '08:55', to: '09:35' };

export function aiConfig(env = process.env) {
  const provider = ['openai', 'mock'].includes(env.AI_PROVIDER) ? env.AI_PROVIDER : 'off';
  const embedding = env.AI_EMBEDDING_MODEL === 'none' ? null : env.AI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  return {
    provider,
    apiKey: env.AI_API_KEY || null,
    model: env.AI_MODEL || DEFAULT_AI_MODEL,
    embeddingModel: embedding,
    maxOutputTokens: int(env.AI_MAX_OUTPUT_TOKENS, 1800, 200, 8000),
    evidenceTokens: int(env.AI_EVIDENCE_TOKENS, 6000, 1000, 30000),
    timeoutMs: int(env.AI_TIMEOUT_MS, 45_000, 2_000, 180_000),
    maxConcurrent: int(env.AI_MAX_CONCURRENT, 2, 1, 8),
    dailyTokenBudget: int(env.AI_DAILY_TOKEN_BUDGET, 300_000, 0, 1e9),
    dailyCallBudget: int(env.AI_DAILY_CALL_BUDGET, 300, 0, 1e6),
    prices: {
      input: price(env.AI_PRICE_INPUT_PER_1M),
      output: price(env.AI_PRICE_OUTPUT_PER_1M),
      embedding: price(env.AI_PRICE_EMBEDDING_PER_1M),
      currency: env.AI_PRICE_CURRENCY || 'USD',
    },
    tvResearch: env.AI_TV_RESEARCH === '1',
    quietWindow: timeWindow(env.AI_QUIET_WINDOW, { from: '09:13', to: '09:31' }),
  };
}

/** Why the AI can't answer with this configuration, or null when it can. */
export function configProblem(config) {
  if (config.provider === 'off') return 'AI is not configured: set AI_PROVIDER=openai and AI_API_KEY in the backend .env (or AI_PROVIDER=mock to try it offline), then restart the backend.';
  if (config.provider === 'openai' && !config.apiKey) return 'AI_PROVIDER is openai but AI_API_KEY is not set in the backend .env.';
  return null;
}

/** The status the browser may see: no key, only whether one is set. */
export function publicConfig(config) {
  return {
    provider: config.provider,
    keyConfigured: Boolean(config.apiKey),
    model: config.provider === 'mock' ? 'mock (offline)' : config.model,
    embeddingModel: config.provider === 'mock' ? 'mock-hash (offline, not semantic)' : config.embeddingModel,
    limits: {
      maxOutputTokens: config.maxOutputTokens, evidenceTokens: config.evidenceTokens, timeoutMs: config.timeoutMs,
      maxConcurrent: config.maxConcurrent, dailyTokenBudget: config.dailyTokenBudget, dailyCallBudget: config.dailyCallBudget,
    },
    pricesConfigured: config.prices.input != null && config.prices.output != null,
    tvResearch: config.tvResearch,
    quietWindow: config.quietWindow,
    problem: configProblem(config),
  };
}
