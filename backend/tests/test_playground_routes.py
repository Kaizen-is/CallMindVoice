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
    assert set(final["ms"]) <= {"stt", "retrieval", "llm", "llmFirst", "firstSegment", "firstAudio", "fast"}
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
    # A prefetch needs the audio itself.
    assert status({"callId": call_id, "text": "Salom"}, query="?prefetch=1") == (400, {"error": "bad_audio"})
    # Two turns in flight would interleave the transcript.
    assert pv.claim_call(call_id)
    assert status({"callId": call_id, "text": "Salom"}) == (409, {"error": "busy_call"})
    pv.release_call(call_id)
    # Once hung up, the call takes no more turns.
    assert api.post("/playground/end", json={"callId": call_id}).status_code == 204
    assert status({"callId": call_id, "text": "Salom"}) == (410, {"error": "ended"})


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
    assert post("reset").json() == {"text": ""}
    assert post("close").json() == {"ok": True}
    assert zipformer_calls == [
        ("feed", USER, sid, 4000),
        ("feed", USER, sid, 0),
        ("finish", USER, sid, 4000),
        ("finish", USER, sid, None),
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
