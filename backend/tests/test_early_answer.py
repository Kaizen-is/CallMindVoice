"""
The early start (app/engine/early.py): the Playground offers the phrase at 0.35 s of quiet and the
answer begins then; the turn at 0.8 s takes it only when its own input is exactly the same.

The point of these tests: an early answer never changes what the model is asked. When it is used,
the model's input is identical to the input a turn without any early start builds; when anything
differs (the caller went on, a turn landed in between, the agent changed), it is thrown away and
the turn asks the model itself. The model is a fake that records every input it is given.
"""

import asyncio
import dataclasses
from typing import Any

import pytest

from app import playground_voice as pv
from app.engine import conversation, early
from app.engine.early import EarlyAnswer, fingerprint
from tests import test_playground_routes as routes
from tests.test_playground_routes import _events, _open_call, _seed_agent

# The Playground route tests' fixtures: a logged-in client, a scripted TTS, fresh call state.
api = routes.api
voiced = routes.voiced
_fresh_voice_state = routes._fresh_voice_state


class FakeModel:
    """Answers "Javob: <question>" in four pieces, a little apart, and records what it was asked."""

    def __init__(self) -> None:
        self.asked: list[Any] = []  # GenerateInput, in order
        self.finished: list[str] = []  # questions answered to the end
        self.cancelled: list[str] = []

    async def __call__(self, inp, on_delta=None):  # noqa: ANN001, ANN204
        self.asked.append(inp)
        answer = f"Javob: {inp.question}"
        words = answer.split(" ")
        try:
            for i, word in enumerate(words):
                await asyncio.sleep(0.02)
                if on_delta:
                    on_delta(word if i == 0 else f" {word}")
        except asyncio.CancelledError:
            self.cancelled.append(inp.question)
            raise
        self.finished.append(inp.question)
        return {"answer": answer, "intent": "other", "answered": True, "usedHits": [], "engine": "fake:model"}


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> FakeModel:
    fake = FakeModel()
    monkeypatch.setattr(conversation, "generate_answer", fake)
    monkeypatch.setattr(early, "generate_answer", fake)
    yield fake
    for cid in list(pv._early):
        pv.drop_early(cid)


def _turn(api, call_id: str, text: str, ahead: str | None = None) -> list[dict]:  # noqa: ANN001
    form = {"callId": call_id, "text": text}
    if ahead is not None:
        res = api.post("/playground/turn?prefetch=1", data={"callId": call_id, "text": ahead})
        assert res.status_code == 202
    return _events(api.post("/playground/turn", data=form))


def _final(events: list[dict]) -> dict:
    return next(e for e in events if e["t"] == "final")


def _without_now(inp) -> dict:  # noqa: ANN001
    return {k: v for k, v in dataclasses.asdict(inp).items() if k != "now"}


def test_used_when_the_input_is_the_same_and_the_model_is_asked_once(api, sql, voiced, model) -> None:  # noqa: ANN001
    agent_id = _seed_agent(sql)
    # A turn with no early start: what the model is asked today.
    plain_call = _open_call(api, agent_id)
    plain = _final(_turn(api, plain_call, "Qancha qarzim qoldi?"))
    assert plain["ms"]["early"] == 0 and len(model.asked) == 1
    plain_input = model.asked[0]

    # The same phrase with an early start: asked once, the same input, the same reply, sooner.
    call_id = _open_call(api, agent_id)
    events = _turn(api, call_id, "Qancha qarzim qoldi?", ahead="Qancha qarzim qoldi?")
    final = _final(events)
    assert final["ms"]["early"] == 1
    assert len(model.asked) == 2 and model.cancelled == []
    assert _without_now(model.asked[1]) == _without_now(plain_input)  # byte for byte the same input
    assert final["text"] == plain["text"] == "Javob: Qancha qarzim qoldi?"
    # What was shown piece by piece is that reply, in order, nothing doubled or lost at the hand-over.
    shown = [e["text"] for e in events if e["t"] in ("reply", "more")]
    assert shown[-1] == final["text"]
    # And the transcript is written as a normal turn.
    rows = sql("SELECT role, text FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)
    assert rows[-2:] == [("caller", "Qancha qarzim qoldi?"), ("agent", "Javob: Qancha qarzim qoldi?")]


def test_thrown_away_when_the_caller_goes_on(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    events = _turn(api, call_id, "Hozir pulim yo'q. Lekin ertaga to'layman.", ahead="Hozir pulim yo'q.")
    final = _final(events)
    assert final["ms"]["early"] == 0
    # The half phrase was asked early but never used; the reply answers the whole phrase.
    assert [a.question for a in model.asked] == ["Hozir pulim yo'q.", "Hozir pulim yo'q. Lekin ertaga to'layman."]
    assert "Hozir pulim yo'q." in model.cancelled or "Hozir pulim yo'q." in model.finished
    assert final["text"] == "Javob: Hozir pulim yo'q. Lekin ertaga to'layman."
    shown = [e["text"] for e in events if e["t"] in ("reply", "more")]
    assert shown[-1] == final["text"] and all(final["text"].startswith(s) for s in shown)  # one answer, grown


def test_a_newer_pause_replaces_the_older_early_answer(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    assert api.post("/playground/turn?prefetch=1", data={"callId": call_id, "text": "Hozir"}).status_code == 202
    final = _final(_turn(api, call_id, "Hozir pulim yo'q.", ahead="Hozir pulim yo'q."))
    assert final["ms"]["early"] == 1 and final["text"] == "Javob: Hozir pulim yo'q."
    assert [a.question for a in model.asked] == ["Hozir", "Hozir pulim yo'q."]


def test_numbers_are_written_the_same_way_as_the_turn(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    final = _final(_turn(api, call_id, "besh yuz ming", ahead="besh yuz ming"))
    assert final["ms"]["early"] == 1 and len(model.asked) == 1  # the same normalised words both times


def test_not_used_when_a_turn_landed_in_between(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    assert api.post("/playground/turn?prefetch=1", data={"callId": call_id, "text": "Salom"}).status_code == 202
    early = pv._early[call_id][1]
    # Another turn is written down meanwhile (a typed message, say): the transcript the answer was
    # begun from is no longer the turn's.
    sql(
        "INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, created_at) VALUES (?,?,?,?,?,?,?)",
        "trn_between0000001", "ten_test000000000001", call_id, 5, "caller", "Ha", "2026-11-20T00:00:00.000Z",
    )  # fmt: skip
    final = _final(_events(api.post("/playground/turn", data={"callId": call_id, "text": "Salom"})))
    assert final["ms"]["early"] == 0 and not early.adopted
    assert len(model.asked) == 2 and model.asked[1].history[-1] == {"role": "caller", "text": "Ha"}


def test_from_the_recording_when_there_are_no_live_words(api, sql, voiced, model, monkeypatch) -> None:  # noqa: ANN001
    heard: list[bytes] = []

    async def transcribe(audio, **_kw):  # noqa: ANN001, ANN003
        heard.append(audio)
        return {"text": "Salom", "engine": "local", "language": "uz"}

    monkeypatch.setattr(pv, "transcribe", transcribe)
    call_id = _open_call(api, _seed_agent(sql))
    wav = {"audio": ("phrase.wav", b"RIFF" + b"\x01" * 4000, "audio/wav")}
    assert api.post("/playground/turn?prefetch=1", data={"callId": call_id}, files=wav).status_code == 202
    final = _final(_events(api.post("/playground/turn", data={"callId": call_id}, files=wav)))
    assert final["ms"]["early"] == 1 and final["text"] == "Javob: Salom"
    assert len(heard) == 1 and len(model.asked) == 1  # transcribed once, asked once


def test_hanging_up_drops_it(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    assert api.post("/playground/turn?prefetch=1", data={"callId": call_id, "text": "Salom"}).status_code == 202
    api.post("/playground/end", json={"callId": call_id})
    assert call_id not in pv._early


# ── the match itself ────────────────────────────────────────────────


def test_anything_the_reply_depends_on_breaks_the_match() -> None:
    history = [{"role": "agent", "text": "Assalomu alaykum"}]
    agent = {"id": "a1", "name": "Laylo", "persona": "friendly", "llm_model": "openai:gpt-5.5"}
    target = {"fullName": "", "birthYear": "", "loanAmount": "", "prompt": ""}
    key = fingerprint("Salom", history, agent, target, True)
    assert key == fingerprint("Salom", [dict(h) for h in history], dict(agent), dict(target), True)
    assert key == fingerprint("salom.", history, agent, target, True)  # the same words, settled (Q5)
    assert key != fingerprint("Salom alaykum", history, agent, target, True)  # other words
    assert key != fingerprint("Salom", [*history, {"role": "caller", "text": "Ha"}], agent, target, True)  # a turn
    assert key != fingerprint("Salom", history, {**agent, "persona": "formal"}, target, True)  # the agent edited
    assert key != fingerprint("Salom", history, {**agent, "llm_model": "anthropic:x"}, target, True)  # its model
    assert key != fingerprint("Salom", history, agent, {**target, "fullName": "Ali"}, True)  # the target
    assert key != fingerprint("Salom", history, agent, target, False)  # streamed or not


def test_a_failed_early_answer_is_not_used(monkeypatch: pytest.MonkeyPatch) -> None:
    async def plan(**_kw):  # noqa: ANN003
        raise RuntimeError("knowledge base down")

    monkeypatch.setattr(early, "plan_reply", plan)

    async def scenario() -> bool:
        answer = EarlyAnswer(tenant_id="t", agent={}, utterance="Salom", model_history=[], target={}, stream_llm=True)
        await asyncio.sleep(0.01)
        return answer.matches("Salom", [], {}, {}, True)

    assert asyncio.run(scenario()) is False


def test_the_same_words_match_however_they_are_written() -> None:
    from app.engine.early import same_words

    assert same_words("Qancha qarzim qoldi?") == same_words("qancha  qarzim qoldi")
    assert same_words("To‘lovni keyingi oyga ko‘chirsam bo‘ladimi?") == same_words(
        "To'lovni keyingi oyga ko'chirsam bo'ladimi"
    )
    assert same_words("Hozir pulim yo'q. Oylik olganimda to'layman.") == same_words(
        "hozir pulim yo'q oylik olganimda to'layman"
    )
    assert same_words("Qancha qarzim qoldi?") != same_words("Qancha qarsim qoldi?")  # a different word
    assert same_words("Qancha qarzim") != same_words("Qancha qarzim qoldi?")  # words missing
    assert same_words("25 ming") != same_words("26 ming")


def test_used_when_the_words_on_screen_differ_only_in_writing(api, sql, voiced, model) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    events = _turn(api, call_id, "Qancha qarzim qoldi?", ahead="qancha qarzim qoldi")
    assert _final(events)["ms"]["early"] == 1
    assert len(model.asked) == 1 and model.cancelled == []  # the model was asked once, at the pause
    rows = sql("SELECT role, text FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)
    assert rows[-2][1] == "Qancha qarzim qoldi?"  # the transcript keeps the settled words
