"""Per-call options and results shared by the model clients — port of src/lib/llm/call.ts."""

from dataclasses import dataclass


@dataclass
class LlmCall:
    """Which model to use instead of the server default, and the tokens the provider reports back."""

    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None


def dig(value: object, *path: object) -> object:
    """`value?.a?.[0]?.b` — None as soon as a step is missing or has the wrong type."""
    for step in path:
        if isinstance(step, int):
            if not isinstance(value, list) or not -len(value) <= step < len(value):
                return None
            value = value[step]
        else:
            if not isinstance(value, dict):
                return None
            value = value.get(step)
    return value


def parts_text(data: object) -> str:
    """`data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''` (Gemini)."""
    parts = dig(data, "candidates", 0, "content", "parts")
    if not isinstance(parts, list):
        return ""
    return "".join(str(t) if (t := dig(p, "text")) is not None else "" for p in parts)
