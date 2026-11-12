"""
The Python knowledge-base search must reproduce the TypeScript version exactly.

`fixtures/golden_rag.json` holds what the ORIGINAL TypeScript modules
(src/lib/rag/{text,embed,chunk,retrieve}.ts) returned for fixed inputs:
normalisation, tokens, stems, language, sentences, highlights, embeddings
(raw float32 bytes), chunks of five documents, and 25 searches over a corpus
built the way ingest.ts stores it. Every value is compared exactly — vectors
byte for byte, scores bit for bit — because the live database holds vectors
and term counts made by the TypeScript code.
"""

import base64
import json
from pathlib import Path

import pytest

from app.rag import chunk, embed, retrieve, text

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_rag.json").read_text(encoding="utf-8"))
STRINGS = GOLDEN["strings"]


@pytest.mark.parametrize("case", STRINGS, ids=[f"s{i}" for i in range(len(STRINGS))])
def test_text_functions(case):
    s = case["input"]
    tokens = text.tokenize(s)
    assert text.normalize(s) == case["normalize"]
    assert tokens == case["tokenize"]
    assert text.tokenize(s, keep_stopwords=True) == case["tokenizeAll"]
    assert text.stems(s) == case["stems"]
    assert [text.concept_of(text.stem(t)) for t in tokens] == case["concepts"]
    assert (text.char_ngrams(tokens[0]) if tokens else []) == case["ngrams"]
    assert text.detect_language(s) == case["language"]
    assert text.estimate_tokens(s) == case["estimateTokens"]
    assert text.sentences(s) == case["sentences"]
    assert [list(p) for p in text.highlight(s, "kredit hujjat narx karta")] == case["highlight"]


@pytest.mark.parametrize("case", STRINGS, ids=[f"s{i}" for i in range(len(STRINGS))])
def test_local_embedding_is_bit_identical(case):
    assert base64.b64encode(embed.pack_vector(embed.local_embed(case["input"]))).decode() == case["embedding"]


@pytest.mark.parametrize("doc", GOLDEN["chunks"], ids=[d["id"] for d in GOLDEN["chunks"]])
def test_chunking(doc):
    got = [
        {"heading": c.heading, "text": c.text, "tokenCount": c.token_count}
        for c in chunk.chunk_document(doc["text"], doc["title"])
    ]
    assert got == doc["chunks"]


def test_faq_chunks():
    pairs = [
        {"q": "Kredit qancha muddatga beriladi?", "a": "36 oygacha."},
        {"q": "  Karta yo‘qolsa nima qilish kerak?  ", "a": " 1600 ga qo‘ng‘iroq qiling. "},
        {"q": "empty answer", "a": "   "},
    ]
    got = [{"heading": c.heading, "text": c.text, "tokenCount": c.token_count} for c in chunk.chunk_faq(pairs)]
    assert got == GOLDEN["faq"]


def _ingest_counts(chunk_text: str, heading: str | None) -> dict[str, int]:
    """Term counts exactly as ingest.ts stores them in chunks.terms_json."""
    counts: dict[str, int] = {}
    for t in text.stems(chunk_text):
        counts[t] = counts.get(t, 0) + 1
    if heading:
        for t in text.stems(heading):
            counts[t] = counts.get(t, 0) + 2
    return counts


@pytest.mark.parametrize("row", GOLDEN["corpus"], ids=[r["id"] for r in GOLDEN["corpus"]])
def test_stored_chunk_data(row):
    assert _ingest_counts(row["text"], row["heading"]) == json.loads(row["terms_json"])
    assert base64.b64encode(embed.pack_vector(embed.local_embed(row["text"]))).decode() == row["embedding"]


def _corpus() -> retrieve.Corpus:
    rows = [{**r, "embedding": base64.b64decode(r["embedding"])} for r in GOLDEN["corpus"]]
    return retrieve.build_corpus(rows, "golden")


QUERIES = GOLDEN["retrievals"]


@pytest.mark.parametrize("case", QUERIES, ids=[f"q{i}" for i in range(len(QUERIES))])
def test_retrieval_scores_are_identical(case):
    result = retrieve.rank(_corpus(), case["query"], top_k=5)
    got = [
        {k: h[k] for k in ("chunkId", "score", "lexicalScore", "denseScore", "rank", "snippet")} for h in result.hits
    ]
    assert got == case["hits"]
    assert result.confidence == case["confidence"]
    assert result.strategy == case["strategy"]
    assert result.total_chunks == case["totalChunks"]
