import { tokenize } from './text.js';
import { cosine, decodeVector } from './embeddings.js';

/**
 * Hybrid retrieval over the document index.
 *
 * 1. Metadata filters: in "as known" mode a market document counts only when
 *    its availableAt is at or before the cutoff (unknown availability is
 *    excluded); methodology documents (how the app works) are always allowed.
 * 2. Three ranked lists:
 *    - exact: chunks whose symbol or trading date metadata matches the question,
 *      or whose text has the symbol as a whole word;
 *    - keyword: BM25 (k1 1.2, b 0.75) over the chunk text and headings;
 *    - vector: cosine similarity with the question's embedding, only with
 *      vectors from the same embedder id (and only when that embedder works).
 * 3. Merge with reciprocal rank fusion, score = sum of w / (60 + rank); the exact
 *    list has weight 1.5, the others 1. Ties keep the keyword order.
 * 4. Deduplicate by chunk id and by content hash, then keep chunks until the
 *    chunk count or the token budget is reached.
 */

const RRF_K = 60;
const K1 = 1.2;
const B = 0.75;
const VECTOR_FLOOR = 0.15; // weaker similarity is noise

function buildKeywordIndex(manifest) {
  const docs = Object.values(manifest.chunks).map((c) => {
    const terms = tokenize(`${(c.path ?? []).join(' ')} ${c.title ?? ''} ${c.text}`);
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { chunk: c, tf, len: terms.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avgLen, n: docs.length };
}

function bm25(index, query, allowed) {
  const terms = [...new Set(tokenize(query))];
  const scored = [];
  for (const d of index.docs) {
    if (!allowed(d.chunk)) continue;
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (index.n - index.df.get(t) + 0.5) / (index.df.get(t) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avgLen)));
    }
    if (score > 0) scored.push({ chunk: d.chunk, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));
}

/** Whether a chunk may be used under `mode` and `cutoff` (ISO time). */
export function allowedAt(chunk, { mode, cutoff }) {
  if (chunk.kind !== 'market' || mode !== 'as-known') return { ok: true };
  if (!chunk.availableAt) return { ok: false, reason: 'unknown' };
  return chunk.availableAt <= cutoff ? { ok: true } : { ok: false, reason: 'after' };
}

export function createRetriever({ indexStore, embedder = null }) {
  let cached = { version: -1, manifest: null, keyword: null, vectors: null, embedderId: null };
  const queryVectors = new Map();

  async function load() {
    const manifest = await indexStore.manifest();
    if (manifest.version !== cached.version || manifest.updatedAt !== cached.manifest?.updatedAt || cached.embedderId !== embedder?.id) {
      const vectors = embedder ? (await indexStore.vectors(embedder.id)).vectors : {};
      cached = { version: manifest.version, manifest, keyword: buildKeywordIndex(manifest), vectors, embedderId: embedder?.id ?? null };
    }
    return cached;
  }

  /** Reload the vectors after an indexing run. */
  const invalidate = () => { cached = { version: -1, manifest: null }; };

  async function queryVector(query, { signal, onUsage }) {
    const key = `${embedder.id}\n${query}`;
    if (queryVectors.has(key)) return queryVectors.get(key);
    const { vectors, tokens } = await embedder.embed([query], { signal });
    await onUsage?.({ input: tokens ?? 0 });
    queryVectors.set(key, vectors[0]);
    if (queryVectors.size > 200) queryVectors.delete(queryVectors.keys().next().value);
    return vectors[0];
  }

  async function search({ query, symbols = [], dates = [], mode = 'retrospective', cutoff = null, maxChunks = 8, maxTokens = 3000, signal, onUsage }) {
    const { manifest, keyword, vectors } = await load();
    const excluded = { afterCutoff: 0, unknownAvailability: 0 };
    const allowedIds = new Set();
    for (const c of Object.values(manifest.chunks)) {
      const a = allowedAt(c, { mode, cutoff });
      if (a.ok) allowedIds.add(c.chunkId);
      else excluded[a.reason === 'after' ? 'afterCutoff' : 'unknownAvailability']++;
    }
    const allowed = (c) => allowedIds.has(c.chunkId);

    const keywordList = bm25(keyword, query, allowed);
    const symbolSet = new Set(symbols.map((s) => s.toUpperCase()));
    const dateSet = new Set(dates);
    const wordRe = symbolSet.size ? new RegExp(`(^|[^A-Z0-9&-])(${[...symbolSet].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Z0-9&-])`) : null;
    const exactList = Object.values(manifest.chunks)
      .filter((c) => allowed(c) && ((c.symbol && symbolSet.has(c.symbol)) || (c.tradingDate && dateSet.has(c.tradingDate)) || (wordRe && wordRe.test(c.text))))
      .map((c) => ({ chunk: c, score: (keywordList.find((k) => k.chunk.chunkId === c.chunkId)?.score ?? 0) + (c.symbol && symbolSet.has(c.symbol) ? 10 : 0) + (c.tradingDate && dateSet.has(c.tradingDate) ? 5 : 0) }))
      .sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId));

    let vectorList = [];
    let retrieval = { mode: 'keyword-only', semantic: false, embedder: embedder?.id ?? null, reason: null };
    if (!embedder) retrieval.reason = 'No embedding model is configured, so only keyword and exact matches were used.';
    else {
      const covered = Object.values(manifest.chunks).filter((c) => vectors[c.chunkId]?.hash === c.contentHash).length;
      if (!covered) retrieval.reason = `The index has no vectors for ${embedder.id} yet (build the index), so only keyword and exact matches were used.`;
      else {
        try {
          const q = await queryVector(query, { signal, onUsage });
          vectorList = Object.values(manifest.chunks)
            .filter((c) => allowed(c) && vectors[c.chunkId]?.hash === c.contentHash)
            .map((c) => ({ chunk: c, score: cosine(q, decodeVector(vectors[c.chunkId].v)) }))
            .filter((x) => x.score != null && x.score >= VECTOR_FLOOR)
            .sort((a, b) => b.score - a.score);
          retrieval = {
            mode: 'hybrid', semantic: embedder.semantic, embedder: embedder.id,
            coverage: { withVectors: covered, chunks: Object.keys(manifest.chunks).length },
            reason: embedder.semantic ? null : 'Mock embeddings (offline): they match shared words, not meaning.',
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          retrieval.reason = `The embedding call failed (${error.message}), so only keyword and exact matches were used.`;
        }
      }
    }

    const fused = new Map();
    const fuse = (list, weight, tag) => list.slice(0, 50).forEach((x, rank) => {
      const f = fused.get(x.chunk.chunkId) ?? { chunk: x.chunk, score: 0, matchedBy: [], order: Infinity };
      f.score += weight / (RRF_K + rank + 1);
      f.matchedBy.push(tag);
      if (tag === 'keyword') f.order = rank;
      fused.set(x.chunk.chunkId, f);
    });
    fuse(exactList, 1.5, 'exact');
    fuse(keywordList, 1, 'keyword');
    fuse(vectorList, 1, 'vector');

    const out = [];
    const hashes = new Set();
    let tokens = 0;
    for (const f of [...fused.values()].sort((a, b) => b.score - a.score || a.order - b.order || a.chunk.chunkId.localeCompare(b.chunk.chunkId))) {
      if (hashes.has(f.chunk.contentHash)) continue;
      if (out.length >= maxChunks) break;
      if (tokens + f.chunk.tokens > maxTokens) continue;
      hashes.add(f.chunk.contentHash);
      tokens += f.chunk.tokens;
      out.push({ ...f.chunk, score: Math.round(f.score * 10000) / 10000, matchedBy: f.matchedBy });
    }
    return { chunks: out, retrieval: { ...retrieval, excluded, candidates: fused.size, tokens } };
  }

  return { search, invalidate, manifest: async () => (await load()).manifest };
}
