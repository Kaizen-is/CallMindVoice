"""
The Playground's voice call served by Python (`app/routers/playground.py`, `app/routers/live.py`):
the NDJSON event order of src/app/api/playground/{call,turn,end}/route.ts, their status codes,
the rows a call writes, the live Zipformer endpoint and the SSE feed. The pieces underneath (turn
engine, voice, segmentation) are parity-tested against the TypeScript elsewhere; here the routes
are checked against what the TypeScript routes send, with a scripted TTS/STT and the local engine.
"""

import asyncio
import json
from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import playground_voice as pv
from app.auth import COOKIE, Session, encode_session
from app.engine import bus
from app.routers import live
from tests.conftest import SECRET
from tests.test_system import _seed_user

TENANT = "ten_test000000000001"
USER = "usr_test000000000001"
NOW = "2026-11-12T00:00:00.000Z"
WAV = b"RIFF" + b"\x00" * 400


def _seed_agent(sql, agent_id: str = "agt_test000000000001", greeting: str = "Assalomu alaykum") -> str:  # noqa: ANN001
    sql(
        "INSERT INTO agents (id, tenant_id, name, status, greeting, primary_lang, voice_id, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        agent_id,
        TENANT,
        "Laylo",
        "live",
        greeting,
        "uz",
        "nilufar",
        NOW,
        NOW,
    )
    return agent_id


@pytest.fixture(autouse=True)
def _fresh_voice_state() -> Iterator[None]:
    for state in (pv._busy, pv._fillers, pv._heard, pv._warmed):
        state.clear()
    yield
    for state in (pv._busy, pv._fillers, pv._heard, pv._warmed):
        state.clear()


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    """A logged-in client on one event loop (a prefetch started in one request is awaited in the next)."""
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


@pytest.fixture
def voiced(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """A configured TTS that renders each text as two small PCM pieces; returns the texts rendered."""
    rendered: list[str] = []

    async def synth(text: str, opts):  # noqa: ANN001
        rendered.append(text)
        for i in range(2):
            await asyncio.sleep(0)
            yield f"{text[:6]}#{i}".encode()

    monkeypatch.setattr(pv, "synthesize_stream", synth)
    monkeypatch.setattr(pv, "tts_configured", lambda engine="default": True)
    monkeypatch.setattr(pv, "cached_pcm", lambda text, opts: None)
    return rendered


def _events(res) -> list[dict]:  # noqa: ANN001
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("application/x-ndjson")
    assert res.headers["x-accel-buffering"] == "no"
    return [json.loads(line) for line in res.text.splitlines() if line]


def _kinds(events: list[dict]) -> list[str]:
    return [e["t"] if e["t"] != "voice" else f"voice:{str(e['ok']).lower()}" for e in events]


def _open_call(api: TestClient, agent_id: str, **extra) -> str:  # noqa: ANN003
    events = _events(api.post("/playground/call", json={"agentId": agent_id, "lang": "uz", **extra}))
    assert events[0]["t"] == "call"
    return events[0]["callId"]


# ── /playground/call ────────────────────────────────────────────────


def test_call_streams_id_greeting_and_its_voice(api, sql, voiced) -> None:  # noqa: ANN001
    agent_id = _seed_agent(sql)
    events = _events(api.post("/playground/call", json={"agentId": agent_id, "lang": "uz", "ttsEngine": "default"}))
    assert _kinds(events) == ["call", "reply", "audio", "audio", "done"]
    call_id = events[0]["callId"]
    assert events[1] == {"t": "reply", "text": "Assalomu alaykum", "lang": "uz", "end": None}
    assert voiced == ["Assalomu alaykum"]
    # A playground chat, with the greeting written down as its first turn.
    (row,) = sql("SELECT channel, from_e164, agent_id, ended_at FROM calls WHERE id = ?", call_id)
    assert row == ("web", "playground", agent_id, None)
    assert sql("SELECT role, text FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)[-1] == (
        "agent",
        "Assalomu alaykum",
    )


def test_call_without_a_greeting_leaves_the_line_open(api, sql, voiced) -> None:  # noqa: ANN001
    agent_id = _seed_agent(sql, greeting="  ")
    assert _kinds(_events(api.post("/playground/call", json={"agentId": agent_id}))) == ["call", "done"]
    assert voiced == []


def test_call_without_a_voice_still_sends_the_text(api, sql) -> None:  # noqa: ANN001
    agent_id = _seed_agent(sql)  # no TTS configured in tests
    events = _events(api.post("/playground/call", json={"agentId": agent_id}))
    assert _kinds(events) == ["call", "reply", "voice:false", "done"]


def test_call_refuses_unknown_agents_and_strangers(api, sql, client) -> None:  # noqa: ANN001
    _seed_agent(sql)
    res = api.post("/playground/call", json={"agentId": "agt_someone_else"})
    assert (res.status_code, res.json()) == (404, {"error": "no_agent"})
    # A garbled body counts as `{}`: the tenant's live agent answers.
    assert _kinds(_events(api.post("/playground/call", content=b"not json")))[0] == "call"
    # Without the login cookie.
    assert client.post("/playground/call", json={}).status_code == 401


# ── /playground/turn ────────────────────────────────────────────────


def test_turn_from_streamed_words(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    voiced.clear()
    events = _events(api.post("/playground/turn", data={"callId": call_id, "text": "  Assalomu alaykum  "}))
    kinds = _kinds(events)
    assert kinds[0] == "heard" and events[0]["text"] == "Assalomu alaykum"
    assert kinds[1] == "reply" and kinds[-3:] == ["final", "detail", "done"]
    assert "audio" in kinds and set(kinds[2:-3]) <= {"audio", "more"}
    final = events[-3]
    # What was shown, piece by piece, is the reply the final event confirms.
    shown = [e["text"] for e in events if e["t"] in ("reply", "more")]
    assert shown[-1] == final["text"] and final["end"] is None
    assert list(final["ms"])[:3] == ["stt", "retrieval", "llm"] and final["ms"]["fast"] == 1
    assert final["ms"]["early"] == 0  # nothing was sent ahead (see test_early_answer.py)
    assert set(final["ms"]) <= {"stt", "retrieval", "llm", "llmFirst", "firstSegment", "firstAudio", "fast", "early"}
    assert {"firstSegment", "firstAudio"} <= set(final["ms"])
    detail = events[-2]["detail"]
    assert detail["engine"] == "local" and detail["language"] == "uz" and "citations" in detail
    # The exchange is written down, and the lock is released.
    roles = [r for (r,) in sql("SELECT role FROM turns WHERE call_id = ? ORDER BY ordinal", call_id) if r != "system"]
    assert roles[-2:] == ["caller", "agent"]
    assert call_id not in pv._busy


def test_turn_from_audio_uses_the_prefetched_transcript(api, sql, monkeypatch) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    heard: list[tuple] = []

    async def transcribe(audio: bytes, **kw):  # noqa: ANN003
        heard.append((len(audio), kw["language"], kw["engine"]))
        return {"text": "Rahmat", "engine": "gapi", "language": "uz"}

    monkeypatch.setattr(pv, "transcribe", transcribe)
    form = {"callId": call_id, "lang": "uz", "sttEngine": "gapi"}
    files = {"audio": ("phrase.wav", WAV, "audio/wav")}
    res = api.post("/playground/turn?prefetch=1", data=form, files=files)
    assert (res.status_code, res.content) == (202, b"")
    events = _events(api.post("/playground/turn", data=form, files=files))
    assert events[0] == {"t": "heard", "text": "Rahmat"}
    assert heard == [(len(WAV), "uz", "gapi")]  # transcribed once, during the pause
    assert _kinds(events)[-1] == "done"


def test_turn_legacy_mode_is_marked(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    events = _events(api.post("/playground/turn", data={"callId": call_id, "text": "Salom", "legacy": "1"}))
    assert events[-3]["t"] == "final" and events[-3]["ms"]["fast"] == 0


def test_turn_says_when_the_recogniser_fails(api, sql, monkeypatch) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))

    async def broken(audio: bytes, **kw):  # noqa: ANN003
        raise RuntimeError("stt down")

    monkeypatch.setattr(pv, "transcribe", broken)
    files = {"audio": ("phrase.wav", WAV, "audio/wav")}
    assert _events(api.post("/playground/turn", data={"callId": call_id}, files=files)) == [
        {"t": "error", "code": "stt"}
    ]
    assert call_id not in pv._busy  # the next phrase is not refused


def test_turn_heard_nothing(api, sql, monkeypatch) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))

    async def silent(audio: bytes, **kw):  # noqa: ANN003
        return {"text": "", "engine": "gapi", "language": "uz"}

    monkeypatch.setattr(pv, "transcribe", silent)
    files = {"audio": ("phrase.wav", WAV, "audio/wav")}
    events = _events(api.post("/playground/turn", data={"callId": call_id}, files=files))
    assert events == [{"t": "heard", "text": ""}, {"t": "done"}]


def test_turn_refusals(api, sql) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))

    def status(data: dict, files: dict | None = None, query: str = "") -> tuple[int, dict | None]:
        res = api.post(f"/playground/turn{query}", data=data, files=files)
        return res.status_code, (res.json() if res.content else None)

    assert status({"callId": call_id}) == (400, {"error": "bad_audio"})
    too_big = {"audio": ("phrase.wav", b"\x00" * 1_400_001, "audio/wav")}
    assert status({"callId": call_id}, too_big) == (400, {"error": "bad_audio"})
    assert status({"callId": "cal_unknown", "text": "Salom"}) == (410, {"error": "ended"})
    # A prefetch needs the words or the audio; the words start the answer early (test_early_answer.py).
    assert status({"callId": call_id}, query="?prefetch=1") == (400, {"error": "bad_audio"})
    assert status({"callId": call_id, "text": "Salom"}, query="?prefetch=1") == (202, None)
    pv.drop_early(call_id)
    # Two turns in flight would interleave the transcript.
    assert pv.claim_call(call_id)
    assert status({"callId": call_id, "text": "Salom"}) == (409, {"error": "busy_call"})
    pv.release_call(call_id)
    # Once hung up, the call takes no more turns.
    assert api.post("/playground/end", json={"callId": call_id}).status_code == 204
    assert status({"callId": call_id, "text": "Salom"}) == (410, {"error": "ended"})


# ── lap times of a turn (app/turn_timings.py) ───────────────────────


def _laps(sql, turn_id: str) -> dict:  # noqa: ANN001
    ((raw,),) = sql("SELECT timings_json FROM turns WHERE id = ?", turn_id)
    return json.loads(raw)["laps"]


def test_turn_saves_its_lap_times_and_the_page_adds_its_own(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    events = _events(api.post("/playground/turn", data={"callId": call_id, "text": "Assalomu alaykum"}))
    final = next(e for e in events if e["t"] == "final")
    turn_id = final["turn"]
    assert sql("SELECT role, call_id FROM turns WHERE id = ?", turn_id) == [("agent", call_id)]
    # The server's marks, under the names the page's waterfall uses, and the engines that ran.
    laps = _laps(sql, turn_id)
    assert {f"srv_{k}": v for k, v in final["ms"].items()}.items() <= laps.items()
    assert laps["srv_filler"] in (0, 1)
    assert laps["engines"] == {"stt": "auto", "tts": "default", "llm": "local"}
    # The original numbers stay as they were.
    ((raw,),) = sql("SELECT timings_json FROM turns WHERE id = ?", turn_id)
    assert {"sttMs", "retrievalMs", "llmMs", "ttsMs", "totalMs"} <= set(json.loads(raw))

    page = {
        "silenceWaitMs": 1100.4,
        "endpointMs": 1180,
        "mouthToEarMs": 2310,
        "gapCount": 0,
        "srv_llmFirst": 1,  # not the page's to write
        "replyRecvMs": -5,  # a broken clock
        "fillerAtMs": "300",
        "gapMs": True,
    }
    body = {"callId": call_id, "turnId": turn_id, "laps": page}
    assert api.post("/playground/timings", json=body).status_code == 204
    laps = _laps(sql, turn_id)
    assert {k: laps[k] for k in ("silenceWaitMs", "endpointMs", "mouthToEarMs", "gapCount")} == {
        "silenceWaitMs": 1100,
        "endpointMs": 1180,
        "mouthToEarMs": 2310,
        "gapCount": 0,
    }
    assert laps.get("srv_llmFirst") == final["ms"].get("llmFirst")  # the server's own value, or none
    assert not {"replyRecvMs", "fillerAtMs", "gapMs"} & set(laps)

    summary = api.get("/playground/timings").json()
    assert summary["turns"] == 1 and summary["total"] == {"p50": 2310, "p95": 2310}
    steps = {s["key"]: s["p50"] for s in summary["steps"]}
    assert steps["silence"] == 1100 and steps["words"] == 80
    assert sum(v or 0 for v in steps.values()) == 2310  # the steps add up to the whole turn
    assert summary["llms"] == ["local"] and summary["ttsEngines"] == ["default"]


def test_lap_times_only_for_this_tenants_playground_agent_turns(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    events = _events(api.post("/playground/turn", data={"callId": call_id, "text": "Salom"}))
    turn_id = next(e for e in events if e["t"] == "final")["turn"]
    ((caller_turn,),) = sql("SELECT id FROM turns WHERE call_id = ? AND role = 'caller' LIMIT 1", call_id)
    laps = {"endpointMs": 900, "mouthToEarMs": 2000}
    for body in (
        {"callId": "cal_unknown", "turnId": turn_id, "laps": laps},
        {"callId": call_id, "turnId": "trn_unknown", "laps": laps},
        {"callId": call_id, "turnId": caller_turn, "laps": laps},
        {"callId": call_id, "turnId": turn_id, "laps": {"nothing": 1}},
    ):
        assert api.post("/playground/timings", json=body).status_code == 404
    assert api.post("/playground/timings", content=b"{garbled").status_code == 404


def test_timing_summary_typical_worst_and_filters(api, sql) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    assert api.get("/playground/timings").json()["turns"] == 0
    for i in range(20):
        llm = "claude:claude-haiku-5-5" if i % 2 else "gemini:gemini-3.5-flash-lite"
        laps = {
            "silenceWaitMs": 1100,
            "endpointMs": 1150,
            "srv_stt": 0,
            "srv_retrieval": 50,
            "srv_llmFirst": 600 + i * 10,
            "srv_firstSegment": 700 + i * 10,
            "srv_firstAudio": 1100 + i * 10,
            "mouthToEarMs": 2300 + i * 10,
            "srv_early": 1 if i < 5 else 0,
            "engines": {"llm": llm, "tts": "gemini-3.8-flash-lite-tts"},
        }
        sql(
            "INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, timings_json, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            f"trn_t{i:02d}",
            TENANT,
            call_id,
            100 + i,
            "agent",
            "Javob",
            json.dumps({"totalMs": 1, "laps": laps}),
            f"2026-11-26T10:00:{i:02d}.000Z",
        )
    summary = api.get("/playground/timings").json()
    assert summary["turns"] == 20
    assert summary["total"] == {"p50": 2390, "p95": 2480}  # nearest rank over 2300…2490
    assert summary["earlyShare"] == 0.25 and summary["fillerShare"] == 0.0
    assert summary["llms"] == ["claude:claude-haiku-5-5", "gemini:gemini-3.5-flash-lite"]
    haiku = api.get("/playground/timings", params={"llm": "claude:claude-haiku-5-5"}).json()
    assert haiku["turns"] == 10 and haiku["total"]["p50"] == 2390  # 5th of 2310…2490
    none = api.get("/playground/timings", params={"tts": "eleven_v4_turbo"}).json()
    assert none["turns"] == 0 and none["total"] == {"p50": None, "p95": None}


def test_a_reopened_chat_shows_its_saved_laps(data_dir) -> None:  # noqa: ANN001
    from app.turn_timings import flat_timings

    raw = json.dumps({"totalMs": 9, "laps": {"endpointMs": 900, "srv_firstAudio": 400, "engines": {"llm": "x"}}})
    assert flat_timings(raw) == {"totalMs": 9, "endpointMs": 900, "srv_firstAudio": 400}
    assert flat_timings('{"totalMs": 9}') == {"totalMs": 9}
    assert flat_timings("not json") == {}


# ── /playground/end ─────────────────────────────────────────────────


def test_end_bills_the_call_once(api, sql) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    for body in (b"", b"{garbled", b'{"callId": 5}'):
        assert api.post("/playground/end", content=body).status_code == 204
    assert sql("SELECT ended_at FROM calls WHERE id = ?", call_id) == [(None,)]
    # The page's beacon: an application/json Blob.
    beacon = json.dumps({"callId": call_id}).encode()
    res = api.post("/playground/end", content=beacon, headers={"content-type": "application/json"})
    assert (res.status_code, res.content) == (204, b"")
    ((ended_at, outcome),) = sql("SELECT ended_at, outcome FROM calls WHERE id = ?", call_id)
    assert ended_at and outcome == "abandoned"  # only the greeting was said
    usage = sql("SELECT calls, abandoned FROM usage_daily WHERE tenant_id = ?", TENANT)
    assert usage == [(1, 1)]
    assert api.post("/playground/end", json={"callId": call_id}).status_code == 204
    assert sql("SELECT calls, abandoned FROM usage_daily WHERE tenant_id = ?", TENANT) == usage
    assert sql("SELECT ended_at FROM calls WHERE id = ?", call_id) == [(ended_at,)]


# ── /speech/live ────────────────────────────────────────────────────


@pytest.fixture
def zipformer_calls(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    calls: list[tuple] = []
    z = live.zipformer
    monkeypatch.setattr(z, "zipformer_available", lambda: True)
    monkeypatch.setattr(z, "feed_live", lambda o, s, x: calls.append(("feed", o, s, len(x))) or "salom")

    def finish(o: str, s: str, x=None) -> str:  # noqa: ANN001
        calls.append(("finish", o, s, None if x is None else len(x)))
        return "salom dunyo"

    monkeypatch.setattr(z, "finish_live", finish)
    monkeypatch.setattr(z, "begin_live", lambda o, s: calls.append(("begin", o, s)) or "sa")
    monkeypatch.setattr(z, "reset_live", lambda o, s: calls.append(("reset", o, s)))
    monkeypatch.setattr(z, "close_live", lambda o, s: calls.append(("close", o, s)))
    return calls


def test_live_words(api, zipformer_calls) -> None:  # noqa: ANN001
    sid = "abcd-1234_ef"
    piece = {"audio": ("blob", np.zeros(4000, dtype="<i2").tobytes(), "application/octet-stream")}

    def post(op: str, files: dict | None = None, sid: str = sid):
        return api.post("/speech/live", data={"sid": sid, "op": op}, files=files)

    assert post("feed", piece).json() == {"text": "salom"}
    assert post("feed").json() == {"text": "salom"}
    assert post("finish", piece).json() == {"text": "salom dunyo"}
    assert post("finish").json() == {"text": "salom dunyo"}
    assert post("begin").json() == {"text": "sa"}
    assert post("reset").json() == {"text": ""}
    assert post("close").json() == {"ok": True}
    assert zipformer_calls == [
        ("feed", USER, sid, 4000),
        ("feed", USER, sid, 0),
        ("finish", USER, sid, 4000),
        ("finish", USER, sid, None),
        ("begin", USER, sid),
        ("reset", USER, sid),
        ("close", USER, sid),
    ]
    assert (post("dance").status_code, post("dance").json()) == (400, {"error": "bad_op"})
    for bad in ("short", "x" * 65, "abcd 1234", "салом-1234"):
        assert post("feed", sid=bad).json() == {"error": "bad_session"}
    big = {"audio": ("blob", b"\x00" * (512 * 1024 + 2), "application/octet-stream")}
    assert post("feed", big).status_code == 413


def test_live_failures(api, monkeypatch) -> None:  # noqa: ANN001
    z = live.zipformer
    monkeypatch.setattr(z, "zipformer_available", lambda: False)
    res = api.post("/speech/live", data={"sid": "abcd-1234", "op": "feed"})
    assert (res.status_code, res.json()) == (503, {"error": "zipformer_not_available"})
    monkeypatch.setattr(z, "zipformer_available", lambda: True)

    def boom(*a):  # noqa: ANN002
        raise PermissionError("session_owner")

    monkeypatch.setattr(z, "feed_live", boom)
    res = api.post("/speech/live", data={"sid": "abcd-1234", "op": "feed"})
    assert (res.status_code, res.json()) == (502, {"error": "zipformer_failed"})


# ── /stream ─────────────────────────────────────────────────────────


def test_stream_sends_heartbeat_events_and_pings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live, "PING_EVERY_S", 0.05)
    session = Session(user={"id": USER}, tenant={"id": TENANT})

    async def main() -> list[str]:
        res = await live.stream(session)
        assert res.media_type == "text/event-stream; charset=utf-8"
        assert res.headers["x-accel-buffering"] == "no"
        frames = res.body_iterator
        out = [await anext(frames)]
        assert bus.subscriber_count(TENANT) == 1
        bus.publish(TENANT, {"type": "call.started", "callId": "cal_1"})
        bus.publish("ten_other", {"type": "call.started", "callId": "cal_2"})
        out.append(await anext(frames))
        out.append(await anext(frames))  # nothing more for 50 ms: a ping
        await frames.aclose()  # the tab closed
        assert bus.subscriber_count(TENANT) == 0
        return out

    heartbeat, event, ping = asyncio.run(main())
    assert heartbeat.startswith('data: {"type":"heartbeat","at":"') and heartbeat.endswith('Z"}\n\n')
    assert event == 'data: {"type":"call.started","callId":"cal_1"}\n\n'
    assert ping == ": ping\n\n"


# ── talked over (Q7): stop the turn, keep only what was heard ───────


def _agent_text(sql, call_id: str) -> list[str]:  # noqa: ANN001
    return [t for (t,) in sql("SELECT text FROM turns WHERE call_id = ? AND role = 'agent' ORDER BY ordinal", call_id)]


def test_a_turn_talked_over_stops_writing_and_keeps_what_it_wrote(api, sql, monkeypatch) -> None:  # noqa: ANN001
    """The model is stopped mid-answer: the turn is written down with only the words written so far."""
    from app.engine import conversation

    words = ["Sizning", "qarzingiz", "besh", "million", "so'm,", "to'lov", "muddati", "yigirma", "beshinchi", "noyabr."]
    told: list[str] = []

    async def slow_model(inp, on_delta=None):  # noqa: ANN001, ANN202
        for i, word in enumerate(words):
            await asyncio.sleep(0.05)
            told.append(word)
            if on_delta:
                on_delta(word if i == 0 else f" {word}")
        return {"answer": " ".join(words), "intent": "other", "answered": True, "usedHits": [], "engine": "fake:m"}

    monkeypatch.setattr(conversation, "generate_answer", slow_model)
    call_id = _open_call(api, _seed_agent(sql))
    agent = dict(zip([c[1] for c in sql("PRAGMA table_info(agents)")], sql("SELECT * FROM agents")[0], strict=True))

    async def go() -> dict:
        stop = asyncio.Event()
        asyncio.get_running_loop().call_later(0.18, stop.set)  # the caller cuts in after ~3 words
        return await conversation.run_turn(
            tenant_id=TENANT,
            call_id=call_id,
            agent=agent,
            utterance="Qarzim qancha?",
            on_delta=lambda d: None,
            stop=stop,
        )

    result = asyncio.run(go())
    assert 1 <= len(result["reply"].split()) < len(words)  # stopped early, kept what was written
    assert len(told) < len(words)  # the model really stopped
    kept = result["reply"].split()
    assert kept == words[: len(kept)]  # whole words only, in order: no half-written last word
    assert _agent_text(sql, call_id)[-1] == result["reply"]


def test_cut_keeps_only_the_share_heard(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    _events(api.post("/playground/turn", data={"callId": call_id, "text": "Kredit foizi qancha?"}))
    full = _agent_text(sql, call_id)[-1]
    n = len(full.split())
    res = api.post("/playground/cut", json={"callId": call_id, "heard": 0.5})
    assert res.status_code == 200 and res.json() == {"result": "cut" if n > 1 else "kept"}
    if n > 1:
        cut = _agent_text(sql, call_id)[-1]
        assert cut.endswith("…") and len(cut[:-1].split()) == max(1, n // 2)
        assert full.startswith(cut[:-1])


def test_a_reply_nobody_heard_is_not_kept(api, sql, voiced) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    _events(api.post("/playground/turn", data={"callId": call_id, "text": "Kredit foizi qancha?"}))
    before = _agent_text(sql, call_id)
    assert api.post("/playground/cut", json={"callId": call_id, "heard": 0}).json() == {"result": "removed"}
    assert _agent_text(sql, call_id) == before[:-1]  # the greeting stays, the unheard reply is gone
    # The caller's own words stay in the transcript.
    assert sql("SELECT text FROM turns WHERE call_id = ? AND role = 'caller'", call_id)[-1] == ("Kredit foizi qancha?",)


def test_cut_refusals(api, sql) -> None:  # noqa: ANN001
    call_id = _open_call(api, _seed_agent(sql))
    assert api.post("/playground/cut", json={"callId": "cal_x", "heard": 0.5}).status_code == 404
    for heard in (-0.1, 1.5, "half", True, None):
        assert api.post("/playground/cut", json={"callId": call_id, "heard": heard}).status_code == 400
    assert api.post("/playground/cut", json={"callId": call_id, "heard": 1}).json() == {"result": "kept"}
