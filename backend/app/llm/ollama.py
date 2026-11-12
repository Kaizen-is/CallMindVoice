"""
Ollama — port of src/lib/llm/ollama.ts: self-hosted models such as Gemma over
Ollama's native REST API. Activated by OLLAMA_BASE_URL (OLLAMA_MODEL,
OLLAMA_API_KEY for Ollama cloud, OLLAMA_KEEP_ALIVE, OLLAMA_TIMEOUT_MS).

Every function returns None on any failure so the provider can fall back.
"""

import asyncio
import logging
import math
from collections.abc import Callable

import regex as re

from app import http
from app.env import env
from app.jscompat import js_json, js_trim
from app.llm.call import LlmCall, dig
from app.llm.json_stream import answer_extractor
from app.llm.openai import json_object
from app.streams import error_body, iter_lines, json_loads

log = logging.getLogger("callmind.ollama")


def has_ollama() -> bool:
    return bool(env("OLLAMA_BASE_URL"))


def ollama_model() -> str:
    return env("OLLAMA_MODEL", "gemma4:31b")


def _base_url() -> str:
    return re.sub(r"/+$", "", env("OLLAMA_BASE_URL"))


def _timeout_s() -> float:
    try:
        n = float(env("OLLAMA_TIMEOUT_MS") or "nan")
    except ValueError:
        n = math.nan
    return n / 1000 if math.isfinite(n) and n > 0 else 15.0


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if env("OLLAMA_API_KEY"):
        headers["Authorization"] = f"Bearer {env('OLLAMA_API_KEY')}"
    return headers


def _note_tokens(meta: LlmCall | None, data: object) -> None:
    if meta is None or not isinstance(data, dict):
        return
    if data.get("prompt_eval_count") is not None:
        meta.tokens_in = data["prompt_eval_count"]
    if data.get("eval_count") is not None:
        meta.tokens_out = data["eval_count"]


async def _call(
    system: str, user: str, options: dict, fmt: dict | None = None, meta: LlmCall | None = None
) -> str | None:
    if not has_ollama():
        return None
    body = {
        "model": (meta.model if meta else None) or ollama_model(),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False,
        # Voice turns are latency-bound: no reasoning trace before the answer.
        "think": False,
        # Keep the weights resident between calls — reloading a 31B model costs seconds of silence.
        "keep_alive": env("OLLAMA_KEEP_ALIVE", "30m"),
        "options": options,
        **({"format": fmt} if fmt else {}),
    }
    try:
        async with asyncio.timeout(_timeout_s()):
            res = await http.client().post(
                f"{_base_url()}/api/chat", headers=_headers(), content=js_json(body).encode()
            )
            if not res.is_success:
                log.warning("[ollama] %s %s: %s", res.status_code, res.reason_phrase, res.text[:300])
                return None
            data = res.json()
        if dig(data, "error"):
            log.warning("[ollama] error: %s", data["error"])
            return None
        _note_tokens(meta, data)
        content = dig(data, "message", "content")
        return (js_trim(content) if isinstance(content, str) else "") or None
    except Exception as err:  # noqa: BLE001
        log.warning("[ollama] request failed: %s", err or type(err).__name__)
        return None


# Ollama constrains decoding to a standard JSON schema passed as `format`.
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "answered": {"type": "boolean"},
        "usedExcerpts": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["answer", "answered", "usedExcerpts"],
}

# Not every host enforces `format` (Ollama cloud does not), so the shape is also in the prompt.
JSON_INSTRUCTION = (
    "\n\nRespond with ONLY a JSON object, no other text: "
    '{"answer": string (what you say out loud), "answered": boolean, "usedExcerpts": number[]}'
)


async def ollama_json(system: str, user: str, meta: LlmCall | None = None) -> str | None:
    raw = await _call(system + JSON_INSTRUCTION, user, {"temperature": 0.2, "num_predict": 500}, ANSWER_SCHEMA, meta)
    if not raw:
        return None
    found = json_object(raw)  # some models still wrap the object in a ```json fence
    if found is None:
        log.warning("[ollama] no JSON in reply: %s", raw[:200])
    return found


async def ollama_json_stream(
    system: str, user: str, on_answer: Callable[[str], None] | None = None, meta: LlmCall | None = None
) -> str | None:
    """Streaming twin of `ollama_json`; the complete JSON string, or None on failure."""
    if not has_ollama():
        return None
    extract = answer_extractor(on_answer) if on_answer else None
    raw = ""
    body = {
        "model": (meta.model if meta else None) or ollama_model(),
        "messages": [{"role": "system", "content": system + JSON_INSTRUCTION}, {"role": "user", "content": user}],
        "stream": True,
        "think": False,
        "keep_alive": env("OLLAMA_KEEP_ALIVE", "30m"),
        "options": {"temperature": 0.2, "num_predict": 500},
        "format": ANSWER_SCHEMA,
    }
    try:
        async with asyncio.timeout(_timeout_s()):
            async with http.client().stream(
                "POST", f"{_base_url()}/api/chat", headers=_headers(), content=js_json(body).encode()
            ) as res:
                if not res.is_success:
                    log.warning("[ollama] %s %s: %s", res.status_code, res.reason_phrase, await error_body(res, 300))
                    return None
                # Newline-delimited JSON, one object per generated piece.
                async for line in iter_lines(res):
                    if not line:
                        continue
                    data = json_loads(line)
                    if dig(data, "error"):
                        log.warning("[ollama] error: %s", data["error"])
                        return None
                    _note_tokens(meta, data)
                    piece = dig(data, "message", "content") or ""
                    if piece:
                        raw += piece
                        if extract:
                            extract(raw)
    except Exception as err:  # noqa: BLE001
        log.warning("[ollama] stream failed: %s", err or type(err).__name__)
        return None
    found = json_object(raw)
    if found is None:
        log.warning("[ollama] no JSON in reply: %s", raw[:200])
    return found


async def ollama_text(system: str, user: str, max_output_tokens: int = 300, meta: LlmCall | None = None) -> str | None:
    return await _call(system, user, {"temperature": 0.3, "num_predict": max_output_tokens}, None, meta)
