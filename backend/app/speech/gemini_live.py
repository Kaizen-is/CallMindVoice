"""
Live words from Google's gemini-3.5-transcribe-live (the Gemini Live API), with GEMINI_API_KEY —
used whenever GEMINI_API_KEY is set (see gemini_speech.py); through Speko with GEMINI_SPEECH_VIA=speko.

The same operations as the Speko streams (speko_live.py), so /speech/live and the page do not care
which one answers: the browser's microphone goes up in ~100 ms pieces of 16 kHz PCM and every
answer is the whole utterance heard so far.

  wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent
  → {"setup": {model, inputAudioTranscription: {languageCodes}}}         ← {"setupComplete": {}}
  → {"realtimeInput": {"audio": {data: base64 PCM, mimeType}}}           ← serverContent.interimInputTranscription
  → {"realtimeInput": {"audioStreamEnd": true}}  (the caller paused)     ← serverContent.inputTranscription (final)

Interim words come while the caller speaks (word by word); a final replaces them when the caller
pauses. The page's own end-of-speech detection sends `audioStreamEnd` ("hybrid VAD" in Google's
guide), so the final comes ~0.1–0.25 s after the pause instead of waiting for Google's silence timer.
A session lasts at most 10 minutes; one that ends is reopened on the next piece.

When Google refuses the session (the free plan's limits, an outage) and Speko is set up, the call
goes on through Speko's route to the same model (phrase by phrase, as before 2026-11-20).
"""

import asyncio
import base64
import contextlib
import json
import logging
import time

import httpx
import websockets

from app.env import env
from app.jscompat import js_trim
from app.speech.gemini_speech import GEMINI_LIVE_STT_MODEL
from app.speech.uz_script import uz_display
from app.usage_log import UsageEntry, record_usage

log = logging.getLogger("callmind.gemini.live")

URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
CONNECT_TIMEOUT_S = 15.0
FINAL_WAIT_S = 1.2  # after audioStreamEnd, how long flush/finish wait for the final
STALE_DROP_S = 1.5  # after a reset, transcripts of the audio before it are dropped at most this long
LANGUAGE_CODES = {"uz": "uz-UZ", "ru": "ru-RU", "en": "en-US"}
USAGE_ENGINE = "speko_live"  # the registry id of "gemini-3.5 live" (kept from when it went through Speko)


class GeminiLiveError(Exception):
    def __init__(self, message: str, refused: bool = False) -> None:
        super().__init__(message)
        self.refused = refused  # Google said no (quota, key): another route may take the call


def url() -> str:
    return env("GEMINI_LIVE_URL", URL)


class GeminiLiveStream:
    """One call's live transcription (opened on first use, reopened when Google ends the session)."""

    def __init__(self, language: str, tenant_id: str | None, vocabulary: list[str] | None = None) -> None:
        self.language = language
        self.tenant_id = tenant_id
        # Words the recogniser is biased towards (Q9): call terms, names (app.speech.vocabulary.live_words).
        self.vocabulary = vocabulary or []
        self.ws: websockets.ClientConnection | None = None
        self.reader: asyncio.Task | None = None
        self.opening: asyncio.Task | None = None
        self.finals: list[str] = []
        self.interim = ""
        self.held = ""  # the live text last shown (it only grows; see _steady)
        self.final_event = asyncio.Event()
        self.drop_stale = False  # after a reset: the next final (and interims before it) belong to old audio
        self.drop_until = 0.0
        self.last_used = time.monotonic()
        self.opened_at = 0.0
        self.audio_bytes = 0

    # ── the session ─────────────────────────────────────────────────

    async def _open(self) -> None:
        key = js_trim(env("GEMINI_API_KEY"))
        if not key:
            raise GeminiLiveError("gemini_not_configured", refused=True)
        target = url()
        try:
            ws = await websockets.connect(
                target,
                additional_headers={"x-goog-api-key": key},
                # The same trust store as the HTTP client (SSL_CERT_FILE); plain ws:// only in tests.
                ssl=httpx.create_ssl_context() if target.startswith("wss:") else None,
                max_size=None,
                open_timeout=CONNECT_TIMEOUT_S,
            )
        except websockets.InvalidStatus as err:
            status = err.response.status_code
            raise GeminiLiveError(f"gemini_live_{status}", refused=status in (401, 402, 403, 429)) from err
        code = LANGUAGE_CODES.get(self.language.split("-")[0])
        try:
            await ws.send(
                json.dumps(
                    {
                        "setup": {
                            "model": f"models/{GEMINI_LIVE_STT_MODEL}",
                            "generationConfig": {"responseModalities": ["TEXT"]},
                            "inputAudioTranscription": {
                                "languageCodes": [code] if code else [],
                                **({"customVocabulary": self.vocabulary} if self.vocabulary else {}),
                            },
                        }
                    }
                )
            )
            first = json.loads(await asyncio.wait_for(ws.recv(), CONNECT_TIMEOUT_S))
            if "setupComplete" not in first:
                raise GeminiLiveError(f"gemini_live: {str(first)[:200]}")
        except websockets.ConnectionClosed as err:
            # Google closes the socket with the reason ("Quota exceeded…", "API key not valid…").
            reason = err.rcvd.reason if err.rcvd else ""
            await ws.close()
            refused = any(w in reason.lower() for w in ("quota", "exceeded", "api key", "permission", "billing"))
            raise GeminiLiveError(f"gemini_live_closed: {reason[:200]}", refused=refused) from err
        except BaseException:
            await ws.close()
            raise
        self.ws = ws
        self.opened_at = time.monotonic()
        self.audio_bytes = 0
        self.reader = asyncio.create_task(self._read(ws))

    async def ensure_open(self) -> None:
        if self.ws is not None:
            return
        if self.opening is None or self.opening.done():
            self.opening = asyncio.create_task(self._open())
        try:
            await asyncio.shield(self.opening)
        finally:
            if self.opening is not None and self.opening.done():
                self.opening = None

    async def _read(self, ws: websockets.ClientConnection) -> None:
        loop = asyncio.get_running_loop()
        error: str | None = None
        try:
            async for raw in ws:
                event = json.loads(raw)
                content = event.get("serverContent") or {}
                interim = content.get("interimInputTranscription")
                final = content.get("inputTranscription")
                if self.drop_stale and loop.time() > self.drop_until:
                    self.drop_stale = False
                if isinstance(interim, dict) and not self.drop_stale:
                    self.interim = interim.get("text") or ""
                if isinstance(final, dict):
                    text = js_trim(final.get("text") or "")
                    if self.drop_stale:
                        self.drop_stale = False  # the old audio's last words: not this utterance's
                        continue
                    if text:
                        self.finals.append(text)
                    self.interim = ""
                    self.final_event.set()
        except websockets.ConnectionClosed as err:
            reason = err.rcvd.reason if err.rcvd else ""
            if err.rcvd and err.rcvd.code not in (1000, 1001):
                error = reason or f"closed {err.rcvd.code}"
                log.warning("[gemini-live] session closed: %s", error)
        except Exception as err:  # noqa: BLE001 - a broken session is reopened on the next piece
            error = str(err) or type(err).__name__
            log.warning("[gemini-live] reader stopped: %s", error)
        finally:
            if self.ws is ws:
                self.ws = None
            self._log_usage(error)
            self.final_event.set()

    def _log_usage(self, error: str | None) -> None:
        if not self.opened_at:
            return
        record_usage(
            UsageEntry(
                kind="stt",
                engine=USAGE_ENGINE,
                model=GEMINI_LIVE_STT_MODEL,
                ms=(time.monotonic() - self.opened_at) * 1000,
                audio_ms=self.audio_bytes / 32,  # 16 kHz 16-bit mono: 32 bytes a millisecond
                ok=error is None,
                error=error,
                tenant_id=self.tenant_id,
            )
        )
        self.opened_at = 0.0

    async def _send(self, message: dict) -> None:
        await self.ensure_open()
        payload = json.dumps(message)
        try:
            await self.ws.send(payload)  # type: ignore[union-attr]
        except (websockets.ConnectionClosed, AttributeError):
            self.ws = None
            await self.ensure_open()  # Google ended the session (10-minute limit): one fresh try
            await self.ws.send(payload)  # type: ignore[union-attr]

    async def _audio(self, pcm: bytes) -> None:
        self.audio_bytes += len(pcm)
        data = base64.b64encode(pcm).decode("ascii")
        await self._send({"realtimeInput": {"audio": {"data": data, "mimeType": "audio/pcm;rate=16000"}}})

    # ── what the page sees ──────────────────────────────────────────

    def _text(self) -> str:
        return js_trim(" ".join(p for p in (*self.finals, self.interim) if p and p.strip()))

    def _shown(self, text: str) -> str:
        """Uzbek in one spelling (Latin, plain apostrophes)."""
        return uz_display(text) if self.language.startswith("uz") else text

    def _steady(self, text: str) -> str:
        """The live words never move backwards on a cut-off re-guess; a real change replaces them."""
        held = self.held
        if held and len(text) < len(held) and held.startswith(text.rstrip(".…- ")):
            return held
        self.held = text
        return text

    async def _settle(self) -> None:
        """Ask for the final now (the caller paused) and wait for it while words are still interim."""
        if not self.interim:
            return
        self.final_event.clear()
        await self._send({"realtimeInput": {"audioStreamEnd": True}})
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.final_event.wait(), FINAL_WAIT_S)

    # ── the browser's operations ────────────────────────────────────

    async def feed(self, pcm: bytes) -> str:
        self.last_used = time.monotonic()
        if pcm:
            await self._audio(pcm)
        else:
            await self.ensure_open()
        return self._steady(self._shown(self._text()))

    async def flush(self, pcm: bytes) -> str:
        """The caller paused (maybe not for good): the words so far, final, and the utterance kept."""
        self.last_used = time.monotonic()
        if pcm:
            await self._audio(pcm)
        await self._settle()
        self.held = self._shown(self._text())
        return self.held

    async def finish(self, pcm: bytes) -> str:
        """The phrase ended: its final words; the next utterance starts empty."""
        heard = await self.flush(pcm)
        self.finals, self.interim, self.held = [], "", ""
        return heard

    async def begin(self) -> str:
        """
        The caller started a new phrase: words Google settled before now are not its (speech no turn
        took up). Words still interim are kept: they may be the phrase's first.
        """
        self.last_used = time.monotonic()
        self.finals, self.held = [], ""
        await self.ensure_open()
        return self._steady(self._shown(self._text()))

    async def reset(self) -> None:
        """Forget what was heard (the agent's turn, a new phrase); the session stays open."""
        self.last_used = time.monotonic()
        pending = bool(self.interim)
        self.finals, self.interim, self.held = [], "", ""
        if self.ws is None:
            await self.ensure_open()  # open ahead of the first words: the handshake takes a moment
            return
        if pending:
            # Words still being heard belong to the audio before now: end that stream and drop its final.
            self.drop_stale = True
            self.drop_until = asyncio.get_running_loop().time() + STALE_DROP_S
            await self._send({"realtimeInput": {"audioStreamEnd": True}})

    async def close(self) -> None:
        ws, self.ws = self.ws, None
        if ws is None:
            return
        with contextlib.suppress(Exception):
            await ws.close()
        if self.reader is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(self.reader), 3)
