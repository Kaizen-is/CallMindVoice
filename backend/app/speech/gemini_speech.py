"""
Gemini's speech models straight from Google (the Gemini API, generativelanguage.googleapis.com), with
the key the app already has for the Gemini LLM (GEMINI_API_KEY, from https://aistudio.google.com/apikey):

  gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts   text-to-speech, streamed as it renders (24 kHz)
  gemini-3.5-transcribe                             one finished utterance → text
  gemini-3.5-transcribe-live                        live words while the caller speaks (gemini_live.py)

On whenever GEMINI_API_KEY is set (since 2026-11-25, when the key moved to a paid prepay account; until
then Gemini's speech went through Speko). Speko stays the fallback when Google refuses a request (quota,
no credit, an outage); GEMINI_SPEECH_VIA=speko sends everything through Speko again.
"""

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator

from app import http
from app.env import env
from app.jscompat import js_json, js_round, js_trim
from app.speech.resample import pcm_pieces, resampled
from app.streams import error_body, read_until

log = logging.getLogger("callmind.gemini.speech")

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"

GEMINI_TTS_MODELS = ("gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts")
GEMINI_TTS_RATE = 24000  # Gemini renders 24 kHz mono 16-bit; other rates are converted here
GEMINI_STT_MODEL = "gemini-3.5-transcribe"
GEMINI_LIVE_STT_MODEL = "gemini-3.5-transcribe-live"

# Gemini's prebuilt voices that speak Uzbek well. The first is the default.
GEMINI_VOICES = (
    {"id": "Kore", "name": "Kore", "gender": "female", "note": "Firm"},
    {"id": "Sulafat", "name": "Sulafat", "gender": "female", "note": "Warm"},
    {"id": "Achernar", "name": "Achernar", "gender": "female", "note": "Soft"},
    {"id": "Aoede", "name": "Aoede", "gender": "female", "note": "Breezy"},
    {"id": "Charon", "name": "Charon", "gender": "male", "note": "Informative"},
    {"id": "Orus", "name": "Orus", "gender": "male", "note": "Firm"},
    {"id": "Iapetus", "name": "Iapetus", "gender": "male", "note": "Clear"},
    {"id": "Puck", "name": "Puck", "gender": "male", "note": "Upbeat"},
)


def is_gemini_tts(model: str) -> bool:
    return model in GEMINI_TTS_MODELS


def gemini_voice(voice_id: str | None = None) -> str:
    """`voice_id` when it is one of Gemini's voices, else the default."""
    return voice_id if voice_id and any(v["id"] == voice_id for v in GEMINI_VOICES) else GEMINI_VOICES[0]["id"]


def _key() -> str:
    return js_trim(env("GEMINI_API_KEY"))


def gemini_speech_configured() -> bool:
    """Whether Gemini's speech goes to Google: the key set and GEMINI_SPEECH_VIA not `speko` (else Speko)."""
    return env("GEMINI_SPEECH_VIA", "google").strip().lower() != "speko" and bool(_key())


class GeminiSpeechError(Exception):
    """A request Google refused or failed. `fallback`: nothing was delivered yet, so another route may try."""

    def __init__(self, message: str, status: int = 502, fallback: bool = True) -> None:
        super().__init__(message)
        self.status = status
        self.fallback = fallback


def _failure(model: str, status: int, body: str) -> GeminiSpeechError:
    log.warning("[gemini] %s %s: %s", model, status, body[:300])
    if status == 429:
        return GeminiSpeechError(f"gemini_quota_{model}", 429)
    return GeminiSpeechError(f"gemini_{status}", 503 if status in (401, 403) else 502)


# ── text-to-speech ──────────────────────────────────────────────────


def _audio_parts(event: object) -> list[tuple[bytes, str]]:
    """The audio pieces (PCM, mime type) in one streamed `GenerateContentResponse`."""
    out: list[tuple[bytes, str]] = []
    for cand in (event.get("candidates") or []) if isinstance(event, dict) else []:
        for part in ((cand.get("content") or {}).get("parts") or []) if isinstance(cand, dict) else []:
            inline = part.get("inlineData") if isinstance(part, dict) else None
            if isinstance(inline, dict) and inline.get("data"):
                out.append((base64.b64decode(inline["data"]), str(inline.get("mimeType") or "")))
    return out


def _pcm_of(data: bytes, mime: str) -> bytes:
    """Raw PCM: streamed pieces are headerless `audio/L16`; a whole answer would be a WAV."""
    if data[:4] == b"RIFF" and b"data" in data[:256]:
        return data[data.index(b"data") + 8 :]
    return data


async def _sse_events(chunks: AsyncIterator[bytes]) -> AsyncIterator[object]:
    """Server-sent events (`alt=sse`): one JSON object per `data:` line."""
    held = b""
    async for chunk in chunks:
        held += chunk
        while b"\n" in held:
            line, held = held.split(b"\n", 1)
            line = line.strip()
            if line.startswith(b"data:"):
                yield json.loads(line[5:])
    if held.strip().startswith(b"data:"):
        yield json.loads(held.strip()[5:])


async def gemini_tts_stream(
    text: str, model: str, voice: str, sample_rate: int = GEMINI_TTS_RATE, quick_start: bool = False
) -> AsyncIterator[bytes]:
    """
    Render `text` with a Gemini TTS model, yielding mono 16-bit PCM at `sample_rate` as it arrives.
    Raises GeminiSpeechError (fallback=True) when Google refuses before any audio is out.
    """
    key = _key()
    if not key:
        raise GeminiSpeechError("gemini_not_configured", 503)
    # 16-bit mono: `sample_rate` bytes are 0.5 s. Quick start: 0.1 s, then 0.25 s pieces (as the others).
    first_piece = (js_round(sample_rate / 5) & ~1) if quick_start else sample_rate // 2
    piece = sample_rate // 2 if quick_start else sample_rate
    body = {
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }
    deadline = asyncio.get_running_loop().time() + 60
    res = await http.open_stream(
        "POST",
        f"{ENDPOINT}/{model}:streamGenerateContent?alt=sse",
        deadline,
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        content=js_json(body).encode(),
    )
    try:
        if not res.is_success:
            raise _failure(model, res.status_code, await error_body(res, 400))

        async def pcm() -> AsyncIterator[bytes]:
            async for event in _sse_events(read_until(res, deadline)):
                if isinstance(event, dict) and event.get("error"):
                    raise GeminiSpeechError(f"gemini_stream_error: {event['error']}", 502, fallback=False)
                for data, mime in _audio_parts(event):
                    yield _pcm_of(data, mime)

        audio = pcm() if sample_rate == GEMINI_TTS_RATE else resampled(pcm(), GEMINI_TTS_RATE, sample_rate)
        async for out in pcm_pieces(audio, first_piece, piece):
            yield out
    finally:
        await res.aclose()


# ── speech-to-text: one finished utterance ──────────────────────────


async def gemini_transcribe_once(wav: bytes, model: str = GEMINI_STT_MODEL) -> str:
    """One utterance (a WAV) → its transcript with Gemini's transcription model. Raises GeminiSpeechError."""
    key = _key()
    if not key:
        raise GeminiSpeechError("gemini_not_configured", 503)
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(wav).decode()}}],
            }
        ],
    }
    async with asyncio.timeout(30):
        res = await http.client().post(
            f"{ENDPOINT}/{model}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            content=js_json(body).encode(),
        )
    if not res.is_success:
        raise _failure(model, res.status_code, res.text)
    data = res.json()
    texts = [
        part.get("text", "")
        for cand in data.get("candidates") or []
        for part in (cand.get("content") or {}).get("parts") or []
        if isinstance(part, dict)
    ]
    return js_trim("".join(texts))
