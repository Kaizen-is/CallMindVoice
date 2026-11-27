"""
Live (streaming) speech-to-text from the cloud: the words appear while the caller speaks.

The browser posts its microphone to /speech/live in ~100 ms pieces of 16 kHz PCM (the same protocol
as the in-app Zipformer model); each call keeps one WebSocket open to the model and forwards the
audio as it comes. Every answer to the browser is the whole utterance heard so far.

  gemini_live   gemini-3.5-transcribe-live, straight from Google (gemini_live.py): word by word.
                Through Speko only as the fallback, when Google refuses (phrase by phrase there:
                Speko does not pass Gemini's interim words on).
  scribe_live   scribe_v3_live (ElevenLabs) through Speko's wss://router.speko.dev/v1/stt/stream:
                `transcript.delta` (interim words) and `transcript.final` (finished spans).

Both bill the audio streamed, so a socket closes after IDLE_CLOSE_S without audio.

Which words are the current phrase's: Speko answers every commit, in order, with a final carrying
its commit id. A reset commits the audio before it, and the answers to that commit and to every
earlier one are dropped. Speech that no phrase took up (the end of a sentence said over the agent's
voice, a cough) is committed on its own after SETTLE_QUIET_S of quiet, and `begin` (the caller
started a new phrase) drops the words settled before it.
"""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

import httpx
import numpy as np
import regex as re
import websockets

from app.env import env
from app.jscompat import js_trim
from app.speech.gemini_live import GeminiLiveError, GeminiLiveStream
from app.speech.gemini_speech import gemini_speech_configured
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
RESET_DROP_S = 1.5  # after a reset, words without a commit id are dropped this long while old answers are owed
SETTLE_QUIET_S = 0.6  # quiet after speech with no commit since: that speech is committed on its own
IDLE_CLOSE_S = 60.0
VOICED_RMS = 150  # a 16-bit piece louder than this (≈ -47 dBFS) may hold words; the page's mic is noise-suppressed


def _voiced(pcm: bytes) -> bool:
    samples = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32)
    return bool(samples.size) and float(np.sqrt(np.mean(samples * samples))) > VOICED_RMS


def live_engine(name: object) -> bool:
    return isinstance(name, str) and name in LIVE_ROUTES


def live_ready(engine: str) -> bool:
    """Whether this server can stream `engine`: Gemini from Google (or Speko as the fallback), Scribe from Speko."""
    if engine == "gemini_live":
        return gemini_speech_configured() or speko_configured()
    return speko_configured()


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
        self.commit_ids = False
        self.last_used = time.monotonic()
        self.opened_at = 0.0
        # Which spoken audio has come back as words. Speko answers each commit, but not always with its
        # own words: Gemini's can arrive with a later commit, and Scribe does not answer a commit that
        # only followed silence. So a commit waits for its answer while speech is still unheard.
        self.voiced = 0  # loud pieces sent so far
        self.heard_up_to = 0  # loud pieces whose words have come back
        self.quiet_s = 0.0  # seconds of quiet audio since the last loud piece
        self.committed_voiced = 0  # loud pieces sent before the last commit
        self.sent_commits = 0  # commits sent on this socket, numbered from 1
        self.commits: dict[str, tuple[int, int]] = {}  # commit id → (its number, loud pieces sent before it)
        self.answered_through = 0  # the highest commit number answered (Speko answers in order)
        self.waiting: str | None = None
        self.answer_event = asyncio.Event()
        # The audio before the current utterance: the answers to commits up to this number are its
        # words; words without a commit id are dropped until those answers are in (or stale_until).
        self.stale_through = 0
        self.stale_until = 0.0

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
        self.commits.clear()
        self.sent_commits = self.answered_through = self.stale_through = 0
        self.stale_until = 0.0
        self.heard_up_to = self.voiced  # what a closed session had not answered will not come back
        self.committed_voiced = self.voiced
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
                    commit = event.get("commit_id") if kind == "transcript.final" else None
                    sent = self.commits.pop(commit, None) if commit else None
                    if sent is not None:
                        self.answered_through = max(self.answered_through, sent[0])
                    if self._stale(sent, loop.time()):
                        if kind == "transcript.final" and self.utterance.interim == text:
                            self.utterance.interim = ""  # the same words, sent ahead of the final
                    elif kind == "transcript.delta":
                        self.utterance.interim = text
                    else:
                        if text.strip():
                            self.utterance.finals.append(text.strip())
                            self.heard_up_to = max(self.heard_up_to, sent[1] if sent else self.voiced)
                        self.utterance.interim = ""
                        self.final_event.set()
                    if commit and commit == self.waiting:
                        self.answer_event.set()
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
            self.answer_event.set()

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

    def _stale(self, sent: tuple[int, int] | None, now: float) -> bool:
        """Whether a transcript is of the audio before the current utterance."""
        if sent is not None:
            return sent[0] <= self.stale_through
        # No commit id (interim words, a session without ids): while the older audio's answers are owed.
        return now < self.stale_until and self.answered_through < self.stale_through

    async def _commit(self, *, waited: bool = False, stale: bool = False) -> None:
        """
        Close off the audio sent so far; Speko answers with its words. `waited`: flush waits for this
        answer. `stale`: the audio so far is not the next utterance's (a reset), nor are its answers.
        """
        await self.ensure_open()
        self.sent_commits += 1
        commit = f"c{self.sent_commits}-{uuid.uuid4().hex[:8]}"
        self.commits[commit] = (self.sent_commits, self.voiced)
        self.committed_voiced = self.voiced
        if waited:
            self.waiting = commit
        if stale:
            self.stale_through = self.sent_commits
            self.stale_until = asyncio.get_running_loop().time() + RESET_DROP_S
        await self._send(json.dumps({"type": "input.commit", "commit_id": commit}))

    async def _send(self, payload: bytes | str) -> None:
        if isinstance(payload, bytes):
            if _voiced(payload):
                self.voiced += 1
                self.quiet_s = 0.0
            else:
                self.quiet_s += len(payload) / (2 * SAMPLE_RATE)
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
            if self.voiced > self.committed_voiced and self.quiet_s >= SETTLE_QUIET_S:
                # Speech ended a while ago and nothing closed it off: its words come back on their own,
                # not joined to the next stretch's (which `begin` may start as a new phrase).
                await self._commit()
        else:
            await self.ensure_open()
        return self._steady(self._shown(self.utterance.text()))

    async def begin(self) -> str:
        """
        The caller started a new phrase: words settled before now are not its (speech no turn took up,
        like the end of a sentence said over the agent's voice). Audio not committed yet is kept: it
        holds the phrase's first words.
        """
        self.last_used = time.monotonic()
        self.utterance.finals = []
        self.held = ""
        self.heard_up_to = max(self.heard_up_to, self.committed_voiced)
        self.stale_through = self.sent_commits
        if self.commit_ids and self.answered_through < self.stale_through:
            self.stale_until = asyncio.get_running_loop().time() + RESET_DROP_S
        await self.ensure_open()
        return self._steady(self._shown(self.utterance.text()))

    async def flush(self, pcm: bytes) -> str:
        """The caller paused (maybe not for good): a commit, the words so far once final; the utterance kept."""
        self.last_used = time.monotonic()
        if pcm:
            await self._send(pcm)
        await self.ensure_open()
        unheard = bool(self.utterance.interim) or self.voiced > self.heard_up_to
        self.final_event.clear()
        self.answer_event.clear()
        if self.commit_ids:
            # Wait for this commit's own answer while spoken audio has not come back as words.
            await self._commit(waited=True)
            if unheard:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.answer_event.wait(), FINAL_WAIT_S)
            self.waiting = None
        else:
            await self._commit()
            if unheard or not self.utterance.finals:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.final_event.wait(), FINAL_WAIT_S)
        self.held = self._shown(self.utterance.text())
        return self.held

    async def finish(self, pcm: bytes) -> str:
        """The phrase ended: the last piece, a commit, and the utterance once its final arrives."""
        heard = await self.flush(pcm)
        self.utterance = _Utterance()
        self.held = ""
        return heard

    async def reset(self) -> None:
        """Forget what was heard (the agent's turn, a new phrase); the socket stays open."""
        self.last_used = time.monotonic()
        self.utterance = _Utterance()
        self.held = ""
        self.heard_up_to = self.voiced  # the audio before now is not this utterance's
        if self.ws is None:
            # Open ahead of the first words: the handshake takes a second or two.
            await self.ensure_open()
            return
        # Words still on their way belong to the audio before now: a commit closes it off, and the
        # answers up to that one are dropped (without commit ids: what arrives in the next moment).
        await self._commit(stale=True)

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


class GoogleFirst:
    """
    gemini_live: Google's own Live API; when Google refuses the session (the free plan's limits, a bad
    key) and Speko is set up, the rest of the call goes through Speko's route to the same model.
    """

    def __init__(self, language: str, tenant_id: str | None, vocabulary: list[str] | None = None) -> None:
        self.language, self.tenant_id = language, tenant_id
        self.google = GeminiLiveStream(language, tenant_id, vocabulary) if gemini_speech_configured() else None
        self.speko = None if self.google else SpekoLiveStream("gemini_live", language, tenant_id)

    @property
    def last_used(self) -> float:
        return (self.speko or self.google).last_used  # type: ignore[union-attr]

    async def _do(self, op: str, *args: bytes) -> object:
        if self.speko is None:
            try:
                return await getattr(self.google, op)(*args)
            except GeminiLiveError as err:
                if not err.refused or not speko_configured():
                    raise LiveSttError(str(err)) from err
                log.warning("[live] Google refused the live session (%s): going on through Speko", err)
                await self.google.close()  # type: ignore[union-attr]
                self.speko = SpekoLiveStream("gemini_live", self.language, self.tenant_id)
        return await getattr(self.speko, op)(*args)

    async def feed(self, pcm: bytes) -> str:
        return await self._do("feed", pcm)  # type: ignore[return-value]

    async def flush(self, pcm: bytes) -> str:
        return await self._do("flush", pcm)  # type: ignore[return-value]

    async def finish(self, pcm: bytes) -> str:
        return await self._do("finish", pcm)  # type: ignore[return-value]

    async def begin(self) -> str:
        return await self._do("begin")  # type: ignore[return-value]

    async def reset(self) -> None:
        await self._do("reset")

    async def close(self) -> None:
        for stream in (self.google, self.speko):
            if stream is not None:
                await stream.close()


# ── the open streams, one per (user, browser session, engine) ───────

_streams: dict[tuple[str, str, str], "SpekoLiveStream | GoogleFirst"] = {}
_lock = asyncio.Lock()


async def _close_idle() -> None:
    now = time.monotonic()
    for key, stream in list(_streams.items()):
        if now - stream.last_used > IDLE_CLOSE_S:
            _streams.pop(key, None)
            await stream.close()


async def stream_for(
    owner: str,
    sid: str,
    engine: str,
    tenant_id: str | None,
    language: str = "uz",
    vocabulary: Callable[[], list[str]] | None = None,
) -> "SpekoLiveStream | GoogleFirst":
    """The browser session's stream; a new Google one is opened with `vocabulary()`'s words (Q9)."""
    if not live_ready(engine):
        raise LiveSttError("live_stt_not_configured")
    async with _lock:
        await _close_idle()
        key = (owner, sid, engine)
        stream = _streams.get(key)
        if stream is None:
            google = engine == "gemini_live"
            stream = (
                GoogleFirst(language, tenant_id, vocabulary() if vocabulary else None)
                if google
                else SpekoLiveStream(engine, language, tenant_id)
            )
            _streams[key] = stream
        return stream


async def close_stream(owner: str, sid: str) -> None:
    for key in [k for k in _streams if k[0] == owner and k[1] == sid]:
        stream = _streams.pop(key, None)
        if stream is not None:
            await stream.close()
