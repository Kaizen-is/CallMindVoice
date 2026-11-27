"""
Grouped search: pick the right "shelf" first, then search only there.

Used for tenants whose knowledge came from a website import (`app.rag.pages`):
every page carries a group (personal_loans, business, about…) and a language.
For everyone else nothing changes — `run_turn` keeps calling `retrieve_async`.

    question ─▶ vector (needed for the search anyway)
             ─▶ score each group: cosine to the group's centroid + keyword hits + "same group as the last turn"
             ─▶ search the three best groups, in the caller's language
             ─▶ not confident? search every group in that language, then everything — keep the best

Why not ask an LLM which group? It costs a model round-trip on every turn of a
phone call (measured: ~0.8 s median); comparing one vector with ~10 centroids is
a matrix product. The fallback means a wrong guess is never worse than searching
everything. Measured on tools/brb_testset.json with tools/eval_retrieval.py.

The vector maths uses numpy and runs in a worker thread: scoring 7,700 chunks of
1,536 dimensions in a Python loop took about a second and, on the event loop,
froze every other request meanwhile.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from sqlalchemy import Connection

from app import db
from app.rag.embed import LOCAL_DIM, LOCAL_ENGINE_ID, hosted_embed_query, hosted_engine_id, local_embed
from app.rag.retrieve import Corpus, RetrievalResult, build_corpus, rank
from app.rag.text import normalize, stem, tokenize

log = logging.getLogger(__name__)

KEYWORD_BONUS = 0.06  # per matching keyword…
KEYWORD_CAP = 0.18  # …at most this much
STICKY_BONUS = 0.05  # the group the previous turn was answered from
# Measured on tools/brb_testset.json (42 questions, 23 Nov 2026), right page first / in the top five / MRR:
#   plain search 55% / 90% / 0.70, ~1 s · best group only 60% / 79% / 0.68 · best 2 groups 64% / 86% / 0.73
#   best 3 + focus 67% / 88% / 0.76, ~0.15 s (chosen) · best 3 without focus 62% / 83% / 0.72
#   an LLM picking the group 67% / 83% / 0.74, +0.8 s per turn. Small set: re-measure as it grows.
# With Uzbek pages only (24 Nov): plain 55% / 81% / 0.65, best 3 + focus 57% / 76% / 0.65 — the drop is the
# Russian questions, whose translated product names no longer match a page in their own language.
GROUPS_SEARCHED = 3  # how many of the best groups are always searched…
RUNNER_UP_GAP = 0.04  # …plus the next one when it scores this close
# Scores are multiplied by (focus / most focused group) ** FOCUS_POWER, focus being how alike a group's
# pages are (the length of their mean vector): a group about many things matches many questions loosely.
FOCUS_POWER = 1.0
MIN_LANG_CHUNKS = 3  # fewer chunks than this in the caller's language: search all languages
SMALL_GROUP_CHUNKS = 3  # the best group this small (the rates) is passed to the model whole
STICKY_CALLS = 500  # how many calls' last group to remember


@dataclass
class GroupedCorpus:
    signature: str
    rows: list[dict[str, Any]]
    full: Corpus
    # Every chunk's vector in one float32 matrix (zero rows where a chunk has none of this size).
    matrix: np.ndarray
    groups: np.ndarray  # group of each row
    langs: np.ndarray  # language of each row
    centroids: dict[str, np.ndarray]
    focus: dict[str, float]
    keywords: dict[str, list[list[str]]]  # group → keyword phrases as stem lists
    subsets: dict[tuple[tuple[str, ...], str | None], tuple[Corpus, np.ndarray]] = field(default_factory=dict)


_cache: dict[str, GroupedCorpus] = {}
_sticky: dict[str, str] = {}  # call id → group of its last answer


def invalidate(tenant_id: str) -> None:
    _cache.pop(tenant_id, None)


def remember(call_id: str, group: str | None) -> None:
    if not group:
        return
    if len(_sticky) >= STICKY_CALLS:
        _sticky.pop(next(iter(_sticky)))
    _sticky.pop(call_id, None)
    _sticky[call_id] = group


def sticky_group(call_id: str | None) -> str | None:
    return _sticky.get(call_id) if call_id else None


# ── loading ──────────────────────────────────────────────────────────


def has_grouped_knowledge(conn: Connection, tenant_id: str) -> bool:
    """True when the tenant has imported website pages (and the database has migration 0002)."""
    from app.rag.pages import table_ready

    if not table_ready(conn):
        return False
    row = db.fetch_one(conn, "SELECT 1 AS ok FROM knowledge_pages WHERE tenant_id = :t LIMIT 1", t=tenant_id)
    return row is not None


def _signature(conn: Connection, tenant_id: str) -> str:
    row = db.fetch_one(
        conn,
        """SELECT (SELECT COUNT(*) FROM chunks WHERE tenant_id = :t) AS c,
                  (SELECT MAX(created_at) FROM chunks WHERE tenant_id = :t) AS m,
                  (SELECT MAX(updated_at) FROM knowledge_groups WHERE tenant_id = :t) AS g""",
        t=tenant_id,
    )
    row = row or {}
    return f"{row.get('c') or 0}:{row.get('m') or ''}:{row.get('g') or ''}"


def _phrase_stems(phrase: str) -> list[str]:
    return [stem(t) for t in tokenize(phrase, keep_stopwords=True)]


# ── Uzbek word endings ───────────────────────────────────────────────
# Uzbek stacks endings: valyuta-si-ni ("its currency", as an object). The shared stemmer (app.rag.text,
# kept identical to the TypeScript) strips one layer, so "valyutasini" stays "valyutasi" and misses the
# pages that say "valyuta" (25 Nov: "valyutasini ber" got "no rates" though the rates page was there).
# For the grouped search only, an Uzbek question also gets the base form of such words, when the pages
# know it; the shared ranking, the plain search and every other tenant are untouched.
_UZ_LAYERS = (
    ("miz", "siz", "man", "san", "dir"),  # predicate: …-man "I am …", …-dir "is …"
    ("ning", "dagi", "gacha", "dan", "ga", "da", "ni"),  # case
    ("imiz", "ingiz", "ing", "im", "si", "i"),  # possessive: -si after a vowel, -i after a consonant
    ("lar",),  # plural
)
_VOWELS = frozenset("aeiou")


def uz_base(token: str) -> str:
    """The token without its endings, at most one per layer, outermost first (at least four letters kept)."""
    word = token
    for layer in _UZ_LAYERS:
        for suffix in layer:
            if not word.endswith(suffix) or len(word) - len(suffix) < 4:
                continue
            before = word[-len(suffix) - 1]
            if (suffix == "si" and before not in _VOWELS) or (suffix == "i" and before in _VOWELS):
                continue
            word = word[: -len(suffix)]
            break
    return word


def expand_query(query: str, df: dict[str, int]) -> str:
    """The query plus the base forms of words whose stacked endings the shared stemmer left on.

    A base form is added (as itself and with -lar, which the stemmer reduces differently) only when its
    stem differs from the word's own and occurs in the corpus: words it already finds add nothing.
    """
    extra: list[str] = []
    seen: set[str] = set()
    for token in tokenize(query):
        base = uz_base(token)
        if base == token:
            continue
        own = stem(token)
        for form in (base, base + "lar"):
            s = stem(form)
            if s != own and s in df and s not in seen:
                seen.add(s)
                extra.append(form)
    return f"{query} {' '.join(extra)}" if extra else query


def load(conn: Connection, tenant_id: str) -> GroupedCorpus:
    sig = _signature(conn, tenant_id)
    cached = _cache.get(tenant_id)
    if cached and cached.signature == sig:
        return cached
    rows = db.fetch_all(
        conn,
        """SELECT c.id, c.document_id, c.heading, c.text, c.token_count, c.embedding, c.terms_json,
                  d.title AS title, COALESCE(kp.grp, 'other') AS grp, COALESCE(kp.lang, d.language) AS lang
           FROM chunks c
           JOIN documents d ON d.id = c.document_id
           LEFT JOIN knowledge_pages kp ON kp.document_id = d.id
           WHERE c.tenant_id = :t AND d.status = 'ready'""",
        t=tenant_id,
    )
    # One matrix of the most common vector size; chunks of another size (an engine change) get a zero row.
    sizes = [len(r["embedding"]) // 4 for r in rows if r.get("embedding")]
    dim = max(set(sizes), key=sizes.count) if sizes else 0
    matrix = np.zeros((len(rows), dim), dtype=np.float32)
    for i, r in enumerate(rows):
        blob = r.get("embedding")
        if blob and len(blob) == dim * 4:
            matrix[i] = np.frombuffer(blob, dtype="<f4")
    # The vectors now live in the matrix only: without the blobs, building a (sub)corpus does not unpack
    # 1,536 floats per chunk into Python lists that the ranking would never read.
    rows = [{**r, "embedding": None} for r in rows]
    full = build_corpus(rows, sig)
    groups = np.array([r["grp"] for r in rows], dtype=object)
    langs = np.array([r["lang"] for r in rows], dtype=object)

    # A group's centroid is the normalised mean of its vectors; the length of that mean (0‥1) says how
    # alike the group's pages are: its "focus".
    centroids: dict[str, np.ndarray] = {}
    focus: dict[str, float] = {}
    for g in sorted(set(groups.tolist())):
        vecs = matrix[groups == g]
        vecs = vecs[np.any(vecs != 0, axis=1)]
        if not len(vecs):
            continue
        mean = vecs.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm > 1e-9:
            centroids[g] = mean / norm
            focus[g] = norm

    keywords: dict[str, list[list[str]]] = {}
    for g in db.fetch_all(conn, "SELECT id, keywords_json FROM knowledge_groups WHERE tenant_id = :t", t=tenant_id):
        try:
            words = [str(k) for k in json.loads(g["keywords_json"] or "[]")]
        except ValueError:
            words = []
        keywords[g["id"]] = [p for p in (_phrase_stems(w) for w in words) if p]

    grouped = GroupedCorpus(sig, rows, full, matrix, groups, langs, centroids, focus, keywords)
    _cache[tenant_id] = grouped
    return grouped


def subset(gc: GroupedCorpus, groups: tuple[str, ...], lang: str | None) -> tuple[Corpus, np.ndarray]:
    """The rows of these groups (all when empty) in this language (all when None), with their indices."""
    key = (groups, lang)
    if key not in gc.subsets:
        mask = np.ones(len(gc.rows), dtype=bool)
        if groups:
            mask &= np.isin(gc.groups, list(groups))
        if lang is not None:
            mask &= gc.langs == lang
        idx = np.flatnonzero(mask)
        corpus = build_corpus([gc.rows[i] for i in idx], f"{gc.signature}:{','.join(groups)}:{lang}")
        gc.subsets[key] = (corpus, idx)
    return gc.subsets[key]


def search(
    gc: GroupedCorpus,
    part: tuple[Corpus, np.ndarray],
    query: str,
    qv: np.ndarray | None,
    engine: str,
    *,
    top_k: int = 5,
    min_score: float = 0.06,
) -> RetrievalResult:
    """Rank one part of the corpus, its dense scores from one matrix product."""
    corpus, idx = part
    dense = (gc.matrix[idx] @ qv).astype(float).tolist() if qv is not None and len(idx) else None
    return rank(
        corpus,
        query,
        top_k=top_k,
        min_score=min_score,
        engine_id=engine,
        use_dense=dense is not None,
        dense_scores=dense,
    )


# ── routing ──────────────────────────────────────────────────────────


def score_groups(gc: GroupedCorpus, query: str, qv: np.ndarray | None, sticky: str | None) -> list[tuple[str, float]]:
    """Every group with a score, best first."""
    joined = f" {' '.join(_phrase_stems(normalize(query)))} "
    top_focus = max(gc.focus.values(), default=1.0)
    scores: list[tuple[str, float]] = []
    for g in sorted(set(gc.groups.tolist())):
        centroid = gc.centroids.get(g)
        score = float(centroid @ qv) if centroid is not None and qv is not None else 0.0
        if FOCUS_POWER and g in gc.focus:
            score *= (gc.focus[g] / top_focus) ** FOCUS_POWER
        hits = sum(1 for phrase in gc.keywords.get(g, []) if f" {' '.join(phrase)} " in joined)
        score += min(KEYWORD_CAP, KEYWORD_BONUS * hits)
        if g == sticky:
            score += STICKY_BONUS
        scores.append((g, score))
    scores.sort(key=lambda s: -s[1])
    return scores


def pick_groups(scores: list[tuple[str, float]]) -> tuple[str, ...]:
    if not scores:
        return ()
    best = [g for g, _ in scores[:GROUPS_SEARCHED]]
    if len(scores) > len(best) and scores[len(best)][1] >= scores[len(best) - 1][1] - RUNNER_UP_GAP:
        best.append(scores[len(best)][0])
    return tuple(best)


async def query_vector(query: str, gc: GroupedCorpus) -> tuple[np.ndarray | None, str]:
    """The query's vector from the engine the chunks were embedded with (None: words only)."""
    dim = gc.matrix.shape[1]
    engine = hosted_engine_id()
    if engine and dim and dim != LOCAL_DIM:
        try:
            vectors = await hosted_embed_query(query)
        except Exception as err:  # noqa: BLE001 - words alone still search
            log.warning("query embedding failed: %s", err)
            return None, engine
        vec = np.asarray(vectors[0], dtype=np.float32) if vectors else None
        return (vec if vec is not None and vec.shape[0] == dim else None), engine
    vec = np.asarray(local_embed(query), dtype=np.float32)
    return (vec if vec.shape[0] == dim else None), LOCAL_ENGINE_ID


def _load(tenant_id: str) -> GroupedCorpus:
    with db.connect() as conn:
        return load(conn, tenant_id)


def _route_and_rank(
    gc: GroupedCorpus,
    query: str,
    qv: np.ndarray | None,
    engine: str,
    language: str,
    threshold: float,
    sticky: str | None,
    top_k: int,
    min_score: float,
) -> tuple[RetrievalResult, tuple[str, ...], list[tuple[str, float]], str, int]:
    scores = score_groups(gc, query, qv, sticky)
    groups = pick_groups(scores)

    def run(part: tuple[Corpus, np.ndarray]) -> RetrievalResult:
        return search(gc, part, query, qv, engine, top_k=top_k, min_score=min_score)

    attempts: list[tuple[str, RetrievalResult]] = []
    in_lang = subset(gc, groups, language)
    attempts.append(("group", run(in_lang if len(in_lang[1]) >= MIN_LANG_CHUNKS else subset(gc, groups, None))))
    if attempts[0][1].confidence < threshold:
        same_lang = subset(gc, (), language)
        if len(same_lang[1]) >= MIN_LANG_CHUNKS:
            attempts.append(("all-groups", run(same_lang)))
        if max(a[1].confidence for a in attempts) < threshold:
            attempts.append(("everything", run(subset(gc, (), None))))
    scope, best = max(attempts, key=lambda a: a[1].confidence)  # first wins a tie: the narrowest search
    if groups:
        best = _keep_best_group(gc, best, groups[0], query, qv, engine, language, top_k, min_score)
    return best, groups, scores, scope, len(attempts)


def _keep_best_group(
    gc: GroupedCorpus,
    result: RetrievalResult,
    group: str,
    query: str,
    qv: np.ndarray | None,
    engine: str,
    language: str,
    top_k: int,
    min_score: float,
) -> RetrievalResult:
    """Make sure the best-scoring group is among the hits the model reads: its best chunk, or all of it.

    Several groups are searched together, and a small group loses to big ones on shared words: the rate
    pages (group "currency") lost to card and news pages for "100 dollarni so'mga almashtirmoqchiman"
    although the question was routed to "currency" first. A group of SMALL_GROUP_CHUNKS or fewer is one
    topic (the rates: individuals, with the "Yangilangan" time, then the app's rates, then companies), so
    all of it is passed; a bigger group passes its best chunk. They take the last places, so the order on
    top (and the confidence) is unchanged.
    """
    if not result.hits:
        return result
    part = subset(gc, (group,), language)
    if not len(part[1]):
        part = subset(gc, (group,), None)
    small = len(part[1]) <= SMALL_GROUP_CHUNKS
    if not small and len(result.hits) < top_k:
        return result  # room left: every match above the minimum score is in already
    own = search(gc, part, query, qv, engine, top_k=len(part[1]) if small else 1, min_score=0 if small else min_score)
    present = {h["chunkId"] for h in result.hits}
    missing = [h for h in own.hits if h["chunkId"] not in present]
    if not missing:
        return result
    keep = max(1, min(len(result.hits), top_k - len(missing)))
    kept = result.hits[:keep]
    floor = kept[-1]["score"]
    added = [{**h, "score": floor, "rank": keep + i + 1} for i, h in enumerate(missing[: top_k - keep])]
    return RetrievalResult(
        hits=[*kept, *added],
        confidence=result.confidence,
        took_ms=result.took_ms,
        strategy=result.strategy,
        total_chunks=result.total_chunks,
    )


async def retrieve_routed(
    tenant_id: str,
    query: str,
    *,
    language: str,
    threshold: float,
    call_id: str | None = None,
    top_k: int = 5,
    min_score: float = 0.06,
) -> RetrievalResult:
    started = time.perf_counter()
    # Loading (the first question after a change) and ranking are CPU work: a worker thread keeps the
    # API serving other calls meanwhile (numpy releases the GIL during the matrix products).
    gc = await asyncio.to_thread(_load, tenant_id)
    if not gc.rows:
        return rank(gc.full, query, top_k=top_k, min_score=min_score)

    qv, engine = await query_vector(query, gc)  # the question as asked: the vector reads whole words
    words = expand_query(query, gc.full.df) if language == "uz" else query
    best, groups, scores, scope, tries = await asyncio.to_thread(
        _route_and_rank, gc, words, qv, engine, language, threshold, sticky_group(call_id), top_k, min_score
    )
    best.strategy = f"routed:{best.strategy}"
    best.took_ms = (time.perf_counter() - started) * 1000
    best.extra = {
        "routing": {
            "groups": list(groups),
            "scores": [{"group": g, "score": round(s, 3)} for g, s in scores[:4]],
            "language": language,
            "scope": scope,
            "attempts": tries,
        }
    }
    # The group the answer came from becomes the hint for the caller's next question.
    if best.hits and call_id:
        top_doc = best.hits[0]["documentId"]
        remember(call_id, next((r["grp"] for r in gc.rows if r["document_id"] == top_doc), None))
    return best
