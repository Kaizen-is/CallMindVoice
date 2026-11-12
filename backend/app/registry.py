# ruff: noqa: E501 - one engine per line, as in the TypeScript source
"""
The engine registry — port of src/lib/speech/registry.ts: every STT, TTS and
LLM engine CallMind can use, with what each one is and what it costs. Pure
data; nothing here calls an engine or reads a key.

`price_per_min` is USD per minute of audio (heard for STT, spoken for TTS);
None means "runs on our own server" or "not known yet". LLM prices are USD per
million tokens. Sources and dates are in the TypeScript file's header.
"""

from dataclasses import dataclass
from typing import Literal

EngineKind = Literal["stt", "tts", "llm"]
LlmProvider = Literal["openai", "anthropic", "gemini", "ollama"]


@dataclass(frozen=True)
class EngineInfo:
    kind: EngineKind
    id: str
    name: str
    vendor: str
    runs: Literal["app", "server", "cloud"]
    live: bool
    languages: tuple[str, ...]
    price_per_min: float | None
    setup: str
    via: str | None = None


ENGINES: tuple[EngineInfo, ...] = (
    # speech to text
    EngineInfo("stt", "kotib", "Own STT", "CallMind", "server", False, ("uz",), None, "STT_TRANSCRIBE_URL"),
    EngineInfo("stt", "gapi", "GAPI", "GAPI (gapi.uz)", "cloud", False, ("uz",), 0.0029, "GAPIAPI"),
    EngineInfo(
        "stt", "local", "Zipformer", "Open model (sherpa-onnx)", "app", True, ("uz",), 0, "models/uzbek-zipformer"
    ),
    EngineInfo(
        "stt", "speko", "gemini-3.5", "Google", "cloud", False, ("uz", "ru", "en"), 0.005, "SPEKO_API_KEY", via="Speko"
    ),
    EngineInfo(
        "stt",
        "scribe",
        "ElevenLabs Scribe",
        "ElevenLabs",
        "cloud",
        False,
        ("uz", "ru", "en"),
        0.0065,
        "SPEKO_API_KEY",
        via="Speko",
    ),
    EngineInfo(
        "stt", "gemini", "Gemini Flash-Lite", "Google", "cloud", False, ("uz", "ru", "en"), 0.0009, "GEMINI_API_KEY"
    ),
    # text to speech
    EngineInfo("tts", "default", "Own TTS", "CallMind", "server", True, ("uz",), None, "TTS_BASE_URL"),
    # Our own model behind the BRB speech proxy (VPN): no per-minute price, but a request limit.
    EngineInfo("tts", "brb", "BRB TTS", "BRB (own model)", "server", False, ("uz",), None, "BRB_SPEECH_LOGIN"),
    EngineInfo(
        "tts",
        "eleven_v3_conversational",
        "ElevenLabs v3",
        "ElevenLabs",
        "cloud",
        True,
        ("uz", "ru", "en"),
        0.045,
        "SPEKO_API_KEY",
        via="Speko",
    ),
    EngineInfo(
        "tts",
        "eleven_v4_turbo",
        "ElevenLabs v4 Turbo",
        "ElevenLabs",
        "cloud",
        True,
        ("uz", "ru", "en"),
        0.036,
        "SPEKO_API_KEY",
        via="Speko",
    ),
)


@dataclass(frozen=True)
class LlmModelInfo:
    """A model an agent can answer with. `id` is `provider:model`."""

    id: str
    provider: LlmProvider
    model: str
    name: str
    vendor: str
    runs: Literal["server", "cloud"]
    streams: bool
    price_in: float | None
    price_out: float | None
    setup: str


_VENDOR = {"openai": "OpenAI", "anthropic": "Anthropic", "gemini": "Google", "ollama": "Self-hosted"}
_SETUP = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "ollama": "OLLAMA_BASE_URL",
}


def _llm(provider: LlmProvider, model: str, name: str, price_in: float | None, price_out: float | None) -> LlmModelInfo:
    return LlmModelInfo(
        id=f"{provider}:{model}",
        provider=provider,
        model=model,
        name=name,
        vendor=_VENDOR[provider],
        runs="server" if provider == "ollama" else "cloud",
        streams=True,  # every hosted provider streams to a caller that voices the answer as it comes
        price_in=price_in,
        price_out=price_out,
        setup=_SETUP[provider],
    )


LLM_MODELS: tuple[LlmModelInfo, ...] = (
    _llm("openai", "gpt-5.5", "GPT-5.5", 5, 30),
    _llm("openai", "gpt-6.1-sol", "GPT-6.1 Sol", 2, 10),
    _llm("openai", "gpt-6.1-terra", "GPT-6.1 Terra", 1, 5),
    _llm("openai", "gpt-6-luna", "GPT-6 Luna", 0.1, 0.5),
    _llm("openai", "gpt-5.4-mini", "GPT-5.4 mini", 0.75, 4.5),
    _llm("openai", "gpt-4.1-mini", "GPT-4.1 mini", 0.4, 1.6),
    _llm("anthropic", "claude-opus-5-5", "Claude Opus 5.5", 4, 20),
    _llm("anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10),
    _llm("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", 0.1, 0.5),
    # Gemini 3.8 Flash doubles to $1.50 / $7.50 on 2027-01-01.
    _llm("gemini", "gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75),
    _llm("gemini", "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 0.3, 2.5),
    _llm("gemini", "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", 0.25, 1.5),
    _llm("ollama", "gemma4:31b", "Gemma 4 31B", None, None),
)


def llm_model_info(model_id: str | None) -> LlmModelInfo | None:
    return next((m for m in LLM_MODELS if m.id == model_id), None) if model_id else None


def llm_cost(model_id: str | None, tokens_in: float | None, tokens_out: float | None) -> float | None:
    """USD for one answer, or None when the model's price or the token counts are not known."""
    m = llm_model_info(model_id)
    if not m or m.price_in is None or m.price_out is None or tokens_in is None or tokens_out is None:
        return None
    return (m.price_in * tokens_in + m.price_out * tokens_out) / 1e6


def engine_info(kind: str, engine_id: str) -> EngineInfo | None:
    return next((e for e in ENGINES if e.kind == kind and e.id == engine_id), None)


def engine_display_name(kind: str, engine_id: str) -> str:
    info = engine_info(kind, engine_id)
    return info.name if info else engine_id


def audio_cost(kind: str, engine_id: str, audio_ms: float | None) -> float | None:
    """USD for `audio_ms` of audio on this engine, or None when its price is not known."""
    info = engine_info(kind, engine_id)
    if info is None or info.price_per_min is None or audio_ms is None:
        return None
    return (info.price_per_min * audio_ms) / 60000
