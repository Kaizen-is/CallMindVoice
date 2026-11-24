"""
Speech for the console — ports of src/app/api/speech/{tts,stt}/route.ts and
src/app/api/models/stt/route.ts. The site reaches them at their original paths
(/api/speech/tts, /api/speech/stt, /api/models/stt) through the Next.js
rewrite, and also as /api/core/*.

  POST /speech/tts   JSON {text, voice?, language?, stream?, engine?, rate?}
                     → a WAV, or (stream: true) raw mono PCM (`audio/L16`), one
                       sentence at a time; `X-Audio-Rate` says the rate.
  POST /speech/stt   multipart {file, language?, denoise?, engine?} or a raw
                     audio body → {text, language, engine}
  POST /models/stt   multipart {file, engine, language} → {text, engine, ms}:
                     exactly that engine (For developers ▸ STT, Models ▸ Voices).
"""

import logging
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.datastructures import UploadFile

from app.auth import LoggedIn
from app.jscompat import js_round, js_trim, utf16_len
from app.speech.stt import SttError, is_stt_engine, stt_configured, stt_engine_ids, transcribe, transcribe_one
from app.speech.tts import (
    SynthOptions,
    TtsError,
    is_tts_engine,
    output_rate,
    synthesize_stream,
    synthesize_wav,
    tts_configured,
)

log = logging.getLogger("callmind.speech")

router = APIRouter()

# Short text is almost always a fixed line (a filler, a greeting, a stock question being re-tested),
# so it is worth caching on disk. Long text is a one-off answer.
CACHEABLE_CHARS = 120

MAX_MODEL_TEST_BYTES = 10 * 1024 * 1024
LANGUAGES = ("uz", "ru", "en")


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def _js_string(value: object) -> str:
    """`String(form.get(name) ?? '')`."""
    if value is None:
        return ""
    if isinstance(value, UploadFile):
        return "[object File]"
    return str(value)


def _is_number(value: object) -> bool:
    """`typeof value === 'number'`."""
    return isinstance(value, int | float) and not isinstance(value, bool)


# ── text to speech ──────────────────────────────────────────────────


@router.post("/speech/tts")
async def speech_tts(request: Request, session: LoggedIn) -> Response:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - the page always sends JSON
        return _error("bad_request", 400)
    if not isinstance(body, dict):
        body = {}
    text = body.get("text")
    asked = body.get("engine")
    rate = body.get("rate")

    engine = asked if is_tts_engine(asked) else "default"
    if not tts_configured(engine):
        return _error("tts_not_configured", 503)
    if not isinstance(text, str) or not js_trim(text):
        return _error("empty_text", 400)

    voice = body.get("voice")
    language = body.get("language")
    opts = SynthOptions(
        tenant_id=session.tenant["id"],
        voice_id=voice if isinstance(voice, str) else None,
        language=language if isinstance(language, str) and language else "uz",
        tag=f"pg_{session.user['id'][:8]}",
        cache=utf16_len(js_trim(text)) <= CACHEABLE_CHARS,
        engine=engine,
        sample_rate=rate if _is_number(rate) else None,
    )
    sent_rate = output_rate(engine, opts.sample_rate)

    if body.get("stream"):
        return StreamingResponse(
            _stream(text, opts),
            media_type=f"audio/L16; rate={sent_rate}; channels=1",
            headers={"Cache-Control": "no-store", "X-Audio-Rate": str(sent_rate)},
        )
    try:
        wav = await synthesize_wav(text, opts)
    except TtsError as err:
        log.warning("[tts] request failed: %s", err)
        return _error(str(err), err.status)
    except Exception as err:  # noqa: BLE001
        log.warning("[tts] request failed: %s", err)
        return _error("tts_unreachable", 502)
    return Response(
        wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Audio-Rate": str(sent_rate)},
    )


async def _stream(text: str, opts: SynthOptions) -> AsyncIterator[bytes]:
    """The sentences as they render. A failure ends the stream, so the listener keeps what already played."""
    try:
        async for piece in synthesize_stream(text, opts):
            yield piece
    except Exception as err:  # noqa: BLE001
        log.warning("[tts] stream aborted: %s", err)


# ── speech to text ──────────────────────────────────────────────────


@router.post("/speech/stt")
async def speech_stt(request: Request, session: LoggedIn) -> JSONResponse:  # noqa: ARG001 - login required
    if not stt_configured():
        return _error("stt_not_configured", 503)

    language: str | None = None
    clean = False
    engine = "auto"
    # Multipart is what the console sends (some proxies refuse raw binary POSTs); a raw body also works.
    if "multipart/form-data" in (request.headers.get("content-type") or ""):
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile) or not upload.size:
            return _error("empty_audio", 400)
        audio = await upload.read()
        lang = form.get("language")
        if isinstance(lang, str) and lang in LANGUAGES:
            language = lang
        clean = form.get("denoise") == "1"
        pinned = form.get("engine")
        if is_stt_engine(pinned):
            engine = pinned
    else:
        audio = await request.body()
    if not audio:
        return _error("empty_audio", 400)

    try:
        heard = await transcribe(audio, language=language, clean=clean, engine=engine)
    except SttError as err:
        log.warning("[stt] request failed: %s", err)
        return _error(str(err), err.status)
    except Exception as err:  # noqa: BLE001
        log.warning("[stt] request failed: %s", err)
        return _error("stt_unreachable", 502)
    return JSONResponse({"text": heard["text"], "language": heard["language"], "engine": heard["engine"]})


@router.post("/models/stt")
async def models_stt(request: Request, session: LoggedIn) -> JSONResponse:  # noqa: ARG001 - login required
    """One recording through exactly one engine: no race, no fallback, no noise cleaning."""
    # `request.formData()` throws on any other body; Starlette would hand back an empty form instead.
    content_type = request.headers.get("content-type") or ""
    if "multipart/form-data" not in content_type and "application/x-www-form-urlencoded" not in content_type:
        return _error("expected_multipart_form", 400)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error("expected_multipart_form", 400)
    upload = form.get("file")
    if not isinstance(upload, UploadFile) or not upload.size:
        return _error("empty_audio", 400)
    if upload.size > MAX_MODEL_TEST_BYTES:
        return _error("audio_too_large", 413)

    engine = _js_string(form.get("engine"))
    if not stt_engine_ids().get(engine):
        return _error("engine_not_ready", 400)
    lang = _js_string(form.get("language"))
    language = lang if lang in LANGUAGES else "uz"

    started = time.perf_counter()
    try:
        heard = await transcribe_one(engine, await upload.read(), language)
    except Exception as err:  # noqa: BLE001
        log.warning("[models/stt] failed: %s", err)
        return _error(str(err) or "stt_failed", 502)
    return JSONResponse(
        {"text": heard["text"], "engine": engine, "ms": js_round((time.perf_counter() - started) * 1000)}
    )
