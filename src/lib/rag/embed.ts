/**
 * Embeddings.
 *
 * Default engine is local and deterministic: a hashed random-projection
 * encoder over stems + character n-grams. It produces genuine dense vectors
 * with meaningful cosine geometry, needs no API key, no model download and no
 * GPU — and it is morphology-tolerant, which matters a lot for Uzbek.
 *
 * Set OPENAI_API_KEY to swap in hosted embeddings; dimensionality is detected
 * at runtime and stored per-chunk, so both can coexist during a migration.
 */
import { charNgrams, conceptOf, stem, tokenize } from './text';

export const LOCAL_DIM = 384;

/** FNV-1a → 32-bit unsigned. */
function hash32(s: string, seed = 2166136261): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Each feature contributes to a small number of dimensions with signed weight —
 * the classic "hashing trick" / signed random projection. Collisions are rare
 * and unbiased at 384 dims for KB-sized vocabularies.
 */
function addFeature(vec: Float32Array, feature: string, weight: number) {
  const h1 = hash32(feature);
  const h2 = hash32(feature, 0x811c9dc5 ^ 0x9e3779b9);
  const h3 = hash32(feature, 0x1b873593);
  const dim = vec.length;
  vec[h1 % dim] += weight * ((h1 & 1) === 0 ? 1 : -1);
  vec[h2 % dim] += weight * 0.72 * ((h2 & 2) === 0 ? 1 : -1);
  vec[h3 % dim] += weight * 0.48 * ((h3 & 4) === 0 ? 1 : -1);
}

export function localEmbed(text: string, dim = LOCAL_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = tokenize(text);
  if (!tokens.length) return vec;

  // Sub-linear term frequency, as in classic tf-idf weighting.
  const tf = new Map<string, number>();
  for (const t of tokens) {
    const s = stem(t);
    tf.set(s, (tf.get(s) ?? 0) + 1);
  }

  for (const [term, count] of tf) {
    const w = 1 + Math.log(count);
    addFeature(vec, `t:${term}`, w);
    // Character n-grams: partial credit, so morphological variants stay close.
    const grams = charNgrams(term);
    const gw = (w * 0.42) / Math.sqrt(grams.length || 1);
    for (const g of grams) addFeature(vec, `g:${g}`, gw);
    // Cross-language concept token, weighted below the literal term so a
    // same-language match always wins the tie.
    const concept = conceptOf(term);
    if (concept) addFeature(vec, `c:${concept}`, w * 0.65);
  }

  // Bigrams capture short phrases ("qabul vaqti", "страховой полис").
  for (let i = 0; i + 1 < tokens.length; i++) {
    addFeature(vec, `b:${stem(tokens[i])}_${stem(tokens[i + 1])}`, 0.55);
  }

  return l2normalize(vec);
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 1e-9) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/* ── serialisation ───────────────────────────────────────────── */

export function packVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function unpackVector(buf: Uint8Array | null): Float32Array | null {
  if (!buf || buf.byteLength < 4) return null;
  const copy = new Uint8Array(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/* ── hosted provider ─────────────────────────────────────────── */

export interface EmbeddingEngine {
  id: string;
  dim: number;
  hosted: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
}

const local: EmbeddingEngine = {
  id: 'ovoz-hashed-ngram-384',
  dim: LOCAL_DIM,
  hosted: false,
  async embed(texts) {
    return texts.map((t) => localEmbed(t));
  },
};

function openai(apiKey: string): EmbeddingEngine {
  const model = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  return {
    id: model,
    dim: 1536,
    hosted: true,
    async embed(texts) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`Embedding request failed: ${res.status}`);
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      return json.data.map((d) => l2normalize(Float32Array.from(d.embedding)));
    },
  };
}

export function embeddingEngine(): EmbeddingEngine {
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    try {
      return openai(key);
    } catch {
      return local;
    }
  }
  return local;
}
