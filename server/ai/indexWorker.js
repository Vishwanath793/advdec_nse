import { parentPort, workerData } from 'node:worker_threads';
import { fsStore } from '../fsStore.js';
import { collectSources } from './rag/sources.js';
import { createIndexStore } from './rag/indexStore.js';
import { runIndexing } from './rag/indexer.js';
import { makeEmbedder } from './providers/index.js';

/**
 * Indexing in its own thread, so reading files, chunking and embedding never
 * block the backend's event loop (the opening collector, the order sender).
 * workerData: { repoRoot, dataDir, config, embed, budgetTokens }.
 * Messages: { type: 'progress' | 'usage' | 'done' | 'error', ... }.
 */
const { repoRoot, dataDir, config, embed, budgetTokens } = workerData;
const controller = new AbortController();
parentPort.on('message', (m) => { if (m?.type === 'cancel') controller.abort(); });

try {
  const { docs, errors } = collectSources({ repoRoot, dataDir, config });
  parentPort.postMessage({ type: 'progress', stage: 'collected', docs: docs.length, errors });
  const stats = await runIndexing({
    indexStore: createIndexStore(fsStore(dataDir)),
    docs,
    embedder: embed ? makeEmbedder(config) : null,
    budgetTokens,
    signal: controller.signal,
    onUsage: async ({ input }) => parentPort.postMessage({ type: 'usage', input }),
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
  });
  parentPort.postMessage({ type: 'done', stats: { ...stats, sourceErrors: errors } });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
}
