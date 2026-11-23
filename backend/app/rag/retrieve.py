"""
Hybrid retrieval — port of src/lib/rag/retrieve.ts.

BM25 (lexical) and dense cosine (semantic) are fused with Reciprocal Rank
Fusion, then re-scored for answer-worthiness; a conservative confidence decides
whether a human gets involved. Scores must match the TypeScript exactly, so the
arithmetic below keeps the same order of operations and plain `+=` loops.

`rank()` is pure (a list of chunk rows in, hits out); `retrieve()` loads the
tenant's chunks from the shared database and caches them like the TypeScript.
"""

import json
import time
from dataclasses import dataclass, field
from typing import Any

import regex
from sqlalchemy import Connection

from app import db
from app.jscompat import JS_S, js_log, utf16_len, utf16_slice
from app.rag.embed import LOCAL_ENGINE_ID, cosine, hosted_embed, hosted_engine_id, local_embed, unpack_vector
from app.rag.text import expand_terms, stem, stems, tokenize

K1 = 1.4
B = 0.72
RRF_K = 60


@dataclass
class Corpus:
    rows: list[dict[str, Any]]
    terms: list[dict[str, float]]
    lengths: list[float]
    avg_len: float
    df: dict[str, int]
    vectors: list[list[float] | None]
    signature: str = ""


@dataclass
class RetrievalResult:
    hits: list[dict[str, Any]]
    confidence: float
    took_ms: float
    strategy: str
    total_chunks: int
    extra: dict[str, Any] = field(default_factory=dict)


def build_corpus(rows: list[dict[str, Any]], signature: str = "") -> Corpus:
    """Rows need: id, document_id, heading, text, embedding (bytes|None), terms_json, title."""
    terms: list[dict[str, float]] = []
    lengths: list[float] = []
    df: dict[str, int] = {}
    vectors: list[list[float] | None] = []
    for r in rows:
        try:
            parsed = json.loads(r["terms_json"])
            term_map = dict(parsed) if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            term_map = {}
        if not term_map:
            for t in stems(r["text"]):
                term_map[t] = term_map.get(t, 0) + 1
        terms.append(term_map)
        length = 0.0
        for v in term_map.values():
            length += v
        lengths.append(length or 1)
        for t in term_map:
            df[t] = df.get(t, 0) + 1
        vectors.append(unpack_vector(r.get("embedding")))
    total = 0.0
    for n in lengths:
        total += n
    avg_len = total / len(lengths) if lengths else 1
    return Corpus(rows, terms, lengths, avg_len, df, vectors, signature)


def _bm25(corpus: Corpus, query_terms: list[str]) -> list[float]:
    n = len(corpus.rows)
    scores = [0.0] * n
    if not n:
        return scores
    seen: dict[str, int] = {}
    for t in query_terms:
        seen[t] = seen.get(t, 0) + 1
    for term, qf in seen.items():
        df = corpus.df.get(term, 0)
        if not df:
            continue
        idf = js_log(1 + (n - df + 0.5) / (df + 0.5))
        q_weight = 1 + js_log(qf)
        for i in range(n):
            tf = corpus.terms[i].get(term)
            if not tf:
                continue
            norm = 1 - B + (B * corpus.lengths[i]) / corpus.avg_len
            scores[i] += idf * q_weight * ((tf * (K1 + 1)) / (tf + K1 * norm))
    return scores


def _rank_of(scores: list[float]) -> dict[int, int]:
    """1-based rank of every positive score; ties keep index order (stable, like Array.sort)."""
    order = sorted((i for i, s in enumerate(scores) if s > 0), key=lambda i: -scores[i])
    return {idx: pos + 1 for pos, idx in enumerate(order)}


def _coverage(corpus: Corpus, idx: int, query_terms: list[str]) -> float:
    if not query_terms:
        return 0
    terms = corpus.terms[idx]
    literal_wanted = {t for t in query_terms if not t.startswith("~")}
    concept_wanted = {t for t in query_terms if t.startswith("~")}
    literal = (sum(1 for t in literal_wanted if t in terms) / len(literal_wanted)) if literal_wanted else 0
    if not concept_wanted:
        return literal
    concept = sum(1 for t in concept_wanted if t in terms) / len(concept_wanted)
    return 0.62 * literal + 0.38 * concept


def _snippet_for(text: str, query_terms: set[str], max_len: int = 260) -> str:
    parts = text.split("\n")
    best = parts[0] if parts else text
    best_score = -1
    for p in parts:
        score = sum(1 for t in set(stems(p)) if t in query_terms)
        if score > best_score:
            best_score, best = score, p
    trimmed = _trim(best)
    if utf16_len(trimmed) > max_len:
        return _trim_end(utf16_slice(trimmed, 0, max_len - 1)) + "…"
    return trimmed


def _trim(s: str) -> str:
    return regex.sub(f"^[{JS_S}]+|[{JS_S}]+$", "", s)


def _trim_end(s: str) -> str:
    return regex.sub(f"[{JS_S}]+$", "", s)


def rank(
    corpus: Corpus,
    query: str,
    *,
    top_k: int = 5,
    min_score: float = 0.06,
    query_vector: list[float] | None = None,
    engine_id: str = LOCAL_ENGINE_ID,
    use_dense: bool = True,
    dense_scores: list[float] | None = None,
) -> RetrievalResult:
    """
    Score the corpus for `query`. `query_vector` defaults to the local embedding; `use_dense=False`
    (the hosted embedding failed) ranks on words alone. `dense_scores` (one per row, already worked
    out — the grouped search does it with numpy) replaces the per-row cosine loop; left out, the
    ranking is exactly the TypeScript's.
    """
    started = time.perf_counter()
    if not corpus.rows:
        return RetrievalResult([], 0, (time.perf_counter() - started) * 1000, "empty-index", 0)

    query_terms = expand_terms([stem(t) for t in tokenize(query)])
    lex = _bm25(corpus, query_terms)

    if dense_scores is not None:
        dense_used, dense = True, dense_scores
    else:
        qv = (query_vector if query_vector is not None else local_embed(query)) if use_dense else None
        dense_used = qv is not None
        dense = [
            cosine(v, qv) if qv is not None and v is not None and len(v) == len(qv) else 0.0 for v in corpus.vectors
        ]

    lex_rank = _rank_of(lex)
    dense_rank = _rank_of(dense)
    max_lex = max([1e-6, *lex])
    max_dense = max([1e-6, *dense])

    fused = []
    for i in range(len(corpus.rows)):
        rrf = (1 / (RRF_K + lex_rank[i]) if i in lex_rank else 0) + (
            1 / (RRF_K + dense_rank[i]) if dense_used and i in dense_rank else 0
        )
        cov = _coverage(corpus, i, query_terms)
        score = rrf * 100 + cov * 0.85 + (lex[i] / max_lex) * 0.45 + ((dense[i] / max_dense) * 0.4 if dense_used else 0)
        fused.append({"i": i, "score": score, "cov": cov})

    fused.sort(key=lambda f: -f["score"])  # stable, like Array.prototype.sort
    top = fused[: max(top_k, 8)]
    max_fused = top[0]["score"] if top else 0

    query_set = set(query_terms)
    hits = []
    for position, f in enumerate(top):
        row = corpus.rows[f["i"]]
        hits.append(
            {
                "chunkId": row["id"],
                "documentId": row["document_id"],
                "documentTitle": row["title"],
                "heading": row["heading"],
                "snippet": _snippet_for(row["text"], query_set),
                "text": row["text"],
                "score": f["score"] / max_fused if max_fused > 0 else 0,
                "lexicalScore": lex[f["i"]] / max_lex,
                "denseScore": dense[f["i"]] / max_dense if dense_used else 0,
                "rank": position + 1,
            }
        )
    hits = [h for h in hits if h["score"] >= min_score][:top_k]

    return RetrievalResult(
        hits=hits,
        confidence=_calibrate_confidence(hits, top, corpus, query_terms, dense_used),
        took_ms=(time.perf_counter() - started) * 1000,
        strategy=f"hybrid:bm25+{engine_id}" if dense_used else "lexical:bm25",
        total_chunks=len(corpus.rows),
    )


def _calibrate_confidence(
    hits: list[dict[str, Any]],
    fused: list[dict[str, Any]],
    corpus: Corpus,
    query_terms: list[str],
    dense_used: bool,
) -> float:
    """Conservative 0‥0.97 belief that the knowledge base can answer — decides human escalation."""
    if not hits or not query_terms:
        return 0
    best = hits[0]
    cov = fused[0]["cov"] if fused else 0
    if len(fused) > 1 and fused[0]["score"] > 0:
        margin = min(1, (fused[0]["score"] - fused[1]["score"]) / fused[0]["score"] / 0.35)
    else:
        margin = 0.5
    unique = set(query_terms)
    unseen_penalty = sum(1 for t in unique if t not in corpus.df) / len(unique)
    lex_strength = min(1, best["lexicalScore"] / 0.62)
    dense_strength = min(1, best["denseScore"] / 0.55) if dense_used else lex_strength
    raw = 0.42 * cov + 0.2 * margin + 0.22 * lex_strength + 0.16 * dense_strength - 0.34 * unseen_penalty
    return max(0, min(0.97, raw / 0.9))


# ── loading from the shared database ───────────────────────────────

_cache: dict[str, Corpus] = {}


def _signature(conn: Connection, tenant_id: str) -> str:
    row = db.fetch_one(conn, "SELECT COUNT(*) AS c, MAX(created_at) AS m FROM chunks WHERE tenant_id = :t", t=tenant_id)
    return f"{(row or {}).get('c') or 0}:{(row or {}).get('m') or ''}"


def load_corpus(conn: Connection, tenant_id: str) -> Corpus:
    sig = _signature(conn, tenant_id)
    cached = _cache.get(tenant_id)
    if cached and cached.signature == sig:
        return cached
    rows = db.fetch_all(
        conn,
        """SELECT c.id, c.document_id, c.heading, c.text, c.token_count, c.embedding, c.terms_json,
                  d.title AS title
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.tenant_id = :t AND d.status = 'ready'""",
        t=tenant_id,
    )
    corpus = build_corpus(rows, sig)
    _cache[tenant_id] = corpus
    return corpus


def invalidate_corpus(tenant_id: str) -> None:
    _cache.pop(tenant_id, None)


def retrieve(tenant_id: str, query: str, *, top_k: int = 5, min_score: float = 0.06) -> RetrievalResult:
    """Search the tenant's knowledge base with the local embedding (no network)."""
    with db.connect() as conn:
        corpus = load_corpus(conn, tenant_id)
    return rank(corpus, query, top_k=top_k, min_score=min_score)


async def retrieve_async(tenant_id: str, query: str, *, top_k: int = 5, min_score: float = 0.06) -> RetrievalResult:
    """
    Search the tenant's knowledge base like `retrieve` in retrieve.ts: with OPENAI_API_KEY set the
    query is embedded by OpenAI (the chunks were too); if that request fails the ranking falls back
    to words alone, never to an error.
    """
    with db.connect() as conn:
        corpus = load_corpus(conn, tenant_id)
    engine = hosted_engine_id()
    if not corpus.rows or engine is None:
        return rank(corpus, query, top_k=top_k, min_score=min_score)
    try:
        vectors = await hosted_embed([query])
    except Exception:  # noqa: BLE001 - lexical ranking still answers
        return rank(corpus, query, top_k=top_k, min_score=min_score, engine_id=engine, use_dense=False)
    qv = vectors[0] if vectors else None
    return rank(
        corpus, query, top_k=top_k, min_score=min_score, query_vector=qv, engine_id=engine, use_dense=qv is not None
    )
