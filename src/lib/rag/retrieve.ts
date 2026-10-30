/**
 * Hybrid retrieval: BM25 (lexical) ⊕ dense cosine (semantic), fused with
 * Reciprocal Rank Fusion, then re-scored for answer-worthiness.
 *
 * Lexical alone misses paraphrase; dense alone misses exact identifiers like
 * "ЛОР", "MRT", a price or a policy number — which is exactly what callers ask
 * about. Fusing both is what makes the answers hold up on real documents.
 */
import { all } from '@/lib/db';
import type { Citation } from '@/lib/types';
import { cosine, embeddingEngine, unpackVector } from './embed';
import { expandTerms, stem, stems, tokenize } from './text';

export interface RetrievalHit extends Citation {
  text: string;
  lexicalScore: number;
  denseScore: number;
  rank: number;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** 0‥1 calibrated belief that the KB can answer this question. */
  confidence: number;
  tookMs: number;
  strategy: string;
  totalChunks: number;
}

const K1 = 1.4;
const B = 0.72;
const RRF_K = 60;

interface ChunkRow {
  id: string;
  document_id: string;
  heading: string | null;
  text: string;
  token_count: number;
  embedding: Uint8Array | null;
  terms_json: string;
  title: string;
}

/* ── corpus cache ────────────────────────────────────────────── */

interface Corpus {
  rows: ChunkRow[];
  terms: Array<Map<string, number>>;
  lengths: number[];
  avgLen: number;
  df: Map<string, number>;
  vectors: Array<Float32Array | null>;
  signature: string;
}

const corpusCache = new Map<string, Corpus>();

function signature(tenantId: string): string {
  const row = all<{ c: number; m: string | null }>(
    `SELECT COUNT(*) AS c, MAX(created_at) AS m FROM chunks WHERE tenant_id=?`,
    tenantId,
  )[0];
  return `${row?.c ?? 0}:${row?.m ?? ''}`;
}

export function invalidateCorpus(tenantId: string) {
  corpusCache.delete(tenantId);
}

function loadCorpus(tenantId: string): Corpus {
  const sig = signature(tenantId);
  const cached = corpusCache.get(tenantId);
  if (cached && cached.signature === sig) return cached;

  const rows = all<ChunkRow>(
    `SELECT c.id, c.document_id, c.heading, c.text, c.token_count, c.embedding, c.terms_json,
            d.title AS title
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.tenant_id = ? AND d.status = 'ready'`,
    tenantId,
  );

  const terms: Array<Map<string, number>> = [];
  const lengths: number[] = [];
  const df = new Map<string, number>();
  const vectors: Array<Float32Array | null> = [];

  for (const r of rows) {
    let map: Map<string, number>;
    try {
      map = new Map(Object.entries(JSON.parse(r.terms_json) as Record<string, number>));
    } catch {
      map = new Map();
    }
    if (!map.size) {
      for (const t of stems(r.text)) map.set(t, (map.get(t) ?? 0) + 1);
    }
    terms.push(map);
    let len = 0;
    for (const v of map.values()) len += v;
    lengths.push(len || 1);
    for (const t of map.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    vectors.push(unpackVector(r.embedding));
  }

  const avgLen = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
  const corpus: Corpus = { rows, terms, lengths, avgLen, df, vectors, signature: sig };
  corpusCache.set(tenantId, corpus);
  return corpus;
}

/* ── scoring ─────────────────────────────────────────────────── */

function bm25(corpus: Corpus, queryTerms: string[]): number[] {
  const N = corpus.rows.length;
  const scores = new Array<number>(N).fill(0);
  if (!N) return scores;

  const seen = new Map<string, number>();
  for (const t of queryTerms) seen.set(t, (seen.get(t) ?? 0) + 1);

  for (const [term, qf] of seen) {
    const df = corpus.df.get(term) ?? 0;
    if (!df) continue;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const qWeight = 1 + Math.log(qf);
    for (let i = 0; i < N; i++) {
      const tf = corpus.terms[i].get(term);
      if (!tf) continue;
      const norm = 1 - B + (B * corpus.lengths[i]) / corpus.avgLen;
      scores[i] += idf * qWeight * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
  }
  return scores;
}

function rankOf(scores: number[]): Map<number, number> {
  const order = scores
    .map((s, i) => [s, i] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]);
  const rank = new Map<number, number>();
  order.forEach(([, idx], i) => rank.set(idx, i + 1));
  return rank;
}

/**
 * How much of the question this candidate actually covers.
 *
 * Literal and conceptual coverage are measured separately and then blended.
 * A cross-language hit has near-zero literal overlap by construction — the
 * words share no characters — but can cover every concept the caller asked
 * about. Scoring only literal overlap would make the engine permanently
 * unsure about the exact cross-language questions it is built to answer.
 */
function coverage(corpus: Corpus, idx: number, queryTerms: string[]): number {
  if (!queryTerms.length) return 0;
  const terms = corpus.terms[idx];

  const literalWanted = new Set<string>();
  const conceptWanted = new Set<string>();
  for (const t of queryTerms) (t.startsWith('~') ? conceptWanted : literalWanted).add(t);

  let literalHit = 0;
  for (const t of literalWanted) if (terms.has(t)) literalHit++;
  const literal = literalWanted.size ? literalHit / literalWanted.size : 0;

  if (!conceptWanted.size) return literal;

  let conceptHit = 0;
  for (const t of conceptWanted) if (terms.has(t)) conceptHit++;
  const concept = conceptHit / conceptWanted.size;

  return 0.62 * literal + 0.38 * concept;
}

function snippetFor(text: string, queryTerms: Set<string>, max = 260): string {
  const parts = text.split('\n');
  let best = parts[0] ?? text;
  let bestScore = -1;
  for (const p of parts) {
    let score = 0;
    for (const t of new Set(stems(p))) if (queryTerms.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  const trimmed = best.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/* ── public API ──────────────────────────────────────────────── */

export async function retrieve(
  tenantId: string,
  query: string,
  { topK = 5, minScore = 0.06 }: { topK?: number; minScore?: number } = {},
): Promise<RetrievalResult> {
  const started = performance.now();
  const corpus = loadCorpus(tenantId);
  const engine = embeddingEngine();

  if (!corpus.rows.length) {
    return {
      hits: [],
      confidence: 0,
      tookMs: performance.now() - started,
      strategy: 'empty-index',
      totalChunks: 0,
    };
  }

  const queryTerms = expandTerms(tokenize(query).map(stem));
  const lex = bm25(corpus, queryTerms);

  let dense = new Array<number>(corpus.rows.length).fill(0);
  let denseUsed = false;
  try {
    const [qv] = await engine.embed([query]);
    if (qv) {
      denseUsed = true;
      dense = corpus.vectors.map((v) => (v && v.length === qv.length ? cosine(v, qv) : 0));
    }
  } catch {
    denseUsed = false;
  }

  const lexRank = rankOf(lex);
  const denseRank = rankOf(dense);
  const maxLex = Math.max(1e-6, ...lex);
  const maxDense = Math.max(1e-6, ...dense);

  const fused = corpus.rows.map((_, i) => {
    const rrf =
      (lexRank.has(i) ? 1 / (RRF_K + lexRank.get(i)!) : 0) +
      (denseUsed && denseRank.has(i) ? 1 / (RRF_K + denseRank.get(i)!) : 0);
    const cov = coverage(corpus, i, queryTerms);
    // RRF gives robust ordering; coverage and normalised magnitude break ties
    // and keep a chunk that literally contains every query term on top.
    const score =
      rrf * 100 + cov * 0.85 + (lex[i] / maxLex) * 0.45 + (denseUsed ? (dense[i] / maxDense) * 0.4 : 0);
    return { i, score, cov };
  });

  fused.sort((a, b) => b.score - a.score);
  const top = fused.slice(0, Math.max(topK, 8));
  const maxFused = top[0]?.score ?? 0;

  const querySet = new Set(queryTerms);
  const hits: RetrievalHit[] = top
    .map((f, rank) => {
      const row = corpus.rows[f.i];
      return {
        chunkId: row.id,
        documentId: row.document_id,
        documentTitle: row.title,
        heading: row.heading,
        snippet: snippetFor(row.text, querySet),
        text: row.text,
        score: maxFused > 0 ? f.score / maxFused : 0,
        lexicalScore: lex[f.i] / maxLex,
        denseScore: denseUsed ? dense[f.i] / maxDense : 0,
        rank: rank + 1,
      };
    })
    .filter((h) => h.score >= minScore)
    .slice(0, topK);

  return {
    hits,
    confidence: calibrateConfidence(hits, top, corpus, queryTerms, denseUsed),
    tookMs: performance.now() - started,
    strategy: denseUsed ? `hybrid:bm25+${engine.id}` : 'lexical:bm25',
    totalChunks: corpus.rows.length,
  };
}

/**
 * Confidence is the number that decides whether a human gets involved, so it is
 * deliberately conservative and built from independent signals:
 *   • how much of the question the best chunk actually covers
 *   • how far the best chunk stands above the runner-up (a flat distribution
 *     means the index has no opinion)
 *   • absolute lexical strength, so a weak-but-unique match doesn't score high
 */
function calibrateConfidence(
  hits: RetrievalHit[],
  fused: Array<{ score: number; cov: number }>,
  corpus: Corpus,
  queryTerms: string[],
  denseUsed: boolean,
): number {
  if (!hits.length || !queryTerms.length) return 0;

  const best = hits[0];
  const cov = fused[0]?.cov ?? 0;
  const margin =
    fused.length > 1 && fused[0].score > 0
      ? Math.min(1, (fused[0].score - fused[1].score) / fused[0].score / 0.35)
      : 0.5;

  // Rare query terms that the corpus has never seen are a strong "I don't know".
  let unseen = 0;
  const unique = new Set(queryTerms);
  for (const t of unique) if (!corpus.df.has(t)) unseen++;
  const unseenPenalty = unseen / unique.size;

  const lexStrength = Math.min(1, best.lexicalScore / 0.62);
  const denseStrength = denseUsed ? Math.min(1, best.denseScore / 0.55) : lexStrength;

  const raw =
    0.42 * cov + 0.2 * margin + 0.22 * lexStrength + 0.16 * denseStrength - 0.34 * unseenPenalty;

  // Squash into a well-behaved 0‥1 band; never claim near-certainty.
  return Math.max(0, Math.min(0.97, raw / 0.9));
}
