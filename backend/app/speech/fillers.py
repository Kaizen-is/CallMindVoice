"""
Filler lines ("bir daqiqa") — port of src/lib/speech/fillers.ts. Played the
moment the caller stops speaking while the answer is computed; fixed text, so
always a disk-cache hit after the first render.
"""

from app.speech.tts import SynthOptions, synthesize_pcm

LINES = {
    "uz": ["Bir daqiqa.", "Hozir tekshiraman.", "Shu zahoti qarayman.", "Aniqlab beraman."],
    "ru": ["Одну минуту.", "Сейчас посмотрю.", "Секунду, проверяю.", "Уточняю."],
    "en": ["One moment.", "Let me check that.", "Just a second.", "Looking that up now."],
}


def filler_lines(language: str) -> list[str]:
    return LINES.get(language, LINES["uz"])


async def filler_pcm(tenant_id: str, voice_id: str | None, language: str, index: int = 0) -> bytes:
    """One filler as 8 kHz PCM; `index` rotates through distinct lines."""
    lines = filler_lines(language)
    return await synthesize_pcm(
        lines[index % len(lines)],
        SynthOptions(tenant_id=tenant_id, voice_id=voice_id, language=language, tag="filler", cache=True),
    )
