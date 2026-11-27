"""
Speko Router (router.speko.dev) — port of src/lib/speech/speko.ts: ElevenLabs
voices for TTS and ElevenLabs Scribe for STT, behind one API key (the sysadmin
allows ElevenLabs only through Speko). The vendor is pinned (`routing.mode:
explicit`) so a request never silently fails over to a vendor that cannot speak
Uzbek. Gemini's speech models now come straight from Google (gemini_speech.py);
Speko renders them only as the fallback when Google refuses a request.

Env: SPEKO_API_KEY, SPEKO_BASE_URL (default https://router.speko.dev/v1),
SPEKO_TTS_VOICE (an ElevenLabs voice id used when a request names none of ours).
"""

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator

import regex as re

from app import http
from app.env import env
from app.jscompat import js_json, js_round, js_trim
from app.speech.gemini_speech import GEMINI_TTS_MODELS, GEMINI_TTS_RATE, GEMINI_VOICES, gemini_voice, is_gemini_tts
from app.speech.resample import pcm_pieces, resampled
from app.streams import error_body, read_until

log = logging.getLogger("callmind.speko")

ELEVEN_TTS_MODELS = ("eleven_v3_conversational", "eleven_v4_turbo")
# Every cloud TTS model the app offers: ElevenLabs' (through Speko) and Gemini's (from Google, Speko as
# the fallback). Gemini renders 24 kHz only (Speko refuses any other rate with 415); other rates are
# converted (app/speech/resample.py).
SPEKO_TTS_MODELS = (*ELEVEN_TTS_MODELS, *GEMINI_TTS_MODELS)

# The first is the default. Nadya and Miron are native Russian voices; the rest native Uzbek.
ELEVEN_VOICES = (
    {"id": "lZSeoYcz4phdvms888pn", "name": "Nadya", "gender": "female", "note": "Calm & meditative"},
    {"id": "VlXLedwkU4YDM3HBGpiI", "name": "Miron", "gender": "male", "note": "Charismatic storyteller"},
    {"id": "cfWx14ZbaEUT4BjIA5tH", "name": "Mirjalol", "gender": "male", "note": "Uzbek · calm, confident"},
    {"id": "tsHbvXAh0M61xzsgDqlk", "name": "Firdavs Urinov", "gender": "male", "note": "Uzbek · narrator"},
    {"id": "agoC45V78njTIxYzwmSb", "name": "Davronbek", "gender": "male", "note": "Uzbek · journalist"},
    {"id": "RaNVfTYq3HYeFPLng6XN", "name": "Mirzaev", "gender": "male", "note": "Uzbek · native speaker"},
    {"id": "fytsqG6MLzC2aCSw7MLa", "name": "Asilbek", "gender": "male", "note": "Uzbek · ads"},
)


def eleven_voice(voice_id: str | None = None) -> str:
    """`voice_id` when it is one of ours, else SPEKO_TTS_VOICE, else the first voice."""
    if voice_id and any(v["id"] == voice_id for v in ELEVEN_VOICES):
        return voice_id
    return js_trim(env("SPEKO_TTS_VOICE")) or ELEVEN_VOICES[0]["id"]


def model_voices(model: str) -> tuple[dict[str, str], ...]:
    """The voices a cloud TTS model speaks with: Gemini's for the Gemini models, else ElevenLabs'."""
    return GEMINI_VOICES if is_gemini_tts(model) else ELEVEN_VOICES


def tts_voice(model: str, voice_id: str | None = None) -> str:
    """The voice to send for `model`: `voice_id` when that model has it, else the model's default."""
    return gemini_voice(voice_id) if is_gemini_tts(model) else eleven_voice(voice_id)


SAMPLE_RATE = 8000


def _key() -> str:
    return js_trim(env("SPEKO_API_KEY"))


def speko_configured() -> bool:
    return bool(_key())


def _base() -> str:
    return re.sub(r"/+$", "", env("SPEKO_BASE_URL", "https://router.speko.dev/v1"))


class SpekoError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


async def speko_stream_pcm(
    text: str, model: str, language: str, voice: str, sample_rate: int = SAMPLE_RATE, quick_start: bool = False
) -> AsyncIterator[bytes]:
    """Render `text` with one ElevenLabs or Gemini model, yielding mono 16-bit PCM pieces as they arrive."""
    # 16-bit mono: `sample_rate` bytes are 0.5 s. Quick start: 0.1 s, then 0.25 s pieces.
    first_piece = (js_round(sample_rate / 5) & ~1) if quick_start else sample_rate // 2
    piece = sample_rate // 2 if quick_start else sample_rate
    key = _key()
    if not key:
        raise SpekoError("speko_not_configured", 503)
    gemini = is_gemini_tts(model)
    render_rate = GEMINI_TTS_RATE if gemini else sample_rate
    body = {
        "routing": {"mode": "explicit", "provider": "gemini" if gemini else "elevenlabs", "model": model},
        "input": text,
        "language": language,
        "voice": voice,
        "audio": {"encoding": "pcm_s16le", "sample_rate_hz": render_rate, "channels": 1},
    }
    deadline = asyncio.get_running_loop().time() + 60
    res = await http.open_stream(
        "POST",
        f"{_base()}/tts/speech",
        deadline,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid.uuid4()),
        },
        content=js_json(body).encode(),
    )
    try:
        if not res.is_success:
            log.warning("[speko] %s %s: %s", model, res.status_code, await error_body(res, 240))
            raise SpekoError(f"speko_{res.status_code}", 503 if res.status_code == 401 else 502)
        audio = read_until(res, deadline)
        if render_rate != sample_rate:
            audio = resampled(audio, render_rate, sample_rate)
        async for out in pcm_pieces(audio, first_piece, piece):
            yield out
    finally:
        await res.aclose()


# ── speech-to-text ──────────────────────────────────────────────────

SPEKO_STT_MODEL = "gemini-3.5-transcribe"
# The streaming ("live") variant of the same model, through Speko: only the fallback now (Google first).
SPEKO_LIVE_MODEL = "gemini-3.5-transcribe-live"
SPEKO_SCRIBE_MODEL = "scribe_v2_realtime"
# ElevenLabs' newer streaming model: word by word on the live socket (app/speech/speko_live.py), and
# as one finished utterance here when the live words are not available.
SPEKO_SCRIBE_LIVE_MODEL = "scribe_v3_live"
SPEKO_GEMINI_ROUTE = {"provider": "gemini", "model": SPEKO_STT_MODEL}
SPEKO_LIVE_ROUTE = {"provider": "gemini", "model": SPEKO_LIVE_MODEL}
SPEKO_SCRIBE_ROUTE = {"provider": "elevenlabs", "model": SPEKO_SCRIBE_MODEL}
SPEKO_SCRIBE_LIVE_ROUTE = {"provider": "elevenlabs", "model": SPEKO_SCRIBE_LIVE_MODEL}


async def speko_transcribe(pcm16k: bytes, language: str | None, route: dict[str, str] = SPEKO_GEMINI_ROUTE) -> str:
    """One finished utterance as 16 kHz mono 16-bit PCM → its transcript."""
    key = _key()
    if not key:
        raise SpekoError("speko_not_configured", 503)
    request = {
        "routing": {"mode": "explicit", "provider": route["provider"], "model": route["model"]},
        "language": language or "uz",
        "audio": {"encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1},
    }
    # Speko wants the parts in this order: the request, then the audio.
    files = [
        ("request", ("blob", js_json(request).encode(), "application/json")),
        ("audio", ("speech.pcm", pcm16k, "application/octet-stream")),
    ]
    async with asyncio.timeout(30):
        res = await http.client().post(
            f"{_base()}/stt/transcriptions",
            headers={"Authorization": f"Bearer {key}", "Idempotency-Key": str(uuid.uuid4())},
            files=files,
        )
        if not res.is_success:
            log.warning("[speko] %s %s: %s", route["model"], res.status_code, res.text[:240])
            raise SpekoError(f"speko_{res.status_code}", 503 if res.status_code == 401 else 502)
        data = res.json()
    text = data.get("text") if isinstance(data, dict) else None
    return js_trim(text if isinstance(text, str) else "")
