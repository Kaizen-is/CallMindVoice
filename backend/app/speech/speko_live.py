"""
Live (streaming) speech-to-text through Speko: the words appear while the caller speaks.

The browser posts its microphone to /speech/live in quarter-second pieces of 16 kHz PCM (the same
protocol as the in-app Zipformer model); for a Speko engine each call keeps one WebSocket open to
wss://router.speko.dev/v1/stt/stream and forwards the audio as it comes. Speko answers with
`transcript.delta` (interim words, replaced by the next) and `transcript.final` (finished spans);
every answer to the browser is the whole utterance heard so far.

  gemini_live   gemini-3.5-transcribe-live (Google): a phrase at a time, as soon as the caller pauses
  scribe_live   scribe_v3_live (ElevenLabs): word by word while they speak

Speko bills the audio streamed, so a socket closes after IDLE_CLOSE_S without audio.
"""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field

import httpx
import regex as re
import websockets

from app.env import env
from app.jscompat import js_trim
from app.speech.speko import speko_configured
from app.speech.uz_script import uz_display
from app.usage_log import UsageEntry, record_usage

log = logging.getLogger("callmind.speko.live")

LIVE_ROUTES = {
    "gemini_live": {"provider": "gemini", "model": "gemini-3.5-transcribe-live", "engine": "speko_live"},
    "scribe_live": {"provider": "elevenlabs", "model": "scribe_v3_live", "engine": "scribe_live"},
}
SAMPLE_RATE = 16000
CONNECT_TIMEOUT_S = 15.0
FINAL_WAIT_S = 1.4  # after input.commit, how long finish() waits for the last final
RESET_DROP_S = 1.5  # after a reset, transcripts of the audio before it are dropped until its commit answers
IDLE_CLOSE_S = 60.0


def live_engine(name: object) -> bool:
    return isinstance(name, str) and name in LIVE_ROUTES


def _stream_url() -> str:
    base = env("SPEKO_BASE_URL", "https://router.speko.dev/v1")
    base = re.sub(r"/+$", "", base)
    return re.sub(r"^http", "ws", base) + "/stt/stream"


class LiveSttError(Exception):
    pass


@dataclass
class _Utterance:
    finals: list[str] = field(default_factory=list)
    interim: str = ""

    def text(self) -> str:
        return js_trim(" ".join(p for p in (*self.finals, self.interim) if p and p.strip()))


class SpekoLiveStream:
    """One call's streaming session (opened on first use, reopened if Speko ends it)."""

    def __init__(self, engine: str, language: str, tenant_id: str | None) -> None:
        self.route = LIVE_ROUTES[engine]
        self.language = language
        self.tenant_id = tenant_id
        self.ws: websockets.ClientConnection | None = None
        self.reader: asyncio.Task | None = None
        self.opening: asyncio.Task | None = None
        self.utterance = _Utterance()
        self.held = ""  # the live text last shown (it only grows; see _steady)
        self.final_event = asyncio.Event()
        self.drop_until = 0.0  # loop time: transcripts before this belong to audio before a reset
        self.drop_commit: str | None = None
        self.commit_ids = False
        self.last_used = time.monotonic()
        self.opened_at = 0.0

    # ── socket ──────────────────────────────────────────────────────

    async def _open(self) -> None:
        key = js_trim(env("SPEKO_API_KEY"))
        if not key:
            raise LiveSttError("speko_not_configured")
        url = _stream_url()
        ws = await websockets.connect(
            url,
            additional_headers={"Authorization": f"Bearer {key}", "Idempotency-Key": str(uuid.uuid4())},
            # The same trust store as the HTTP client (SSL_CERT_FILE); plain ws:// only in tests.
            ssl=httpx.create_ssl_context() if url.startswith("wss:") else None,
            max_size=None,
            open_timeout=CONNECT_TIMEOUT_S,
        )
        try:
            await ws.send(
                json.dumps(
                    {
                        "type": "session.configure",
                        "routing": {
                            "mode": "explicit",
                            "provider": self.route["provider"],
                            "model": self.route["model"],
                        },
                        "audio": {"encoding": "pcm_s16le", "sample_rate_hz": SAMPLE_RATE, "channels": 1},
                        "language": self.language,
                    }
                )
            )
            first = json.loads(await asyncio.wait_for(ws.recv(), CONNECT_TIMEOUT_S))
            if first.get("type") != "session.ready":
                message = (first.get("error") or {}).get("message") or first.get("type")
                raise LiveSttError(f"speko: {message}")
        except BaseException:
            await ws.close()
            raise
        self.commit_ids = bool(first.get("commit_ids"))
        self.ws = ws
        self.opened_at = time.monotonic()
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
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                event = json.loads(raw)
                kind = event.get("type")
                if kind in ("transcript.delta", "transcript.final"):
                    text = event.get("text") or ""
                    if self.drop_until:
                        answered = self.drop_commit and event.get("commit_id") == self.drop_commit
                        if kind == "transcript.final" and answered:
                            self.drop_until, self.drop_commit = 0.0, None
                            continue
                        if loop.time() < self.drop_until:
                            continue  # the audio before the reset
                        self.drop_until, self.drop_commit = 0.0, None
                    if kind == "transcript.delta":
                        self.utterance.interim = text
                    else:
                        if text.strip():
                            self.utterance.finals.append(text.strip())
                        self.utterance.interim = ""
                        self.final_event.set()
                elif kind == "session.closed":
                    self._log_usage(event.get("usage") or {}, None)
                    return
                elif kind == "error":
                    message = (event.get("error") or {}).get("message", "error")
                    log.warning("[speko-live] %s: %s", self.route["model"], message)
                    self._log_usage({}, message)
                    return
        except websockets.ConnectionClosed:
            pass
        except Exception as err:  # noqa: BLE001 - a broken socket is reopened on the next piece
            log.warning("[speko-live] reader stopped: %s", err)
        finally:
            if self.ws is ws:
                self.ws = None
            self.final_event.set()

    def _log_usage(self, usage: dict, error: str | None) -> None:
        duration = usage.get("duration_ms")
        record_usage(
            UsageEntry(
                kind="stt",
                engine=self.route["engine"],
                model=self.route["model"],
                ms=(time.monotonic() - self.opened_at) * 1000 if self.opened_at else 0,
                audio_ms=float(duration) if isinstance(duration, int | float) else None,
                ok=error is None,
                error=error,
                tenant_id=self.tenant_id,
            )
        )

    async def _send(self, payload: bytes | str) -> None:
        await self.ensure_open()
        if self.ws is None:
            raise LiveSttError("speko_live_closed")
        try:
            await self.ws.send(payload)
        except websockets.ConnectionClosed:
            self.ws = None
            await self.ensure_open()  # Speko ended the session (limit, idle): one fresh try
            await self.ws.send(payload)  # type: ignore[union-attr]

    # ── the browser's operations ────────────────────────────────────

    def _shown(self, text: str) -> str:
        """Uzbek in one spelling (Latin, plain apostrophes): the live words only grow, never flip."""
        return uz_display(text) if self.language.startswith("uz") else text

    def _steady(self, text: str) -> str:
        """
        The live words never move backwards: an interim guess that is just a cut-off of what was
        already shown (Scribe re-guesses "...juda muv" after "...juda muvaffaqiyatli qadami bo'ldi.")
        keeps the longer text; a real change of words replaces it. The final always wins (finish).
        """
        held = self.held
        if held and len(text) < len(held) and held.startswith(text.rstrip(".…- ")):
            return held
        self.held = text
        return text

    async def feed(self, pcm: bytes) -> str:
        self.last_used = time.monotonic()
        if pcm:
            await self._send(pcm)
        else:
            await self.ensure_open()
        return self._steady(self._shown(self.utterance.text()))

    async def finish(self, pcm: bytes) -> str:
        """The phrase ended: the last piece, a commit, and the utterance once its final arrives."""
        self.last_used = time.monotonic()
        if pcm:
            await self._send(pcm)
        self.final_event.clear()
        await self._send(json.dumps({"type": "input.commit"}))
        if self.utterance.interim or not self.utterance.finals:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.final_event.wait(), FINAL_WAIT_S)
        heard = self._shown(self.utterance.text())
        self.utterance = _Utterance()
        self.held = ""
        return heard

    async def reset(self) -> None:
        """Forget what was heard (the agent's turn, a new phrase); the socket stays open."""
        self.last_used = time.monotonic()
        self.utterance = _Utterance()
        self.held = ""
        if self.ws is None:
            # Open ahead of the first words: the handshake takes a second or two.
            await self.ensure_open()
            return
        # Transcripts still on their way belong to the audio before now: drop them until the
        # commit that flushes it is answered (or for a moment, when Speko does not echo commit ids).
        commit = f"reset-{uuid.uuid4().hex[:12]}"
        self.drop_commit = commit if self.commit_ids else None
        self.drop_until = asyncio.get_running_loop().time() + RESET_DROP_S
        await self._send(json.dumps({"type": "input.commit", "commit_id": commit}))

    async def close(self) -> None:
        ws, self.ws = self.ws, None
        if ws is None:
            return
        try:
            await ws.send(json.dumps({"type": "session.close"}))
            if self.reader is not None:
                await asyncio.wait_for(asyncio.shield(self.reader), 3)
        except Exception:  # noqa: BLE001
            pass
        finally:
            await ws.close()


# ── the open streams, one per (user, browser session, engine) ───────

_streams: dict[tuple[str, str, str], SpekoLiveStream] = {}
_lock = asyncio.Lock()


async def _close_idle() -> None:
    now = time.monotonic()
    for key, stream in list(_streams.items()):
        if now - stream.last_used > IDLE_CLOSE_S:
            _streams.pop(key, None)
            await stream.close()


async def stream_for(owner: str, sid: str, engine: str, tenant_id: str | None, language: str = "uz") -> SpekoLiveStream:
    if not speko_configured():
        raise LiveSttError("speko_not_configured")
    async with _lock:
        await _close_idle()
        key = (owner, sid, engine)
        stream = _streams.get(key)
        if stream is None:
            stream = SpekoLiveStream(engine, language, tenant_id)
            _streams[key] = stream
        return stream


async def close_stream(owner: str, sid: str) -> None:
    for key in [k for k in _streams if k[0] == owner and k[1] == sid]:
        stream = _streams.pop(key, None)
        if stream is not None:
            await stream.close()
