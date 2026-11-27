"""
Time limits on a live turn (Q2): the backup model joins when the chosen model is silent too long,
the first to speak answers, the local engine answers when neither does, and a caller's question
waits only so long for its OpenAI vector. Models are scripted; times are scaled down.
"""

import asyncio
import json
import time

import pytest

from app.engine.live_turn import playground_turn
from app.llm import provider
from app.llm.prompts import GenerateInput
from app.rag import embed

ANSWER = {"answered": True, "usedExcerpts": []}


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch, data_dir) -> None:  # noqa: ANN001
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")
    monkeypatch.setenv("LLM_BACKUP_AFTER_MS", "100")
    monkeypatch.setenv("LLM_GIVE_UP_MS", "400")
    provider.claude.client()  # built once per process (about 2 s the first time), as on a running server


def _inp() -> GenerateInput:
    return GenerateInput(
        question="Qancha qarzim qoldi?",
        hits=[],
        confidence=0.0,
        language="uz",
        agent_name="Laylo",
        threshold=0.5,
        llm="openai:gpt-5.5",
    )


def _model(log: list[str], name: str, *, first_after: float | None, text: str, fail: bool = False):  # noqa: ANN202
    """A scripted streaming model: silent for `first_after` s (None: forever), then the whole answer."""

    async def speak(on_answer) -> str | None:  # noqa: ANN001
        log.append(f"{name} start")
        try:
            if fail:
                return None
            await asyncio.sleep(3600 if first_after is None else first_after)
            on_answer(text)
            log.append(f"{name} spoke")
            return json.dumps({"answer": text, **ANSWER})
        except asyncio.CancelledError:
            log.append(f"{name} cancelled")
            raise

    return speak


def _wire(monkeypatch: pytest.MonkeyPatch, chosen, backup) -> None:  # noqa: ANN001
    async def openai_stream(system, user, on_answer=None, call=None):  # noqa: ANN001, ANN202
        return await chosen(on_answer)

    async def claude_stream(model, system, user, on_answer, call):  # noqa: ANN001, ANN202
        assert model == "claude-haiku-5-5"
        return await backup(on_answer)

    monkeypatch.setattr(provider.openai, "openai_json_stream", openai_stream)
    monkeypatch.setattr(provider.claude, "json_stream", claude_stream)


def _run(inp: GenerateInput) -> tuple[dict, list[str], float]:
    heard: list[str] = []

    async def go() -> dict:
        return await provider.generate_answer(inp, heard.append)

    t = time.perf_counter()
    out = asyncio.run(go())
    return out, heard, time.perf_counter() - t


def test_a_quick_model_answers_alone(keys, monkeypatch) -> None:  # noqa: ANN001
    log: list[str] = []
    _wire(
        monkeypatch,
        _model(log, "gpt", first_after=0.02, text="Asosiy javob"),
        _model(log, "haiku", first_after=0.0, text="Zaxira"),
    )
    out, heard, took = _run(_inp())
    assert out["answer"] == "Asosiy javob" and out["engine"] == "openai:gpt-5.5"
    assert heard == ["Asosiy javob"] and log == ["gpt start", "gpt spoke"]  # the backup never started
    assert took < 0.5


def test_a_silent_model_is_overtaken_by_the_backup(keys, monkeypatch) -> None:  # noqa: ANN001
    log: list[str] = []
    _wire(
        monkeypatch,
        _model(log, "gpt", first_after=None, text="never"),
        _model(log, "haiku", first_after=0.05, text="Zaxira javob"),
    )
    out, heard, took = _run(_inp())
    assert out["answer"] == "Zaxira javob" and out["engine"] == "claude:claude-haiku-5-5 (fallback)"
    assert heard == ["Zaxira javob"]  # only the model that answers is heard
    assert log == ["gpt start", "haiku start", "haiku spoke", "gpt cancelled"]
    assert 0.14 <= took < 0.3  # joined at 0.1 s, spoke 0.05 s later


def test_the_chosen_model_still_answers_if_it_speaks_first(keys, monkeypatch) -> None:  # noqa: ANN001
    log: list[str] = []
    _wire(
        monkeypatch,
        _model(log, "gpt", first_after=0.13, text="Asosiy javob"),
        _model(log, "haiku", first_after=0.2, text="Zaxira"),
    )
    out, heard, _ = _run(_inp())
    assert out["answer"] == "Asosiy javob" and out["engine"] == "openai:gpt-5.5"
    assert heard == ["Asosiy javob"]
    assert log == ["gpt start", "haiku start", "gpt spoke", "haiku cancelled"]


def test_neither_speaks_the_local_engine_answers_at_the_give_up_time(keys, monkeypatch) -> None:  # noqa: ANN001
    log: list[str] = []
    _wire(monkeypatch, _model(log, "gpt", first_after=None, text="x"), _model(log, "haiku", first_after=None, text="y"))
    out, heard, took = _run(_inp())
    assert out["engine"] == "local" and out["answer"]
    assert heard == []  # nothing half-said by either model
    assert sorted(log) == ["gpt cancelled", "gpt start", "haiku cancelled", "haiku start"]
    assert 0.38 <= took < 0.6


def test_a_model_that_fails_at_once_is_rescued_without_waiting(keys, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("LLM_BACKUP_AFTER_MS", "800")
    log: list[str] = []
    _wire(
        monkeypatch,
        _model(log, "gpt", first_after=0, text="", fail=True),
        _model(log, "haiku", first_after=0.01, text="Zaxira javob"),
    )
    out, heard, took = _run(_inp())
    assert out["engine"].endswith("(fallback)") and heard == ["Zaxira javob"]
    assert took < 0.6  # well before the 0.8 s join: the failure was known at once


def test_turned_off_the_chosen_model_is_waited_for(keys, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("LLM_BACKUP_AFTER_MS", "0")
    log: list[str] = []
    _wire(
        monkeypatch,
        _model(log, "gpt", first_after=0.25, text="Asosiy javob"),
        _model(log, "haiku", first_after=0.0, text="Zaxira"),
    )
    out, _, took = _run(_inp())
    assert out["engine"] == "openai:gpt-5.5" and log == ["gpt start", "gpt spoke"] and took >= 0.25


def test_no_backup_when_it_is_the_chosen_model(keys, monkeypatch) -> None:  # noqa: ANN001
    log: list[str] = []
    _wire(monkeypatch, _model(log, "gpt", first_after=0, text="x"), _model(log, "haiku", first_after=0.2, text="Haiku"))
    inp = _inp()
    inp.llm = "anthropic:claude-haiku-5-5"
    out, heard, _ = _run(inp)
    assert out["engine"] == "claude:claude-haiku-5-5" and heard == ["Haiku"] and log == ["haiku start", "haiku spoke"]


def test_a_discarded_turn_cancels_both_models(keys, monkeypatch) -> None:  # noqa: ANN001
    """An early answer thrown away (the caller went on) must not leave either model running."""
    log: list[str] = []
    _wire(monkeypatch, _model(log, "gpt", first_after=None, text="x"), _model(log, "haiku", first_after=None, text="y"))

    async def go() -> None:
        task = asyncio.ensure_future(provider.generate_answer(_inp(), lambda d: None))
        await asyncio.sleep(0.15)  # past the join: both are running
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)

    asyncio.run(go())
    assert sorted(log) == ["gpt cancelled", "gpt start", "haiku cancelled", "haiku start"]


def test_the_settings(monkeypatch) -> None:  # noqa: ANN001
    for raw, join in (("", 1.5), ("2500", 2.5), ("0", None), ("off", None), ("junk", 1.5)):
        monkeypatch.setenv("LLM_BACKUP_AFTER_MS", raw)
        assert provider._backup_joins_after_s() == join
    monkeypatch.delenv("LLM_GIVE_UP_MS", raising=False)
    assert provider._give_up_after_s() == 3.0
    monkeypatch.delenv("EMBED_QUERY_DEADLINE_MS", raising=False)
    assert embed.query_deadline_s() == 0.3
    monkeypatch.setenv("EMBED_QUERY_DEADLINE_MS", "off")
    assert embed.query_deadline_s() is None


def test_a_slow_question_vector_gives_up_in_time(monkeypatch) -> None:  # noqa: ANN001
    async def slow(texts):  # noqa: ANN001, ANN202
        await asyncio.sleep(2)
        return [[1.0]]

    async def quick(texts):  # noqa: ANN001, ANN202
        return [[1.0]]

    monkeypatch.setenv("EMBED_QUERY_DEADLINE_MS", "100")
    monkeypatch.setattr(embed, "hosted_embed", slow)
    embed._QUERY_CACHE.clear()
    t = time.perf_counter()
    with playground_turn(), pytest.raises(TimeoutError):  # retrieve/routing catch it and rank by words alone
        asyncio.run(embed.hosted_embed_query("Qancha qarzim qoldi?"))
    assert time.perf_counter() - t < 0.3
    monkeypatch.setattr(embed, "hosted_embed", quick)
    assert asyncio.run(embed.hosted_embed_query("x")) == [[1.0]]


def test_outside_the_playground_a_slow_vector_is_waited_for(monkeypatch) -> None:  # noqa: ANN001
    async def slowish(texts):  # noqa: ANN001, ANN202
        await asyncio.sleep(0.2)
        return [[1.0]]

    monkeypatch.setenv("EMBED_QUERY_DEADLINE_MS", "100")
    monkeypatch.setattr(embed, "hosted_embed", slowish)
    embed._QUERY_CACHE.clear()
    assert asyncio.run(embed.hosted_embed_query("phone call question")) == [[1.0]]


def test_a_slow_hand_off_summary_gives_way_to_the_local_one(keys, monkeypatch) -> None:  # noqa: ANN001
    async def hung(system, user, max_tokens, call):  # noqa: ANN001, ANN202
        await asyncio.sleep(3600)

    monkeypatch.setenv("SUMMARY_DEADLINE_MS", "150")
    monkeypatch.setattr(provider.openai, "openai_text", hung)
    turns = [{"role": "caller", "text": "Qarzim qancha?"}, {"role": "agent", "text": "Tekshiraman."}]
    t = time.perf_counter()
    with playground_turn():  # phone calls keep waiting for the model's summary, as before
        text = asyncio.run(provider.summarize_call(turns, "uz", "low_confidence", "openai:gpt-5.5"))
    assert text == provider.summarize_local(turns, "uz", "low_confidence")
    assert time.perf_counter() - t < 0.4


def test_openai_reuses_the_agent_prompt_in_playground_turns(monkeypatch) -> None:  # noqa: ANN001
    """Q11: a stable `prompt_cache_key` from the system prompt, in Playground turns only (phone/API unchanged)."""
    from app.llm import openai

    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert openai._cache_key("SYSTEM") == {}  # outside a Playground turn: the request is as before
    with playground_turn():
        first = openai._cache_key("SYSTEM")
        assert first["prompt_cache_key"].startswith("callmind-")
        assert openai._cache_key("SYSTEM") == first  # same prompt, same key: reused turn after turn
        assert openai._cache_key("EDITED") != first  # an edited agent starts a new one
        monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:1234/v1")
        assert openai._cache_key("SYSTEM") == {}  # another OpenAI-compatible server: not sent
