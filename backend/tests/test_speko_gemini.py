"""
Gemini STT and TTS (added 18 Nov 2026): gemini-3.5-transcribe-live, gemini-3.8-flash-tts and
gemini-3.8-flash-lite-tts — straight from Google whenever GEMINI_API_KEY is set (since 25 Nov;
app/speech/gemini_speech.py), with Speko as the fallback when Google refuses. Google and Speko
answer from a fake transport.
"""

import asyncio
import base64
import hashlib
import json
import math

import httpx
import numpy as np
import pytest

from app import http
from app.registry import ENGINES
from app.speech import gemini_speech, speko, stt, tts
from app.speech.resample import StreamResampler, resample_pcm16
from app.speech.wav import pcm16_to_float  # noqa: F401  (kept importable: used by other speech code)


def _tone(freq: float, rate: int, secs: float = 1.0, amp: int = 10000) -> bytes:
    t = np.arange(int(rate * secs)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype("<i2").tobytes()


def _rms(pcm: bytes) -> float:
    a = np.frombuffer(pcm, "<i2").astype(float)[2000:-2000]
    return float(np.sqrt((a**2).mean()))


# ── the resampler ───────────────────────────────────────────────────


@pytest.mark.parametrize(("dst", "alias"), [(8000, 10000), (16000, 11000)])
def test_resampler_keeps_speech_and_removes_aliasing(dst: int, alias: int) -> None:
    kept = resample_pcm16(_tone(1000, 24000), 24000, dst)
    folded = resample_pcm16(_tone(alias, 24000), 24000, dst)
    assert abs(_rms(kept) / 7071 - 1) < 0.01  # 1 kHz passes at full level
    assert _rms(folded) / 7071 < 0.001  # what would fold back below Nyquist is gone
    assert abs(len(kept) // 2 - dst) < 20  # one second stays one second


def test_resampler_piece_by_piece_equals_one_go() -> None:
    src = _tone(440, 24000) + _tone(2500, 24000, 0.5)
    whole = resample_pcm16(src, 24000, 8000)
    r = StreamResampler(24000, 8000)
    pieces = b"".join(r.feed(src[i : i + 777]) for i in range(0, len(src), 777))  # odd sizes split samples
    assert pieces + r.flush() == whole


# ── TTS ─────────────────────────────────────────────────────────────


def _fake_speko(seen: list[dict], pcm: bytes) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=pcm)

    http.set_transport(httpx.MockTransport(handler))


async def _collect(chunks) -> bytes:  # noqa: ANN001
    return b"".join([c async for c in chunks])


@pytest.fixture
def speko_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPEKO_API_KEY", "test-key")


def test_gemini_tts_renders_24k_and_converts_to_the_rate_asked(speko_key) -> None:  # noqa: ANN001
    seen: list[dict] = []
    src = _tone(500, 24000, 0.5)
    _fake_speko(seen, src)
    out = asyncio.run(_collect(speko.speko_stream_pcm("Salom", "gemini-3.8-flash-tts", "uz", "Kore", 8000)))
    assert seen[0]["routing"] == {"mode": "explicit", "provider": "gemini", "model": "gemini-3.8-flash-tts"}
    assert seen[0]["audio"]["sample_rate_hz"] == 24000  # Gemini refuses any other rate
    assert seen[0]["voice"] == "Kore"
    assert out == resample_pcm16(src, 24000, 8000)

    seen.clear()
    same = asyncio.run(_collect(speko.speko_stream_pcm("Salom", "gemini-3.8-flash-lite-tts", "uz", "Puck", 24000)))
    assert seen[0]["audio"]["sample_rate_hz"] == 24000 and same == src  # 24 kHz asked: passed straight on


def test_elevenlabs_tts_is_unchanged(speko_key) -> None:  # noqa: ANN001
    seen: list[dict] = []
    _fake_speko(seen, b"\x01\x02" * 4000)
    out = asyncio.run(_collect(speko.speko_stream_pcm("Salom", "eleven_v4_turbo", "uz", "lZSeoYcz4phdvms888pn", 8000)))
    assert seen[0]["routing"]["provider"] == "elevenlabs"
    assert seen[0]["audio"]["sample_rate_hz"] == 8000
    assert out == b"\x01\x02" * 4000


def test_voices_belong_to_their_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SPEKO_TTS_VOICE", raising=False)
    assert speko.tts_voice("gemini-3.8-flash-tts", None) == "Kore"
    assert speko.tts_voice("gemini-3.8-flash-tts", "Charon") == "Charon"
    assert speko.tts_voice("gemini-3.8-flash-tts", "lZSeoYcz4phdvms888pn") == "Kore"  # an ElevenLabs voice
    assert speko.tts_voice("eleven_v4_turbo", "Charon") == speko.ELEVEN_VOICES[0]["id"]  # a Gemini voice
    assert speko.tts_voice("eleven_v4_turbo", "cfWx14ZbaEUT4BjIA5tH") == "cfWx14ZbaEUT4BjIA5tH"
    assert [v["id"] for v in speko.model_voices("gemini-3.8-flash-lite-tts")] == [v["id"] for v in speko.GEMINI_VOICES]


def test_tts_engines_and_cache_keys(speko_key) -> None:  # noqa: ANN001
    engines = tts.tts_engines()
    assert engines["gemini-3.8-flash-tts"] and engines["gemini-3.8-flash-lite-tts"]
    assert tts.is_tts_engine("gemini-3.8-flash-tts")
    voice = tts.ResolvedVoice(kind="speaker", speaker="laylo")
    # ElevenLabs keys are exactly what they were before Gemini (the disk cache stays valid).
    eleven = tts.cache_key("Salom", voice, "eleven_v4_turbo", "cfWx14ZbaEUT4BjIA5tH", 24000)
    expected = hashlib.sha1(b"Salom speko:eleven_v4_turbo:cfWx14ZbaEUT4BjIA5tH:24000").hexdigest()  # noqa: S324
    assert eleven == expected
    a = tts.cache_key("Salom", voice, "gemini-3.8-flash-tts", "Kore", 24000)
    b = tts.cache_key("Salom", voice, "gemini-3.8-flash-tts", "Charon", 24000)
    c = tts.cache_key("Salom", voice, "gemini-3.8-flash-lite-tts", "Kore", 24000)
    assert len({a, b, c, eleven}) == 4


# ── STT ─────────────────────────────────────────────────────────────


def _wav(seconds: float = 1.0) -> bytes:
    return tts.pcm_to_wav(_tone(300, 16000, seconds, 6000), 16000)


def test_gemini_live_stt(speko_key) -> None:  # noqa: ANN001
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("latin-1")
        asked.append(json.loads(body[body.index("{") : body.index("}}") + 2])["routing"]["model"])
        return httpx.Response(200, json={"text": "Salom dunyo"})

    http.set_transport(httpx.MockTransport(handler))
    assert stt.stt_engines()["gemini_live"] is True
    assert stt.stt_engine_ids()["speko_live"] is True
    heard = asyncio.run(stt.transcribe(_wav(), language="uz", engine="gemini_live"))
    assert heard == {"text": "Salom dunyo", "engine": "speko_live", "language": "uz"}
    one = asyncio.run(stt.transcribe_one("speko_live", _wav(), "uz"))
    assert one["engine"] == "speko_live"
    plain = asyncio.run(stt.transcribe(_wav(), language="uz", engine="gemini"))
    assert plain["engine"] == "speko"  # the existing gemini-3.5 choice is unchanged
    assert asked == ["gemini-3.5-transcribe-live", "gemini-3.5-transcribe-live", "gemini-3.5-transcribe"]


def test_registry_lists_the_gemini_engines_as_google() -> None:
    by_id = {e.id: e for e in ENGINES}
    assert by_id["speko_live"].kind == "stt" and by_id["speko"].kind == "stt"
    for engine in ("speko", "speko_live", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"):
        assert by_id[engine].vendor == "Google" and by_id[engine].via is None
        assert by_id[engine].setup == "GEMINI_API_KEY"
    assert by_id["gemini-3.8-flash-tts"].kind == "tts"
    assert not math.isnan(len(ENGINES))


def test_google_whenever_the_key_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.delenv("GEMINI_SPEECH_VIA", raising=False)
    assert gemini_speech.gemini_speech_configured()
    monkeypatch.setenv("GEMINI_SPEECH_VIA", "google")
    assert gemini_speech.gemini_speech_configured()
    monkeypatch.setenv("GEMINI_SPEECH_VIA", " Speko ")  # everything through Speko again
    assert not gemini_speech.gemini_speech_configured()
    monkeypatch.delenv("GEMINI_SPEECH_VIA")
    monkeypatch.delenv("GEMINI_API_KEY")
    assert not gemini_speech.gemini_speech_configured()


# ── agents and the Playground ───────────────────────────────────────


def test_agent_saves_a_gemini_voice() -> None:
    from app.agent_studio import agent_tts

    assert agent_tts({"ttsEngine": "gemini-3.8-flash-tts", "ttsVoiceId": "Sulafat"}) == (
        "gemini-3.8-flash-tts",
        "Sulafat",
    )
    # An ElevenLabs voice with a Gemini model falls back to the model's first voice.
    assert agent_tts({"ttsEngine": "gemini-3.8-flash-tts", "ttsVoiceId": "cfWx14ZbaEUT4BjIA5tH"})[1] == "Kore"
    assert agent_tts({"ttsEngine": "eleven_v4_turbo", "ttsVoiceId": "Sulafat"})[1] == speko.ELEVEN_VOICES[0]["id"]


def test_playground_picks_the_models_voice(speko_key) -> None:  # noqa: ANN001
    from app.playground_voice import voice_pick

    agent = {"tenant_id": "t1", "voice_id": "laylo", "tts_voice_id": ""}
    assert voice_pick(agent, "gemini-3.8-flash-lite-tts", "Orus").voice_id == "Orus"
    assert voice_pick(agent, "gemini-3.8-flash-lite-tts", "cfWx14ZbaEUT4BjIA5tH").voice_id == "Kore"
    assert voice_pick(agent, "eleven_v4_turbo", "Orus").voice_id == speko.ELEVEN_VOICES[0]["id"]


# ── straight from Google (since 20 Nov 2026) ────────────────────────


def _sse(*pieces: bytes) -> bytes:
    """Google's streamed answer: one `data:` line per GenerateContentResponse with an audio part."""
    lines = []
    for pcm in pieces:
        part = {"inlineData": {"mimeType": "audio/L16;codec=pcm;rate=24000", "data": base64.b64encode(pcm).decode()}}
        lines.append(f"data: {json.dumps({'candidates': [{'content': {'parts': [part]}}]})}\r\n\r\n")
    return "".join(lines).encode()


def _hosts(seen: list[str], google: httpx.Response, speko_pcm: bytes = b"") -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.url.host}{request.url.path}")
        if request.url.host == "generativelanguage.googleapis.com":
            assert request.headers["x-goog-api-key"] == "g-key"
            return google
        return httpx.Response(200, content=speko_pcm)

    http.set_transport(httpx.MockTransport(handler))


@pytest.fixture
def google_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.setenv("GEMINI_SPEECH_VIA", "google")


def test_google_tts_streams_and_converts(google_key) -> None:  # noqa: ANN001
    seen: list[str] = []
    a, b = _tone(500, 24000, 0.3), _tone(700, 24000, 0.3)
    _hosts(seen, httpx.Response(200, content=_sse(a, b)))
    out = asyncio.run(_collect(gemini_speech.gemini_tts_stream("Salom", "gemini-3.8-flash-tts", "Charon", 8000)))
    assert seen == ["generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:streamGenerateContent"]
    assert out == resample_pcm16(a + b, 24000, 8000)  # converted as one stream, nothing lost at the joins
    seen.clear()
    same = asyncio.run(_collect(gemini_speech.gemini_tts_stream("Salom", "gemini-3.8-flash-lite-tts", "Kore", 24000)))
    assert same == a + b


def test_google_tts_through_the_tts_layer(google_key) -> None:  # noqa: ANN001
    seen: list[str] = []
    src = _tone(500, 24000, 0.4)
    _hosts(seen, httpx.Response(200, content=_sse(src)))
    assert tts.tts_engines()["gemini-3.8-flash-tts"] and not tts.tts_engines()["eleven_v4_turbo"]
    opts = tts.SynthOptions(tenant_id="t1", voice_id="Puck", engine="gemini-3.8-flash-tts", sample_rate=24000)
    voice = tts.ResolvedVoice(kind="speaker", speaker="laylo")
    out = asyncio.run(_collect(tts._raw_engine_pcm("Salom", voice, opts)))
    assert out == src and all(h.startswith("generativelanguage") for h in seen)


def test_tts_falls_back_to_speko_when_google_refuses(google_key, speko_key) -> None:  # noqa: ANN001
    seen: list[str] = []
    speko_pcm = _tone(600, 24000, 0.2)
    _hosts(seen, httpx.Response(429, json={"error": {"message": "Quota exceeded"}}), speko_pcm)
    opts = tts.SynthOptions(tenant_id="t1", voice_id="Kore", engine="gemini-3.8-flash-tts", sample_rate=24000)
    voice = tts.ResolvedVoice(kind="speaker", speaker="laylo")
    out = asyncio.run(_collect(tts._raw_engine_pcm("Salom", voice, opts)))
    assert out == speko_pcm
    assert [h.split("/")[0] for h in seen] == ["generativelanguage.googleapis.com", "router.speko.dev"]


def test_google_refusal_without_speko_is_an_error(google_key) -> None:  # noqa: ANN001
    _hosts([], httpx.Response(429, json={"error": {"message": "Quota exceeded"}}))
    opts = tts.SynthOptions(tenant_id="t1", voice_id="Kore", engine="gemini-3.8-flash-tts", sample_rate=24000)
    voice = tts.ResolvedVoice(kind="speaker", speaker="laylo")
    with pytest.raises(tts.TtsError, match="gemini_quota"):
        asyncio.run(_collect(tts._raw_engine_pcm("Salom", voice, opts)))


@pytest.mark.parametrize(
    ("choice", "engine", "speko_model"),
    [("gemini_live", "speko_live", "gemini-3.5-transcribe-live"), ("gemini", "speko", "gemini-3.5-transcribe")],
)
def test_gemini_one_utterance_from_google(google_key, speko_key, choice, engine, speko_model) -> None:  # noqa: ANN001
    seen: list[str] = []
    answer = {"candidates": [{"content": {"parts": [{"text": "Salom dunyo"}]}}]}
    _hosts(seen, httpx.Response(200, json=answer))
    heard = asyncio.run(stt.transcribe(_wav(), language="uz", engine=choice))
    assert heard == {"text": "Salom dunyo", "engine": engine, "language": "uz"}
    assert seen == ["generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent"]
    # Google refuses: Speko's route to the same model takes the utterance.
    seen.clear()
    routes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host)
        if request.url.host == "generativelanguage.googleapis.com":
            return httpx.Response(429, json={"error": {"message": "Quota exceeded"}})
        routes.append(request.content.decode("utf-8", "replace"))
        return httpx.Response(200, json={"text": "Salom Speko"})

    http.set_transport(httpx.MockTransport(handler))
    heard = asyncio.run(stt.transcribe(_wav(), language="uz", engine=choice))
    assert heard["text"] == "Salom Speko" and seen == ["generativelanguage.googleapis.com", "router.speko.dev"]
    assert any(speko_model in r for r in routes)
