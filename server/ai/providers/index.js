import { configProblem } from '../config.js';
import { createMockEmbedder } from '../rag/embeddings.js';
import { createMockProvider } from './mock.js';
import { createOpenAiProvider } from './openai.js';

/** The generation provider for a configuration, or null when AI is off or has no key. */
export function makeProvider(config) {
  if (configProblem(config)) return null;
  if (config.provider === 'mock') return createMockProvider();
  return createOpenAiProvider({ apiKey: config.apiKey, model: config.model, embeddingModel: config.embeddingModel, timeoutMs: config.timeoutMs });
}

/** The embedder for a configuration (mock in mock mode), or null. */
export function makeEmbedder(config) {
  if (config.provider === 'mock') return createMockEmbedder();
  if (config.provider === 'openai' && config.apiKey && config.embeddingModel) return makeProvider(config)?.embedder ?? null;
  return null;
}
