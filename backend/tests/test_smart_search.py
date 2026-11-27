"""
Q3, the knowledge-base search at a smarter time (Playground turns only): a phrase with no question in it
skips the search and keeps the call's last facts, a follow-up's two searches run side by side, and a
question's vector is reused. Outside a Playground turn everything works as before.
"""

import asyncio
import time

import pytest

from app.engine import conversation, live_turn
from app.engine.live_turn import is_small_talk, playground_turn
from app.rag import embed
from app.rag.retrieve import RetrievalResult

AGENT = {
    "id": "agt_t",
    "tenant_id": "ten_t",
    "name": "Laylo",
    "confidence_threshold": 0.55,
    "persona": None,
    "instructions": None,
    "greeting": None,
    "hours_json": "{}",
    "llm_model": None,
}
HISTORY = [
    {"role": "caller", "text": "Kredit foizi qancha?"},
    {"role": "agent", "text": "Avtokredit yillik 24 foiz. Kurslarni ham aytaymi?"},
]


@pytest.mark.parametrize(
    "phrase",
    ["ha", "Ha.", "xo'p", "xo‘p", "xop", "ha mayli", "Ha, rahmat!", "katta rahmat", "Assalomu alaykum",
     "ha-ha", "sog' bo'ling", "kerak emas", "yo'g'e", "allo", "mm", "Tushunarli"],
)  # fmt: skip
def test_small_talk(phrase: str) -> None:
    assert is_small_talk(phrase)


@pytest.mark.parametrize(
    "phrase",
    ["ha, qancha qarzim bor?", "rahmat, kurs qancha?", "ha ha ha ha", "", "  ", "yo'q emas", "salom alaykum",
     "Qancha qarzim qoldi?", "5", "ha 5"],
)  # fmt: skip
def test_not_small_talk(phrase: str) -> None:
    assert not is_small_talk(phrase)


@pytest.fixture
def searches(monkeypatch: pytest.MonkeyPatch, data_dir) -> list[tuple[str, float, float]]:  # noqa: ANN001
    """The plain search, scripted: each query takes 0.1 s; returns (query, start, end) per search."""
    log: list[tuple[str, float, float]] = []

    async def fake(tenant_id, query, top_k=5):  # noqa: ANN001, ANN202
        start = time.perf_counter()
        await asyncio.sleep(0.1)
        log.append((query, start, time.perf_counter()))
        weak = "\n" not in query  # the bare follow-up is weak, the one in context is strong
        conf = 0.3 if weak else 0.8
        return RetrievalResult(
            hits=[{"documentId": "d", "q": query}], confidence=conf, took_ms=1, strategy="hybrid", total_chunks=3
        )

    monkeypatch.setattr(conversation, "retrieve_async", fake)
    monkeypatch.setattr(conversation, "knowledge_tenant", lambda conn, agent, tenant_id: tenant_id)
    monkeypatch.setattr(conversation, "has_grouped_knowledge", lambda conn, tenant: False)
    live_turn._last_facts.clear()
    return log


def _plan(utterance: str, history: list | None = None, call_id: str = "cal_t", playground: bool = True):  # noqa: ANN202
    async def go():  # noqa: ANN202
        return await conversation.plan_reply(
            tenant_id="ten_t",
            agent=AGENT,
            utterance=utterance,
            model_history=history or [],
            target={},
            call_id=call_id,
        )

    if playground:
        with playground_turn():
            return asyncio.run(go())
    return asyncio.run(go())


def test_small_talk_skips_the_search_and_keeps_the_last_facts(searches) -> None:  # noqa: ANN001
    first = _plan("Avtokredit foizi qancha?")
    assert len(searches) == 1 and first.retrieval.hits
    plan = _plan("ha", HISTORY)
    assert len(searches) == 1  # no new search
    assert plan.retrieval.hits == first.retrieval.hits and plan.retrieval.strategy == "reused:hybrid"
    assert plan.retrieval_ms < 50
    # A new call has no facts yet: nothing is looked up, nothing is passed.
    fresh = _plan("rahmat", call_id="cal_other")
    assert fresh.retrieval.hits == [] and fresh.retrieval.strategy == "skipped:small_talk" and len(searches) == 1


def test_a_question_after_small_talk_is_searched(searches) -> None:  # noqa: ANN001
    _plan("ha")
    _plan("ha, qancha qarzim bor?")
    assert [q for q, _s, _e in searches] == ["ha, qancha qarzim bor?"]


def test_follow_up_searches_run_side_by_side(searches) -> None:  # noqa: ANN001
    t = time.perf_counter()
    plan = _plan("foizi-chi?", HISTORY)
    took = time.perf_counter() - t
    (q1, s1, e1), (q2, s2, e2) = sorted(searches, key=lambda r: r[1])
    assert s2 < e1  # the second started before the first ended
    assert took < 0.18  # one search's time, not two
    assert "\n" in plan.retrieval.hits[0]["q"]  # the stronger search in context was kept


def test_outside_the_playground_nothing_changes(searches) -> None:  # noqa: ANN001
    _plan("ha", HISTORY, playground=False)
    # Searched as before, and (weak) searched again in context, one after the other.
    assert [q for q, _s, _e in searches] == ["ha", "Kredit foizi qancha?\nha"]
    searches.clear()
    t = time.perf_counter()
    _plan("foizi-chi?", HISTORY, playground=False)
    assert time.perf_counter() - t >= 0.2  # the follow-up search after the first, as before
    (_q1, _s1, e1), (_q2, s2, _e2) = sorted(searches, key=lambda r: r[1])
    assert s2 >= e1


def test_kb_smart_search_off(searches, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("KB_SMART_SEARCH", "off")
    _plan("ha", HISTORY)
    assert len(searches) == 2  # the old way: the search, then the follow-up search


def test_a_question_vector_is_reused(monkeypatch) -> None:  # noqa: ANN001
    calls: list[list[str]] = []

    async def hosted(texts):  # noqa: ANN001, ANN202
        calls.append(texts)
        return [[0.6, 0.8]]

    monkeypatch.setattr(embed, "hosted_embed", hosted)
    embed._QUERY_CACHE.clear()
    assert asyncio.run(embed.hosted_embed_query("Qancha qarzim qoldi?")) == [[0.6, 0.8]]
    assert asyncio.run(embed.hosted_embed_query("Qancha qarzim qoldi?")) == [[0.6, 0.8]]
    assert calls == [["Qancha qarzim qoldi?"]]  # asked once (the early start), reused by the turn


def test_questions_searched_side_by_side_share_one_request(monkeypatch) -> None:  # noqa: ANN001
    calls: list[list[str]] = []

    async def hosted(texts):  # noqa: ANN001, ANN202
        calls.append(list(texts))
        await asyncio.sleep(0.05)
        return [[float(i)] for i, _ in enumerate(texts)]

    monkeypatch.setattr(embed, "hosted_embed", hosted)
    embed._QUERY_CACHE.clear()

    async def both():  # noqa: ANN202
        return await asyncio.gather(
            embed.hosted_embed_query("foizi-chi?"), embed.hosted_embed_query("Kredit?\nfoizi-chi?")
        )

    assert asyncio.run(both()) == [[[0.0]], [[1.0]]]
    assert calls == [["foizi-chi?", "Kredit?\nfoizi-chi?"]]  # one request, not two
