"""
Turn gating in the phone bridge (telephony-bridge/bridge.py), frame by frame and in-process: what
the caller's line may and may not do while a turn is being answered.

  - The utterance's turn exists in the same step that finalizes it (no frame can open a second one).
  - THINKING (the /turn is in flight, its reply not yet playing): background speech neither cancels
    the turn nor becomes a new one.
  - SPEAKING: sustained speech is still a barge-in, and becomes the next utterance.
  - REARMING: the line's tail right after a reply is ignored, then listening resumes.
  - Calls are independent; a superseded turn finishing late changes nothing.
"""

import dataclasses
import importlib.util
import math
import struct
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("callmind_bridge", REPO / "telephony-bridge" / "bridge.py")
assert _spec and _spec.loader
bridge = importlib.util.module_from_spec(_spec)
sys.modules["callmind_bridge"] = bridge
_spec.loader.exec_module(bridge)


def frames(ms: int, amplitude: int) -> list[bytes]:
    """20 ms frames of a 300 Hz tone at 8 kHz (small amplitude = line noise, large = speech)."""
    out = []
    for f in range(ms // 20):
        samples = [int(amplitude * math.sin(2 * math.pi * 300 * (f * 160 + i) / 8000)) for i in range(160)]
        out.append(struct.pack("<160h", *samples))
    return out


NOISE, SPEECH = 60, 9000


class _Writer:
    def write(self, data: bytes) -> None:
        pass

    def is_closing(self) -> bool:
        return False

    def can_write_eof(self) -> bool:
        return False

    def close(self) -> None:
        pass


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch) -> Clock:  # noqa: ANN001
    c = Clock()
    monkeypatch.setattr(bridge, "now_ms", c)
    return c


def make_conn() -> tuple:
    conn = bridge.Connection(_Writer(), client=None)
    spawned: list = []

    def spawn(coro):  # noqa: ANN001, ANN202
        spawned.append(coro)
        coro.close()  # the HTTP side is not under test here

    conn.spawn = spawn
    return conn, spawned


def feed(conn, clock: Clock, chunks: list[bytes]) -> None:  # noqa: ANN001
    for chunk in chunks:
        bridge.on_audio(conn, chunk)
        clock.t += 20


def speak_one_utterance(conn, clock: Clock) -> None:  # noqa: ANN001
    feed(conn, clock, frames(400, NOISE) + frames(600, SPEECH) + frames(360, NOISE))


def test_the_turn_exists_as_soon_as_the_utterance_ends(clock) -> None:  # noqa: ANN001
    conn, spawned = make_conn()
    speak_one_utterance(conn, clock)
    assert len(spawned) == 1
    assert conn.turn is not None and conn.turn.turn_id == 1
    assert conn.state == bridge.THINKING
    assert not conn.speaking


def test_background_speech_while_thinking_is_dropped(clock) -> None:  # noqa: ANN001
    conn, spawned = make_conn()
    speak_one_utterance(conn, clock)
    turn = conn.turn
    # Someone else talks, loudly, for a whole second while the answer is being worked out.
    feed(conn, clock, frames(1000, SPEECH) + frames(400, NOISE))
    assert conn.turn is turn and not turn.aborted  # the caller's turn was not cancelled
    assert len(spawned) == 1  # and no second utterance was started
    assert not conn.speaking and conn.preroll == []
    assert conn.dropped_ms >= 1000


def test_the_old_behaviour_is_one_setting_away(clock, monkeypatch) -> None:  # noqa: ANN001
    vad = dataclasses.replace(bridge.CONFIG.vad, barge_while_thinking=True)
    monkeypatch.setattr(bridge, "CONFIG", dataclasses.replace(bridge.CONFIG, vad=vad))
    conn, _ = make_conn()
    speak_one_utterance(conn, clock)
    turn = conn.turn
    feed(conn, clock, frames(300, SPEECH))
    assert turn.aborted and conn.turn is None


def test_speech_over_the_reply_is_a_barge_in_and_the_next_utterance(clock) -> None:  # noqa: ANN001
    conn, spawned = make_conn()
    speak_one_utterance(conn, clock)
    turn = conn.turn
    turn.playback.mark_reply_start()  # the reply's own audio is now on the line
    assert conn.state == bridge.SPEAKING
    feed(conn, clock, frames(100, SPEECH))  # a short burst is not enough
    assert conn.turn is turn
    feed(conn, clock, frames(100, NOISE))
    assert conn.barge_voiced_ms == 0
    feed(conn, clock, frames(700, SPEECH) + frames(360, NOISE))
    assert turn.aborted
    assert len(spawned) == 2  # the interruption became its own turn
    assert conn.turn is not None and conn.turn.turn_id == 2


def test_a_late_finish_of_a_superseded_turn_changes_nothing(clock) -> None:  # noqa: ANN001
    conn, _ = make_conn()
    first = conn.new_turn()
    second = conn.new_turn()
    conn.release(first)
    assert conn.turn is second
    assert conn.state == bridge.THINKING


def test_the_line_rearms_after_the_reply(clock) -> None:  # noqa: ANN001
    conn, spawned = make_conn()
    speak_one_utterance(conn, clock)
    conn.release(conn.turn)
    assert conn.state == bridge.REARMING
    # The reply's tail / room audio right after it: ignored, and no preroll is kept from it.
    feed(conn, clock, frames(bridge.CONFIG.vad.rearm_ms, SPEECH))
    assert not conn.speaking and len(spawned) == 1
    assert conn.state == bridge.LISTENING
    # Then a real new phrase is heard as usual.
    feed(conn, clock, frames(200, NOISE) + frames(600, SPEECH) + frames(360, NOISE))
    assert len(spawned) == 2


def test_calls_are_independent(clock) -> None:  # noqa: ANN001
    a, spawned_a = make_conn()
    b, spawned_b = make_conn()
    speak_one_utterance(a, clock)
    assert a.state == bridge.THINKING
    # Call B is not affected by call A thinking.
    feed(b, clock, frames(400, NOISE) + frames(600, SPEECH))
    assert b.state == bridge.CAPTURING
    feed(b, clock, frames(360, NOISE))
    assert len(spawned_a) == 1 and len(spawned_b) == 1
    assert a.turn is not b.turn
