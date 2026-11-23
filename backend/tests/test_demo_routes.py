"""
The public bank demo served by Python (`app/routers/demo.py`, `app/demo.py`): what
src/app/api/demo/{call,turn,end}/route.ts answer — the per-address and total rate limits, the
refusals, the NDJSON events of a call and a turn, the voice streamed while the reply is written,
the transcript prefetched during a pause, the rows a demo call writes (never billed) — and the
/demo page's data with its warm-up. STT, TTS and the model are scripted here; the same routes ran
end to end against the TypeScript ones (fake speech and model services) before this port.
"""

import asyncio
import base64
import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app import background
from app import demo as demo_lib
from app import logistics as logistics_lib
from app.engine import bus
from app.routers import demo as demo_router

TENANT = "ten_demo0000000000001"
AGENT = "agt_1qi9jqhzhd7pygpd"  # the default demo agent (no DEMO_AGENT_ID)
NOW = "2026-11-12T00:00:00.000Z"
CLIP = b"UTTER:kredit|" + b"\x01\x02" * 500


def seed_agent(sql, agent_id: str = AGENT, tenant: str = TENANT, voice: str = "isomiddin", target: str = "{}") -> None:  # noqa: ANN001
    sql(
        "INSERT OR IGNORE INTO tenants (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)",
        tenant,
        "Bank",
        tenant,
        NOW,
        NOW,
    )
    sql(
        "INSERT INTO agents (id, tenant_id, name, status, greeting, primary_lang, voice_id, target_json, "
        "escalation_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        agent_id,
        tenant,
        "Isomiddin",
        "live",
        "Assalomu alaykum",
        "uz",
        voice,
        target,
        # No knowledge base here: an unanswered turn must not count as a hand-off.
        json.dumps({"onLowConfidence": False, "onRepeatedFailure": False}),
        NOW,
        NOW,
    )


def clear_state() -> None:
    for state in (
        demo_lib._hits,
        demo_lib._busy,
        demo_lib._openings,
        demo_lib._warmed,
        demo_lib._fillers,
        demo_lib._heard,
        logistics_lib._heard,
    ):
        state.clear()
    logistics_lib._state["warmed"] = False


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    clear_state()
    yield
    clear_state()


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    """One client on one event loop (a prefetch started in one request is awaited in the next)."""
    from app.main import create_app

    seed_agent(sql)
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def voiced(monkeypatch: pytest.MonkeyPatch) -> dict:
    """A configured TTS: each text renders as two pieces; `cache` holds what is "on disk"."""
    seen: dict = {"stream": [], "pcm": [], "cache": {}}

    async def synth(text: str, opts):  # noqa: ANN001
        seen["stream"].append((text, opts))
        for i in range(2):
            await asyncio.sleep(0)
            yield f"{text[:8]}#{i}".encode()

    async def synthesize_pcm(text: str, opts):  # noqa: ANN001
        seen["pcm"].append((text, opts))
        seen["cache"][(text, opts.voice_id)] = f"PCM[{text}]".encode()
        return seen["cache"][(text, opts.voice_id)]

    monkeypatch.setattr(demo_lib, "synthesize_stream", synth)
    monkeypatch.setattr(demo_lib, "synthesize_pcm", synthesize_pcm)
    monkeypatch.setattr(demo_lib, "tts_configured", lambda engine="default": True)
    monkeypatch.setattr(demo_lib, "cached_pcm", lambda text, opts: seen["cache"].get((text, opts.voice_id)))
    return seen


@pytest.fixture
def heard(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Scripted STT: the transcript for each utterance's bytes (default: a loan question)."""
    state: dict = {"calls": [], "texts": {}, "fail": set()}

    async def transcribe(audio: bytes, *, language=None, clean=False, engine=None, vocabulary=None):  # noqa: ANN001
        state["calls"].append((audio, language, clean))
        state.setdefault("vocabulary", []).append(vocabulary)
        await asyncio.sleep(0)
        if audio in state["fail"]:
            raise RuntimeError("stt_down")
        return {"text": state["texts"].get(audio, "Kredit to'lovi qachon?"), "engine": "kotib", "language": language}

    monkeypatch.setattr(demo_lib, "transcribe", transcribe)
    return state


@pytest.fixture
def opening(monkeypatch: pytest.MonkeyPatch) -> list:
    """The model's opening line (engine `openai:test`); records each generation's input."""
    asked: list = []

    async def generate_answer(inp, on_delta=None):  # noqa: ANN001
        asked.append(inp)
        text = "Assalomu alaykum! Aziz Karimov bilan gaplashyapmanmi?" if inp.language == "uz" else "Здравствуйте!"
        return {"answer": text, "intent": "greeting", "answered": True, "usedHits": [], "engine": "openai:test"}

    monkeypatch.setattr(demo_lib, "generate_answer", generate_answer)
    return asked


def events(res) -> list[dict]:  # noqa: ANN001
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/x-ndjson; charset=utf-8"
    assert res.headers["cache-control"] == "no-store, no-transform"
    assert res.headers["x-accel-buffering"] == "no"
    return [json.loads(line) for line in res.text.splitlines() if line]


def kinds(evs: list[dict]) -> list[str]:
    return [e["t"] if e["t"] != "voice" else f"voice:{str(e['ok']).lower()}" for e in evs]


def open_call(api: TestClient, **body) -> str:  # noqa: ANN003
    evs = events(api.post("/demo/call", json={"lang": "uz", **body}))
    assert evs[0]["t"] == "call"
    return evs[0]["callId"]


def turn(api: TestClient, call_id: str, audio: bytes = CLIP, prefetch: bool = False, **fields):  # noqa: ANN003
    path = "/demo/turn?prefetch=1" if prefetch else "/demo/turn"
    data = {"callId": call_id, "lang": "uz", "voice": "", **fields}
    return api.post(path, data=data, files={"audio": ("speech.wav", audio, "audio/wav")})


def drain(api: TestClient) -> None:
    api.portal.call(background.drain)


# ── /demo/call ──────────────────────────────────────────────────────


def test_call_streams_the_opening_and_writes_it_down(api, sql, voiced, opening) -> None:  # noqa: ANN001
    evs = events(api.post("/demo/call", json={"lang": "uz", "voice": ""}))
    assert kinds(evs) == ["call", "reply", "audio", "audio", "done"]
    call_id = evs[0]["callId"]
    text = "Assalomu alaykum! Aziz Karimov bilan gaplashyapmanmi?"
    assert evs[1] == {"t": "reply", "text": text, "lang": "uz", "end": None}
    assert evs[2] == {"t": "audio", "pcm": base64.b64encode(f"{text[:8]}#0".encode()).decode()}
    ((said, opts),) = voiced["stream"]
    assert said == text
    assert (opts.tenant_id, opts.voice_id, opts.language, opts.tag, opts.cache) == (
        TENANT,
        "isomiddin",
        "uz",
        "demo",
        True,
    )
    # The model was asked as on a real pickup, about the invented borrower.
    (inp,) = opening
    assert (inp.question, inp.history, inp.hits, inp.confidence) == ("Allo", [], [], 0)
    assert inp.target["fullName"] == "Aziz Karimov" and inp.target["prompt"] == demo_lib.DEFAULT_CALL_PROMPT
    (row,) = sql(
        "SELECT tenant_id, agent_id, direction, channel, from_e164, to_e164, caller_name, status, language, turns, "
        "answered_at IS NOT NULL, ended_at FROM calls WHERE id = ?",
        call_id,
    )
    assert row == (TENANT, AGENT, "outbound", "web", "demo", "demo", "Demo", "active", "uz", 1, 1, None)
    turns = sql("SELECT ordinal, role, text, language FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)
    assert turns == [(0, "caller", "Allo", "uz"), (1, "agent", text, "uz")]


def test_the_opening_is_generated_once_a_day_per_agent_version(api, sql, voiced, opening) -> None:  # noqa: ANN001
    open_call(api)
    open_call(api)
    assert len(opening) == 1
    open_call(api, lang="ru")
    assert len(opening) == 2
    sql("UPDATE agents SET updated_at = '2026-11-13T00:00:00.000Z' WHERE id = ?", AGENT)
    open_call(api)
    assert len(opening) == 3


def test_the_local_engine_gives_the_fixed_opening_and_is_asked_again(api, sql) -> None:  # noqa: ANN001
    # No model and no TTS configured: the fixed line, and the browser speaks it itself.
    evs = events(api.post("/demo/call", json={"lang": "ru"}))
    assert kinds(evs) == ["call", "reply", "voice:false", "done"]
    assert evs[1]["text"] == demo_lib.FALLBACK_OPENING["ru"]
    assert demo_lib._openings == {}
    evs = events(api.post("/demo/call", json={"lang": "uz"}))
    assert evs[1]["text"] == (
        "Assalomu alaykum! Biznesni rivojlantirish bankidan qoʻngʻiroq qilyapman. Aziz Karimov bilan "
        "gaplashyapmanmi? Iltimos, tugʻilgan yilingizni ayting."
    )


def test_the_bank_script_replaces_the_default_prompt(api, sql, opening) -> None:  # noqa: ANN001
    sql(
        "UPDATE agents SET target_json = ? WHERE id = ?",
        json.dumps({"fullName": "Real Person", "prompt": " Pul! "}),
        AGENT,
    )
    open_call(api)
    assert opening[0].target == {
        "fullName": "Aziz Karimov",
        "birthYear": "1992",
        "loanAmount": "7 800 000 so'm",
        "prompt": "Pul!",
    }


@pytest.mark.parametrize(
    ("asked", "used"),
    [(" laylo ", "laylo"), ("nadya", "isomiddin"), ("vc_mine", "vc_mine"), ("vc_other", "isomiddin"), (7, "isomiddin")],
)
def test_the_voice_must_be_one_the_page_offers(api, sql, voiced, opening, asked, used) -> None:  # noqa: ANN001
    for vid, tenant in (("vc_mine", TENANT), ("vc_other", "ten_other")):
        sql(
            "INSERT INTO custom_voices (id, tenant_id, name, mode, created_at) VALUES (?,?,?,?,?)",
            vid,
            tenant,
            vid,
            "design",
            NOW,
        )
    open_call(api, voice=asked)
    assert voiced["stream"][0][1].voice_id == used


def test_call_bodies_read_like_the_fetch_api(api, opening) -> None:  # noqa: ANN001
    # Garbled or not an object: `{}` / undefined fields — Uzbek, the agent's voice.
    for content in (b"not json", b"", b'"text"', b"[1]", b"7", b'{"lang": NaN}'):
        evs = events(api.post("/demo/call", content=content, headers={"content-type": "application/json"}))
        assert evs[1]["lang"] == "uz", content
    # `null` crashed the TypeScript route (`body.lang` of null) after the limit counted it.
    assert api.post("/demo/call", content=b"null").status_code == 500


def test_no_demo_agent_is_unavailable(data_dir, monkeypatch) -> None:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as client:
        assert (client.post("/demo/call", json={}).status_code, client.post("/demo/call").json()) == (
            503,
            {"error": "unavailable"},
        )
        res = client.post("/demo/turn", data={"callId": "x"}, files={"audio": ("a.wav", CLIP, "audio/wav")})
        assert (res.status_code, res.json()) == (503, {"error": "unavailable"})
        assert client.get("/views/demo").json()["available"] is False


def test_demo_agent_id_points_elsewhere(api, sql, monkeypatch, opening) -> None:  # noqa: ANN001
    seed_agent(sql, agent_id="agt_other", voice="laylo")
    monkeypatch.setenv("DEMO_AGENT_ID", "agt_other")
    call_id = open_call(api)
    assert sql("SELECT agent_id FROM calls WHERE id = ?", call_id) == [("agt_other",)]


# ── rate limits ─────────────────────────────────────────────────────


def test_limit_values_are_the_typescript_ones() -> None:
    assert demo_lib.LIMITS == {"call": (20, 200), "turn": (200, 1500), "prefetch": (300, 2000)}
    assert demo_lib.WINDOW_MS == 600_000


def test_twenty_calls_per_address_in_ten_minutes(api, opening, monkeypatch) -> None:  # noqa: ANN001
    clock = {"now": 1_800_000_000_000}
    monkeypatch.setattr(demo_lib, "now_ms", lambda: clock["now"])
    for i in range(20):
        res = api.post("/demo/call", json={}, headers={"x-forwarded-for": f"203.0.113.5, 10.0.0.{i}"})
        assert res.status_code == 200
    busy = api.post("/demo/call", json={}, headers={"x-forwarded-for": " 203.0.113.5 "})
    assert (busy.status_code, busy.json()) == (429, {"error": "busy"})
    # The first hop is the visitor; both demos share the limit.
    assert api.post("/demo/call", json={}, headers={"x-forwarded-for": "203.0.113.5, 1.1.1.1"}).status_code == 429
    assert api.post("/logistics/call", json={}, headers={"x-forwarded-for": "203.0.113.5"}).status_code == 429
    assert api.post("/demo/call", json={}, headers={"x-forwarded-for": "203.0.113.6"}).status_code == 200
    # Turns and prefetches have their own counters.
    res = api.post("/demo/turn", json={}, headers={"x-forwarded-for": "203.0.113.5"})
    assert (res.status_code, res.json()) == (400, {"error": "bad_request"})
    # Ten minutes on, the address may call again.
    clock["now"] += 600_000
    assert api.post("/demo/call", json={}, headers={"x-forwarded-for": "203.0.113.5"}).status_code == 200


def test_total_limits_and_the_direct_address(api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(demo_lib, "LIMITS", {"call": (2, 3), "turn": (1, 2), "prefetch": (5, 5)})
    codes = [
        api.post("/demo/turn", json={}, headers=h).status_code
        for h in ({"x-forwarded-for": "198.51.100.1"}, {"x-forwarded-for": "198.51.100.1"}, {}, {}, {"x-real-ip": "x"})
    ]
    # Per address: 1 turn (with no forwarded address, the connection's: "testclient"); in total: 2.
    assert codes == [400, 429, 400, 429, 429]
    assert demo_lib._hits["turn:198.51.100.1"] and demo_lib._hits["turn:testclient"]
    assert len(demo_lib._hits["turn:*"]) == 2


def test_client_address(api) -> None:  # noqa: ANN001
    from starlette.requests import Request

    def address(headers: list[tuple[bytes, bytes]], peer: str | None = "127.0.0.1") -> str:
        scope = {"type": "http", "headers": headers, "client": (peer, 50000) if peer else None}
        return demo_lib.client_address(Request(scope))

    assert address([(b"x-forwarded-for", b"1.2.3.4, 10.0.0.1")]) == "1.2.3.4"
    assert address([(b"x-forwarded-for", b" , 10.0.0.1"), (b"x-real-ip", b"5.6.7.8")]) == "5.6.7.8"
    assert address([(b"x-forwarded-for", b""), (b"x-real-ip", b"")]) == "direct"
    assert address([(b"x-forwarded-for", b"9.9.9.9"), (b"x-forwarded-for", b"8.8.8.8")]) == "9.9.9.9"
    # No X-Forwarded-For at all: Next.js would have set it to the connection's address.
    assert address([(b"x-real-ip", b"5.6.7.8")]) == "127.0.0.1"
    assert address([(b"x-real-ip", b"5.6.7.8")], peer=None) == "5.6.7.8"
    assert address([], peer=None) == "direct"


# ── /demo/turn: refusals ────────────────────────────────────────────


def test_turn_refusals(api, sql, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)

    def check(res, status: int, code: str) -> None:  # noqa: ANN001
        assert (res.status_code, res.json()) == (status, {"error": code})

    check(api.post("/demo/turn", json={"callId": call_id}), 400, "bad_request")
    check(api.post("/demo/turn", content=b"x"), 400, "bad_request")
    check(api.post("/demo/turn", content=b"x", headers={"content-type": "multipart/form-data"}), 400, "bad_request")
    check(api.post("/demo/turn", data={"callId": call_id, "audio": "x"}), 400, "bad_audio")
    check(api.post("/demo/turn", files={"callId": (None, call_id)}), 400, "bad_audio")
    check(turn(api, call_id, b""), 400, "bad_audio")
    check(turn(api, call_id, b"\0" * 1_400_001), 400, "bad_audio")
    check(turn(api, "call_nope", b"\0" * 1_400_000), 410, "ended")
    res = api.post("/demo/turn", files={"callId": ("id.txt", call_id.encode()), "audio": ("a.wav", CLIP)})
    check(res, 410, "ended")  # String(file) is "[object File]"
    # Someone else's call (not from "demo", or another agent's) is not a demo call.
    sql("UPDATE calls SET from_e164 = 'playground' WHERE id = ?", call_id)
    check(turn(api, call_id), 410, "ended")


def test_turn_is_refused_while_another_is_written_down(api, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    assert demo_lib.claim_call(call_id)
    res = turn(api, call_id)
    assert (res.status_code, res.json()) == (409, {"error": "busy_call"})
    demo_lib.release_call(call_id)
    assert kinds(events(turn(api, call_id)))[-1] == "done"


def test_old_or_long_calls_take_no_more_turns(api, sql, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    sql("UPDATE calls SET turns = 40 WHERE id = ?", call_id)
    assert turn(api, call_id).status_code == 410
    (row,) = sql("SELECT status, outcome, ended_at IS NOT NULL, duration_ms FROM calls WHERE id = ?", call_id)
    assert row[:3] == ("completed", "resolved_by_ai", 1) and row[3] >= 1000
    other = open_call(api)
    sql("UPDATE calls SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", other)
    assert turn(api, other).status_code == 410
    assert sql("SELECT outcome FROM calls WHERE id = ?", other) == [("resolved_by_ai",)]


# ── /demo/turn: the conversation ────────────────────────────────────


def test_turn_streams_heard_filler_reply_voice_and_final(api, sql, voiced, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    voiced["cache"][("Bir daqiqa.", "isomiddin")] = b"FILLER0"
    evs = events(turn(api, call_id))
    assert kinds(evs) == ["heard", "filler", "reply", "audio", "audio", "final", "done"]
    assert evs[0] == {"t": "heard", "text": "Kredit to'lovi qachon?"}
    assert evs[1] == {"t": "filler", "pcm": base64.b64encode(b"FILLER0").decode()}
    reply = sql("SELECT text FROM turns WHERE call_id = ? AND role = 'agent' ORDER BY ordinal DESC", call_id)[0][0]
    assert evs[2] == {"t": "reply", "text": reply, "lang": "uz", "end": None}
    assert evs[5]["text"] == reply and evs[5]["end"] is None
    assert list(evs[5]["ms"]) == ["stt", "retrieval", "llm"]
    # Transcribed in the call's language through the noise cleaner.
    assert heard["calls"] == [(CLIP, "uz", True)]
    # The next turn rotates to the next filler, which is not rendered yet: none, rather than a render.
    assert "filler" not in kinds(events(turn(api, call_id)))
    assert sql("SELECT COUNT(*) FROM turns WHERE call_id = ? AND role IN ('caller', 'agent')", call_id) == [(6,)]


def test_no_filler_for_a_greeting_or_another_voice(api, voiced, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    voiced["cache"][("Bir daqiqa.", "isomiddin")] = b"FILLER0"
    heard["texts"][b"hello"] = "Assalomu alaykum"
    assert "filler" not in kinds(events(turn(api, call_id, b"hello")))
    assert "filler" not in kinds(events(turn(api, call_id, voice="laylo")))
    assert "filler" in kinds(events(turn(api, call_id)))


def test_the_reply_is_voiced_sentence_by_sentence_as_written(api, voiced, heard, opening, monkeypatch) -> None:  # noqa: ANN001
    async def run_turn(**kw):  # noqa: ANN003
        for delta in ("  Ha. ", "To'lov o'n beshinchi", " noyabr. ", "Yana savol bormi?"):
            kw["on_delta"](delta)
            await asyncio.sleep(0.01)
        reply = "Ha. To'lov o'n beshinchi noyabr. Yana savol bormi?"
        return {"reply": reply, "escalate": None, "timings": {"retrievalMs": 3, "llmMs": 40}}

    monkeypatch.setattr(demo_router, "run_turn", run_turn)
    call_id = open_call(api)
    voiced["stream"].clear()
    evs = events(turn(api, call_id))
    assert kinds(evs) == ["heard", "reply", "audio", "audio", "more", "audio", "audio", "final", "done"]
    # "Ha." alone is too short to voice: it waits for the next sentence.
    assert evs[1] == {"t": "reply", "text": "Ha. To'lov o'n beshinchi noyabr.", "lang": "uz", "end": None}
    assert evs[4] == {"t": "more", "text": "Ha. To'lov o'n beshinchi noyabr. Yana savol bormi?"}
    assert [t for t, _ in voiced["stream"]] == ["Ha. To'lov o'n beshinchi noyabr.", "Yana savol bormi?"]
    assert evs[7]["ms"] == {"stt": evs[7]["ms"]["stt"], "retrieval": 3, "llm": 40}


def test_a_reply_without_voice_says_so(api, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    assert kinds(events(turn(api, call_id))) == ["heard", "reply", "voice:false", "final", "done"]


def test_heard_nothing_ends_the_turn(api, sql, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    heard["texts"][CLIP] = ""
    assert events(turn(api, call_id)) == [{"t": "heard", "text": ""}, {"t": "done"}]
    assert sql("SELECT COUNT(*) FROM turns WHERE call_id = ?", call_id) == [(2,)]


def test_stt_failure_is_a_server_error_and_frees_the_call(api, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    heard["fail"].add(CLIP)
    assert events(turn(api, call_id)) == [{"t": "error", "code": "server"}]
    heard["fail"].clear()
    assert kinds(events(turn(api, call_id)))[-1] == "done"


def test_a_transfer_ends_the_call(api, sql, heard, opening, monkeypatch) -> None:  # noqa: ANN001
    async def run_turn(**kw):  # noqa: ANN003
        return {
            "reply": "Sizni operatorga ulayman.",
            "escalate": "explicit_request",
            "timings": {"retrievalMs": 1, "llmMs": 2},
        }

    monkeypatch.setattr(demo_router, "run_turn", run_turn)
    call_id = open_call(api)
    evs = events(turn(api, call_id))
    assert evs[-2]["t"] == "final" and evs[-2]["end"] == "transfer"
    assert sql("SELECT status, outcome FROM calls WHERE id = ?", call_id) == [("completed", "resolved_by_operator")]
    assert turn(api, call_id).status_code == 410


def test_prefetch_transcribes_once_for_the_turn_that_follows(api, heard, opening, monkeypatch) -> None:  # noqa: ANN001
    call_id = open_call(api)
    res = turn(api, call_id, prefetch=True)
    assert (res.status_code, res.content) == (202, b"")
    assert len(heard["calls"]) == 1
    events(turn(api, call_id))
    assert len(heard["calls"]) == 1  # the prefetched transcript was used
    # Other bytes, or a stale prefetch, are transcribed again.
    turn(api, call_id, b"other", prefetch=True)
    events(turn(api, call_id))
    assert len(heard["calls"]) == 3
    turn(api, call_id, prefetch=True)
    clock = demo_lib.now_ms() + 20_000
    monkeypatch.setattr(demo_lib, "now_ms", lambda: clock)
    events(turn(api, call_id))
    assert len(heard["calls"]) == 5


def test_a_failed_prefetch_is_retried_by_the_turn(api, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    heard["fail"].add(CLIP)
    assert turn(api, call_id, prefetch=True).status_code == 202
    drain(api)
    heard["fail"].clear()
    assert events(turn(api, call_id))[0] == {"t": "heard", "text": "Kredit to'lovi qachon?"}
    assert len(heard["calls"]) == 2


def test_prefetch_needs_a_live_call_and_audio(api, heard, opening) -> None:  # noqa: ANN001
    assert turn(api, "call_nope", prefetch=True).status_code == 410
    call_id = open_call(api)
    assert turn(api, call_id, b"", prefetch=True).status_code == 400
    assert heard["calls"] == []


# ── /demo/end and closing ───────────────────────────────────────────


def test_end_closes_only_demo_calls_and_never_bills(api, sql, heard, opening) -> None:  # noqa: ANN001
    call_id = open_call(api)
    events(turn(api, call_id))
    seen: list[dict] = []
    unsubscribe = bus.subscribe(TENANT, seen.append)
    try:
        for content in (
            b"",
            b"{x",
            b"null",
            b'{"callId": 5}',
            json.dumps({"callId": call_id, "x": float("nan")}).encode(),
        ):
            assert api.post("/demo/end", content=content).status_code == 204
        assert sql("SELECT ended_at FROM calls WHERE id = ?", call_id) == [(None,)]
        res = api.post("/demo/end", content=json.dumps({"callId": call_id}), headers={"content-type": "text/plain"})
        assert (res.status_code, res.content) == (204, b"")
        assert api.post("/demo/end", json={"callId": call_id}).status_code == 204
    finally:
        unsubscribe()
    last = sql("SELECT MAX(created_at) FROM turns WHERE call_id = ?", call_id)[0][0]
    (row,) = sql("SELECT status, outcome, ended_at, duration_ms, cost_usd FROM calls WHERE id = ?", call_id)
    assert row[:3] == ("completed", "resolved_by_ai", last) and row[3] >= 1000 and row[4] == 0
    ended = [e for e in seen if e["type"] == "call_ended"]
    assert ended == [
        {"type": "call_ended", "callId": call_id, "outcome": "resolved_by_ai", "durationMs": row[3], "csat": None}
    ]


def test_opening_a_call_closes_abandoned_ones(api, sql, opening) -> None:  # noqa: ANN001
    stale = open_call(api)
    fresh = open_call(api)
    sql("UPDATE calls SET started_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)", stale, fresh)
    sql("UPDATE turns SET created_at = '2026-01-01T00:00:03.000Z' WHERE call_id = ?", stale)
    sql("UPDATE turns SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE call_id = ?", fresh)
    open_call(api)
    assert sql("SELECT outcome, ended_at, duration_ms FROM calls WHERE id = ?", stale) == [
        ("abandoned", "2026-01-01T00:00:03.000Z", 3000)
    ]
    assert sql("SELECT ended_at FROM calls WHERE id = ?", fresh) == [(None,)]


# ── /views/demo ─────────────────────────────────────────────────────


def test_view_has_what_the_page_renders(api, sql) -> None:  # noqa: ANN001
    sql(
        "INSERT INTO custom_voices (id, tenant_id, name, mode, created_at) VALUES (?,?,?,?,?)",
        "vc_1",
        TENANT,
        "Bank voice",
        "clone",
        NOW,
    )
    res = api.get("/views/demo")
    assert res.status_code == 200 and res.headers["content-type"] == "application/json"
    assert res.json() == {
        "available": True,
        "identity": {
            "agent": {"uz": "Isomiddin", "ru": "Исомиддин"},
            "org": {"uz": "Biznesni rivojlantirish banki", "ru": "Банк развития бизнеса"},
        },
        "persona": {"name": {"uz": "Aziz Karimov", "ru": "Азиз Каримов"}, "birthYear": "1992"},
        "voices": [
            {"id": "laylo", "name": "Laylo", "group": "builtin"},
            {"id": "isomiddin", "name": "Isomiddin", "group": "builtin"},
            {"id": "vc_1", "name": "Bank voice", "group": "clone"},
        ],
    }


def test_view_warms_both_openings_then_the_fillers_once(api, voiced, opening) -> None:  # noqa: ANN001
    api.get("/views/demo")
    drain(api)
    assert [inp.language for inp in opening] == ["uz", "ru"]
    assert [t for t, _ in voiced["stream"]] == [
        "Assalomu alaykum! Aziz Karimov bilan gaplashyapmanmi?",
        "Здравствуйте!",
    ]
    assert [t for t, _ in voiced["pcm"]] == [
        "Bir daqiqa.", "Hozir tekshiraman.", "Shu zahoti qarayman.", "Aniqlab beraman.",
        "Одну минуту.", "Сейчас посмотрю.", "Секунду, проверяю.", "Уточняю.",
    ]  # fmt: skip
    assert {o.voice_id for _, o in voiced["pcm"]} == {"isomiddin"}
    api.get("/views/demo")
    drain(api)
    assert len(voiced["stream"]) == 2 and len(opening) == 2
    # The warmed openings are what a pickup then plays.
    open_call(api)
    assert len(opening) == 2


def test_view_warm_up_without_a_voice_still_prepares_the_openings(api, opening) -> None:  # noqa: ANN001
    api.get("/views/demo")
    drain(api)
    assert [inp.language for inp in opening] == ["uz", "ru"]
