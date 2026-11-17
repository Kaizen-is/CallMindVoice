"""
The console's speech routes served by Python (`app/routers/speech.py`): the status codes, error
codes, headers and bodies of src/app/api/speech/{tts,stt}/route.ts and src/app/api/models/stt/route.ts.
The engines underneath are parity-tested elsewhere; here they are scripted.
"""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE, encode_session
from app.routers import speech
from app.speech.stt import SttError
from app.speech.tts import TtsError
from tests.conftest import SECRET
from tests.test_system import _seed_user

TENANT = "ten_test000000000001"
USER = "usr_test000000000001"
WAV = b"RIFF" + b"\x00" * 400


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


@pytest.fixture
def anon(data_dir) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client


@pytest.fixture
def tts(monkeypatch: pytest.MonkeyPatch) -> dict:
    """A configured TTS; records the options of each render."""
    seen: dict = {"opts": []}

    async def wav(text, opts):  # noqa: ANN001
        seen["opts"].append(opts)
        seen["text"] = text
        return b"RIFFwav"

    async def stream(text, opts):  # noqa: ANN001
        seen["opts"].append(opts)
        yield b"one"
        yield b"two"

    monkeypatch.setattr(speech, "tts_configured", lambda engine="default": True)
    monkeypatch.setattr(speech, "synthesize_wav", wav)
    monkeypatch.setattr(speech, "synthesize_stream", stream)
    return seen


# ── /speech/tts ─────────────────────────────────────────────────────


def test_tts_needs_a_login(anon) -> None:  # noqa: ANN001
    res = anon.post("/speech/tts", json={"text": "Salom"})
    assert res.status_code == 401
    assert res.json() == {"error": "unauthorized"}


def test_tts_not_configured_comes_before_the_text_check(api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(speech, "tts_configured", lambda engine="default": False)
    res = api.post("/speech/tts", json={"text": ""})
    assert (res.status_code, res.json()) == (503, {"error": "tts_not_configured"})


@pytest.mark.parametrize("text", ["", "   ", None, 5])
def test_tts_empty_text(api, tts, text) -> None:  # noqa: ANN001
    res = api.post("/speech/tts", json={"text": text})
    assert (res.status_code, res.json()) == (400, {"error": "empty_text"})


def test_tts_wav_and_its_options(api, tts) -> None:  # noqa: ANN001
    res = api.post("/speech/tts", json={"text": "Salom", "voice": "laylo", "language": "ru"})
    assert res.status_code == 200
    assert res.content == b"RIFFwav"
    assert res.headers["content-type"] == "audio/wav"
    assert res.headers["cache-control"] == "no-store"
    assert res.headers["x-audio-rate"] == "8000"
    (opts,) = tts["opts"]
    assert (opts.tenant_id, opts.voice_id, opts.language, opts.tag) == (TENANT, "laylo", "ru", f"pg_{USER[:8]}")
    assert (opts.engine, opts.cache, opts.sample_rate) == ("default", True, None)


def test_tts_defaults_and_long_text_is_not_cached(api, tts) -> None:  # noqa: ANN001
    api.post("/speech/tts", json={"text": "a" * 121, "engine": "not-an-engine"})
    (opts,) = tts["opts"]
    assert (opts.language, opts.engine, opts.cache, opts.voice_id) == ("uz", "default", False, None)


def test_tts_cache_limit_counts_utf16_after_trim(api, tts) -> None:  # noqa: ANN001
    # 60 emoji are 120 UTF-16 units: still cacheable, like `text.trim().length <= 120`.
    api.post("/speech/tts", json={"text": "  " + "😀" * 60 + "  "})
    assert tts["opts"][0].cache is True
    api.post("/speech/tts", json={"text": "😀" * 60 + "a"})
    assert tts["opts"][1].cache is False


def test_tts_elevenlabs_at_24k(api, tts) -> None:  # noqa: ANN001
    res = api.post("/speech/tts", json={"text": "Salom", "engine": "eleven_v4_turbo", "rate": 24000})
    assert res.headers["x-audio-rate"] == "24000"
    assert tts["opts"][0].sample_rate == 24000
    # Own TTS always answers 8 kHz, whatever rate is asked.
    res = api.post("/speech/tts", json={"text": "Salom", "engine": "default", "rate": 24000})
    assert res.headers["x-audio-rate"] == "8000"
    # A rate that is not a number is ignored.
    api.post("/speech/tts", json={"text": "Salom", "engine": "eleven_v4_turbo", "rate": "24000"})
    assert tts["opts"][2].sample_rate is None


def test_tts_stream(api, tts) -> None:  # noqa: ANN001
    res = api.post("/speech/tts", json={"text": "Salom. Qalaysiz?", "stream": True})
    assert res.status_code == 200
    assert res.content == b"onetwo"
    assert res.headers["content-type"] == "audio/L16; rate=8000; channels=1"
    assert res.headers["x-audio-rate"] == "8000"
    assert res.headers["cache-control"] == "no-store"


def test_tts_stream_failure_keeps_what_already_played(api, monkeypatch) -> None:  # noqa: ANN001
    async def stream(text, opts):  # noqa: ANN001
        yield b"first"
        raise TtsError("tts_stream_failed")

    monkeypatch.setattr(speech, "tts_configured", lambda engine="default": True)
    monkeypatch.setattr(speech, "synthesize_stream", stream)
    res = api.post("/speech/tts", json={"text": "Salom", "stream": True})
    assert (res.status_code, res.content) == (200, b"first")


def test_tts_errors(api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(speech, "tts_configured", lambda engine="default": True)

    async def tts_error(text, opts):  # noqa: ANN001
        raise TtsError("tts_auth_failed", 502)

    monkeypatch.setattr(speech, "synthesize_wav", tts_error)
    res = api.post("/speech/tts", json={"text": "Salom"})
    assert (res.status_code, res.json()) == (502, {"error": "tts_auth_failed"})

    async def crash(text, opts):  # noqa: ANN001
        raise RuntimeError("boom")

    monkeypatch.setattr(speech, "synthesize_wav", crash)
    res = api.post("/speech/tts", json={"text": "Salom"})
    assert (res.status_code, res.json()) == (502, {"error": "tts_unreachable"})


# ── /speech/stt ─────────────────────────────────────────────────────


@pytest.fixture
def stt(monkeypatch: pytest.MonkeyPatch) -> dict:
    seen: dict = {}

    async def transcribe(audio, *, language=None, clean=False, engine=None):  # noqa: ANN001
        seen.update(audio=audio, language=language, clean=clean, engine=engine)
        return {"text": "salom", "language": "uz", "engine": "gapi"}

    monkeypatch.setattr(speech, "stt_configured", lambda: True)
    monkeypatch.setattr(speech, "transcribe", transcribe)
    return seen


def test_stt_needs_a_login(anon) -> None:  # noqa: ANN001
    assert anon.post("/speech/stt", content=WAV).status_code == 401


def test_stt_not_configured(api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(speech, "stt_configured", lambda: False)
    res = api.post("/speech/stt", content=WAV)
    assert (res.status_code, res.json()) == (503, {"error": "stt_not_configured"})


def test_stt_multipart(api, stt) -> None:  # noqa: ANN001
    res = api.post(
        "/speech/stt",
        files={"file": ("a.wav", WAV, "audio/wav")},
        data={"language": "ru", "denoise": "1", "engine": "gapi"},
    )
    assert res.status_code == 200
    assert res.json() == {"text": "salom", "language": "uz", "engine": "gapi"}
    assert stt == {"audio": WAV, "language": "ru", "clean": True, "engine": "gapi"}


def test_stt_multipart_ignores_unknown_language_and_engine(api, stt) -> None:  # noqa: ANN001
    api.post("/speech/stt", files={"file": ("a.wav", WAV)}, data={"language": "de", "engine": "nope", "denoise": "0"})
    assert (stt["language"], stt["engine"], stt["clean"]) == (None, "auto", False)


def test_stt_raw_body(api, stt) -> None:  # noqa: ANN001
    res = api.post("/speech/stt", content=WAV, headers={"content-type": "audio/wav"})
    assert res.status_code == 200
    assert stt == {"audio": WAV, "language": None, "clean": False, "engine": "auto"}


def test_stt_empty_audio(api, stt) -> None:  # noqa: ANN001
    res = api.post("/speech/stt", files={"file": ("a.wav", b"")})
    assert (res.status_code, res.json()) == (400, {"error": "empty_audio"})
    res = api.post("/speech/stt", content=b"", headers={"content-type": "audio/wav"})
    assert (res.status_code, res.json()) == (400, {"error": "empty_audio"})


def test_stt_errors(api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr(speech, "stt_configured", lambda: True)

    async def stt_error(audio, **kw):  # noqa: ANN001, ANN003
        raise SttError("gapi_not_configured", 503)

    monkeypatch.setattr(speech, "transcribe", stt_error)
    res = api.post("/speech/stt", content=WAV, headers={"content-type": "audio/wav"})
    assert (res.status_code, res.json()) == (503, {"error": "gapi_not_configured"})

    async def crash(audio, **kw):  # noqa: ANN001, ANN003
        raise RuntimeError("boom")

    monkeypatch.setattr(speech, "transcribe", crash)
    res = api.post("/speech/stt", content=WAV, headers={"content-type": "audio/wav"})
    assert (res.status_code, res.json()) == (502, {"error": "stt_unreachable"})


# ── /models/stt ─────────────────────────────────────────────────────


@pytest.fixture
def one_engine(monkeypatch: pytest.MonkeyPatch) -> dict:
    seen: dict = {}

    async def transcribe_one(engine, audio, language=None):  # noqa: ANN001
        seen.update(engine=engine, audio=audio, language=language)
        return {"text": "salom dunyo", "engine": engine, "language": language}

    monkeypatch.setattr(speech, "stt_engine_ids", lambda: {"gapi": True, "kotib": False})
    monkeypatch.setattr(speech, "transcribe_one", transcribe_one)
    return seen


def test_models_stt_needs_a_login(anon) -> None:  # noqa: ANN001
    assert anon.post("/models/stt", files={"file": ("a.wav", WAV)}).status_code == 401


def test_models_stt_needs_a_form(api, one_engine) -> None:  # noqa: ANN001
    res = api.post("/models/stt", json={"engine": "gapi"})
    assert (res.status_code, res.json()) == (400, {"error": "expected_multipart_form"})


def test_models_stt_checks(api, one_engine) -> None:  # noqa: ANN001
    res = api.post("/models/stt", files={"file": ("a.wav", b"")}, data={"engine": "gapi"})
    assert (res.status_code, res.json()) == (400, {"error": "empty_audio"})
    res = api.post("/models/stt", files={"file": ("a.wav", b"x" * (10 * 1024 * 1024 + 1))}, data={"engine": "gapi"})
    assert (res.status_code, res.json()) == (413, {"error": "audio_too_large"})
    res = api.post("/models/stt", files={"file": ("a.wav", WAV)}, data={"engine": "kotib"})
    assert (res.status_code, res.json()) == (400, {"error": "engine_not_ready"})
    res = api.post("/models/stt", files={"file": ("a.wav", WAV)})
    assert (res.status_code, res.json()) == (400, {"error": "engine_not_ready"})


def test_models_stt_runs_exactly_that_engine(api, one_engine) -> None:  # noqa: ANN001
    res = api.post("/models/stt", files={"file": ("a.wav", WAV)}, data={"engine": "gapi", "language": "ru"})
    assert res.status_code == 200
    body = res.json()
    assert (body["text"], body["engine"]) == ("salom dunyo", "gapi")
    assert isinstance(body["ms"], int)
    assert one_engine == {"engine": "gapi", "audio": WAV, "language": "ru"}
    api.post("/models/stt", files={"file": ("a.wav", WAV)}, data={"engine": "gapi", "language": "fr"})
    assert one_engine["language"] == "uz"


def test_models_stt_failure(api, monkeypatch) -> None:  # noqa: ANN001
    async def fail(engine, audio, language=None):  # noqa: ANN001
        raise SttError("gapi 500: down")

    monkeypatch.setattr(speech, "stt_engine_ids", lambda: {"gapi": True})
    monkeypatch.setattr(speech, "transcribe_one", fail)
    res = api.post("/models/stt", files={"file": ("a.wav", WAV)}, data={"engine": "gapi"})
    assert (res.status_code, res.json()) == (502, {"error": "gapi 500: down"})
