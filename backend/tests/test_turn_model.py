"""
L3, the end-of-turn model (app/speech/turn_model.py): its input, the live sessions' recent audio, the
score a flush brings back (over requests and over the socket), and what the timing summary makes of it.
"""

import json
from collections.abc import Iterator

import numpy as np
import pytest

from app import turn_timings
from app.speech import speko_live
from app.speech import turn_model as tm
from tests.test_playground_routes import api  # noqa: F401


class FakeModel:
    """Says 0.9 for a phrase that ends quiet after something loud, else 0.1; remembers what it was given."""

    def __init__(self) -> None:
        self.inputs: list[np.ndarray] = []

    def run(self, _outputs, feeds):  # noqa: ANN001, ANN201
        x = feeds["input_features"]
        self.inputs.append(x)
        tail, body = x[0, :, -30:].mean(), x[0, :, :-30].max()
        return [np.array([[0.9 if body - tail > 0.5 else 0.1]], dtype=np.float32)]


@pytest.fixture
def model() -> Iterator[FakeModel]:
    fake = FakeModel()
    tm.set_session(fake)
    tm._recent.clear()
    yield fake
    tm.set_session(None)
    tm._recent.clear()


def _speech_then_quiet(speech_s: float = 1.0, quiet_s: float = 0.3) -> bytes:
    t = np.arange(int(speech_s * 16000)) / 16000
    voice = 0.3 * np.sin(2 * np.pi * 220 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))
    x = np.concatenate([voice, np.zeros(int(quiet_s * 16000))])
    return (x * 32767).astype("<i2").tobytes()


def test_features_are_whisper_shaped() -> None:
    f = tm.features(np.zeros(16000, dtype=np.float32))
    assert f.shape == (1, 80, 800) and f.dtype == np.float32
    long = tm.features(np.random.default_rng(0).standard_normal(20 * 16000).astype(np.float32))
    assert long.shape == (1, 80, 800)  # the last 8 s


def test_recent_audio_follows_the_phrase(model: FakeModel) -> None:
    tm.note("u", "s1", "feed", b"\x00\x10" * 16000)  # 1 s
    tm.note("u", "s1", "feed", np.zeros(8000, dtype=np.float32))  # 0.5 s, as floats
    assert len(tm.recent_audio("u", "s1")) == 24000
    tm.note("u", "s1", "begin", None)  # a new phrase keeps only the moment before it
    assert len(tm.recent_audio("u", "s1")) == 8000
    tm.note("u", "s1", "feed", b"\x00\x00" * (10 * 16000))
    assert len(tm.recent_audio("u", "s1")) == 8 * 16000  # never more than 8 s
    tm.note("u", "s1", "reset", None)
    assert len(tm.recent_audio("u", "s1")) == 0
    tm.note("u", "s1", "close", None)
    assert tm.recent_audio("u", "s1") is None


def test_no_model_no_score() -> None:
    tm.set_session(None)
    tm.note("u", "s2", "feed", _speech_then_quiet())
    assert tm.end_probability_for("u", "s2")[0] is None  # tests have their own data dir: no model file
    tm.note("u", "s2", "close", None)


def _cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeStream:
        async def feed(self, pcm: bytes) -> str:
            return "Men to'layman"

        async def flush(self, pcm: bytes) -> str:
            return "Men to'layman."

    async def stream_for(owner, sid, engine, tenant_id, language="uz", vocabulary=None):  # noqa: ANN001, ANN202
        return FakeStream()

    monkeypatch.setattr(speko_live, "live_ready", lambda engine: True)
    monkeypatch.setattr(speko_live, "stream_for", stream_for)


def test_endpoint_scores_the_phrase_so_far(api, model: FakeModel, monkeypatch) -> None:  # noqa: ANN001, F811
    _cloud(monkeypatch)
    form = {"sid": "sid-turn-model-01", "engine": "gemini_live", "language": "uz"}
    piece = ("p.pcm", _speech_then_quiet(), "application/octet-stream")
    assert api.post("/speech/live", data={**form, "op": "feed"}, files={"audio": piece}).json() == {
        "text": "Men to'layman"
    }
    assert api.post("/speech/live", data={**form, "op": "flush"}).json() == {"text": "Men to'layman."}
    assert not model.inputs  # the recogniser's ops never run the model
    scored = api.post("/speech/live", data={**form, "op": "endpoint"}).json()
    assert scored["text"] is None and scored["endProb"] == 0.9 and scored["endMs"] >= 0
    assert len(model.inputs) == 1
    tm.set_session(None)  # no model: an answer without a score
    assert api.post("/speech/live", data={**form, "op": "endpoint"}).json() == {"text": None}
    assert api.post("/speech/live", data={**form, "op": "endpoint", "sid": "x"}).status_code == 400


def test_the_socket_carries_the_score(api, model: FakeModel, monkeypatch) -> None:  # noqa: ANN001, F811
    _cloud(monkeypatch)
    with api.websocket_connect("/playground/ws") as ws:
        ws.send_text(json.dumps({"op": "live-config", "sid": "sid-turn-model-02", "engine": "gemini_live"}))
        ws.send_bytes(_speech_then_quiet())
        ws.receive_text()
        ws.send_text(json.dumps({"op": "live", "id": 7, "live": "endpoint"}))
        reply = json.loads(ws.receive_text())
    assert reply["id"] == 7 and reply["endProb"] == 0.9 and "endMs" in reply


def test_the_summary_says_what_the_model_would_have_done(monkeypatch: pytest.MonkeyPatch) -> None:
    picked = [
        {"tmEnd": 950, "tmMid": 0, "tmMids": 0, "tmUsed": 1},
        {"tmEnd": 400, "tmMid": 920, "tmMids": 1, "tmUsed": 0},
        {"tmEnd": 990, "tmMid": 300, "tmMids": 2, "tmUsed": 0},
        {"silenceWaitMs": 600},  # not scored
    ]
    view = turn_timings._turn_model_view(picked)
    assert view == {"turns": 3, "sure": 900, "endsSure": 0.67, "pausedTurns": 2, "cutOffs": 0.5, "used": 0.33}
    assert turn_timings._turn_model_view([{"silenceWaitMs": 600}]) is None
