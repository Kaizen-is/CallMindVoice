"""
OpenAI — port of src/lib/llm/openai.ts, over the Chat Completions REST API.
Activated by OPENAI_API_KEY; OPENAI_MODEL picks the model (default
gpt-4.1-mini: no reasoning pass, so the first words come fast) and
OPENAI_BASE_URL an OpenAI-compatible endpoint. Answers always stream.

Every function returns None on any failure so the provider can fall back.
"""

import asyncio
import logging
import math
from collections.abc import Callable

import regex as re

from app import http
from app.env import env, env_raw
from app.jscompat import js_json, js_trim
from app.llm.call import LlmCall, dig
from app.llm.json_stream import answer_extractor
from app.streams import error_body, iter_lines, json_loads

log = logging.getLogger("callmind.openai")


def has_openai() -> bool:
    return bool(env("OPENAI_API_KEY"))


def openai_model() -> str:
    return env("OPENAI_MODEL", "gpt-4.1-mini")


def _base_url() -> str:
    return re.sub(r"/+$", "", env("OPENAI_BASE_URL", "https://api.openai.com/v1"))


def _timeout_s() -> float:
    try:
        n = float(env("OPENAI_TIMEOUT_MS") or "nan")
    except ValueError:
        n = math.nan
    return n / 1000 if math.isfinite(n) and n > 0 else 20.0


def sampling_for(model: str) -> dict:
    """Reasoning models take no temperature and think unless told not to; the lowest setting's name varies."""
    if re.search(r"chat-latest", model):
        return {}
    # The larger GPT-6 tiers (Sol, Astra) start at "low"; "none" is a 400 there.
    if re.search(r"^gpt-\d+(\.\d+)?-(sol|astra)\b", model, flags=re.ASCII):
        return {"reasoning_effort": "low"}
    if re.search(r"^gpt-5(-|$)", model):
        return {"reasoning_effort": "minimal"}
    if re.search(r"^gpt-(5\.\d|[6-9])", model):
        return {"reasoning_effort": "none"}
    if re.search(r"^o\d", model):
        return {"reasoning_effort": "low"}
    return {"temperature": 0.2}


# Strict structured output: the reply always parses, and `answer` comes first.
ANSWER_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "answer",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "description": "What you say out loud."},
                "answered": {"type": "boolean"},
                "usedExcerpts": {"type": "array", "items": {"type": "integer"}},
            },
            "required": ["answer", "answered", "usedExcerpts"],
            "additionalProperties": False,
        },
    },
}


def _headers() -> dict[str, str]:
    return {"Content-Type": "application/json", "Authorization": f"Bearer {env_raw('OPENAI_API_KEY')}"}


def json_object(raw: str) -> str | None:
    """The text from the first '{' to the last '}', or None."""
    start = raw.find("{")
    end = raw.rfind("}")
    return raw[start : end + 1] if start >= 0 and end > start else None


async def openai_json_stream(
    system: str, user: str, on_answer: Callable[[str], None] | None = None, call: LlmCall | None = None
) -> str | None:
    """The structured answer, streamed; the complete JSON string, or None on failure."""
    if not has_openai():
        return None
    model = (call.model if call else None) or openai_model()
    extract = answer_extractor(on_answer) if on_answer else None
    raw = ""
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": True,
        # Token counts arrive in one last chunk. Only asked of OpenAI itself.
        **({} if env("OPENAI_BASE_URL") else {"stream_options": {"include_usage": True}}),
        "max_completion_tokens": 500,
        "response_format": ANSWER_FORMAT,
        **sampling_for(model),
    }
    try:
        async with asyncio.timeout(_timeout_s()):
            async with http.client().stream(
                "POST", f"{_base_url()}/chat/completions", headers=_headers(), content=js_json(body).encode()
            ) as res:
                if not res.is_success:
                    log.warning("[openai] %s: %s", res.status_code, await error_body(res, 300))
                    return None
                # Server-sent events: `data: {chunk}` lines, ending with `data: [DONE]`.
                async for line in iter_lines(res):
                    if not line.startswith("data:"):
                        continue
                    data = js_trim(line[5:])
                    if data == "[DONE]":
                        continue
                    chunk = json_loads(data)  # a bad chunk ends the stream, as in TypeScript
                    usage = dig(chunk, "usage")
                    if isinstance(usage, dict) and call is not None:
                        call.tokens_in = usage.get("prompt_tokens")
                        call.tokens_out = usage.get("completion_tokens")
                    piece = dig(chunk, "choices", 0, "delta", "content") or ""
                    if piece:
                        raw += piece
                        if extract:
                            extract(raw)
    except Exception as err:  # noqa: BLE001
        log.warning("[openai] stream failed: %s", err or type(err).__name__)
        return None
    found = json_object(raw)
    if found is None:
        log.warning("[openai] no JSON in reply: %s", raw[:200])
    return found


async def openai_text(system: str, user: str, max_output_tokens: int = 300, call: LlmCall | None = None) -> str | None:
    """Plain text, for the operator hand-off summary."""
    if not has_openai():
        return None
    model = (call.model if call else None) or openai_model()
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_completion_tokens": max_output_tokens,
        **sampling_for(model),
    }
    try:
        async with asyncio.timeout(_timeout_s()):
            res = await http.client().post(
                f"{_base_url()}/chat/completions", headers=_headers(), content=js_json(body).encode()
            )
            if not res.is_success:
                log.warning("[openai] %s: %s", res.status_code, res.text[:300])
                return None
            data = res.json()
        usage = dig(data, "usage")
        if call is not None and isinstance(usage, dict):
            call.tokens_in = usage.get("prompt_tokens")
            call.tokens_out = usage.get("completion_tokens")
        content = dig(data, "choices", 0, "message", "content")
        return (js_trim(content) if isinstance(content, str) else "") or None
    except Exception as err:  # noqa: BLE001
        log.warning("[openai] request failed: %s", err or type(err).__name__)
        return None
