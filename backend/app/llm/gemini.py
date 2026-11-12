"""
Google Gemini — port of src/lib/llm/gemini.ts. Called directly over the REST
API. Activated by GEMINI_API_KEY; the model defaults to a low-latency flash
model because voice turns are latency-bound.

Every function returns None on any failure (missing key, HTTP error, timeout,
safety block) so the provider can fall back and a call is never dropped.
"""

import asyncio
import base64
import logging
from collections.abc import Callable

from app import http
from app.env import env
from app.jscompat import js_json, js_trim
from app.llm.call import LlmCall, dig, parts_text
from app.llm.json_stream import answer_extractor
from app.streams import iter_lines, json_loads

log = logging.getLogger("callmind.gemini")

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"
TIMEOUT_S = 8.0


def has_gemini() -> bool:
    return bool(env("GEMINI_API_KEY"))


def gemini_model() -> str:
    # A flash-lite model gives the lowest time-to-first-word for voice. Override with GEMINI_MODEL.
    return env("GEMINI_MODEL", "gemini-flash-lite-latest")


def _note_usage(meta: LlmCall | None, data: object) -> None:
    usage = dig(data, "usageMetadata")
    if meta is None or not isinstance(usage, dict):
        return
    # Thinking tokens are billed as output.
    meta.tokens_in = usage.get("promptTokenCount")
    meta.tokens_out = (usage.get("candidatesTokenCount") or 0) + (usage.get("thoughtsTokenCount") or 0)


def _body(system: str, user: str, generation_config: dict) -> str:
    return js_json(
        {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": generation_config,
        }
    )


async def _call(system: str, user: str, generation_config: dict, meta: LlmCall | None = None) -> str | None:
    key = env("GEMINI_API_KEY")
    if not key:
        return None
    model = (meta.model if meta else None) or gemini_model()
    try:
        async with asyncio.timeout(TIMEOUT_S):
            res = await http.client().post(
                f"{ENDPOINT}/{model}:generateContent",
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                content=_body(system, user, generation_config).encode(),
            )
            if not res.is_success:
                log.warning("[gemini] %s %s: %s", res.status_code, res.reason_phrase, res.text[:300])
                return None
            data = res.json()
        _note_usage(meta, data)
        block = dig(data, "promptFeedback", "blockReason")
        if block:
            log.warning("[gemini] blocked: %s", block)
            return None
        return js_trim(parts_text(data)) or None
    except Exception as err:  # noqa: BLE001 - any failure means "no answer"
        log.warning("[gemini] request failed: %s", err or type(err).__name__)
        return None


# Gemini's OpenAPI-subset schema (upper-case types, no additionalProperties). propertyOrdering keeps the JSON stable.
ANSWER_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "answer": {"type": "STRING"},
        "answered": {"type": "BOOLEAN"},
        "usedExcerpts": {"type": "ARRAY", "items": {"type": "INTEGER"}},
    },
    "required": ["answer", "answered", "usedExcerpts"],
    "propertyOrdering": ["answer", "answered", "usedExcerpts"],
}

ANSWER_CONFIG = {
    "responseMimeType": "application/json",
    "responseSchema": ANSWER_SCHEMA,
    "temperature": 0.2,
    "maxOutputTokens": 500,
}


async def gemini_json(system: str, user: str, meta: LlmCall | None = None) -> str | None:
    """Structured answer — the raw JSON string, or None."""
    return await _call(system, user, ANSWER_CONFIG, meta)


async def gemini_json_stream(
    system: str, user: str, on_answer: Callable[[str], None] | None = None, meta: LlmCall | None = None
) -> str | None:
    """
    Streaming twin of `gemini_json` (`streamGenerateContent`, server-sent events): the `answer`
    text goes to `on_answer` piece by piece. Resolves to the complete JSON string, or None on
    failure — check what was already streamed before falling back, since it may have been spoken.
    """
    key = env("GEMINI_API_KEY")
    if not key:
        return None
    model = (meta.model if meta else None) or gemini_model()
    extract = answer_extractor(on_answer) if on_answer else None
    raw = ""
    try:
        async with asyncio.timeout(TIMEOUT_S):
            async with http.client().stream(
                "POST",
                f"{ENDPOINT}/{model}:streamGenerateContent?alt=sse",
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                content=_body(system, user, ANSWER_CONFIG).encode(),
            ) as res:
                if not res.is_success:
                    body = (await res.aread()).decode("utf-8", "replace")
                    log.warning("[gemini] stream %s %s: %s", res.status_code, res.reason_phrase, body[:300])
                    return None
                # One `data: {...}` line per event; each carries the next piece, the last also the token counts.
                async for line in iter_lines(res):
                    if not line.startswith("data:"):
                        continue
                    try:
                        data = json_loads(line[5:])
                    except ValueError:
                        continue
                    block = dig(data, "promptFeedback", "blockReason")
                    if block:
                        log.warning("[gemini] blocked: %s", block)
                        return None
                    _note_usage(meta, data)
                    piece = parts_text(data)
                    if piece:
                        raw += piece
                        if extract:
                            extract(raw)
    except Exception as err:  # noqa: BLE001
        log.warning("[gemini] stream failed: %s", err or type(err).__name__)
        return None
    return js_trim(raw) or None


async def gemini_text(system: str, user: str, max_output_tokens: int = 300, meta: LlmCall | None = None) -> str | None:
    """Plain text, for the operator hand-off summary."""
    return await _call(system, user, {"temperature": 0.3, "maxOutputTokens": max_output_tokens}, meta)


# ── speech-to-text ──────────────────────────────────────────────────

STT_TIMEOUT_S = 8.0
NO_SPEECH = "<empty>"


async def gemini_transcribe(wav: bytes, language_name: str) -> str | None:
    """
    One utterance (16 kHz mono WAV): the verbatim transcript, '' for no speech, None on failure.
    A model asked to "say nothing" on silence says something anyway, so it gets a marker to answer with.
    """
    key = env("GEMINI_API_KEY")
    if not key:
        return None
    model = env("GEMINI_STT_MODEL", "gemini-flash-lite-latest")
    instruction = (
        "You are the speech-to-text engine of a phone line. Transcribe the caller's words "
        f"verbatim in the language they actually speak (expected: {language_name}), in that "
        "language's normal script. Write numbers as digits. Never translate, answer, "
        f"summarise or add anything. If there is no intelligible speech, output exactly: {NO_SPEECH}"
    )
    body = {
        "systemInstruction": {"parts": [{"text": instruction}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(wav).decode()}}],
            }
        ],
        "generationConfig": {"temperature": 0, "maxOutputTokens": 400},
    }
    try:
        async with asyncio.timeout(STT_TIMEOUT_S):
            res = await http.client().post(
                f"{ENDPOINT}/{model}:generateContent",
                headers={"Content-Type": "application/json", "x-goog-api-key": key},
                content=js_json(body).encode(),
            )
            if not res.is_success:
                log.warning("[gemini] stt %s: %s", res.status_code, res.text[:200])
                return None
            data = res.json()
        text = js_trim(parts_text(data))
        return "" if NO_SPEECH in text else text
    except Exception as err:  # noqa: BLE001
        log.warning("[gemini] stt failed: %s", err or type(err).__name__)
        return None
