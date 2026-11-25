"""
The audio preprocessing pipeline (app/audio/): stages, honest status reporting, VAD, the isolation
provider plumbing, fallbacks, live-turn flags and the STT lab routes.

The isolation "model" here is a scripted HTTP stand-in: these tests prove the plumbing (what is
sent, what is reported, what happens on failure), not separation quality. Quality needs the real
sidecar and real recordings (docs/audio-pipeline.md, "Measuring").
"""

import asyncio
import json
from collections.abc import Iterator

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import http
from app.audio import store
from app.audio.dsp import from_pcm16, highpass, level_db, normalize_gain, to_wav
from app.audio.pipeline import ProcessingOptions, prepare_for_stt, prepare_live, run_pipeline
from app.audio.vad import EnergyVad, SileroStream, SileroVad, VadSettings, set_silero_session
from app.auth import COOKIE, encode_session
from app.speech.wav import decode_wav, is_silent
from tests.conftest import SECRET
from tests.test_system import _seed_user

RATE = 16000


def voice(ms: float, rate: int = RATE, f0: float = 140.0, amp: float = 0.3) -> np.ndarray:
    """A crude voiced sound: harmonics of f0 with a syllable-rate envelope."""
    t = np.arange(int(rate * ms / 1000)) / rate
    x = sum(np.sin(2 * np.pi * f0 * k * t) / k for k in range(1, 12))
    env = 0.6 + 0.4 * np.sin(2 * np.pi * 4 * t)
    return (amp * x / 3 * env).astype(np.float32)


def silence(ms: float, rate: int = RATE, noise: float = 0.002) -> np.ndarray:
    rng = np.random.default_rng(int(ms))
    return (noise * rng.standard_normal(int(rate * ms / 1000))).astype(np.float32)


@pytest.fixture(autouse=True)
def _reset_audio(monkeypatch) -> Iterator[None]:  # noqa: ANN001
    for key in (
        "VOICE_ISOLATION_URL", "VOICE_ISOLATION_PROVIDER", "VOICE_ISOLATION_BROWSER", "VOICE_ISOLATION_PHONE",
        "VOICE_ISOLATION_FALLBACK", "SERVER_VAD", "SILERO_VAD_MODEL", "AUDIO_LAB",
    ):  # fmt: skip
        monkeypatch.delenv(key, raising=False)
    set_silero_session(None, "")
    store.clear()
    yield
    set_silero_session(None, "")
    store.clear()


# ── signal basics ───────────────────────────────────────────────────


def test_highpass_removes_hum_and_keeps_the_voice_band() -> None:
    t = np.arange(RATE) / RATE
    hum = np.sin(2 * np.pi * 30 * t).astype(np.float32)
    tone = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
    assert level_db(highpass(hum, RATE)) < level_db(hum) - 30
    assert abs(level_db(highpass(tone, RATE)) - level_db(tone)) < 0.5


def test_gain_is_capped_like_the_browser() -> None:
    quiet = voice(500, amp=0.001)
    _, gain = normalize_gain(quiet)
    assert gain == 8.0


# ── VAD ─────────────────────────────────────────────────────────────


def test_energy_vad_finds_speech_with_preroll_and_keeps_short_pauses_inside() -> None:
    clip = np.concatenate([silence(600), voice(800), silence(250), voice(600), silence(900)])
    result = EnergyVad().detect(clip, RATE, VadSettings(min_silence_ms=700, pad_ms=250))
    assert len(result.segments) == 1  # the 250 ms hesitation does not split the turn
    seg = result.segments[0]
    assert 300 <= seg.start_ms <= 400  # 600 ms onset minus ~250 ms pre-roll
    assert seg.end_ms >= 2250  # the last syllable is kept, plus padding
    assert result.score_kind == "energy_score"


def test_a_single_spike_is_not_speech() -> None:
    clip = np.concatenate([silence(800), voice(60, amp=0.8), silence(800)])
    assert EnergyVad().detect(clip, RATE).segments == []


def test_quiet_speech_is_still_found() -> None:
    clip = np.concatenate([silence(500, noise=0.0005), voice(700, amp=0.01), silence(800, noise=0.0005)])
    assert len(EnergyVad().detect(clip, RATE).segments) == 1


class FakeSilero:
    """Stands in for the onnxruntime session: checks the tensors, answers from window energy."""

    def __init__(self) -> None:
        self.calls = 0

    def run(self, _outputs, feeds):  # noqa: ANN001, ANN201
        x, state, sr = feeds["input"], feeds["state"], feeds["sr"]
        assert x.dtype == np.float32 and state.shape == (2, 1, 128) and sr.dtype == np.int64
        assert x.shape == ((1, 576) if int(sr) == 16000 else (1, 288))
        self.calls += 1
        rms = float(np.sqrt(np.mean(x[:, -512 if int(sr) == 16000 else -256 :] ** 2)))
        return np.array([[min(1.0, rms * 20)]], dtype=np.float32), state + 1


def test_silero_runs_on_its_documented_tensors_and_segments() -> None:
    set_silero_session(FakeSilero())
    clip = np.concatenate([silence(600), voice(900), silence(1000)])
    result = SileroVad().detect(clip, RATE)
    assert result.engine == "silero" and result.score_kind == "probability"
    assert result.hop_ms == 32
    assert len(result.segments) == 1


def test_silero_state_is_per_stream() -> None:
    session = FakeSilero()
    a, b = SileroStream(session, 16000), SileroStream(session, 16000)
    a.prob(voice(32)[:512])
    assert float(a.state.sum()) != 0 and float(b.state.sum()) == 0
    a.reset()
    assert float(a.state.sum()) == 0


def test_silero_unavailable_is_reported_not_faked() -> None:
    result = asyncio.run(run_pipeline(voice(500), RATE, ProcessingOptions(vad="silero")))
    vad = result.stage("vad")
    assert vad and vad.status == "unavailable" and result.vad is None


# ── voice isolation plumbing and honesty ────────────────────────────


def isolator(handler) -> None:  # noqa: ANN001
    http.set_transport(httpx.MockTransport(handler))


def test_isolation_off_is_reported_as_disabled() -> None:
    result = asyncio.run(run_pipeline(voice(500), RATE, ProcessingOptions()))
    assert result.stage("voice_isolation").status == "disabled"


def test_isolation_without_a_provider_never_claims_to_have_run(monkeypatch) -> None:  # noqa: ANN001
    x = voice(500)
    result = asyncio.run(run_pipeline(x, RATE, ProcessingOptions(voice_isolation=True, highpass=False, gain=False)))
    stage = result.stage("voice_isolation")
    assert stage.status == "unavailable" and stage.error == "provider_not_configured"
    assert np.allclose(result.samples, x, atol=1e-4)  # untouched (16 kHz in → no resample)


def test_isolation_runs_at_the_model_rate_and_reports_timing(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("VOICE_ISOLATION_URL", "http://isolator.test")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        start = body.index(b"RIFF")
        samples, rate = decode_wav(body[start:])
        seen["rate"], seen["path"] = rate, request.url.path
        return httpx.Response(200, content=to_wav(samples * 0.5, rate))

    isolator(handler)
    x = voice(800, rate=48000)
    result = asyncio.run(
        run_pipeline(x, 48000, ProcessingOptions(voice_isolation=True, highpass=False, gain=False, vad="off"))
    )
    stage = result.stage("voice_isolation")
    assert seen == {"rate": 48000, "path": "/isolate"}
    assert stage.status == "ran" and stage.ms > 0 and stage.provider == "inworld"
    assert stage.level_out_db < stage.level_in_db
    assert not stage.notes  # full-band input: nothing to warn about
    assert result.sample_rate == 16000 and result.stage("resample").status == "ran"


def test_low_rate_input_is_flagged_not_passed_off_as_full_band(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("VOICE_ISOLATION_URL", "http://isolator.test")
    isolator(lambda request: httpx.Response(200, content=to_wav(np.zeros(48000, np.float32), 48000)))
    result = asyncio.run(run_pipeline(voice(500, rate=8000), 8000, ProcessingOptions(voice_isolation=True)))
    notes = " ".join(result.stage("voice_isolation").notes)
    assert "not restored" in notes and "telephone" in notes


def test_a_failing_isolator_falls_back_to_the_original(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("VOICE_ISOLATION_URL", "http://isolator.test")
    isolator(lambda request: httpx.Response(500, text="boom"))
    x = voice(500)
    result = asyncio.run(run_pipeline(x, RATE, ProcessingOptions(voice_isolation=True, highpass=False, gain=False)))
    stage = result.stage("voice_isolation")
    assert stage.status == "failed" and stage.error == "isolator_500"
    assert np.allclose(result.samples, x, atol=1e-4)


# ── live turns ──────────────────────────────────────────────────────


def test_live_turns_are_untouched_by_default() -> None:
    wav = to_wav(voice(700), RATE)
    assert asyncio.run(prepare_for_stt(wav, "phone")) is wav
    assert asyncio.run(prepare_live(wav, "browser")) is wav


def test_reject_fallback_turns_untrusted_audio_into_nothing_heard(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("VOICE_ISOLATION_PHONE", "1")
    monkeypatch.setenv("VOICE_ISOLATION_FALLBACK", "reject")  # and no isolator configured
    out = asyncio.run(prepare_live(to_wav(voice(700, rate=8000), 8000), "phone"))
    assert is_silent(out)
    # The browser route has its own flag: still untouched.
    wav = to_wav(voice(700), RATE)
    assert asyncio.run(prepare_live(wav, "browser")) is wav


def test_server_vad_trims_a_live_turn_to_speech(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("SERVER_VAD", "energy")
    wav = to_wav(np.concatenate([silence(1500), voice(700), silence(1500)]), RATE)
    out, rate = decode_wav(asyncio.run(prepare_for_stt(wav, "browser")))
    assert rate == RATE and 0.9 < len(out) / RATE < 1.6  # ~0.7 s speech + padding, not 3.7 s


def test_background_only_audio_becomes_nothing_heard_with_server_vad(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("SERVER_VAD", "energy")
    assert is_silent(asyncio.run(prepare_for_stt(to_wav(silence(2000), RATE), "phone")))


def test_sessions_run_concurrently_without_mixing() -> None:
    clips = [voice(400 + 100 * i, f0=110 + 20 * i) for i in range(6)]

    async def all_at_once() -> list:
        return await asyncio.gather(
            *(run_pipeline(c, RATE, ProcessingOptions(highpass=False, gain=False)) for c in clips)
        )

    results = asyncio.run(all_at_once())
    for clip, result in zip(clips, results, strict=True):
        assert np.allclose(result.samples, clip, atol=1e-4)


# ── the STT lab routes ──────────────────────────────────────────────


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


def test_the_lab_needs_a_login(data_dir) -> None:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as anon:
        assert anon.get("/audio/capabilities").status_code == 401
        assert anon.post("/audio/process", files={"file": ("a.wav", b"x")}).status_code == 401


def test_capabilities_say_what_is_really_available(api) -> None:  # noqa: ANN001
    caps = api.get("/audio/capabilities").json()
    assert caps["noiseSuppression"]["available"] is False
    assert caps["voiceIsolation"][0] == {
        "id": "inworld",
        "model": "inworld/voice-isolator",
        "nativeRates": [48000],
        "available": False,
        "kind": "dominant_speaker",
    }
    assert {v["id"]: v["available"] for v in caps["vad"]} == {"energy": True, "silero": False}


def test_process_returns_stages_vad_and_playable_clips(api) -> None:  # noqa: ANN001
    clip = np.concatenate([silence(500, rate=48000), voice(900, rate=48000), silence(700, rate=48000)])
    options = {"highpass": True, "gain": False, "voiceIsolation": True, "vad": "energy", "trim": True}
    res = api.post(
        "/audio/process", files={"file": ("rec.wav", to_wav(clip, 48000))}, data={"options": json.dumps(options)}
    )
    assert res.status_code == 200
    body = res.json()
    stages = {s["name"]: s for s in body["stages"]}
    assert stages["highpass"]["status"] == "ran" and stages["gain"]["status"] == "disabled"
    assert stages["voice_isolation"]["status"] == "unavailable"  # asked for, but not configured
    assert stages["trim"]["status"] == "ran"
    assert body["metrics"]["inputSampleRate"] == 48000 and body["metrics"]["outputSampleRate"] == 16000
    assert body["metrics"]["isolationMs"] is None
    assert len(body["vad"]["segments"]) == 1
    assert set(body["clips"]) == {"raw", "conditioned", "final"}  # no "isolated" clip: it did not run
    raw = api.get(f"/audio/clip/{body['clips']['raw']['token']}")
    assert raw.status_code == 200 and raw.headers["content-type"] == "audio/wav"
    final, rate = decode_wav(api.get(f"/audio/clip/{body['clips']['final']['token']}").content)
    assert rate == 16000 and len(final) / rate == pytest.approx(body["metrics"]["outputDurationMs"] / 1000, abs=0.01)


def test_clips_belong_to_their_owner(api) -> None:  # noqa: ANN001
    token = store.put("someone:else", b"RIFF")
    assert api.get(f"/audio/clip/{token}").status_code == 404
    assert api.get("/audio/clip/nope").status_code == 404


def test_process_rejects_what_it_cannot_read(api, monkeypatch) -> None:  # noqa: ANN001
    assert api.post("/audio/process", files={"file": ("a.mp3", b"ID3....")}).status_code == 415
    assert api.post("/audio/process", data={"options": "{}"}).status_code == 400
    monkeypatch.setenv("AUDIO_LAB", "0")
    assert api.post("/audio/process", files={"file": ("a.wav", to_wav(voice(300), RATE))}).status_code == 404


def test_pcm_helpers_round_trip() -> None:
    x = voice(100)
    back, rate = decode_wav(to_wav(x, RATE))
    assert rate == RATE and np.allclose(back, x, atol=1e-4)
    assert len(from_pcm16(b"\x00\x00\xff\x7f")) == 2
