"""
The AudioSocket bridge in Python (telephony-bridge/bridge.py) on a simulated Asterisk call
(`tests/bridge_sim.py`): the requests it makes to the site, the audio it puts on the line, barge-in,
fillers and hanging up after an escalation. During the port the same call was run against the
original bridge.mjs: the same 9 requests and byte-identical audio (156 frames).
"""

import asyncio

import pytest

from tests.bridge_sim import FROM, SECRET, TO, pcm, python_bridge, run_call


@pytest.fixture(scope="module")
def call() -> dict:
    return asyncio.run(run_call(python_bridge()))


def _audio(call: dict) -> bytes:
    return b"".join(payload for _, kind, payload in call["frames"] if kind == 0x10)


def test_every_request_carries_the_secret_and_the_numbers(call) -> None:  # noqa: ANN001
    assert all(r["secret"] == SECRET for r in call["requests"])
    for r in call["requests"]:
        if r["path"] != "end":
            assert r["to"] == TO


def test_opening_the_call(call) -> None:  # noqa: ANN001
    first = [r for r in call["requests"] if r.get("first") == "true"]
    assert first == [{"path": "turn", "secret": SECRET, "callId": "", "from": FROM, "to": TO, "first": "true"}]
    fillers = sorted(r["i"] for r in call["requests"] if r["path"] == "filler")
    assert fillers == ["0", "1", "2"]


def test_each_utterance_becomes_a_turn(call) -> None:  # noqa: ANN001
    turns = [r for r in call["requests"] if r["path"] == "turn" and "audio_len" in r]
    assert len(turns) == 4
    for r in turns:
        assert r["callId"] == "call_simulated0001"
        assert (r["audio_name"], r["audio_type"]) == ("utterance.wav", "audio/wav")
        assert r["from"] == FROM
    # 200 ms preroll + 600 ms speech + 350 ms of trailing silence, as a WAV (44-byte header).
    assert [r["audio_len"] for r in turns] == [18604, 18604, 17004, 18604]
    # Only the turn after the barge-in reports how much of the cut-off reply was heard.
    assert ["spokenRatio" in r for r in turns] == [False, False, True, False]
    assert 0.2 <= float(turns[2]["spokenRatio"]) <= 0.45
    assert len(turns[2]["spokenRatio"].split(".")[1]) == 3  # toFixed(3)


def test_audio_on_the_line(call) -> None:  # noqa: ANN001
    frames = [(kind, payload) for _, kind, payload in call["frames"]]
    assert frames and all(kind == 0x10 and len(payload) == 320 for kind, payload in frames)
    audio = _audio(call)
    greeting, reply0 = pcm("greeting", 600), pcm("reply0", 500)
    filler_lines = [pcm(f"filler{i}", 300) for i in range(3)]
    # The greeting, then (the answer took 0.7 s) a filler, then the first reply — frame-aligned, no gaps.
    assert audio.startswith(greeting)
    rest = audio[len(greeting) :]
    assert any(rest.startswith(f) for f in filler_lines)
    assert rest[4800:].startswith(reply0)


def test_barge_in_stops_the_long_reply(call) -> None:  # noqa: ANN001
    audio = _audio(call)
    long_reply = pcm("reply1", 2400)
    start = audio.find(long_reply[:3200])
    assert start > 0
    played = 0
    while start + played < len(audio) and played < len(long_reply) and audio[start + played] == long_reply[played]:
        played += 1
    # Cut off well before its end (it is 2.4 s; the caller spoke after about 0.7 s).
    assert 0 < played < len(long_reply) // 2
    assert any("barge-in — stopping playback" in line for line in call["output"])


def test_escalation_plays_the_handoff_then_hangs_up(call) -> None:  # noqa: ANN001
    assert _audio(call).endswith(pcm("reply3", 500))
    assert call["hung_up_by_bridge"] is True
    (end,) = [r for r in call["requests"] if r["path"] == "end"]
    assert end["callId"] == "call_simulated0001"
    assert end["content_type"] == "application/json"
    assert isinstance(end["durationSec"], int) and 5 <= end["durationSec"] <= 20
    assert call["requests"][-1]["path"] == "end"
