import { Worker } from 'node:worker_threads';
import { aiConfig, INDEX_QUIET_WINDOW, publicConfig } from './config.js';
import { aiError, redactSecrets } from './errors.js';
import { createUsageLedger } from './usage.js';
import { createIndexStore } from './rag/indexStore.js';
import { createRetriever } from './rag/retrieve.js';
import { removeDocument } from './rag/indexer.js';
import { createAnalystData } from './data.js';
import { createAnalyst, inQuietWindow } from './analyst.js';
import { makeProvider } from './providers/index.js';

/**
 * The AI Analyst service on the backend: configuration, provider, document
 * index (built in a worker thread), retrieval, usage ledger and the analyst.
 * A failure here never reaches the rest of the backend: every call is
 * self-contained and errors are returned, not thrown into timers.
 */
export function createAiService({ store, dataDir, repoRoot, snapshots, calendar, config = aiConfig(), provider = makeProvider(config), now = () => new Date(), workerUrl = new URL('./indexWorker.js', import.meta.url) }) {
  const usage = createUsageLedger({ store, config, now });
  const indexStore = createIndexStore(store);
  const embedder = provider?.embedder ?? null;
  const retriever = createRetriever({ indexStore, embedder });
  const data = createAnalystData({ snapshots, calendar, now });
  const analyst = createAnalyst({ config, provider, data, retriever, usage, calendar, now });
  let job = null; // { state, embed, startedAt, finishedAt, progress, stats, error, worker }

  async function indexInfo() {
    const manifest = await indexStore.manifest();
    const chunks = Object.values(manifest.chunks);
    const vectors = embedder ? (await indexStore.vectors(embedder.id)).vectors : {};
    const missing = chunks.filter((c) => vectors[c.chunkId]?.hash !== c.contentHash);
    const bySource = {};
    for (const d of Object.values(manifest.docs)) bySource[d.sourceType] = (bySource[d.sourceType] ?? 0) + 1;
    return {
      version: manifest.version, updatedAt: manifest.updatedAt, docs: Object.keys(manifest.docs).length, chunks: chunks.length, bySource,
      embedder: embedder?.id ?? null, semantic: Boolean(embedder?.semantic), withVectors: chunks.length - missing.length,
      missingVectors: missing.length, missingVectorTokens: missing.reduce((n, c) => n + c.tokens + 20, 0),
      suspiciousChunks: chunks.filter((c) => c.suspicious).length,
      documents: Object.values(manifest.docs).map((d) => ({ docId: d.docId, title: d.title, sourceType: d.sourceType, kind: d.kind, tradingDate: d.tradingDate, availableAt: d.availableAt, chunks: d.chunkIds.length, ingestedAt: d.ingestedAt })),
    };
  }

  const jobView = () => (job ? { state: job.state, embed: job.embed, startedAt: job.startedAt, finishedAt: job.finishedAt ?? null, progress: job.progress ?? null, stats: job.stats ?? null, error: job.error ?? null } : null);

  async function status() {
    return {
      platform: 'web',
      config: publicConfig(config),
      index: await indexInfo(),
      job: jobView(),
      usage: await usage.summary(),
      quietNow: inQuietWindow(config.quietWindow, now(), calendar),
      indexQuietNow: inQuietWindow(INDEX_QUIET_WINDOW, now(), calendar),
      tools: ['getAnalysisSnapshot', 'getStockAnalysis', 'screenSnapshot', 'compareStocks', 'getRecordedDates', 'getHistoricalOutcomes', 'getDataCoverage'],
    };
  }

  /** Start indexing in a worker. `embed`: also compute missing embeddings (costs tokens with a real provider). */
  async function startIndexing({ embed = false } = {}) {
    if (job?.state === 'running') return jobView();
    if (inQuietWindow(INDEX_QUIET_WINDOW, now(), calendar)) {
      throw aiError('quiet', `Indexing waits until after ${INDEX_QUIET_WINDOW.to} IST on trading days, so the pre-open and opening window have the backend to themselves.`);
    }
    const embedNow = Boolean(embed && embedder);
    let budgetTokens = Infinity;
    if (embedNow && config.provider !== 'mock') {
      await usage.check();
      const u = await usage.summary();
      budgetTokens = Math.max(0, config.dailyTokenBudget - u.totalTokens);
    }
    const worker = new Worker(workerUrl, {
      workerData: { repoRoot, dataDir, config: { ...config }, embed: embedNow, budgetTokens },
    });
    job = { state: 'running', embed: embedNow, startedAt: now().toISOString(), worker };
    const current = job;
    const finish = (state, extra) => {
      if (current.state !== 'running') return;
      Object.assign(current, { state, finishedAt: now().toISOString(), ...extra });
      retriever.invalidate();
    };
    worker.on('message', (m) => {
      if (m?.type === 'progress') current.progress = m;
      else if (m?.type === 'usage') usage.add('embed', { input: m.input }).catch(() => {});
      else if (m?.type === 'done') finish('done', { stats: m.stats });
      else if (m?.type === 'error') finish('failed', { error: redactSecrets(m.message) });
    });
    worker.on('error', (error) => finish('failed', { error: redactSecrets(error.message) }));
    worker.on('exit', (code) => finish(code === 0 ? 'done' : 'failed', code === 0 ? {} : { error: `Indexing stopped (exit ${code}).` }));
    return jobView();
  }

  function cancelIndexing() {
    if (job?.state === 'running') job.worker.postMessage({ type: 'cancel' });
    return jobView();
  }

  async function source(chunkId) {
    const manifest = await indexStore.manifest();
    const c = Object.hasOwn(manifest.chunks, chunkId) ? manifest.chunks[chunkId] : null;
    if (!c) throw aiError('invalid', 'No such indexed source.');
    const { text, chunkId: id, docId, title, heading, path, sourceType, sourceRef, kind, symbol, tradingDate, availableAt, publishedAt, ingestedAt, contentHash, suspicious, retrospective, version } = c;
    return { chunkId: id, docId, title, heading, path, sourceType, sourceRef, kind, symbol, tradingDate, availableAt, publishedAt, ingestedAt, contentHash, suspicious, retrospective, version, text, embedder: embedder?.id ?? null };
  }

  async function removeDoc(docId) {
    if (!(await removeDocument(indexStore, docId))) throw aiError('invalid', 'No such indexed document.');
    retriever.invalidate();
    return indexInfo();
  }

  return {
    status,
    ask: (body, opts) => analyst.ask(body, opts),
    snapshots: () => snapshots.list(),
    startIndexing,
    cancelIndexing,
    source,
    removeDoc,
    usage: () => usage.summary(),
    close: () => job?.worker?.terminate(),
  };
}
