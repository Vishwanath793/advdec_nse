import { chunkMarkdown, estimateTokens, looksLikeInstructions, sha256, slug } from './text.js';
import { encodeVector } from './embeddings.js';
import { stableStringify } from '../../../src/utils/aiContext.js';

/**
 * Ingestion -> normalisation -> chunking -> embeddings -> persistent index.
 * Incremental: a document whose content hash is unchanged keeps its chunks,
 * and a chunk whose hash already has a vector for this embedder is not
 * embedded again. Vectors are stored per embedder id, so changing the
 * embedding model never mixes vectors.
 */

const EMBED_BATCH = 64;

const META_KEYS = ['sourceType', 'sourceRef', 'title', 'kind', 'symbol', 'isin', 'tradingDate', 'availableAt', 'publishedAt', 'version', 'retrospective'];

/** Normalised text: one line ending, no trailing spaces, at most one blank line. */
export const normalizeText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

/** The text that is embedded: the chunk with its document, heading and date in front (contextual retrieval). */
export function embeddingText(chunk) {
  const head = [chunk.title, ...(chunk.path ?? [])].filter(Boolean).join(' > ');
  const tags = [chunk.tradingDate && `date ${chunk.tradingDate}`, chunk.symbol && `symbol ${chunk.symbol}`].filter(Boolean).join(', ');
  return `${head}${tags ? ` (${tags})` : ''}\n${chunk.text}`;
}

/** Chunks for one document, with stable ids (document id + heading path + ordinal). */
export function chunkDocument(doc, ingestedAt) {
  const seen = new Map();
  return chunkMarkdown(normalizeText(doc.text)).map((c) => {
    let base = `${doc.docId}#${slug(c.path.join(' '))}.${c.ordinal}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (n) base = `${base}~${n}`;
    return {
      chunkId: base,
      docId: doc.docId,
      heading: c.heading,
      path: c.path,
      text: c.text,
      contentHash: sha256(c.text),
      tokens: estimateTokens(c.text),
      suspicious: looksLikeInstructions(c.text),
      ingestedAt,
      ...Object.fromEntries(META_KEYS.map((k) => [k, doc[k] ?? null])),
    };
  });
}

/**
 * Bring the index up to date with `docs` (from sources.js).
 * `embedder` may be null (keyword-only index). `budgetTokens` caps embedding
 * tokens for this run; `onUsage({ input })` records each embedding call.
 * With `prune`, documents no longer in `docs` are removed.
 */
export async function runIndexing({ indexStore, docs, embedder = null, budgetTokens = Infinity, onUsage = async () => {}, onProgress = () => {}, signal, now = () => new Date(), prune = true }) {
  const manifest = await indexStore.manifest();
  const ingestedAt = now().toISOString();
  const stats = { docs: docs.length, added: 0, updated: 0, unchanged: 0, removed: 0, chunks: 0, embedded: 0, embeddingTokens: 0, embedder: embedder?.id ?? null, stoppedForBudget: false };
  let changed = false;
  const wanted = new Set();

  for (const doc of docs) {
    if (signal?.aborted) throw new Error('Indexing cancelled.');
    wanted.add(doc.docId);
    const contentHash = sha256(normalizeText(doc.text) + stableStringify(Object.fromEntries(META_KEYS.map((k) => [k, doc[k] ?? null]))));
    const old = manifest.docs[doc.docId];
    if (old?.contentHash === contentHash) { stats.unchanged++; continue; }
    for (const id of old?.chunkIds ?? []) delete manifest.chunks[id];
    const chunks = chunkDocument(doc, ingestedAt);
    for (const c of chunks) manifest.chunks[c.chunkId] = c;
    manifest.docs[doc.docId] = {
      docId: doc.docId, ...Object.fromEntries(META_KEYS.map((k) => [k, doc[k] ?? null])),
      contentHash, ingestedAt, chunkIds: chunks.map((c) => c.chunkId),
    };
    stats[old ? 'updated' : 'added']++;
    changed = true;
  }
  if (prune) {
    for (const docId of Object.keys(manifest.docs)) {
      if (wanted.has(docId)) continue;
      for (const id of manifest.docs[docId].chunkIds) delete manifest.chunks[id];
      delete manifest.docs[docId];
      stats.removed++;
      changed = true;
    }
  }
  if (changed) {
    manifest.version += 1;
    manifest.updatedAt = ingestedAt;
    await indexStore.saveManifest(manifest);
  }
  stats.chunks = Object.keys(manifest.chunks).length;
  onProgress({ stage: 'chunked', ...stats });

  if (embedder) {
    const store = await indexStore.vectors(embedder.id);
    let vectorsChanged = false;
    for (const id of Object.keys(store.vectors)) if (!manifest.chunks[id]) { delete store.vectors[id]; vectorsChanged = true; }
    const todo = Object.values(manifest.chunks).filter((c) => store.vectors[c.chunkId]?.hash !== c.contentHash);
    for (let i = 0; i < todo.length; i += EMBED_BATCH) {
      if (signal?.aborted) break;
      const batch = todo.slice(i, i + EMBED_BATCH);
      const texts = batch.map(embeddingText);
      const estimate = texts.reduce((n, t) => n + estimateTokens(t), 0);
      if (stats.embeddingTokens + estimate > budgetTokens) { stats.stoppedForBudget = true; break; }
      const { vectors, tokens } = await embedder.embed(texts, { signal });
      await onUsage({ input: tokens ?? estimate });
      stats.embeddingTokens += tokens ?? estimate;
      batch.forEach((c, k) => { store.vectors[c.chunkId] = { hash: c.contentHash, v: encodeVector(vectors[k]) }; });
      store.dims = vectors[0]?.length ?? store.dims;
      stats.embedded += batch.length;
      vectorsChanged = true;
      onProgress({ stage: 'embedding', done: Math.min(i + EMBED_BATCH, todo.length), of: todo.length });
      await indexStore.saveVectors(embedder.id, store); // saved per batch, so a stop keeps what was paid for
    }
    if (vectorsChanged) await indexStore.saveVectors(embedder.id, store);
  }
  return stats;
}

/** Remove one document and its chunks (its vectors are dropped on the next run). */
export async function removeDocument(indexStore, docId) {
  const manifest = await indexStore.manifest();
  const doc = manifest.docs[docId];
  if (!doc) return false;
  for (const id of doc.chunkIds) delete manifest.chunks[id];
  delete manifest.docs[docId];
  manifest.version += 1;
  manifest.updatedAt = new Date().toISOString();
  await indexStore.saveManifest(manifest);
  return true;
}
