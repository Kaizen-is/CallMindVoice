"""
L8 pilot (app/engine/native_call.py, app/routers/playground_native.py): the tools our code answers, the
text guardrail, and a whole call over the socket against a stand-in Gemini Live server (no voice made).
"""

import asyncio
import base64
import contextlib
import json
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
import websockets
from starlette.websockets import WebSocketDisconnect

from app.engine.native_call import CallFacts, guard, run_tool, whole_sentences
from tests.test_playground_routes import TENANT, _seed_agent, api  # noqa: F401

NOW = datetime(2026, 11, 27, 9, 0, tzinfo=UTC)
TARGET = {"fullName": "Aziz Karimov", "birthYear": "1992", "loanAmount": "7 800 000 so'm", "prompt": "uch oyga"}


def test_identity_gates_the_balance_and_the_promise() -> None:
    facts = CallFacts(dict(TARGET), "uz")
    assert run_tool(facts, "get_balance", {}) == {"error": "identity_not_confirmed"}
    assert run_tool(facts, "record_promise", {"day": "ertaga"}, NOW)["saved"] is False
    wrong = run_tool(facts, "check_identity", {"birth_year": "1987"})
    assert wrong["confirmed"] is False and "1992" not in json.dumps(wrong)  # the model never learns the year
    assert run_tool(facts, "check_identity", {"birth_year": "1992-yil"}) == {"confirmed": True}
    balance = run_tool(facts, "get_balance", {})
    assert balance["owes"] == "7 800 000 so'm" and any("2 600 000" in line for line in balance["split"])


def test_a_promise_is_checked_in_code() -> None:
    facts = CallFacts(dict(TARGET), "uz", confirmed=True)
    saved = run_tool(facts, "record_promise", {"day": "25-dekabr", "amount": 99_000_000}, NOW)
    assert saved["saved"] is True and saved["amount"] == 7_800_000  # no more than the debt
    assert facts.promise["date"] == "2026-12-25"
    assert run_tool(facts, "record_promise", {"day": "2027-06-01"}, NOW) == {
        "saved": False,
        "reason": "day_out_of_range",
    }
    assert run_tool(facts, "record_promise", {"day": "qachondir"}, NOW)["reason"] == "day_not_understood"


def test_the_guardrail_flags_sums() -> None:
    facts = CallFacts(dict(TARGET), "uz")
    assert guard(facts, "Sizda yetti million sakkiz yuz ming so'm qarz bor.") == ["sum_before_identity"]
    # Why we call is private too: no loan, debt or payment before the identity check (the bank's name is fine).
    assert guard(facts, "Kredit bo'yicha muddati oʻtgan toʻlovni eslatish uchun qoʻngʻiroq qildim.") == [
        "topic_before_identity"
    ]
    assert guard(facts, "Я звоню по поводу задолженности.") == ["topic_before_identity"]
    assert guard(facts, "Men Isomiddin, Biznesni rivojlantirish bankidan qoʻngʻiroq qilyapman.") == []
    facts.confirmed = True
    assert guard(facts, "Kredit bo'yicha muddati o'tgan to'lovni eslatmoqchiman.") == []
    assert guard(facts, "Qarzingiz 7 800 000 so'm, uch qismga 2 600 000 so'mdan.") == []
    assert guard(facts, "Qarzingiz 8 100 000 so'm.") == ["sum_not_given:8100000"]


def test_a_cut_line_keeps_its_whole_sentences() -> None:
    assert whole_sentences("Tushundim. Yetti million sakkiz") == "Tushundim."
    assert whole_sentences("Tushundim, yetti million sakkiz") == ""
    assert whole_sentences("Rahmat! Qachon?") == "Rahmat! Qachon?"


class FakeGemini:
    """A stand-in Gemini Live server: greets, asks for the year through check_identity, then answers."""

    def __init__(self) -> None:
        self.received: list[dict] = []
        self.port = 0
        self.ready = threading.Event()

    async def handler(self, ws) -> None:  # noqa: ANN001
        async def say(text: str, audio: bool = True) -> None:
            parts = [
                {"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": base64.b64encode(b"\x01\x02" * 8).decode()}}
            ]
            await ws.send(json.dumps({"serverContent": {"modelTurn": {"parts": parts if audio else []}}}))
            await ws.send(json.dumps({"serverContent": {"outputTranscription": {"text": text}}}))
            await ws.send(json.dumps({"serverContent": {"turnComplete": True}}))

        async for raw in ws:
            msg = json.loads(raw)
            self.received.append(msg)
            if "setup" in msg:
                await ws.send(json.dumps({"setupComplete": {}}))
            elif "clientContent" in msg:
                text = msg["clientContent"]["turns"][0]["parts"][0]["text"]
                if text.startswith("[The call"):
                    await say("Assalomu alaykum! Aziz Karimov bilan gaplashyapmanmi?")
                elif "1992" in text:
                    # As the real server: the tool call closes a model turn of its own, then the answer follows.
                    call = {"functionCalls": [{"id": "c1", "name": "check_identity", "args": {"birth_year": "1992"}}]}
                    await ws.send(json.dumps({"toolCall": call}))
                    await ws.send(json.dumps({"serverContent": {"turnComplete": True}}))
                else:
                    # The person talked over a line that was cut mid-number: not a wrong sum.
                    await ws.send(json.dumps({"serverContent": {"outputTranscription": {"text": "Bu yetti million"}}}))
                    await ws.send(json.dumps({"serverContent": {"interrupted": True}}))
                    await ws.send(json.dumps({"serverContent": {"turnComplete": True}}))
                    await say("Qarzingiz 9 000 000 so'm.")  # a sum it was never given: the guardrail flags it
            elif "toolResponse" in msg:
                await say("Rahmat, tasdiqlandi.")

    def run(self) -> None:
        async def main() -> None:
            async with websockets.serve(self.handler, "127.0.0.1", 0) as server:
                self.port = server.sockets[0].getsockname()[1]
                self.ready.set()
                await asyncio.Future()

        threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
        self.ready.wait(5)


@pytest.fixture
def gemini(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeGemini]:
    fake = FakeGemini()
    fake.run()
    monkeypatch.setenv("GEMINI_LIVE_URL", f"ws://127.0.0.1:{fake.port}")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    yield fake


def _until(ws, kind: str) -> tuple[dict, list]:  # noqa: ANN001
    seen = []
    while True:
        message = ws.receive()
        if message.get("bytes") is not None:
            seen.append(("audio", len(message["bytes"])))
            continue
        event = json.loads(message["text"])
        seen.append(event)
        if event.get("t") == kind:
            return event, seen


def test_a_native_call_end_to_end(api, sql, gemini: FakeGemini) -> None:  # noqa: ANN001, F811
    sql(
        "UPDATE agents SET target_json = ? WHERE id = ?",
        json.dumps(TARGET),
        _seed_agent(sql),
    )
    with api.websocket_connect("/playground/native?agentId=agt_test000000000001&lang=uz") as ws:
        ready, _ = _until(ws, "ready")
        opening, seen = _until(ws, "turn")
        assert "Aziz Karimov" in opening["agent"] and ("audio", 16) in seen
        ws.send_text(json.dumps({"op": "text", "text": "Ha, men. 1992-yil."}))
        tool, _ = _until(ws, "tool")
        assert tool["name"] == "check_identity" and tool["result"] == {"confirmed": True}
        asked, _ = _until(ws, "turn")
        assert asked["more"] is True and asked["agent"] == ""  # the tool's turn: the answer comes next
        confirmed, _ = _until(ws, "turn")
        assert confirmed["agent"] == "Rahmat, tasdiqlandi." and confirmed["flags"] == []
        assert confirmed["more"] is False
        ws.send_text(json.dumps({"op": "text", "text": "Qancha qarzim bor?"}))
        cut, seen = _until(ws, "turn")
        assert {"t": "interrupted"} in seen
        assert cut["cut"] is True and cut["agent"] == "Bu yetti million" and cut["flags"] == []
        flagged, _ = _until(ws, "turn")
        assert flagged["flags"] == ["sum_not_given:9000000"] and flagged["cut"] is False
        ws.send_text(json.dumps({"op": "end"}))
        with contextlib.suppress(WebSocketDisconnect):
            while True:  # until the server has hung up and closed the socket
                ws.receive_text()
    setup = gemini.received[0]["setup"]
    assert setup["model"] == "models/gemini-3.8-live" and setup["tools"][0]["functionDeclarations"][0]["name"]
    assert "1992" not in json.dumps(setup)  # the year never reaches the model
    rows = sql("SELECT role, text FROM turns WHERE call_id = ? ORDER BY ordinal", ready["callId"])
    assert [r[0] for r in rows][:3] == ["agent", "caller", "agent"]
    for _ in range(50):  # the server hangs up after the socket closes
        if sql("SELECT ended_at FROM calls WHERE id = ?", ready["callId"])[0][0]:
            break
        time.sleep(0.05)
    assert sql("SELECT ended_at FROM calls WHERE id = ?", ready["callId"])[0][0]
