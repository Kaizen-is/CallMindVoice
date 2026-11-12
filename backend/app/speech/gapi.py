"""
GAPI speech-to-text (console.gapi.uz) — port of src/lib/speech/gapi.ts. One
short utterance per request through `/v1/transcribe`, with everything a live
turn does not need switched off (speaker enrolment, PII, diarization, …).
Numbers come back as words (`itn: false`); the app's converter reads them.
"""

import asyncio
import logging

import regex as re

from app import http
from app.env import env
from app.jscompat import JS_S, js_json, js_trim
from app.speech.denoise import denoise

log = logging.getLogger("callmind.gapi")

TIMEOUT_S = 12.0

SETTINGS = {
    "diarization": False,
    "itn": False,
    "formatting": True,
    "pii": False,
    "gender": False,
    "call_outcome": False,
    "speaker_identification": False,
    "enroll": "off",
    "language_detection": True,
}


def _key() -> str:
    return js_trim(env("GAPI_API_KEY") or env("GAPIAPI"))


def gapi_configured() -> bool:
    return bool(_key())


_SPACES = re.compile(f"[{JS_S}]+")


async def gapi_transcribe(
    audio: bytes, *, language: str | None = None, vocabulary: list[str] | None = None, clean: bool = False
) -> dict:
    """`{text, engine: 'gapi', language}`; empty text for silence; raises on failure."""
    key = _key()
    if not key:
        raise RuntimeError("gapi_not_configured")
    body = await denoise(audio) if clean else audio
    files: list = [("file", ("speech.wav", body, "audio/wav")), ("settings", (None, js_json(SETTINGS).encode()))]
    if vocabulary:
        files.append(("vocabulary", (None, js_json(vocabulary[:20]).encode())))
    base = re.sub(r"/+$", "", env("GAPI_BASE_URL", "https://console.gapi.uz"))
    async with asyncio.timeout(TIMEOUT_S):
        res = await http.client().post(f"{base}/v1/transcribe", headers={"Authorization": f"Bearer {key}"}, files=files)
        if not res.is_success:
            log.warning("[gapi] %s: %s", res.status_code, res.text[:240])
            raise RuntimeError(f"gapi_{res.status_code}")
        data = res.json()
    if not isinstance(data, dict):
        data = {}
    raw = data.get("text")
    if raw is None:
        segments = data.get("segments")
        raw = (
            " ".join(str(s.get("text") or "") if isinstance(s, dict) else "" for s in segments)
            if isinstance(segments, list)
            else ""
        )
    text = js_trim(_SPACES.sub(" ", str(raw)))
    code = data.get("language", {}).get("code") if isinstance(data.get("language"), dict) else None
    return {"text": text, "engine": "gapi", "language": code if code is not None else language}
