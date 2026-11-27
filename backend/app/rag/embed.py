"""
Local embeddings — port of src/lib/rag/embed.ts, bit for bit.

A hashed random-projection encoder over stems, character n-grams, concept
tokens and bigrams (384 dims, L2-normalised). Vectors already stored in
`chunks.embedding` were made by the TypeScript version, so a query vector made
here must be identical, or dense search would silently degrade. That means:

- FNV-1a runs over UTF-16 code units (JavaScript `charCodeAt`), 32-bit wrap;
- the vector is a Float32Array: every addition is rounded to float32;
- additions happen in the same order (term insertion order, then bigrams).
"""

import asyncio
import math
import struct
import weakref

from app.jscompat import f32, js_log, utf16_units
from app.rag.text import char_ngrams, concept_of, stem, tokenize

LOCAL_DIM = 384
LOCAL_ENGINE_ID = "ovoz-hashed-ngram-384"

_SEED_2 = (0x811C9DC5 ^ 0x9E3779B9) & 0xFFFFFFFF
_SEED_3 = 0x1B873593


def hash32(s: str, seed: int = 2166136261) -> int:
    """FNV-1a, 32-bit unsigned, over UTF-16 code units (as `hash32` in embed.ts)."""
    h = seed
    for unit in utf16_units(s):
        h = ((h ^ unit) * 16777619) & 0xFFFFFFFF
    return h


def _add_feature(vec: list[float], feature: str, weight: float) -> None:
    h1 = hash32(feature)
    h2 = hash32(feature, _SEED_2)
    h3 = hash32(feature, _SEED_3)
    dim = len(vec)
    # Same operation order as the TypeScript (weight * 0.72 * sign), rounded to float32 on store.
    vec[h1 % dim] = f32(vec[h1 % dim] + weight * (1 if (h1 & 1) == 0 else -1))
    vec[h2 % dim] = f32(vec[h2 % dim] + weight * 0.72 * (1 if (h2 & 2) == 0 else -1))
    vec[h3 % dim] = f32(vec[h3 % dim] + weight * 0.48 * (1 if (h3 & 4) == 0 else -1))


def local_embed(text: str, dim: int = LOCAL_DIM) -> list[float]:
    vec = [0.0] * dim
    tokens = tokenize(text)
    if not tokens:
        return vec

    # Sub-linear term frequency (dict keeps insertion order, like the TypeScript Map).
    tf: dict[str, int] = {}
    for t in tokens:
        s = stem(t)
        tf[s] = tf.get(s, 0) + 1

    for term, count in tf.items():
        w = 1 + js_log(count)
        _add_feature(vec, f"t:{term}", w)
        grams = char_ngrams(term)
        gw = (w * 0.42) / math.sqrt(len(grams) or 1)
        for g in grams:
            _add_feature(vec, f"g:{g}", gw)
        concept = concept_of(term)
        if concept:
            _add_feature(vec, f"c:{concept}", w * 0.65)

    # Bigrams capture short phrases ("qabul vaqti", "страховой полис").
    for i in range(len(tokens) - 1):
        _add_feature(vec, f"b:{stem(tokens[i])}_{stem(tokens[i + 1])}", 0.55)

    return l2normalize(vec)


# Plain left-to-right loops on purpose: Python 3.12's sum() uses compensated
# summation, which is more accurate than JavaScript's `+=` and so not identical.


def l2normalize(v: list[float]) -> list[float]:
    total = 0.0
    for x in v:
        total += x * x
    norm = math.sqrt(total)
    if norm > 1e-9:
        return [f32(x / norm) for x in v]
    return v


def cosine(a: list[float], b: list[float]) -> float:
    """Dot product (vectors are already normalised); over the shorter length, as in the TypeScript."""
    dot = 0.0
    for x, y in zip(a, b, strict=False):
        dot += x * y
    return dot


# ── serialisation (chunks.embedding BLOB) ──────────────────────────


def pack_vector(v: list[float]) -> bytes:
    """Raw little-endian float32, no header — what the TypeScript stores."""
    return struct.pack(f"<{len(v)}f", *v)


def unpack_vector(blob: bytes | None) -> list[float] | None:
    if not blob or len(blob) < 4:
        return None
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob[: n * 4]))


# ── hosted embeddings (OpenAI), as `embeddingEngine()` in embed.ts ──


def hosted_engine_id() -> str | None:
    """The OpenAI embedding model when OPENAI_API_KEY is set (1536 dims), else None (local engine)."""
    from app.env import env

    return env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small") if env("OPENAI_API_KEY") else None


async def hosted_embed(texts: list[str]) -> list[list[float]]:
    """L2-normalised float32 vectors from OpenAI. Raises on any failure (callers fall back to words)."""
    from app import http
    from app.env import env
    from app.jscompat import js_json

    model = env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    res = await http.client().post(
        "https://api.openai.com/v1/embeddings",
        headers={"content-type": "application/json", "authorization": f"Bearer {env('OPENAI_API_KEY')}"},
        content=js_json({"model": model, "input": texts}).encode(),
    )
    if not res.is_success:
        raise RuntimeError(f"Embedding request failed: {res.status_code}")
    return [l2normalize([f32(x) for x in d["embedding"]]) for d in res.json()["data"]]


def query_deadline_s() -> float | None:
    """How long a caller's question may wait for its OpenAI vector (EMBED_QUERY_DEADLINE_MS; 0 or off: no limit)."""
    from app.env import env

    raw = (env("EMBED_QUERY_DEADLINE_MS") or "").strip()
    if raw.lower() == "off":
        return None
    try:
        ms = float(raw) if raw else 300.0
    except ValueError:
        ms = 300.0
    return ms / 1000 if ms > 0 else None


_QUERY_CACHE: dict[tuple[str, str], tuple[float, list[list[float]]]] = {}
QUERY_CACHE_TTL_S = 600.0
BATCH_WAIT_S = 0.005  # questions asked this close together go to OpenAI as one request
_batches: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, list[tuple[str, asyncio.Future]]]" = (
    weakref.WeakKeyDictionary()
)


def _cache_key(query: str) -> tuple[str, str]:
    from app.env import env

    return (env("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"), query)


async def _flush_batch(loop: asyncio.AbstractEventLoop) -> None:
    import time

    await asyncio.sleep(BATCH_WAIT_S)
    batch = _batches.pop(loop, [])
    texts = list(dict.fromkeys(q for q, _f in batch))
    try:
        vectors = await hosted_embed(texts)
    except Exception as err:  # noqa: BLE001 - each waiting search falls back to words alone
        for _q, fut in batch:
            if not fut.done():
                fut.set_exception(err)
        return
    by_text = dict(zip(texts, vectors, strict=False))
    if len(_QUERY_CACHE) > 1000:
        _QUERY_CACHE.clear()
    for text, vec in by_text.items():
        _QUERY_CACHE[_cache_key(text)] = (time.monotonic(), [vec])  # kept even if its search gave up
    for q, fut in batch:
        if not fut.done():
            fut.set_result([by_text[q]] if q in by_text else [])


async def _embed_together(query: str) -> list[list[float]]:
    """The query's vector, fetched in one request with any other question asked within BATCH_WAIT_S."""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future = loop.create_future()
    batch = _batches.setdefault(loop, [])
    batch.append((query, fut))
    if len(batch) == 1:
        loop.create_task(_flush_batch(loop))
    return await fut


async def hosted_embed_query(query: str) -> list[list[float]]:
    """
    The question's vector. The same question asked again within 10 minutes (the turn after its early
    start, a repeated question) reuses it, and questions searched side by side (a follow-up and the same
    words in context) share one request. In a Playground turn it waits at most `query_deadline_s` (about
    0.3 s): slower raises TimeoutError and the search goes on with words alone.
    """
    import time

    from app.engine.live_turn import in_playground

    hit = _QUERY_CACHE.get(_cache_key(query))
    if hit is not None and time.monotonic() - hit[0] < QUERY_CACHE_TTL_S:
        return hit[1]
    deadline = query_deadline_s() if in_playground() else None
    if deadline is None:
        return await _embed_together(query)
    async with asyncio.timeout(deadline):
        return await _embed_together(query)
