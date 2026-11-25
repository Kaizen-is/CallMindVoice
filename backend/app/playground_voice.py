"""
The Playground's real-time voice call — port of src/lib/playground-voice.ts.
One streamed response per turn (newline-delimited JSON) carries what the STT
heard, the reply as the model writes it, and the reply's voice sentence by
sentence — with the phrase transcribed during the caller's pause, a cached
"bir daqiqa" while the agent thinks, and the caller free to talk over it.
"""

import asyncio
import base64
import contextlib
import hashlib
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

import regex as re
from fastapi.responses import StreamingResponse

from app import background
from app.audio.pipeline import prepare_live
from app.catalog import VOICES
from app.engine.conversation import agent_target
from app.jscompat import JS_S, js_json, js_trim, js_trim_end, js_trim_start, utf16_len
from app.llm.local import classify_intent
from app.playground import call_voice
from app.rag.text import detect_language
from app.speech.fillers import filler_lines, fillers_enabled
from app.speech.speko import ELEVEN_VOICES, GEMINI_VOICES, speko_voices
from app.speech.stt import Transcript, is_stt_engine, transcribe
from app.speech.tts import (
    SAMPLE_RATE,
    SynthOptions,
    cached_pcm,
    is_tts_engine,
    output_rate,
    speaking_speed,
    synthesize_pcm,
    synthesize_stream,
    tts_configured,
)
from app.voices import list_custom_voices

log = logging.getLogger("callmind.playground")

Send = Callable[[dict], None]


class Signal:
    """AbortSignal: set once when the caller hangs up or talks over the reply."""

    def __init__(self) -> None:
        self.aborted = False
        self._callbacks: list[Callable[[], None]] = []

    def abort(self) -> None:
        if self.aborted:
            return
        self.aborted = True
        for cb in list(self._callbacks):
            cb()

    def on_abort(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._callbacks.append(cb)
        return lambda: self._callbacks.remove(cb) if cb in self._callbacks else None


# ── the wire format: newline-delimited JSON, as the demo's ──────────

NDJSON_HEADERS = {
    "Cache-Control": "no-store, no-transform",
    # nginx would otherwise hold every sentence back until the last rendered.
    "X-Accel-Buffering": "no",
}


def event_stream(work: Callable[[Send, Signal], Awaitable[None]]) -> StreamingResponse:
    """
    Run `work(send, signal)` and stream every event it sends. When the client goes away the signal
    is aborted and sends are dropped, but the work itself carries on (the turn is still written down).
    """
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()
    signal = Signal()

    def send(event: dict) -> None:
        if not signal.aborted:
            queue.put_nowait(f"{js_json(event)}\n".encode())

    async def runner() -> None:
        try:
            await work(send, signal)
        except Exception as err:  # noqa: BLE001
            log.warning("[playground] call request failed: %s", err, exc_info=True)
            send({"t": "error", "code": "server"})
        finally:
            queue.put_nowait(None)

    async def body() -> AsyncIterator[bytes]:
        background.spawn(runner())
        try:
            while (item := await queue.get()) is not None:
                yield item
        finally:
            # Hung up or talked over: stop rendering the agent's voice.
            signal.abort()

    return StreamingResponse(body(), media_type="application/x-ndjson; charset=utf-8", headers=NDJSON_HEADERS)


# ── the engines and voice the Playground picked ─────────────────────


@dataclass(frozen=True)
class VoicePick:
    engine: str
    voice_id: str


def voice_pick(agent: dict[str, Any], engine: object, voice: object) -> VoicePick:
    """The TTS engine and voice asked for, checked against what this deployment and tenant have."""
    tts = engine if is_tts_engine(engine) and tts_configured(engine) else "default"  # type: ignore[arg-type]
    if tts == "default":
        return VoicePick(tts, call_voice(agent, voice))
    if tts == "brb":  # our BRB model has a single voice
        return VoicePick(tts, "")
    want = voice if isinstance(voice, str) and voice else agent.get("tts_voice_id")
    voices = speko_voices(tts)  # the model's own voices: ElevenLabs' or Gemini's
    known = any(v["id"] == want for v in voices)
    return VoicePick(tts, want if known else voices[0]["id"])  # type: ignore[arg-type]


def _voice_name(agent: dict[str, Any], voice_id: str | None) -> str | None:
    for v in (*VOICES, *ELEVEN_VOICES, *GEMINI_VOICES):
        if v["id"] == voice_id:
            return v["name"]
    return next((v["name"] for v in list_custom_voices(agent["tenant_id"]) if v["id"] == voice_id), None)


def speaking_agent(agent: dict[str, Any], pick: VoicePick) -> dict[str, Any]:
    """
    An agent that makes the call introduces itself by the name of the voice the caller hears, for
    this call only (the saved agent is unchanged). A receptionist keeps its own name.
    """
    if not agent_target(agent)["fullName"]:
        return agent
    spoken = _voice_name(agent, pick.voice_id)
    if not spoken:
        return agent
    own = _voice_name(agent, agent.get("voice_id"))
    greeting = agent.get("greeting") or ""
    if own and own != spoken:
        greeting = greeting.replace(own, spoken)
    return {**agent, "name": spoken, "greeting": greeting}


def stt_pick(value: object) -> str:
    return value if is_stt_engine(value) else "auto"  # type: ignore[return-value]


# The Playground call plays in a browser, not down a phone line: models that render more than
# 8 kHz (BRB, ElevenLabs) are asked for 24 kHz. Our own TTS server only makes 8 kHz and ignores it.
WEB_RATE = 24000


def _synth_options(agent: dict[str, Any], lang: str, pick: VoicePick, quick_start: bool = False) -> SynthOptions:
    # Cached, like the demo: scripted calls repeat sentences, and a hit is a file read.
    return SynthOptions(
        tenant_id=agent["tenant_id"],
        voice_id=pick.voice_id,
        language=lang,
        tag="pg_call",
        cache=True,
        engine=pick.engine,
        sample_rate=WEB_RATE,
        quick_start=quick_start,
        speed=speaking_speed(agent),
    )


def _rate_of(opts: SynthOptions) -> dict[str, int]:
    """The `rate` an audio event carries: only when it is not the phone's 8 kHz, which the page assumes."""
    rate = output_rate(opts.engine, opts.sample_rate)
    return {} if rate == SAMPLE_RATE else {"rate": rate}


def _can_speak(pick: VoicePick) -> bool:
    return tts_configured(pick.engine)


def _b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode("ascii")


# ── one turn at a time per call ─────────────────────────────────────

_busy: set[str] = set()
_fillers: dict[str, int] = {}
_heard: dict[str, dict[str, Any]] = {}
_warmed: set[str] = set()


def claim_call(call_id: str) -> bool:
    """Two turns in flight would interleave the transcript."""
    if call_id in _busy:
        return False
    _busy.add(call_id)
    return True


def release_call(call_id: str) -> None:
    _busy.discard(call_id)


# ── the agent's voice ───────────────────────────────────────────────


async def speak(agent: dict[str, Any], text: str, lang: str, pick: VoicePick, send: Send, signal: Signal) -> None:
    """Stream the agent's voice for `text`, sentence by sentence."""
    if not _can_speak(pick):
        send({"t": "voice", "ok": False})
        return
    opts = _synth_options(agent, lang, pick)
    sent = 0
    try:
        async with aclosing(synthesize_stream(text, opts)) as pieces:
            async for pcm in pieces:
                if signal.aborted:
                    break
                send({"t": "audio", "pcm": _b64(pcm), **_rate_of(opts)})
                sent += 1
    except Exception as err:  # noqa: BLE001
        log.warning("[playground] tts failed: %s", err)
    if not sent and not signal.aborted:
        send({"t": "voice", "ok": False})


# A clause long enough to be said on its own: four words, 25 characters.
CLAUSE_MIN_WORDS = 4
CLAUSE_MIN_CHARS = 25
_SENTENCE_END = re.compile(f"[.!?…]+(?=[{JS_S}])")
_CLAUSE_END = re.compile(f"[,;:—–]+(?=[{JS_S}])")
_WORD_GAP = re.compile(f"[{JS_S}]+")


def next_segment(text: str, taken: int, finished: bool, fast: bool, segments: int) -> tuple[str | None, int]:
    """
    The next piece of a reply being written to hand to the voice, and the new `taken`: a whole
    sentence (at least 12 characters: a lone "Ha." waits for the next one); with `fast`, the very
    first piece may be a clause of four words or more; once `finished`, everything left.
    """
    rest = text[taken:]
    if finished:
        return (js_trim(rest) or None), len(text)
    ends = list(_SENTENCE_END.finditer(rest))
    if ends:
        cut = ends[-1].end()
        if utf16_len(js_trim(rest[:cut])) >= 12:
            return js_trim(rest[:cut]), taken + cut
    if fast and segments == 0:
        for m in _CLAUSE_END.finditer(rest):
            piece = js_trim(rest[: m.end()])
            if utf16_len(piece) >= CLAUSE_MIN_CHARS and len(_WORD_GAP.split(piece)) >= CLAUSE_MIN_WORDS:
                return piece, taken + m.end()
    return None, taken


@dataclass
class _Rendering:
    """One segment being rendered, possibly ahead of the one playing."""

    shown_up_to: int
    pieces: list[bytes] = field(default_factory=list)
    done: bool = False
    failure: BaseException | None = None
    wake: asyncio.Event = field(default_factory=asyncio.Event)

    async def chunks(self, signal: Signal) -> AsyncIterator[bytes]:
        read = 0
        while True:
            if signal.aborted:
                return
            if read < len(self.pieces):
                read += 1
                yield self.pieces[read - 1]
                continue
            if self.done:
                if self.failure:
                    raise self.failure
                return
            self.wake.clear()
            await self.wake.wait()


def _render_ahead(segment: str, opts: SynthOptions, signal: Signal, shown_up_to: int) -> _Rendering:
    """Start rendering `segment` now and keep its audio until it is read."""
    r = _Rendering(shown_up_to)
    remove = signal.on_abort(r.wake.set)  # talked over: the reader stops at once

    async def render() -> None:
        try:
            async with aclosing(synthesize_stream(segment, opts)) as pieces:
                async for pcm in pieces:
                    if signal.aborted:
                        break
                    r.pieces.append(pcm)
                    r.wake.set()
        except Exception as err:  # noqa: BLE001
            r.failure = err
        finally:
            r.done = True
            r.wake.set()
            remove()

    background.spawn(render())
    return r


def _silent(shown_up_to: int) -> _Rendering:
    return _Rendering(shown_up_to, done=True)


@dataclass
class SpeakOptions:
    # First piece may be a clause; the next sentence renders while one plays; first audio after 0.1 s.
    fast: bool = True
    on_first_segment: Callable[[], None] | None = None
    on_first_audio: Callable[[], None] | None = None


class SpeakAsWritten:
    """
    Voice a reply while the model is still writing it: each complete sentence goes to the TTS as
    soon as the voice is free (with `fast`: the first clause at once, and the next sentence is
    rendered ahead). `push` each delta; `await finish(reply)` once the reply is complete.
    """

    def __init__(
        self, agent: dict[str, Any], lang: str, pick: VoicePick, send: Send, signal: Signal, options: SpeakOptions
    ) -> None:
        self.lang, self.pick, self.send, self.signal, self.options = lang, pick, send, signal, options
        self.opts = _synth_options(agent, lang, pick, options.fast)
        self.text = ""
        self.taken = 0
        self.finished = False
        self.shown = False
        self.sent = 0
        self.segments = 0
        self._wake = asyncio.Event()
        self._worker = asyncio.get_running_loop().create_task(self._run())

    def _take(self) -> _Rendering | None:
        segment, self.taken = next_segment(self.text, self.taken, self.finished, self.options.fast, self.segments)
        if not segment:
            return None
        if self.segments == 0 and self.options.on_first_segment:
            self.options.on_first_segment()
        self.segments += 1
        if _can_speak(self.pick):
            return _render_ahead(segment, self.opts, self.signal, self.taken)
        return _silent(self.taken)

    async def _run(self) -> None:
        current: _Rendering | None = None
        while True:
            if self.signal.aborted:
                return
            if current is None:
                current = self._take()
            if current is None:
                if self.finished:
                    return
                self._wake.clear()
                await self._wake.wait()
                continue
            said = js_trim(self.text[: current.shown_up_to])
            self.send(
                {"t": "more", "text": said}
                if self.shown
                else {"t": "reply", "text": said, "lang": self.lang, "end": None}
            )
            self.shown = True
            upcoming: _Rendering | None = None
            try:
                async with aclosing(current.chunks(self.signal)) as pieces:
                    async for pcm in pieces:
                        if self.signal.aborted:
                            break
                        self.send({"t": "audio", "pcm": _b64(pcm), **_rate_of(self.opts)})
                        if self.sent == 0 and self.options.on_first_audio:
                            self.options.on_first_audio()
                        self.sent += 1
                        # Render the next sentence while this one plays.
                        if self.options.fast and upcoming is None:
                            upcoming = self._take()
            except Exception as err:  # noqa: BLE001
                log.warning("[playground] tts failed: %s", err)
            current = upcoming

    def push(self, delta: str) -> None:
        if self.finished:
            return
        self.text = self.text + delta if self.taken else js_trim_start(self.text + delta)
        self._wake.set()

    async def finish(self, reply: str) -> None:
        """The reply is complete; returns once all of it has been voiced."""
        if not js_trim(self.text) or reply.startswith(js_trim_end(self.text)):
            self.text = reply
        self.finished = True
        self._wake.set()
        await self._worker
        if not self.sent and self.shown and not self.signal.aborted:
            self.send({"t": "voice", "ok": False})


# ── "bir daqiqa" while the agent thinks ─────────────────────────────

# Turns where "let me check" would be absurd: hello, yes, thanks, goodbye.
NO_FILLER = {"greeting", "goodbye", "affirm", "human"}


def warm_fillers(agent: dict[str, Any], lang: str, pick: VoicePick) -> None:
    """Render the filler lines in the picked engine and voice once, in the background."""
    key = f"{agent['tenant_id']}:{pick.engine}:{pick.voice_id}:{lang}"
    if not fillers_enabled() or key in _warmed or not _can_speak(pick):
        return
    _warmed.add(key)

    async def warm() -> None:
        for line in filler_lines(lang):
            opts = _synth_options(agent, lang, pick)
            if not cached_pcm(line, opts):
                with contextlib.suppress(Exception):
                    await synthesize_pcm(line, opts)

    background.spawn(warm())


def filler_for(agent: dict[str, Any], call_id: str, said: str, pick: VoicePick) -> dict[str, Any] | None:
    """A cached filler for this turn, as the `filler` event's fields, or None — never rendered now."""
    if not fillers_enabled() or not _can_speak(pick) or classify_intent(said) in NO_FILLER:
        return None
    language = detect_language(said)
    lines = filler_lines(language)
    turn = _fillers.get(call_id, 0)
    opts = _synth_options(agent, language, pick)
    pcm = cached_pcm(lines[turn % len(lines)], opts)
    if not pcm:
        return None
    _fillers[call_id] = turn + 1
    if len(_fillers) > 2000:
        _fillers.clear()
    return {"pcm": _b64(pcm), **_rate_of(opts)}


# ── transcribing during the pause ───────────────────────────────────

PREFETCH_TTL_S = 20.0


def _audio_key(audio: bytes, lang: str, engine: str) -> str:
    return f"{engine}:{lang}:{hashlib.sha1(audio).hexdigest()}"


def _quiet(task: asyncio.Task) -> None:
    if not task.cancelled():
        task.exception()  # a failure is retried by the turn itself


def prefetch_heard(call_id: str, audio: bytes, lang: str, engine: str, words: list[str] | None = None) -> None:
    """Start transcribing a phrase the page offered at an early pause (`words`: names and terms to expect)."""

    async def heard() -> Transcript:
        return await transcribe(
            await prepare_live(audio, "browser"), language=lang, clean=True, engine=engine, vocabulary=words
        )

    task = asyncio.get_running_loop().create_task(heard())
    task.add_done_callback(_quiet)
    _heard[call_id] = {"key": _audio_key(audio, lang, engine), "at": time.time(), "transcript": task}
    if len(_heard) > 500:
        stale = time.time() - PREFETCH_TTL_S
        for cid in [c for c, e in _heard.items() if e["at"] < stale]:
            del _heard[cid]


async def heard_in(call_id: str, audio: bytes, lang: str, engine: str, words: list[str] | None = None) -> Transcript:
    """What the caller said: the prefetched transcript when it matches, else a fresh one."""
    entry = _heard.pop(call_id, None)
    if entry and entry["key"] == _audio_key(audio, lang, engine) and time.time() - entry["at"] < PREFETCH_TTL_S:
        try:
            return await entry["transcript"]
        except Exception:  # noqa: BLE001 - transcribe again below
            pass
    return await transcribe(
        await prepare_live(audio, "browser"), language=lang, clean=True, engine=engine, vocabulary=words
    )
