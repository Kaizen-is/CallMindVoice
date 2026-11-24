"""
The STT layer — port of src/lib/speech/stt.ts. Turns one caller utterance
(a WAV) into text.

`auto`: Kotib (STT_TRANSCRIBE_URL, the internal Uzbek model) and Whisper
(WHISPER_TRANSCRIBE_URL) run concurrently on the same audio for an
Uzbek-primary agent and the better transcript wins — the caller waits for the
slower one, never both. Without Whisper, Gemini covers the non-Uzbek side and
stands in when Kotib is down. By name: GAPI (`gapi`), Zipformer in-process
(`local`), gemini-3.5 via Speko (`gemini`), ElevenLabs Scribe via Speko
(`scribe`), BRB Whisper on Triton over gRPC (`brb`).
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

import regex as re

from app import http
from app.env import env
from app.jscompat import JS_B, js_trim, utf16_len
from app.llm.gemini import gemini_transcribe, has_gemini
from app.speech import zipformer
from app.speech.brb_stt import brb_stt_configured, brb_stt_model, brb_transcribe
from app.speech.denoise import denoise
from app.speech.gapi import gapi_configured, gapi_transcribe
from app.speech.numbers import uzbek_numbers_to_digits
from app.speech.speko import (
    SPEKO_GEMINI_ROUTE,
    SPEKO_LIVE_MODEL,
    SPEKO_LIVE_ROUTE,
    SPEKO_SCRIBE_LIVE_MODEL,
    SPEKO_SCRIBE_LIVE_ROUTE,
    SPEKO_SCRIBE_MODEL,
    SPEKO_SCRIBE_ROUTE,
    SPEKO_STT_MODEL,
    speko_configured,
    speko_transcribe,
)
from app.speech.vocabulary import echoes_prompt, whisper_prompt
from app.speech.wav import is_silent, wav_duration_ms, wav_to_pcm16k
from app.usage_log import UsageEntry, record_usage

log = logging.getLogger("callmind.stt")

Transcript = dict  # {text, engine, language}

STT_ENGINES = ("auto", "gapi", "local", "gemini", "gemini_live", "scribe", "scribe_live", "brb")


class SttError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _empty() -> Transcript:
    return {"text": "", "engine": "none", "language": None}


def is_stt_engine(value: object) -> bool:
    return isinstance(value, str) and value in STT_ENGINES


TIMEOUT_S = 20.0


def stt_engines() -> dict[str, bool]:
    """Which engines this deployment can run, for the Playground's model picker."""
    return {
        "auto": bool(env("STT_TRANSCRIBE_URL") or env("WHISPER_TRANSCRIBE_URL")),
        "gapi": gapi_configured(),
        "local": zipformer.zipformer_available(),
        "gemini": speko_configured(),
        "gemini_live": speko_configured(),
        "scribe": speko_configured(),
        "scribe_live": speko_configured(),
        "brb": brb_stt_configured(),
    }


def stt_configured() -> bool:
    return any(stt_engines().values())


def stt_engine_ids() -> dict[str, bool]:
    """Which single engines this deployment can run (as the usage log and model lab name them)."""
    return {
        "kotib": bool(env("STT_TRANSCRIBE_URL")),
        "whisper": bool(env("WHISPER_TRANSCRIBE_URL")),
        "gapi": gapi_configured(),
        "local": zipformer.zipformer_available(),
        "speko": speko_configured(),
        "speko_live": speko_configured(),
        "gemini": has_gemini(),
        "scribe": speko_configured(),
        "scribe_live": speko_configured(),
        "brb": brb_stt_configured(),
    }


async def transcribe_one(engine: str, audio: bytes, language: str | None = None) -> Transcript:
    """One engine, nothing else: no race, no fallback, no noise cleaning. Raises when it fails."""
    if not audio:
        raise SttError("empty_audio", 400)
    if not stt_engine_ids().get(engine):
        raise SttError(f"{engine}_not_configured", 503)
    if is_silent(audio):
        return _empty()
    if engine == "kotib":
        heard = await _kotib(audio)
        return {**heard, "text": uzbek_numbers_to_digits(heard["text"])} if heard["text"] else heard
    if engine == "whisper":
        return await _whisper(audio, language)
    if engine == "gapi":
        return await _gapi_one(audio, language)
    if engine == "local":
        return await _local_zipformer(audio)
    if engine == "speko":
        return await _speko_gemini(audio, language)
    if engine == "speko_live":
        return await _speko_gemini(audio, language, live=True)
    if engine == "scribe":
        return await _speko_scribe(audio, language)
    if engine == "scribe_live":
        return await _speko_scribe(audio, language, live=True)
    if engine == "brb":
        return await _brb_whisper(audio, language)
    heard = await _gemini(audio, language or "uz")
    if heard is None:
        raise SttError("gemini_failed")
    return heard


# ── usage logging ───────────────────────────────────────────────────


async def _logged(
    engine: str, model: str | None, audio: bytes, work: Callable[[], Awaitable[Transcript]]
) -> Transcript:
    started = time.perf_counter()
    audio_ms = wav_duration_ms(audio)
    try:
        heard = await work()
    except Exception as err:
        record_usage(
            UsageEntry(
                kind="stt",
                engine=engine,
                model=model,
                ms=(time.perf_counter() - started) * 1000,
                audio_ms=audio_ms,
                ok=False,
                error=str(err) or type(err).__name__,
            )
        )
        raise
    record_usage(
        UsageEntry(
            kind="stt",
            engine=engine,
            model=model,
            ms=(time.perf_counter() - started) * 1000,
            audio_ms=audio_ms,
            ok=True,
        )
    )
    return heard


async def _gapi_one(
    audio: bytes, language: str | None = None, clean: bool = False, vocabulary: list[str] | None = None
) -> Transcript:
    async def work() -> Transcript:
        try:
            heard = await gapi_transcribe(audio, language=language, vocabulary=vocabulary, clean=clean)
        except Exception as err:
            raise SttError(str(err) or "gapi_failed") from err
        return {**heard, "text": uzbek_numbers_to_digits(heard["text"])} if heard["text"] else _empty()

    return await _logged("gapi", None, audio, work)


# ── Kotib and Whisper ───────────────────────────────────────────────


async def _kotib(audio: bytes) -> Transcript:
    return await _logged("kotib", None, audio, lambda: _kotib_request(audio))


async def _kotib_request(audio: bytes) -> Transcript:
    url = env("STT_TRANSCRIBE_URL")
    if not url:
        return _empty()
    async with asyncio.timeout(TIMEOUT_S):
        res = await http.client().post(
            url, files=[("file", ("speech.wav", audio, "audio/wav"))], headers={"accept": "application/json"}
        )
        # Raised rather than returned empty, so "Kotib is down" differs from "the caller said nothing".
        if not res.is_success:
            raise SttError(f"kotib {res.status_code}: {res.text[:160]}")
        data = res.json()
    text = js_trim(str(data.get("text") or "")) if isinstance(data, dict) else ""
    return {"text": text, "engine": "kotib", "language": data.get("language") or "uz"} if text else _empty()


async def _local_zipformer(audio: bytes) -> Transcript:
    async def work() -> Transcript:
        try:
            text = await asyncio.to_thread(zipformer.transcribe_wav, audio)
        except Exception as err:
            raise SttError(f"local: {err or 'failed'}") from err
        return {"text": uzbek_numbers_to_digits(text), "engine": "local", "language": "uz"} if text else _empty()

    return await _logged("local", "uzbek-zipformer", audio, work)


async def _speko_gemini(audio: bytes, language: str | None = None, live: bool = False) -> Transcript:
    """gemini-3.5 through Speko; `live` = its streaming variant (engine `speko_live` in the usage log)."""
    engine, model, route = (
        ("speko_live", SPEKO_LIVE_MODEL, SPEKO_LIVE_ROUTE) if live else ("speko", SPEKO_STT_MODEL, SPEKO_GEMINI_ROUTE)
    )

    async def work() -> Transcript:
        try:
            text = await speko_transcribe(wav_to_pcm16k(audio), language, route)
        except Exception as err:
            raise SttError(f"{model}: {err or 'failed'}" if live else f"gemini-3.5: {err or 'failed'}") from err
        return (
            {"text": text, "engine": engine, "language": language or "uz"}
            if text and not _is_hallucination(text)
            else _empty()
        )

    return await _logged(engine, model, audio, work)


async def _speko_scribe(audio: bytes, language: str | None = None, live: bool = False) -> Transcript:
    """ElevenLabs Scribe through Speko; `live` = Scribe v3 Live (engine `scribe_live`), as one utterance."""
    engine, model, route = (
        ("scribe_live", SPEKO_SCRIBE_LIVE_MODEL, SPEKO_SCRIBE_LIVE_ROUTE)
        if live
        else ("scribe", SPEKO_SCRIBE_MODEL, SPEKO_SCRIBE_ROUTE)
    )

    async def work() -> Transcript:
        try:
            text = await speko_transcribe(wav_to_pcm16k(audio), language, route)
        except Exception as err:
            raise SttError(f"{engine}: {err or 'failed'}" if live else f"scribe: {err or 'failed'}") from err
        if not text or _is_hallucination(text):
            return _empty()
        return {"text": uzbek_numbers_to_digits(text), "engine": engine, "language": language or "uz"}

    return await _logged(engine, model, audio, work)


async def _brb_whisper(audio: bytes, language: str | None = None) -> Transcript:
    """BRB Whisper (our own model on Triton); numbers as digits, like the other engines."""

    async def work() -> Transcript:
        try:
            text = await brb_transcribe(wav_to_pcm16k(audio), language)
        except Exception as err:
            raise SttError(f"brb: {err or 'failed'}") from err
        if not text or _is_hallucination(text):
            return _empty()
        return {"text": uzbek_numbers_to_digits(text), "engine": "brb", "language": language or "uz"}

    return await _logged("brb", brb_stt_model(), audio, work)


async def _whisper(audio: bytes, language: str | None = None, vocabulary: list[str] | None = None) -> Transcript:
    return await _logged(
        "whisper",
        env("WHISPER_MODEL", "whisper-large-v3-turbo"),
        audio,
        lambda: _whisper_request(audio, language, vocabulary),
    )


async def _whisper_request(
    audio: bytes, language: str | None = None, vocabulary: list[str] | None = None
) -> Transcript:
    url = env("WHISPER_TRANSCRIBE_URL")
    if not url:
        return _empty()
    files: list = [
        ("file", ("speech.wav", audio, "audio/wav")),
        ("model", (None, env("WHISPER_MODEL", "whisper-large-v3-turbo").encode())),
        ("response_format", (None, b"json")),
    ]
    # Pinning the language saves ~100 ms; omitted for Uzbek-primary agents, where the caller may switch.
    if language and language != "uz":
        files.append(("language", (None, language.encode())))
    # The names and terms to expect, as text that "came before" (Whisper's `prompt`).
    prompt = whisper_prompt(vocabulary)
    if prompt:
        files.append(("prompt", (None, prompt.encode())))
    key = env("WHISPER_API_KEY")
    headers = {"accept": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
    async with asyncio.timeout(TIMEOUT_S):
        res = await http.client().post(url, files=files, headers=headers)
        if not res.is_success:
            raise SttError(f"whisper {res.status_code}: {res.text[:160]}")
        data = res.json()
    text = js_trim(str(data.get("text") or "")) if isinstance(data, dict) else ""
    if echoes_prompt(text, prompt):
        return _empty()  # Whisper repeating its word list back: it heard nothing it could make out
    detected = data.get("language") if isinstance(data, dict) else None
    return {"text": text, "engine": "whisper", "language": detected or language or None} if text else _empty()


LANGUAGE_NAME = {"uz": "Uzbek (Latin script)", "ru": "Russian", "en": "English"}


async def _gemini(audio: bytes, language: str) -> Transcript | None:
    """Gemini's transcript; empty when it heard no speech, None when it failed."""
    started = time.perf_counter()
    text = await gemini_transcribe(audio, LANGUAGE_NAME.get(language, "Russian"))
    record_usage(
        UsageEntry(
            kind="stt",
            engine="gemini",
            model=env("GEMINI_STT_MODEL") or None,
            ms=(time.perf_counter() - started) * 1000,
            audio_ms=wav_duration_ms(audio),
            ok=text is not None,
            error="gemini_failed" if text is None else None,
        )
    )
    if text is None:
        return None
    return (
        {"text": text, "engine": "gemini", "language": language} if text and not _is_hallucination(text) else _empty()
    )


# ── choosing between two transcripts ────────────────────────────────

# Whisper hallucinates fixed phrases on silence or noise.
HALLUCINATIONS = (
    "thank you",
    "thanks for watching",
    "you",
    "bye",
    "субтитры",
    "продолжение следует",
    "спасибо за просмотр",
)
_END_PUNCT = re.compile(r"[.!?…]")


def _is_hallucination(text: str) -> bool:
    t = js_trim(_END_PUNCT.sub("", text.lower()))
    return utf16_len(t) <= 30 and any(t == h or t.startswith(h) for h in HALLUCINATIONS)


_LETTER = re.compile(r"\p{L}")
_UZ_MARKER = re.compile(f"[oʻgʻʼ']|{JS_B}(va|bilan|uchun|qanday|nechta|bor|yoq|kerak|soat){JS_B}", re.IGNORECASE)


def _uzbekness(text: str) -> float:
    """Fraction of letters that belong to the Uzbek Latin alphabet's extras."""
    letters = len(_LETTER.findall(text))
    if not letters:
        return 0
    return len(_UZ_MARKER.findall(text)) / letters


def _pick(a: Transcript, b: Transcript, primary: str) -> Transcript:
    """The transcript to act on. Both engines are trusted on their home turf."""
    good = [t for t in (a, b) if t["text"] and not _is_hallucination(t["text"])]
    if not good:
        return _empty()
    if len(good) == 1:
        return good[0]
    kot, whi = (good[0], good[1]) if good[0]["engine"] == "kotib" else (good[1], good[0])
    if primary != "uz":
        return whi
    # Whisper confidently reporting another language that reads like it: the caller switched.
    if whi["language"] and whi["language"] != "uz" and _uzbekness(whi["text"]) < 0.02:
        return whi
    # A near-empty result is usually a truncated decode; prefer whichever heard more.
    if utf16_len(kot["text"]) < utf16_len(whi["text"]) * 0.5:
        return whi
    return kot


# ── public entry point ──────────────────────────────────────────────


async def transcribe(
    audio: bytes,
    *,
    language: str | None = None,
    clean: bool = False,
    engine: str | None = None,
    vocabulary: list[str] | None = None,
) -> Transcript:
    """
    Transcribe one complete utterance (`clean` runs the noise cleaner first; `vocabulary` lists names
    and terms to expect, used by GAPI and Whisper). Never raises on a single engine failing — only
    when nothing is configured, or every configured engine errored.
    """
    if not audio:
        raise SttError("empty_audio", 400)

    if engine and engine != "auto":
        if not stt_engines().get(engine):
            raise SttError(f"{engine}_not_configured", 503)
        if is_silent(audio):
            return _empty()
        if engine == "local":
            return await _local_zipformer(await denoise(audio) if clean else audio)
        if engine == "gemini":
            return await _speko_gemini(await denoise(audio) if clean else audio, language)
        if engine == "gemini_live":
            return await _speko_gemini(await denoise(audio) if clean else audio, language, live=True)
        if engine == "scribe":
            return await _speko_scribe(await denoise(audio) if clean else audio, language)
        if engine == "scribe_live":
            return await _speko_scribe(await denoise(audio) if clean else audio, language, live=True)
        if engine == "brb":
            return await _brb_whisper(await denoise(audio) if clean else audio, language)
        return await _gapi_one(audio, language, clean, vocabulary)

    has_kotib = bool(env("STT_TRANSCRIBE_URL"))
    has_whisper = bool(env("WHISPER_TRANSCRIBE_URL"))
    if not has_kotib and not has_whisper:
        raise SttError("stt_not_configured", 503)
    if is_silent(audio):
        return _empty()
    if clean:
        audio = await denoise(audio)

    primary = language or "uz"
    gemini_ear = not has_whisper and has_gemini()

    # With no Whisper, Kotib (Uzbek only) would garble Russian: Gemini hears it properly.
    if gemini_ear and primary != "uz":
        heard = await _gemini(audio, primary)
        if heard:
            return heard

    use_kotib = has_kotib and (primary == "uz" or not has_whisper)
    kotib_down = False

    async def kotib_side() -> Transcript:
        nonlocal kotib_down
        if not use_kotib:
            return _empty()
        try:
            return await _kotib(audio)
        except Exception as err:  # noqa: BLE001
            kotib_down = True
            log.warning("[stt] kotib failed: %s", err)
            return _empty()

    async def whisper_side() -> Transcript:
        if not has_whisper:
            return _empty()
        try:
            return await _whisper(audio, primary, vocabulary)
        except Exception as err:  # noqa: BLE001
            log.warning("[stt] whisper failed: %s", err)
            return _empty()

    k, w = await asyncio.gather(kotib_side(), whisper_side())
    picked = _pick(k, w, primary)
    # Kotib unreachable on an Uzbek turn: Gemini is slower, but heard late beats not heard.
    if not picked["text"] and kotib_down and gemini_ear:
        return (await _gemini(audio, primary)) or _empty()
    # Kotib spells numbers out; done after the pick, which weighs transcripts by length.
    return {**picked, "text": uzbek_numbers_to_digits(picked["text"])} if picked["engine"] == "kotib" else picked
