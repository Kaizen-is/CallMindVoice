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

import math
import struct

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
