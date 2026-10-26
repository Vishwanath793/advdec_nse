import { embedderSlug } from './embeddings.js';

/**
 * Persistent document index on a JSON store ({ read(name), write(name, value) }),
 * behind this small interface so it can be swapped for another index later:
 *   ai/index/manifest.json            documents and chunks (text and metadata)
 *   ai/index/vectors-<embedder>.json  one file per embedding model and version
 * Vectors of different embedders are kept apart and never mixed.
 */

export const INDEX_SCHEMA = 1;
const MANIFEST = 'ai/index/manifest.json';
const vectorsFile = (embedderId) => `ai/index/vectors-${embedderSlug(embedderId)}.json`;

export const emptyManifest = () => ({ schemaVersion: INDEX_SCHEMA, version: 0, updatedAt: null, docs: {}, chunks: {} });

export function createIndexStore(store) {
  return {
    async manifest() {
      const saved = await store.read(MANIFEST);
      // An index from another schema is rebuilt, not read.
      return saved?.schemaVersion === INDEX_SCHEMA ? saved : emptyManifest();
    },
    saveManifest: (manifest) => store.write(MANIFEST, manifest),
    async vectors(embedderId) {
      const saved = await store.read(vectorsFile(embedderId));
      return saved?.embedder === embedderId ? saved : { embedder: embedderId, dims: null, vectors: {} };
    },
    saveVectors: (embedderId, data) => store.write(vectorsFile(embedderId), { ...data, embedder: embedderId }),
  };
}
