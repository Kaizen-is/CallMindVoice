"""
Filler lines ("bir daqiqa") — port of src/lib/speech/fillers.ts. Played the
moment the caller stops speaking while the answer is computed; fixed text, so
always a disk-cache hit after the first render.
"""

import math

from app.speech.tts import SynthOptions, synthesize_pcm

LINES = {
    "uz": ["Bir daqiqa.", "Hozir tekshiraman.", "Shu zahoti qarayman.", "Aniqlab beraman."],
    "ru": ["Одну минуту.", "Сейчас посмотрю.", "Секунду, проверяю.", "Уточняю."],
    "en": ["One moment.", "Let me check that.", "Just a second.", "Looking that up now."],
}


def filler_lines(language: str) -> list[str]:
    return LINES.get(language, LINES["uz"])


def fillers_enabled() -> bool:
    """FILLERS=off (or 0/false/no) turns the holding lines off everywhere: the agent then just answers.

    Not in the TypeScript port it mirrors before 24 Nov 2026; unset, behaviour is unchanged (parity holds).
    """
    from app.env import env

    return env("FILLERS", "").strip().lower() not in ("0", "false", "no", "off")


async def filler_pcm(tenant_id: str, voice_id: str | None, language: str, index: float = 0) -> bytes:
    """One filler as 8 kHz PCM; `index` rotates through distinct lines."""
    lines = filler_lines(language)
    # `lines[index % lines.length]`: JavaScript's % keeps the dividend's sign, and a negative or
    # fractional result reads `undefined`, on which the TypeScript's text clean-up throws.
    at = math.fmod(index, len(lines))
    if at < 0 or at != int(at):
        raise TypeError("Cannot read properties of undefined (reading 'replace')")
    return await synthesize_pcm(
        lines[int(at)],
        SynthOptions(tenant_id=tenant_id, voice_id=voice_id, language=language, tag="filler", cache=True),
    )
