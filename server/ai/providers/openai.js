import OpenAI from 'openai';
import { aiError, redactSecrets } from '../errors.js';
import { normalize } from '../rag/embeddings.js';

/**
 * OpenAI adapter for the AI Analyst (Responses API with function tools and a
 * strict JSON-schema answer; Embeddings API). Its own client, key and model
 * (AI_API_KEY, AI_MODEL): the TV research pipeline's client and settings are not used.
 * Requests set store: false. The SDK's own retries are off, so every call is
 * counted against the daily budget exactly once.
 */

export function mapProviderError(error, signal) {
  if (error?.code && error.name === 'AiError') return error;
  // The SDK's error classes don't set `name`, so check the class.
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError || error?.name === 'AbortError') return aiError('cancelled', 'Cancelled.');
  const message = redactSecrets(error?.message ?? String(error));
  if (error instanceof OpenAI.APIConnectionTimeoutError || /timed? ?out/i.test(message)) return aiError('timeout', 'The AI provider did not answer in time. Try again, or raise AI_TIMEOUT_MS.');
  const status = error?.status;
  if (status === 429) {
    return aiError('rate_limited', /quota|billing|insufficient/i.test(message)
      ? 'The AI provider says the account has no quota left (HTTP 429). Check billing on the provider\'s site.'
      : 'The AI provider is rate-limiting requests (HTTP 429). Wait a minute and try again.');
  }
  if (status === 401 || status === 403) return aiError('auth', 'The AI provider rejected AI_API_KEY (HTTP 401/403). Check the key in the backend .env.');
  if (status === 404) return aiError('provider', `The AI provider does not know this model (HTTP 404). Check AI_MODEL / AI_EMBEDDING_MODEL. ${message}`);
  if (status) return aiError('provider', `The AI provider returned HTTP ${status}: ${message}`);
  return aiError('provider', `Could not reach the AI provider: ${message}`);
}

const DIMS = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072, 'text-embedding-ada-002': 1536 };

export function createOpenAiProvider({ apiKey, model, embeddingModel, timeoutMs, client = null }) {
  const api = client ?? new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });

  async function respond({ instructions, input, tools, schema, maxOutputTokens, signal }) {
    let res;
    try {
      res = await api.responses.create({
        model,
        instructions,
        input,
        ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
        text: { format: { type: 'json_schema', name: 'analyst_answer', schema, strict: true } },
        max_output_tokens: maxOutputTokens,
        store: false,
      }, { signal, timeout: timeoutMs, maxRetries: 0 });
    } catch (error) { throw mapProviderError(error, signal); }
    const output = Array.isArray(res?.output) ? res.output : [];
    const calls = output.filter((o) => o.type === 'function_call');
    if (!calls.length && res?.status && res.status !== 'completed') {
      throw aiError('provider', `The answer was not completed (${res.incomplete_details?.reason ?? res.status}); no partial answer is shown.`);
    }
    return {
      toolCalls: calls.map((c) => ({ callId: c.call_id, name: c.name, arguments: c.arguments })),
      // Only the call items go back in the next request (store: false keeps nothing on the provider's side).
      continuation: calls.map((c) => ({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments })),
      text: calls.length ? null : (res?.output_text ?? null),
      usage: { input: res?.usage?.input_tokens ?? 0, output: res?.usage?.output_tokens ?? 0 },
    };
  }

  const embedder = embeddingModel ? {
    id: `openai:${embeddingModel}`,
    model: embeddingModel,
    dims: DIMS[embeddingModel] ?? null,
    semantic: true,
    async embed(texts, { signal } = {}) {
      let res;
      try {
        res = await api.embeddings.create({ model: embeddingModel, input: texts, encoding_format: 'float' }, { signal, timeout: timeoutMs, maxRetries: 0 });
      } catch (error) { throw mapProviderError(error, signal); }
      const data = [...(res?.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== texts.length) throw aiError('provider', 'The embedding reply did not match the request.');
      return { vectors: data.map((d) => normalize(Float32Array.from(d.embedding))), tokens: res?.usage?.prompt_tokens ?? res?.usage?.total_tokens ?? 0 };
    },
  } : null;

  return { name: 'openai', model, embedder, respond };
}
