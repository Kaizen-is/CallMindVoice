"""
The public logistics demo served by Python (`app/routers/logistics.py`, `app/logistics.py`): what
src/app/api/logistics/{call,turn,end}/route.ts answer — its own tenant and agent created on first
use, the greeting, GAPI for Uzbek and the app's own STT for Russian, the shipment lookup handed to
the model, a transfer ending the call, no fillers — and the /logistics page's data with the
warm-up of the greetings. The bank demo's limits and per-call lock are shared (tests in
test_demo_routes.py). The lookup itself is parity-tested in test_logistics_data_parity.py.
"""

import asyncio
import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app import demo as demo_lib
from app import logistics as logistics_lib
from app.engine import conversation
from app.logistics_data import logistics_context, lookup_note
from tests.test_demo_routes import clear_state, drain, events, kinds

CLIP = b"UTTER:track|" + b"\x01\x02" * 500
TRACK_WORDS = "Track raqamim to'rt yuz sakson ikki ming to'qqiz yuz o'n uch"


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    clear_state()
    yield
    clear_state()


@pytest.fixture
def api(data_dir) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app(), raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def voiced(monkeypatch: pytest.MonkeyPatch) -> dict:
    seen: dict = {"stream": [], "pcm": [], "cache": {}}

    async def synth(text: str, opts):  # noqa: ANN001
        seen["stream"].append((text, opts))
        for i in range(2):
            await asyncio.sleep(0)
            yield f"{text[:8]}#{i}".encode()

    async def synthesize_pcm(text: str, opts):  # noqa: ANN001
        seen["pcm"].append((text, opts))
        seen["cache"][(text, opts.voice_id, opts.language)] = b"PCM"
        return b"PCM"

    def cached(text: str, opts):  # noqa: ANN001
        return seen["cache"].get((text, opts.voice_id, opts.language))

    for module in (demo_lib, logistics_lib):
        monkeypatch.setattr(module, "tts_configured", lambda engine="default": True)
        monkeypatch.setattr(module, "cached_pcm", cached)
        monkeypatch.setattr(module, "synthesize_pcm", synthesize_pcm)
    monkeypatch.setattr(demo_lib, "synthesize_stream", synth)
    return seen


@pytest.fixture
def stt(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Scripted GAPI and own STT; records how each was asked."""
    state: dict = {"gapi": [], "own": [], "text": TRACK_WORDS, "fail": False}

    async def gapi_transcribe(audio: bytes, *, language=None, vocabulary=None, clean=False):  # noqa: ANN001
        state["gapi"].append((audio, language, vocabulary, clean))
        await asyncio.sleep(0)
        if state["fail"]:
            raise RuntimeError("gapi_500")
        return {"text": state["text"], "engine": "gapi", "language": "uz"}

    async def transcribe(audio: bytes, *, language=None, clean=False, engine=None):  # noqa: ANN001
        state["own"].append((audio, language, clean, engine))
        return {"text": "Когда придёт посылка 482913?", "engine": "kotib", "language": "ru"}

    monkeypatch.setattr(logistics_lib, "gapi_transcribe", gapi_transcribe)
    monkeypatch.setattr(logistics_lib, "transcribe", transcribe)
    return state


@pytest.fixture
def model(monkeypatch: pytest.MonkeyPatch) -> list:
    """The model behind run_turn: records each GenerateInput; answers in two sentences, streamed."""
    asked: list = []

    async def generate_answer(inp, on_delta=None):  # noqa: ANN001
        asked.append(inp)
        intent = "human" if "operator" in inp.question.lower() else "status"
        answer = "Topdim, Dilshod aka. Hozir Xorgos chegarasida." if intent == "status" else "Operatorga ulayman."
        if on_delta:
            on_delta(answer)
        return {"answer": answer, "intent": intent, "answered": True, "usedHits": [], "engine": "openai:test"}

    async def summarize_call(transcript, language, reason, llm=None):  # noqa: ANN001
        return "Mijoz operator so'radi."

    monkeypatch.setattr(conversation, "generate_answer", generate_answer)
    monkeypatch.setattr(conversation, "summarize_call", summarize_call)
    return asked


def open_call(api: TestClient, **body) -> str:  # noqa: ANN003
    evs = events(api.post("/logistics/call", json={"lang": "uz", **body}))
    return evs[0]["callId"]


def turn(api: TestClient, call_id: str, audio: bytes = CLIP, prefetch: bool = False, **fields):  # noqa: ANN003
    path = "/logistics/turn?prefetch=1" if prefetch else "/logistics/turn"
    data = {"callId": call_id, "lang": "uz", "voice": "", **fields}
    return api.post(path, data=data, files={"audio": ("speech.wav", audio, "audio/wav")})


# ── the demo's own tenant and agent ─────────────────────────────────


def test_the_agent_is_created_once_on_first_use(api, sql) -> None:  # noqa: ANN001
    assert api.get("/views/logistics").status_code == 200
    (tenant,) = sql(
        "SELECT id, name, slug, industry, created_at = updated_at FROM tenants WHERE id = 'ten_logistics_demo'"
    )
    assert tenant == ("ten_logistics_demo", "Logistics demo", "logistics-demo", "logistics", 1)
    (agent,) = sql(
        "SELECT tenant_id, name, status, persona, greeting, fallback_line, instructions, languages_json, primary_lang, "
        "voice_id, escalation_json, hours_json, tools_json, target_json, updated_at FROM agents "
        "WHERE id = 'agt_logistics_demo'"
    )
    assert agent[:14] == (
        "ten_logistics_demo", "Logistika operatori", "live", "friendly", "", "", "", '["uz","ru"]', "uz", "isomiddin",
        '{"onLowConfidence":false,"onExplicitRequest":true,"onNegativeSentiment":false,"onRepeatedFailure":false,'
        '"maxFailedTurns":2,"afterHoursAction":"answer_anyway","ringTimeoutSec":30,"fallbackNumber":""}',
        "{}", "[]", "{}",
    )  # fmt: skip
    stamp = agent[14]
    api.get("/views/logistics")
    open_call(api)
    assert sql("SELECT updated_at FROM agents WHERE id = 'agt_logistics_demo'") == [(stamp,)]
    assert sql("SELECT COUNT(*) FROM tenants WHERE id = 'ten_logistics_demo'") == [(1,)]


def test_view_has_what_the_page_renders(api, monkeypatch) -> None:  # noqa: ANN001
    voices = [
        {"id": "isomiddin", "name": "Isomiddin", "group": "builtin"},
        {"id": "laylo", "name": "Laylo", "group": "builtin"},
    ]
    view = {"available": False, "voices": voices, "tracks": ["482913", "615027", "739184", "827405"]}
    assert api.get("/views/logistics").json() == {**view, "initialVoice": "isomiddin"}
    assert api.get("/views/logistics?voice=laylo").json()["initialVoice"] == "laylo"
    assert api.get("/views/logistics?voice=Laylo").json()["initialVoice"] == "isomiddin"
    assert api.get("/views/logistics?voice=").json()["initialVoice"] == "isomiddin"
    for name in ("GAPI_API_KEY", "GAPIAPI"):
        monkeypatch.setenv(name, " key ")
        assert api.get("/views/logistics").json()["available"] is True
        monkeypatch.delenv(name)
    monkeypatch.setenv("GAPI_API_KEY", "  ")
    assert api.get("/views/logistics").json()["available"] is False


def test_view_warms_the_greetings_once(api, voiced) -> None:  # noqa: ANN001
    voiced["cache"][(logistics_lib.greeting_for("ru", "laylo"), "laylo", "ru")] = b"OLD"
    api.get("/views/logistics")
    drain(api)
    assert [(t, o.voice_id, o.language, o.tag, o.cache) for t, o in voiced["pcm"]] == [
        (logistics_lib.greeting_for("uz", "isomiddin"), "isomiddin", "uz", "demo", True),
        (logistics_lib.greeting_for("ru", "isomiddin"), "isomiddin", "ru", "demo", True),
        (logistics_lib.greeting_for("uz", "laylo"), "laylo", "uz", "demo", True),
    ]
    api.get("/views/logistics")
    drain(api)
    assert len(voiced["pcm"]) == 3


def test_no_warm_up_without_a_voice(api, monkeypatch) -> None:  # noqa: ANN001
    api.get("/views/logistics")
    drain(api)
    assert logistics_lib._state["warmed"] is False


# ── /logistics/call ─────────────────────────────────────────────────


def test_call_answers_with_the_greeting(api, sql, voiced) -> None:  # noqa: ANN001
    evs = events(api.post("/logistics/call", json={"lang": "uz", "voice": "laylo"}))
    assert kinds(evs) == ["call", "reply", "audio", "audio", "done"]
    text = (
        "Assalomu alaykum! Yetkazib berish xizmati, men Laylo. Track raqamingizni yoki telefon raqamingizni ayting, "
        "yukingiz qayerdaligini tekshirib beraman."
    )
    assert evs[1] == {"t": "reply", "text": text, "lang": "uz", "end": None}
    assert voiced["stream"][0][1].voice_id == "laylo"
    call_id = evs[0]["callId"]
    (row,) = sql(
        "SELECT tenant_id, agent_id, direction, channel, from_e164, to_e164, caller_name, status, language, turns, "
        "answered_at IS NOT NULL FROM calls WHERE id = ?",
        call_id,
    )
    assert row == ("ten_logistics_demo", "agt_logistics_demo", "inbound", "web", "logistics", "logistics",
                   "Logistics demo", "active", "uz", 0, 1)  # fmt: skip
    assert sql("SELECT ordinal, role, text, language FROM turns WHERE call_id = ?", call_id) == [
        (0, "agent", text, "uz")
    ]


def test_call_in_russian_with_an_unknown_voice(api) -> None:  # noqa: ANN001
    evs = events(api.post("/logistics/call", json={"lang": "ru", "voice": "nadya"}))
    assert evs[1]["text"] == (
        "Здравствуйте! Служба доставки, меня зовут Isomiddin. Подскажите номер отслеживания или номер телефона, и я "
        "проверю, где ваш груз."
    )
    assert kinds(evs) == ["call", "reply", "voice:false", "done"]
    assert api.post("/logistics/call", content=b"null").status_code == 500


# ── /logistics/turn ─────────────────────────────────────────────────


def test_turn_refusals(api, sql) -> None:  # noqa: ANN001
    call_id = open_call(api)
    assert api.post("/logistics/turn", json={}).json() == {"error": "bad_request"}
    assert api.post("/logistics/turn", files={"callId": (None, call_id)}).json() == {"error": "bad_audio"}
    assert turn(api, call_id, b"\0" * 1_400_001).json() == {"error": "bad_audio"}
    assert turn(api, "call_nope").status_code == 410
    assert demo_lib.claim_call(call_id)
    assert (turn(api, call_id).status_code, turn(api, call_id).json()) == (409, {"error": "busy_call"})


def test_uzbek_goes_to_gapi_and_the_lookup_to_the_model(api, sql, stt, model) -> None:  # noqa: ANN001
    call_id = open_call(api, voice="laylo")
    evs = events(turn(api, call_id, voice="laylo"))
    assert kinds(evs) == ["heard", "reply", "voice:false", "final", "done"]  # no filler on this demo
    assert evs[0] == {"t": "heard", "text": TRACK_WORDS}  # GAPI's words as they came
    vocabulary = list(logistics_lib.LOGISTICS_VOCABULARY)
    assert stt["gapi"] == [(CLIP, "uz", vocabulary, False)] and stt["own"] == []
    (inp,) = model
    assert inp.extra_system == logistics_context([TRACK_WORDS], "Laylo")
    assert inp.extra_note == lookup_note([TRACK_WORDS])
    assert "Shipment of Dilshod Rahimov" in inp.extra_system
    assert evs[3]["text"] == "Topdim, Dilshod aka. Hozir Xorgos chegarasida." and evs[3]["end"] is None
    # The greeting is history the model sees; the turn is written down after it.
    assert [r[0] for r in sql("SELECT role FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)] == [
        "agent",
        "caller",
        "agent",
    ]


def test_russian_keeps_the_own_stt(api, stt, model) -> None:  # noqa: ANN001
    call_id = open_call(api, lang="ru")
    evs = events(turn(api, call_id, lang="ru"))
    assert evs[0] == {"t": "heard", "text": "Когда придёт посылка 482913?"}
    assert stt["own"] == [(CLIP, "ru", False, None)] and stt["gapi"] == []
    assert model[0].extra_system.startswith("COMPANY SYSTEM") and "Malika" not in model[0].extra_system


def test_stt_failure_hears_nothing(api, stt, model) -> None:  # noqa: ANN001
    call_id = open_call(api)
    stt["fail"] = True
    assert events(turn(api, call_id)) == [{"t": "heard", "text": ""}, {"t": "done"}]
    assert model == []
    stt["fail"] = False
    assert kinds(events(turn(api, call_id)))[-1] == "done"


def test_prefetch_is_picked_up_by_the_turn(api, stt, model) -> None:  # noqa: ANN001
    call_id = open_call(api)
    assert turn(api, call_id, prefetch=True).status_code == 202
    events(turn(api, call_id))
    assert len(stt["gapi"]) == 1


def test_asking_for_a_person_transfers_and_ends_the_call(api, sql, stt, model, voiced) -> None:  # noqa: ANN001
    call_id = open_call(api)
    voiced["cache"][("Bir daqiqa.", "isomiddin", "uz")] = b"FILLER"
    stt["text"] = "Operator bilan gaplashmoqchiman"
    evs = events(turn(api, call_id))
    assert "filler" not in kinds(evs)
    assert evs[-2] == {
        "t": "final",
        "text": "Operatorga ulayman.",
        "end": "transfer",
        "ms": evs[-2]["ms"],
    }
    assert sql("SELECT status, outcome, escalated FROM calls WHERE id = ?", call_id) == [
        ("completed", "resolved_by_operator", 1)
    ]
    assert sql("SELECT reason, summary FROM escalations WHERE call_id = ?", call_id) == [
        ("explicit_request", "Mijoz operator so'radi.")
    ]
    assert turn(api, call_id).status_code == 410


def test_end_touches_only_logistics_calls(api, sql, data_dir) -> None:  # noqa: ANN001
    from tests.test_demo_routes import seed_agent

    call_id = open_call(api)
    seed_agent(sql)
    demo_call = events(api.post("/demo/call", json={}))[0]["callId"]
    assert api.post("/logistics/end", json={"callId": demo_call}).status_code == 204
    assert api.post("/demo/end", json={"callId": call_id}).status_code == 204
    assert sql("SELECT COUNT(*) FROM calls WHERE ended_at IS NOT NULL") == [(0,)]
    res = api.post("/logistics/end", content=json.dumps({"callId": call_id}), headers={"content-type": "text/plain"})
    assert res.status_code == 204
    assert sql("SELECT outcome FROM calls WHERE id = ?", call_id) == [("resolved_by_ai",)]
