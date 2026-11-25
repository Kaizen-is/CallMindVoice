"""
Noise cleaning in front of STT — port of src/lib/speech/denoise.ts (the
internal CleanVoice service, DENOISE_URL). Cleaning is a nicety, never a
dependency: unset, unreachable, slow or erroring, the original audio goes on.

This is NOISE suppression. It does not remove other people's voices; voice
isolation is a separate stage (app/audio/isolation.py).
"""

import asyncio
import logging
from dataclasses import dataclass
from urllib.parse import urlencode, urljoin

from app import http
from app.env import env

log = logging.getLogger("callmind.denoise")

THRESHOLD_DB = 30  # SNR at or above which the service leaves the audio untouched
ATTN_LIMIT_DB = 40  # cap on how far noise is pushed down
TIMEOUT_S = 3.0  # a caller should never wait on a stuck cleaner


@dataclass
class DenoiseOutcome:
    audio: bytes
    status: str  # cleaned | skipped (clean enough, service left it) | unavailable | failed
    snr_db: str = ""
    service_ms: str = ""
    error: str = ""


def denoise_configured() -> bool:
    return bool(env("DENOISE_URL"))


async def denoise_detailed(audio: bytes, threshold_db: float = THRESHOLD_DB) -> DenoiseOutcome:
    """Like `denoise`, and says what actually happened."""
    base = env("DENOISE_URL")
    if not base:
        return DenoiseOutcome(audio, "unavailable")
    query = urlencode({"threshold_db": str(threshold_db), "model": "auto", "attn_limit_db": str(ATTN_LIMIT_DB)})
    url = f"{urljoin(base, '/process')}?{query}"
    try:
        async with asyncio.timeout(TIMEOUT_S):
            res = await http.client().post(url, files=[("file", ("speech.wav", audio, "audio/wav"))])
            if not res.is_success:
                log.warning("[denoise] %s: %s", res.status_code, res.text[:160])
                return DenoiseOutcome(audio, "failed", error=f"denoise_{res.status_code}")
            cleaned = res.content
        if not cleaned:
            return DenoiseOutcome(audio, "failed", error="empty_response")
        snr, ms = res.headers.get("x-snr-db") or "", res.headers.get("x-processing-ms") or ""
        if res.headers.get("x-cleaned") == "true":
            log.info("[denoise] cleaned: snr %s dB, %s ms", snr, ms)
            return DenoiseOutcome(cleaned, "cleaned", snr, ms)
        return DenoiseOutcome(cleaned, "skipped", snr, ms)
    except Exception as err:  # noqa: BLE001
        log.warning("[denoise] unavailable, using original audio: %s", err or type(err).__name__)
        return DenoiseOutcome(audio, "failed", error=str(err) or type(err).__name__)


async def denoise(audio: bytes) -> bytes:
    """The cleaned utterance, or `audio` itself whenever cleaning is not possible."""
    return (await denoise_detailed(audio)).audio
