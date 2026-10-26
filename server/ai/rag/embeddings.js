import { tokenize } from './text.js';

/**
 * Embedding adapters share one shape:
 *   { id, model, dims, semantic, embed(texts, { signal }) -> { vectors: Float32Array[], tokens } }
 * `id` names the model and its version; vectors made by different ids are never compared.
 */

const MOCK_DIMS = 256;

/** 32-bit FNV-1a of a string. */
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic offline embedder for tests and mock mode: hashed terms and
 * term pairs. It finds shared words, not meaning, so it is labelled not semantic.
 */
export function createMockEmbedder() {
  return {
    id: `mock:hash-v1@${MOCK_DIMS}`,
    model: 'mock-hash-v1',
    dims: MOCK_DIMS,
    semantic: false,
    async embed(texts) {
      const vectors = texts.map((text) => {
        const v = new Float32Array(MOCK_DIMS);
        const terms = tokenize(text);
        const add = (t, w) => { const h = fnv(t); v[h % MOCK_DIMS] += (h & 0x80000000 ? -1 : 1) * w; };
        terms.forEach((t, i) => { add(t, 1); if (i) add(`${terms[i - 1]} ${t}`, 0.5); });
        return normalize(v);
      });
      return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
    },
  };
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are stored normalised
}

export const encodeVector = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
export function decodeVector(text) {
  const buf = Buffer.from(text, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** File-name-safe form of an embedder id. */
export const embedderSlug = (id) => id.replace(/[^a-zA-Z0-9.-]+/g, '_');
