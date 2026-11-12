"""
Noise cleaning in front of STT — port of src/lib/speech/denoise.ts (the
internal CleanVoice service, DENOISE_URL). Cleaning is a nicety, never a
dependency: unset, unreachable, slow or erroring, the original audio goes on.
"""

import asyncio
import logging
from urllib.parse import urlencode, urljoin

from app import http
from app.env import env

log = logging.getLogger("callmind.denoise")

THRESHOLD_DB = 30  # SNR at or above which the service leaves the audio untouched
ATTN_LIMIT_DB = 40  # cap on how far noise is pushed down
TIMEOUT_S = 3.0  # a caller should never wait on a stuck cleaner


def denoise_configured() -> bool:
    return bool(env("DENOISE_URL"))


async def denoise(audio: bytes) -> bytes:
    """The cleaned utterance, or `audio` itself whenever cleaning is not possible."""
    base = env("DENOISE_URL")
    if not base:
        return audio
    query = urlencode({"threshold_db": str(THRESHOLD_DB), "model": "auto", "attn_limit_db": str(ATTN_LIMIT_DB)})
    url = f"{urljoin(base, '/process')}?{query}"
    try:
        async with asyncio.timeout(TIMEOUT_S):
            res = await http.client().post(url, files=[("file", ("speech.wav", audio, "audio/wav"))])
            if not res.is_success:
                log.warning("[denoise] %s: %s", res.status_code, res.text[:160])
                return audio
            cleaned = res.content
        if not cleaned:
            return audio
        if res.headers.get("x-cleaned") == "true":
            log.info(
                "[denoise] cleaned: snr %s dB, %s ms", res.headers.get("x-snr-db"), res.headers.get("x-processing-ms")
            )
        return cleaned
    except Exception as err:  # noqa: BLE001
        log.warning("[denoise] unavailable, using original audio: %s", err or type(err).__name__)
        return audio
