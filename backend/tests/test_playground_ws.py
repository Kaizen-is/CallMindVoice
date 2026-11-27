"""
The Playground call over one WebSocket (L2, app/routers/playground_ws.py): live words, a turn with its
audio as raw bytes, an early start, a cut-in and timings — the same results as the HTTP routes.
"""

import json
import struct

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.speech import speko_live
from tests.test_playground_routes import TENANT, _events, _open_call, _seed_agent, api, voiced  # noqa: F401

HEADER = struct.Struct("<BIII")


def _turn_events(ws, seq: int) -> tuple[list[dict], list[bytes]]:  # noqa: ANN001
    """Read the socket until the turn `seq` is closed: its JSON events and its audio frames."""
    events, audio = [], []
    while True:
        message = ws.receive()
        if message.get("bytes") is not None:
            kind, got_seq, rate, after = HEADER.unpack_from(message["bytes"])
            assert got_seq == seq
            audio.append(message["bytes"][HEADER.size :])
            continue
        event = json.loads(message["text"])
        if event.get("seq") != seq:
            continue
        if event["t"] == "closed":
            return events, audio
        events.append(event)


def test_a_turn_over_the_socket_is_the_same_turn(api, sql, voiced) -> None:  # noqa: ANN001, F811
    call_id = _open_call(api, _seed_agent(sql))
    with api.websocket_connect("/playground/ws") as ws:
        ws.send_text(json.dumps({"op": "turn", "seq": 1, "fields": {"callId": call_id, "text": "Assalomu alaykum"}}))
        events, audio = _turn_events(ws, 1)
    kinds = [e["t"] for e in events]
    assert kinds[0] == "heard" and events[0]["text"] == "Assalomu alaykum"
    assert kinds[-3:] == ["final", "detail", "done"] and "reply" in kinds
    assert audio and all(audio)  # the voice came back as raw bytes, not base64 text
    final = next(e for e in events if e["t"] == "final")
    assert final["turn"].startswith("trn")  # Q1: the turn id, as over HTTP
    rows = [r for (r,) in sql("SELECT role FROM turns WHERE call_id = ? ORDER BY ordinal", call_id) if r != "system"]
    assert rows[-2:] == ["caller", "agent"]


def test_refusals_and_the_early_start(api, sql, voiced) -> None:  # noqa: ANN001, F811
    call_id = _open_call(api, _seed_agent(sql))
    with api.websocket_connect("/playground/ws") as ws:
        ws.send_text(json.dumps({"op": "turn", "seq": 7, "fields": {"callId": "cal_unknown", "text": "Salom"}}))
        assert json.loads(ws.receive_text()) == {"seq": 7, "t": "error", "status": 410, "error": "ended"}
        ws.send_text(json.dumps({"op": "prefetch", "seq": 8, "fields": {"callId": call_id, "text": "Qarzim qancha?"}}))
        assert json.loads(ws.receive_text()) == {"seq": 8, "t": "accepted", "status": 202}
        ws.send_text(json.dumps({"op": "turn", "seq": 9, "fields": {"callId": call_id, "text": "Qarzim qancha?"}}))
        events, _audio = _turn_events(ws, 9)
    assert next(e for e in events if e["t"] == "final")["ms"]["early"] == 1  # the early start was used


def test_cut_and_timings_over_the_socket(api, sql, voiced) -> None:  # noqa: ANN001, F811
    call_id = _open_call(api, _seed_agent(sql))
    with api.websocket_connect("/playground/ws") as ws:
        ws.send_text(
            json.dumps({"op": "turn", "seq": 1, "fields": {"callId": call_id, "text": "Kredit foizi qancha?"}})
        )
        events, _audio = _turn_events(ws, 1)
        turn_id = next(e for e in events if e["t"] == "final")["turn"]
        ws.send_text(
            json.dumps(
                {
                    "op": "timings",
                    "callId": call_id,
                    "turnId": turn_id,
                    "laps": {"endpointMs": 900, "mouthToEarMs": 2000},
                }
            )
        )
        assert json.loads(ws.receive_text()) == {"t": "timings", "ok": True}
        ws.send_text(json.dumps({"op": "cut", "callId": call_id, "heard": 0}))
        assert json.loads(ws.receive_text()) == {"t": "cut", "result": "removed"}
        ws.send_text(json.dumps({"op": "cut", "callId": "cal_x", "heard": 0}))
        assert json.loads(ws.receive_text()) == {"t": "cut", "result": "refused"}


def test_live_words_over_the_socket(api, monkeypatch) -> None:  # noqa: ANN001, F811
    """Audio pieces as binary frames and the control ops by id reach the same live-words code."""
    seen: list[tuple] = []

    class FakeStream:
        async def feed(self, pcm: bytes) -> str:
            seen.append(("feed", len(pcm)))
            return "Qancha qarzim"

        async def flush(self, pcm: bytes) -> str:
            seen.append(("flush", len(pcm)))
            return "Qancha qarzim qoldi?"

    async def stream_for(owner, sid, engine, tenant_id, language="uz", vocabulary=None):  # noqa: ANN001, ANN202
        seen.append(("stream", sid, engine, language))
        return FakeStream()

    monkeypatch.setattr(speko_live, "live_ready", lambda engine: True)
    monkeypatch.setattr(speko_live, "stream_for", stream_for)
    with api.websocket_connect("/playground/ws") as ws:
        ws.send_text(
            json.dumps({"op": "live-config", "sid": "sid-ws-test-0001", "engine": "gemini_live", "language": "uz"})
        )
        ws.send_bytes(b"\x00\x01" * 1600)
        assert json.loads(ws.receive_text()) == {"t": "live", "id": None, "text": "Qancha qarzim", "status": 200}
        ws.send_text(json.dumps({"op": "live", "id": 5, "live": "flush"}))
        assert json.loads(ws.receive_text()) == {"t": "live", "id": 5, "text": "Qancha qarzim qoldi?", "status": 200}
    assert ("feed", 3200) in seen and ("flush", 0) in seen
    assert seen[0] == ("stream", "sid-ws-test-0001", "gemini_live", "uz")


def test_no_login_no_socket(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as closed, client.websocket_connect("/playground/ws") as ws:
        ws.receive_text()
    assert closed.value.code == 4401
