"""
BRB Whisper through the BRB speech proxy (`POST /stt/transcribe`, same account as BRB TTS): the
login and token renewal, the upload, the errors, and the `brb` engine in `stt.transcribe`.
"""

import asyncio
import json
import math
import struct
from collections.abc import Iterator

import httpx
import pytest

from app import http
from app.speech import brb, stt
from app.speech.tts import pcm_to_wav

BASE = "http://brb.test"


class FakeProxy:
    """The proxy's auth and STT routes; `stt` scripts each /stt/transcribe answer in turn."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.stt: list[httpx.Response] = []
        self.logins = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/auth/login":
            self.logins += 1
            body = json.loads(request.content)
            assert body == {"login": "brb-user", "password": "brb-pass"}
            return httpx.Response(200, json={"access_token": f"tok{self.logins}", "refresh_token": "ref"})
        if request.url.path == "/auth/refresh":
            return httpx.Response(401, json={"detail": "expired"})
        assert request.url.path == "/stt/transcribe"
        return self.stt.pop(0)

    def uploads(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == "/stt/transcribe"]


@pytest.fixture
def proxy(data_dir, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeProxy]:  # noqa: ANN001
    monkeypatch.setenv("BRB_SPEECH_URL", BASE + "/")
    monkeypatch.setenv("BRB_SPEECH_LOGIN", "brb-user")
    monkeypatch.setenv("BRB_SPEECH_PASSWORD", "brb-pass")
    fake = FakeProxy()
    http.set_transport(httpx.MockTransport(fake))
    brb.reset()
    try:
        yield fake
    finally:
        http.set_transport(None)
        brb.reset()


def _wav(rate: int = 8000) -> bytes:
    """Half a second of a loud tone (not silence)."""
    n = rate // 2
    return pcm_to_wav(struct.pack(f"<{n}h", *(int(12000 * math.sin(i / 3)) for i in range(n))), rate)


def test_transcribe_uploads_the_file_with_the_token(proxy: FakeProxy) -> None:
    proxy.stt = [httpx.Response(200, json={"text": "  Salom, BRB!  "})]
    assert asyncio.run(brb.brb_transcribe(b"RIFF-audio")) == "Salom, BRB!"
    (upload,) = proxy.uploads()
    assert upload.headers["authorization"] == "Bearer tok1"
    assert upload.headers["content-type"].startswith("multipart/form-data")
    assert b'name="file"; filename="speech.wav"' in upload.content and b"RIFF-audio" in upload.content


def test_transcribe_renews_the_token_once_on_401(proxy: FakeProxy) -> None:
    proxy.stt = [httpx.Response(401, json={"detail": "expired"}), httpx.Response(200, json={"text": "ha"})]
    assert asyncio.run(brb.brb_transcribe(b"RIFF")) == "ha"
    assert [u.headers["authorization"] for u in proxy.uploads()] == ["Bearer tok1", "Bearer tok2"]


@pytest.mark.parametrize(
    ("answer", "error", "status"),
    [
        (httpx.Response(429, json={"detail": "limit"}), "brb_limit", 429),
        (httpx.Response(500, text="boom"), "brb_stt_500", 502),
        (httpx.Response(422, json={"detail": []}), "brb_stt_422", 502),
        (httpx.Response(200, text="not json"), "brb_stt_bad_response", 502),
    ],
)
def test_transcribe_errors(proxy: FakeProxy, answer: httpx.Response, error: str, status: int) -> None:
    proxy.stt = [answer]
    with pytest.raises(brb.BrbError) as raised:
        asyncio.run(brb.brb_transcribe(b"RIFF"))
    assert (str(raised.value), raised.value.status) == (error, status)


@pytest.mark.parametrize("body", [{}, {"text": None}, {"text": 5}, []])
def test_transcribe_without_text_is_empty(proxy: FakeProxy, body: object) -> None:
    proxy.stt = [httpx.Response(200, json=body)]
    assert asyncio.run(brb.brb_transcribe(b"RIFF")) == ""


def test_transcribe_needs_the_account(data_dir) -> None:  # noqa: ANN001
    with pytest.raises(brb.BrbError) as raised:
        asyncio.run(brb.brb_transcribe(b"RIFF"))
    assert (str(raised.value), raised.value.status) == ("brb_not_configured", 503)


# ── the `brb` engine ────────────────────────────────────────────────


def test_brb_engine_is_ready_with_the_tts_account(proxy: FakeProxy) -> None:
    assert stt.stt_engines()["brb"] is True
    assert stt.stt_engine_ids()["brb"] is True


def test_brb_engine_sends_16k_wav_and_reads_numbers(proxy: FakeProxy) -> None:
    proxy.stt = [httpx.Response(200, json={"text": "ikki yuz ming so'm"})]
    heard = asyncio.run(stt.transcribe(_wav(8000), language="uz", engine="brb"))
    assert heard == {"text": "200 000 so'm", "engine": "brb", "language": "uz"}
    (upload,) = proxy.uploads()
    wav = upload.content.split(b"\r\n\r\n", 1)[1]
    assert wav[:4] == b"RIFF" and struct.unpack_from("<I", wav, 24)[0] == 16000  # resampled to 16 kHz


def test_brb_engine_drops_hallucinations(proxy: FakeProxy) -> None:
    proxy.stt = [httpx.Response(200, json={"text": "Продолжение следует..."})]
    assert asyncio.run(stt.transcribe(_wav(), engine="brb"))["text"] == ""


def test_brb_engine_failure_is_an_stt_error(proxy: FakeProxy) -> None:
    proxy.stt = [httpx.Response(429, json={"detail": "limit"})]
    with pytest.raises(stt.SttError, match="brb: brb_limit"):
        asyncio.run(stt.transcribe(_wav(), engine="brb"))


def test_brb_engine_not_configured(data_dir) -> None:  # noqa: ANN001
    with pytest.raises(stt.SttError, match="brb_not_configured"):
        asyncio.run(stt.transcribe(_wav(), engine="brb"))
