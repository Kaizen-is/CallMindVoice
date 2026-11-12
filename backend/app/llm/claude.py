"""
Claude through the official Anthropic SDK — the Claude half of
src/lib/llm/provider.ts (client, request shape, streamed structured answer).

Voice turns are latency-bound: thinking off where the model allows it, low
effort, a hard output cap, structured JSON output, streaming.
"""

import logging
from collections.abc import Callable
from typing import Any

import anthropic
import regex as re

from app.env import env
from app.jscompat import js_trim
from app.llm.call import LlmCall
from app.llm.json_stream import answer_extractor

log = logging.getLogger("callmind.claude")

_client: anthropic.AsyncAnthropic | None = None
_client_key: str | None = None


def client() -> anthropic.AsyncAnthropic | None:
    """The shared client, or None when ANTHROPIC_API_KEY is not set."""
    global _client, _client_key
    key = env("ANTHROPIC_API_KEY")
    if not key:
        return None
    if _client is None or _client_key != key:
        _client = anthropic.AsyncAnthropic(api_key=key)
        _client_key = key
    return _client


def default_model() -> str:
    return env("ANTHROPIC_MODEL", "claude-opus-5")


def thinking_for(model: str) -> dict[str, Any]:
    """
    Thinking off for voice turns, in the form each model accepts: Opus 5.5 (and Fable / Mythos)
    cannot turn it off, so low effort is the only lever; Sonnet 5.5 turns it off with
    `between_tools`; the others take `disabled`.
    """
    if re.search(r"^claude-(opus-5-5|fable|mythos)", model):
        return {}
    if re.search(r"^claude-sonnet-5-5", model):
        return {"thinking": {"type": "between_tools"}}
    return {"thinking": {"type": "disabled"}}


ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string", "description": "What the assistant says out loud, in the caller’s language."},
        "answered": {"type": "boolean", "description": "True only if the excerpts fully support the answer."},
        "usedExcerpts": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "Numbers of the excerpts the answer relies on.",
        },
    },
    "required": ["answer", "answered", "usedExcerpts"],
    "additionalProperties": False,
}


def answer_params(model: str, system: str, user: str) -> dict[str, Any]:
    """The request every Claude answer makes. Depth of reasoning is not what makes this answer good — grounding is."""
    return {
        "model": model,
        "max_tokens": 400,
        **thinking_for(model),
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": ANSWER_SCHEMA}},
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }


def _text_of(message: Any) -> str | None:
    """The first text block's text, or None (also on a refusal)."""
    if getattr(message, "stop_reason", None) == "refusal":
        return None
    block = next((b for b in message.content if getattr(b, "type", None) == "text"), None)
    return block.text if block is not None else None


async def answer_once(model: str, system: str, user: str, call: LlmCall) -> tuple[str | None, str]:
    """
    One structured answer in one piece: (the JSON text or None on refusal / no text, the model
    that answered). Raises on an API error.
    """
    claude = client()
    if claude is None:
        raise RuntimeError("anthropic_not_configured")
    message = await claude.messages.create(**answer_params(model, system, user))
    call.tokens_in = message.usage.input_tokens
    call.tokens_out = message.usage.output_tokens
    return _text_of(message), message.model


async def json_stream(
    model: str, system: str, user: str, on_answer: Callable[[str], None], call: LlmCall
) -> str | None:
    """
    Claude's structured answer, streamed: the `answer` text goes to `on_answer` as it is written.
    The complete JSON string, or None on failure or refusal — check what was already streamed
    before falling back.
    """
    claude = client()
    if claude is None:
        return None
    extract = answer_extractor(on_answer)
    raw = ""
    try:
        async with claude.messages.stream(**answer_params(model, system, user)) as stream:
            async for event in stream:
                if event.type == "content_block_delta" and event.delta.type == "text_delta":
                    raw += event.delta.text
                    extract(raw)
            message = await stream.get_final_message()
        call.tokens_in = message.usage.input_tokens
        call.tokens_out = message.usage.output_tokens
        if message.stop_reason == "refusal":
            return None
    except Exception as err:  # noqa: BLE001
        log.warning("[claude] stream failed: %s", err or type(err).__name__)
        return None
    return js_trim(raw) or None


async def text(model: str, system: str, user: str, max_tokens: int) -> str | None:
    """Plain text (the operator hand-off summary). None on refusal or no text; raises on an API error."""
    claude = client()
    if claude is None:
        return None
    message = await claude.messages.create(
        model=model,
        max_tokens=max_tokens,
        **thinking_for(model),
        output_config={"effort": "low"},
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return _text_of(message)
