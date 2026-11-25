"""
CallMind telephony bridge — Asterisk AudioSocket ⇄ CallMind (Python port of bridge.mjs).

  Asterisk ──AudioSocket(TCP)──▶ this bridge ──HTTP(x-bridge-secret)──▶ the site (/api/telephony/bridge/*)
           ◀──── slin audio ─────           ◀──── streamed PCM ───────

A standalone asyncio service (Python ≥ 3.12; one dependency, `httpx`, already in the backend's
virtualenv). It speaks the Asterisk AudioSocket wire protocol on a TCP port, endpoints the caller's
audio into complete utterances, and hands each one to the bridge endpoints, which own every secret
(STT/TTS and the LLM engine). The bridge holds only NEXT_BASE_URL, BRIDGE_SHARED_SECRET and the
settings below.

Run it with the backend's virtualenv:   backend/.venv/bin/python telephony-bridge/bridge.py

── AudioSocket wire protocol ──────────────────────────────────────────────────
  Every message is:  [1-byte type][2-byte big-endian length][payload]
    0x00 TERMINATE  hang up (payload usually empty)
    0x01 UUID       16-byte call id (Asterisk channel), sent once on connect
    0x03 DTMF       one ASCII digit
    0x10 AUDIO      signed 16-bit LE PCM, 8 kHz mono, 20 ms (320-byte) frames
    0xff ERROR      error notification
  TCP is a stream, so messages split/merge across segments — they are reassembled.

── What makes it sound live ───────────────────────────────────────────────────
  • Streamed playback: /turn returns raw 8 kHz PCM as a chunked stream, one sentence at a time;
    frames go onto the line the moment the first bytes land.
  • Filler lines: if the answer has not started within FILLER_AFTER_MS, a pre-fetched holding line
    ("bir daqiqa") plays in the agent's own voice. The fillers are fetched during the greeting.
  • Barge-in: inbound audio is analysed while the agent speaks; sustained speech stops playback,
    aborts the in-flight turn and reports how much of the reply the caller heard.
  • Adaptive VAD: the energy threshold tracks the line's own noise floor.

── Turn states (one per call; `Connection.state`) ─────────────────────────────
  LISTENING  waiting for the caller; line noise is tracked, a short preroll is kept.
  CAPTURING  the caller is speaking; frames go into the utterance.
  THINKING   the utterance is finalized and its /turn is in flight (filler included). Caller audio
             is DROPPED: background speech here must not cancel the turn or become the next one.
             (VAD_BARGE_WHILE_THINKING=1 restores the old behaviour: barge-in also while thinking.)
  SPEAKING   the reply's own audio is on the line; sustained speech is a barge-in.
  REARMING   the reply just ended: for VAD_REARM_MS the line's tail and stale audio are ignored,
             then back to LISTENING with a fresh preroll.
  The utterance's Turn is created in the same step that finalizes it, so no frame can slip in
  between "finalized" and "thinking" and start a second utterance.

── Remaining v1 limitations ───────────────────────────────────────────────────
  • No in-call SIP transfer on escalate — the handoff line plays, then the bridge hangs up.
  • to/from are a static env mapping (BRIDGE_TO_NUMBER / BRIDGE_FROM_NUMBER).

The behaviour (framing, VAD arithmetic, pacing, the HTTP requests and their fields) is the same as
bridge.mjs; `telephony-bridge/test_bridge.py` drives both with the same simulated call.
"""

import asyncio
import base64
import contextlib
import json
import math
import os
import re
import signal
import socket
import sys
import time
from array import array
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from urllib.parse import quote

import httpx

# ── env helpers (parseInt / parseFloat semantics) ───────────────────

_INT = re.compile(r"^[\s﻿\xa0]*([+-]?\d+)")
_FLOAT = re.compile(r"^[\s﻿\xa0]*([+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))")


def int_env(name: str, default: int) -> int:
    """`parseInt(process.env[name] ?? '', 10)`, falling back when it is not a finite number."""
    match = _INT.match(os.environ.get(name, ""))
    return int(match.group(1)) if match else default


def float_env(name: str, default: float) -> float:
    """`parseFloat(process.env[name] ?? '')`, falling back when it is not a finite number."""
    match = _FLOAT.match(os.environ.get(name, ""))
    if not match:
        return default
    value = float(match.group(1).replace("Infinity", "inf"))
    return value if math.isfinite(value) else default


# ── config (env, with defaults) ─────────────────────────────────────


@dataclass(frozen=True)
class Vad:
    # 350 ms: 700 ms is audible dead air on every turn; the adaptive threshold makes 350 ms safe.
    silence_ms: int = int_env("VAD_SILENCE_MS", 350)
    # Absolute floor for "voiced", used until the noise floor is measured and as a lower bound after.
    min_rms: int = int_env("VAD_MIN_RMS", 350)
    # Voiced = noise floor × this.
    rms_factor: float = float_env("VAD_RMS_FACTOR", 3.5)
    # Barge-in needs a higher bar: the agent's own audio leaks back on some trunks.
    barge_rms_factor: float = float_env("VAD_BARGE_RMS_FACTOR", 5)
    max_utterance_ms: int = int_env("VAD_MAX_UTTERANCE_MS", 15000)
    min_voiced_ms: int = int_env("VAD_MIN_VOICED_MS", 200)
    preroll_ms: int = int_env("VAD_PREROLL_MS", 200)
    barge_ms: int = int_env("VAD_BARGE_MS", 240)
    # Strict turn gating: while a turn is in flight and its reply has not started, caller audio is
    # dropped. 1 = the old behaviour (loud audio while thinking cancels the turn as a barge-in).
    barge_while_thinking: bool = bool(
        re.fullmatch(r"(1|true|yes|on)", os.environ.get("VAD_BARGE_WHILE_THINKING", ""), re.IGNORECASE)
    )
    # After the reply ends, ignore the line this long (its echo tail, stale room audio).
    rearm_ms: int = int_env("VAD_REARM_MS", 200)


@dataclass(frozen=True)
class Config:
    port: int = int_env("AUDIOSOCKET_PORT", 8090)
    next_base_url: str = (os.environ.get("NEXT_BASE_URL") or "http://localhost:3000").rstrip("/")
    secret: str = os.environ.get("BRIDGE_SHARED_SECRET") or ""
    to_number: str = os.environ.get("BRIDGE_TO_NUMBER") or ""
    from_number: str = os.environ.get("BRIDGE_FROM_NUMBER") or "anonymous"
    vad: Vad = field(default_factory=Vad)
    filler_after_ms: int = int_env("FILLER_AFTER_MS", 300)
    fillers_enabled: bool = not re.fullmatch(r"(0|false|no|off)", os.environ.get("FILLERS", ""), re.IGNORECASE)
    verbose: bool = bool(re.fullmatch(r"(1|true|yes|on)", os.environ.get("BRIDGE_LOG", ""), re.IGNORECASE))


CONFIG = Config()

# ── audio + protocol constants ──────────────────────────────────────

SAMPLE_RATE = 8000
BYTES_PER_SAMPLE = 2
FRAME_MS = 20
FRAME_BYTES = ((SAMPLE_RATE * FRAME_MS) // 1000) * BYTES_PER_SAMPLE  # 320
BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) // 1000  # 16

TERMINATE, UUID, DTMF, AUDIO, ERROR = 0x00, 0x01, 0x03, 0x10, 0xFF
TURN_TIMEOUT_S = 120  # STT + LLM + TTS worst case
END_TIMEOUT_S = 15
FILLER_TIMEOUT_S = 20
FILLER_COUNT = 3  # distinct holding lines prefetched per call

# Rough speech rate, used only to estimate a reply's length before it renders.
BYTES_PER_CHAR = 60 * BYTES_PER_MS


def log(*args: object) -> None:
    now = datetime.now(UTC)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    print(stamp, "[bridge]", *args, flush=True)


def now_ms() -> float:
    return time.monotonic() * 1000


def utf16_len(text: str) -> int:
    """`text.length`: UTF-16 code units (an emoji counts 2)."""
    return len(text.encode("utf-16-le")) // 2


def js_to_fixed(x: float, digits: int) -> str:
    """`x.toFixed(digits)`: the exact binary value rounded half away from zero."""
    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


# ── per-connection state ────────────────────────────────────────────

LISTENING, CAPTURING, THINKING, SPEAKING, REARMING = "listening", "capturing", "thinking", "speaking", "rearming"


class Connection:
    """One AudioSocket connection: its socket and all the endpointing/turn state."""

    def __init__(self, writer: asyncio.StreamWriter, client: httpx.AsyncClient):
        self.writer = writer
        self.client = client
        self.closed = False
        self.buffer = b""
        self.uuid: str | None = None
        self.call_id = ""  # CallMind call id (from x-ovoz-callid)
        self.from_ = CONFIG.from_number
        self.to = CONFIG.to_number
        # endpointing
        self.speaking = False
        self.utter: list[bytes] = []
        self.voiced_ms = 0.0
        self.silence_ms = 0.0
        self.utter_ms = 0.0
        self.preroll: list[bytes] = []
        self.preroll_ms = 0.0
        self.noise_floor = float(CONFIG.vad.min_rms)
        self.barge_voiced_ms = 0.0
        self.rearm_until = 0.0  # now_ms() until which the line is ignored after a reply
        self.dropped_ms = 0.0  # caller audio dropped while thinking/rearming (diagnostics)
        self.last_state = LISTENING
        # turn lifecycle
        self.turn_seq = 0  # every turn (greeting included) gets the next id
        self.turn: Turn | None = None
        self.fillers: list[bytes] = []
        self.filler_at = 0
        self.pending_ratio = 0.0  # barge-in report for the NEXT /turn request
        self.ended = False
        self.started_at = time.time()
        self.tasks: set[asyncio.Task] = set()

    def spawn(self, coro) -> asyncio.Task:  # noqa: ANN001
        """Fire and forget, like an un-awaited promise (kept referenced so it is not collected)."""
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    @property
    def state(self) -> str:
        """The call's turn state, derived from what is actually happening (so it cannot drift)."""
        if self.turn is not None:
            return SPEAKING if self.turn.playback.reply_from is not None else THINKING
        if now_ms() < self.rearm_until:
            return REARMING
        return CAPTURING if self.speaking else LISTENING

    def new_turn(self) -> "Turn":
        """Open the next turn and make it current: synchronously, in the step that needs it."""
        self.turn_seq += 1
        turn = Turn(Playback(self), turn_id=self.turn_seq)
        self.turn = turn
        return turn

    def release(self, turn: "Turn") -> None:
        """`turn` is over. Only the current turn rearms the line; a superseded one changes nothing."""
        if self.turn is turn:
            self.turn = None
            self.rearm()

    def rearm(self) -> None:
        """Back to listening after a reply: forget audio gathered meanwhile, ignore the tail."""
        self.rearm_until = now_ms() + CONFIG.vad.rearm_ms
        self.preroll = []
        self.preroll_ms = 0
        self.barge_voiced_ms = 0

    @property
    def destroyed(self) -> bool:
        return self.closed or self.writer.is_closing()

    def write_message(self, kind: int, payload: bytes = b"") -> None:
        """Frame and send one AudioSocket message."""
        if self.destroyed:
            return
        self.writer.write(bytes([kind]) + len(payload).to_bytes(2, "big") + payload)

    def end_socket(self) -> None:
        """`socket.end()`: stop writing and let the connection close."""
        if not self.writer.is_closing():
            with contextlib.suppress(Exception):
                if self.writer.can_write_eof():
                    self.writer.write_eof()
            self.writer.close()


@dataclass
class Turn:
    playback: "Playback"
    turn_id: int = 0
    replyChars: int = 0  # noqa: N815 - the name bridge.mjs uses
    aborted: bool = False
    tasks: set = field(default_factory=set)

    def abort(self) -> None:
        """`AbortController.abort()`: stops the HTTP request and the reply stream, nothing else."""
        if self.aborted:
            return
        self.aborted = True
        for task in list(self.tasks):
            task.cancel()

    async def run(self, coro):  # noqa: ANN001, ANN201
        """Await `coro` as an abortable part of this turn; raises Aborted if the turn was aborted."""
        if self.aborted:
            coro.close()
            raise Aborted
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        try:
            return await task
        except asyncio.CancelledError:
            if self.aborted and not _cancelling_outer():
                raise Aborted from None
            raise
        finally:
            self.tasks.discard(task)


class Aborted(Exception):
    """The turn's abort signal fired (barge-in, hang-up or the turn timeout)."""


def _cancelling_outer() -> bool:
    current = asyncio.current_task()
    return bool(current and current.cancelling())


# ── framing: reassemble [type][len][payload] from the TCP stream ────


def drain(conn: Connection) -> None:
    buf = conn.buffer
    offset = 0
    while len(buf) - offset >= 3:
        kind = buf[offset]
        length = int.from_bytes(buf[offset + 1 : offset + 3], "big")
        if len(buf) - offset - 3 < length:
            break  # incomplete — wait for more bytes
        payload = buf[offset + 3 : offset + 3 + length]
        offset += 3 + length
        handle_message(conn, kind, payload)
    conn.buffer = buf[offset:] if offset > 0 else buf


# ── message dispatch ────────────────────────────────────────────────


def handle_message(conn: Connection, kind: int, payload: bytes) -> None:
    if kind == UUID:
        conn.uuid = format_uuid(payload)
        log(f"call up  uuid={conn.uuid}  to={conn.to or '(unset)'}  from={conn.from_}")
        conn.spawn(open_and_greet(conn, conn.new_turn()))
    elif kind == AUDIO:
        on_audio(conn, payload)
    elif kind == DTMF:
        log(f"dtmf {payload.decode('utf-8', 'replace')}")
    elif kind == TERMINATE:
        log("terminate frame from Asterisk")
        cancel_turn(conn)
        conn.spawn(finish(conn))
        conn.end_socket()
    elif kind == ERROR:
        log(f"error frame from Asterisk: 0x{payload.hex()}")
    # Unknown/ignored frame types (some Asterisk builds emit others).


def cancel_turn(conn: Connection) -> None:
    if conn.turn:
        conn.turn.playback.cancel()
        conn.turn.abort()


# ── VAD / endpointing ───────────────────────────────────────────────


def on_audio(conn: Connection, payload: bytes) -> None:
    """One 20 ms frame of caller audio: barge-in detection, utterance building, or noise tracking."""
    if len(payload) < BYTES_PER_SAMPLE:
        return

    rms = rms_of(payload)
    dur_ms = (len(payload) / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000
    vad = CONFIG.vad
    state = conn.state
    if state != conn.last_state:
        if CONFIG.verbose:
            turn_note = f"  turn={conn.turn.turn_id}" if conn.turn else ""
            log(f"state {conn.last_state} -> {state}{turn_note}")
            if conn.last_state in (THINKING, REARMING) and conn.dropped_ms:
                log(f"  dropped {round(conn.dropped_ms)} ms of caller audio while {conn.last_state}")
        if state not in (THINKING, REARMING):
            conn.dropped_ms = 0
        conn.last_state = state

    # ── thinking / rearming: the turn is decided; nothing heard now may cancel or extend it. ──
    if state == REARMING or (state == THINKING and not vad.barge_while_thinking):
        conn.dropped_ms += dur_ms
        conn.barge_voiced_ms = 0
        conn.preroll = []
        conn.preroll_ms = 0
        return

    # ── barge-in: the agent is talking and the caller starts. ──
    if conn.turn:
        if rms >= conn.noise_floor * vad.barge_rms_factor:
            conn.barge_voiced_ms += dur_ms
            # Hold the audio: a real barge-in is the start of the caller's next utterance.
            conn.preroll.append(bytes(payload))
            conn.preroll_ms += dur_ms
            if conn.barge_voiced_ms >= vad.barge_ms:
                barge_in(conn)
        else:
            # Isolated noise, not speech — forget it.
            conn.barge_voiced_ms = 0
            trim_preroll(conn)
        return

    voiced = rms >= voiced_threshold(conn)

    if voiced:
        if not conn.speaking:
            # Speech onset — seed the utterance with the preroll so it is not clipped.
            conn.speaking = True
            conn.utter = conn.preroll[:]
            conn.utter_ms = conn.preroll_ms
            conn.voiced_ms = 0
            conn.silence_ms = 0
            conn.preroll = []
            conn.preroll_ms = 0
        conn.utter.append(bytes(payload))
        conn.utter_ms += dur_ms
        conn.voiced_ms += dur_ms
        conn.silence_ms = 0
    elif conn.speaking:
        # Keep trailing silence inside the utterance; end the turn once it is long enough.
        conn.utter.append(bytes(payload))
        conn.utter_ms += dur_ms
        conn.silence_ms += dur_ms
        if conn.silence_ms >= vad.silence_ms:
            endpoint(conn)
            return
    else:
        # Idle: a clean sample of the line's noise floor, tracked slowly.
        conn.noise_floor = conn.noise_floor * 0.95 + rms * 0.05
        conn.preroll.append(bytes(payload))
        conn.preroll_ms += dur_ms
        trim_preroll(conn)

    # Hard cap so a caller who never pauses still gets processed.
    if conn.speaking and conn.utter_ms >= vad.max_utterance_ms:
        endpoint(conn)


def voiced_threshold(conn: Connection) -> float:
    """The energy a frame must exceed to count as speech, on this line, right now."""
    return max(CONFIG.vad.min_rms, conn.noise_floor * CONFIG.vad.rms_factor)


def trim_preroll(conn: Connection) -> None:
    while conn.preroll_ms > CONFIG.vad.preroll_ms and len(conn.preroll) > 1:
        dropped = conn.preroll.pop(0)
        conn.preroll_ms -= (len(dropped) / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000


def endpoint(conn: Connection) -> None:
    """Finalize the buffered utterance and, if it is real speech, process it."""
    chunks = conn.utter
    voiced_ms = conn.voiced_ms
    conn.speaking = False
    conn.utter = []
    conn.utter_ms = 0
    conn.voiced_ms = 0
    conn.silence_ms = 0

    if voiced_ms < CONFIG.vad.min_voiced_ms:
        return  # a click/cough, not a turn
    # FINALIZING -> THINKING in this same step: the turn exists before the next frame is read.
    turn = conn.new_turn()
    conn.spawn(_process_logged(conn, b"".join(chunks), turn))


async def _process_logged(conn: Connection, pcm: bytes, turn: "Turn") -> None:
    try:
        await process_utterance(conn, pcm, turn)
    except Exception as err:  # noqa: BLE001
        log("turn error:", err)
        conn.release(turn)


def barge_in(conn: Connection) -> None:
    """The caller talked over the agent: stop now, drop the rest, remember how much was heard."""
    turn = conn.turn
    if not turn:
        return
    conn.pending_ratio = turn.playback.spoken_ratio(turn.replyChars)
    log(
        f"barge-in — stopping playback at {js_to_fixed(conn.pending_ratio * 100, 0)}% of the reply"
        f" (turn {turn.turn_id})"
    )
    turn.playback.cancel()
    turn.abort()
    conn.turn = None
    conn.barge_voiced_ms = 0
    # The frames that triggered the barge-in are already in the preroll.


# ── turn processing ─────────────────────────────────────────────────


async def open_and_greet(conn: Connection, turn: Turn) -> None:
    playback = turn.playback
    # Fetch the holding lines concurrently with the greeting.
    conn.spawn(prefetch_fillers(conn))
    try:
        res = await call_turn(conn, turn, first=True)
        if not res:
            log("greeting turn failed — leaving the call silent")
            return
        # bridge.mjs set this unguarded: a barge-in during the greeting left `state.turn` null and the
        # TypeError ended the whole Node process. Here the reply length is only recorded if still ours.
        if conn.turn is turn:
            turn.replyChars = utf16_len(res["text"])
        await pump(turn, res, playback)
        await playback.drain()
    finally:
        conn.release(turn)


async def process_utterance(conn: Connection, pcm: bytes, turn: Turn) -> None:
    playback = turn.playback

    # Cover the STT + retrieval + generation gap with a holding line, but only if the answer is slow.
    loop = asyncio.get_running_loop()

    def play_filler() -> None:
        filler = next_filler(conn)
        if filler and not playback.started:
            playback.push(filler)

    filler_timer = loop.call_later(CONFIG.filler_after_ms / 1000, play_filler)

    try:
        res = await call_turn(conn, turn, audio=pcm_to_wav(pcm))
        if not res:
            return
        if conn.turn is turn:
            turn.replyChars = utf16_len(res["text"])
        await pump(turn, res, playback, filler_timer.cancel)
        await playback.drain()

        if res["escalate"]:
            # No SIP transfer in v1 — the handoff line was just spoken; end the call.
            log(f"escalation flagged: {res['escalate']} — no in-call transfer in v1, ending call")
            await finish(conn)
            conn.end_socket()
    finally:
        filler_timer.cancel()
        conn.release(turn)


async def pump(turn: Turn, res: dict, playback: "Playback", on_first_chunk=None) -> None:  # noqa: ANN001
    """Read the reply body and feed playback as it arrives (raw L16 streams; anything else is buffered)."""
    try:
        await turn.run(read_into(res, playback, on_first_chunk))
    except (Exception, Aborted) as err:  # noqa: BLE001
        # A barge-in or a hangup aborts the body mid-flight — the normal end of an interrupted turn.
        if not playback.cancelled:
            log("reply stream ended early:", "This operation was aborted" if isinstance(err, Aborted) else err)
    finally:
        with contextlib.suppress(Exception):
            await asyncio.shield(res["response"].aclose())
    playback.end()


async def read_into(res: dict, playback: "Playback", on_first_chunk) -> None:  # noqa: ANN001
    response: httpx.Response = res["response"]
    if res["raw"]:
        async for chunk in response.aiter_bytes():
            if not chunk:
                continue
            if on_first_chunk:
                on_first_chunk()
                on_first_chunk = None
            playback.mark_reply_start()
            playback.push(bytes(chunk))
    else:
        parts = [bytes(chunk) async for chunk in response.aiter_bytes()]
        if on_first_chunk:
            on_first_chunk()
        playback.mark_reply_start()
        playback.push(wav_to_pcm8k_mono16(b"".join(parts)))


async def call_turn(conn: Connection, turn: Turn, *, audio: bytes | None = None, first: bool = False) -> dict | None:
    """POST one turn. Updates conn.call_id from the response and returns the still-open body."""
    data: list[tuple[str, str]] = [("callId", conn.call_id or ""), ("from", conn.from_ or ""), ("to", conn.to or "")]
    if first:
        data.append(("first", "true"))
    # Barge-in report for the reply the caller cut off, if any.
    if conn.pending_ratio > 0:
        data.append(("spokenRatio", js_to_fixed(conn.pending_ratio, 3)))
        conn.pending_ratio = 0
    files = [("audio", ("utterance.wav", audio, "audio/wav"))] if audio else None

    request = conn.client.build_request(
        "POST",
        f"{CONFIG.next_base_url}/api/telephony/bridge/turn",
        headers={"x-bridge-secret": CONFIG.secret},
        data=dict(data),
        files=files,
    )
    loop = asyncio.get_running_loop()
    timeout = loop.call_later(TURN_TIMEOUT_S, turn.abort)
    try:
        response = await turn.run(conn.client.send(request, stream=True))
    except Aborted:
        return None
    except Exception as err:  # noqa: BLE001
        if not turn.aborted:
            log("turn request failed:", err)
        return None
    finally:
        timeout.cancel()

    if not response.is_success:
        try:
            detail = (await response.aread()).decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = ""
        await response.aclose()
        log(f"turn {response.status_code}: {detail[:200]}")
        return None

    call_id = response.headers.get("x-ovoz-callid") or conn.call_id
    if call_id:
        conn.call_id = call_id
    text_b64 = response.headers.get("x-ovoz-text") or ""
    text = _b64_text(text_b64) if text_b64 else ""
    if CONFIG.verbose and text:
        log(f"agent ({response.headers.get('x-ovoz-engine') or '-'}): {text}")
    return {
        "callId": call_id,
        "escalate": response.headers.get("x-ovoz-escalate") or "",
        "text": text,
        "response": response,
        "raw": "l16" in (response.headers.get("content-type") or "").lower(),
    }


def _b64_text(value: str) -> str:
    """`Buffer.from(value, 'base64').toString('utf8')`: lenient about padding and junk characters."""
    cleaned = re.sub(r"[^A-Za-z0-9+/\-_]", "", value).replace("-", "+").replace("_", "/")
    cleaned += "=" * (-len(cleaned) % 4)
    try:
        return base64.b64decode(cleaned).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return ""


async def prefetch_fillers(conn: Connection) -> None:
    """Download the holding lines once per call, in the background."""
    if not CONFIG.fillers_enabled or conn.fillers or not conn.to:
        return

    async def one(i: int) -> bytes | None:
        try:
            url = f"{CONFIG.next_base_url}/api/telephony/bridge/filler?to={quote(conn.to, safe='')}&i={i}"
            res = await conn.client.get(url, headers={"x-bridge-secret": CONFIG.secret}, timeout=FILLER_TIMEOUT_S)
            if not res.is_success:
                return None
            return res.content
        except Exception:  # noqa: BLE001
            return None  # fillers are a nicety; never let them break a call

    results = await asyncio.gather(*(one(i) for i in range(FILLER_COUNT)))
    conn.fillers = [b for b in results if b]
    if CONFIG.verbose:
        log(f"fillers ready: {len(conn.fillers)}")


def next_filler(conn: Connection) -> bytes | None:
    """Rotate through the prefetched lines so a call never repeats one twice running."""
    if not conn.fillers:
        return None
    filler = conn.fillers[conn.filler_at % len(conn.fillers)]
    conn.filler_at += 1
    return filler


async def finish(conn: Connection) -> None:
    """Close the CallMind call row exactly once (0x00 or socket close, whichever first)."""
    if conn.ended:
        return
    conn.ended = True
    duration_sec = math.floor((time.time() - conn.started_at) + 0.5)  # Math.round
    if not conn.call_id:
        log(f"call closed with no CallMind callId (dur={duration_sec}s)")
        return
    try:
        res = await conn.client.post(
            f"{CONFIG.next_base_url}/api/telephony/bridge/end",
            headers={"x-bridge-secret": CONFIG.secret, "Content-Type": "application/json"},
            content=json.dumps({"callId": conn.call_id, "durationSec": duration_sec}, separators=(",", ":")),
            timeout=END_TIMEOUT_S,
        )
        log(f"end {res.status_code}  callId={conn.call_id}  dur={duration_sec}s")
    except Exception as err:  # noqa: BLE001
        log("end request failed:", err)


# ── playback: a paced 20 ms frame writer over a growing buffer ──────


class Playback:
    """
    Paces PCM onto the AudioSocket at one 320-byte frame per 20 ms of real time while the buffer
    behind it is still being filled. The loop waits if it catches up with the producer (a slow second
    sentence is a natural pause, not a glitch); cancelling stops mid-frame.
    """

    def __init__(self, conn: Connection):
        self.conn = conn
        self.queue: list[bytes] = []  # unsent PCM, in order
        self.queued = 0  # total bytes ever pushed
        self.sent = 0  # total bytes actually written to the line
        self.done = False  # producer finished
        self.cancelled = False
        self.started = False
        self.loop: asyncio.Task | None = None
        # Byte offsets at which the actual reply began; a filler before it does not count as "heard".
        self.reply_from: tuple[int, int] | None = None

    def mark_reply_start(self) -> None:
        if self.reply_from is None:
            self.reply_from = (self.queued, self.sent)

    def push(self, pcm: bytes | None) -> None:
        if self.cancelled or not pcm:
            return
        self.queue.append(pcm)
        self.queued += len(pcm)
        self.started = True
        if self.loop is None:
            self.loop = self.conn.spawn(self._run())

    def end(self) -> None:
        self.done = True

    def cancel(self) -> None:
        self.cancelled = True
        self.queue = []

    async def drain(self) -> None:
        """Wait for everything pushed so far to finish playing."""
        self.end()
        if self.loop is not None:
            await self.loop

    def spoken_ratio(self, reply_chars: int = 0) -> float:
        """How much of the reply the caller heard (estimated from the text until the stream ends)."""
        if self.reply_from is None:
            return 0
        queued = self.queued - self.reply_from[0]
        sent = max(0, self.sent - self.reply_from[1])
        total = queued if self.done else max(queued, reply_chars * BYTES_PER_CHAR)
        if not total:
            return 0
        return min(1, max(0.02, sent / total))

    async def _run(self) -> None:
        # Drift-corrected pacing: one frame every 20 ms of wall clock.
        next_at = now_ms()
        carry = b""
        conn = self.conn
        while not self.cancelled and not conn.destroyed and not conn.ended:
            # Gather one frame's worth of bytes out of the queue.
            while len(carry) < FRAME_BYTES and self.queue:
                carry = carry + self.queue.pop(0) if carry else self.queue.pop(0)

            if len(carry) < FRAME_BYTES:
                if self.done:
                    # Final partial frame: pad with silence so Asterisk gets a whole one.
                    if carry:
                        conn.write_message(AUDIO, carry + bytes(FRAME_BYTES - len(carry)))
                        self.sent += len(carry)
                    return
                # Producer is behind — wait briefly and try again.
                await asyncio.sleep(0.010)
                next_at = max(next_at, now_ms())
                continue

            conn.write_message(AUDIO, carry[:FRAME_BYTES])
            self.sent += FRAME_BYTES
            carry = carry[FRAME_BYTES:]

            next_at += FRAME_MS
            delay = next_at - now_ms()
            if delay > 1:
                await asyncio.sleep(delay / 1000)


# ── audio helpers ───────────────────────────────────────────────────


def rms_of(pcm: bytes) -> float:
    """RMS energy of a signed-16 LE PCM buffer (0..32767)."""
    n = len(pcm) // 2
    if not n:
        return 0
    samples = array("h", pcm[: n * 2])
    if sys.byteorder != "little":
        samples.byteswap()
    total = 0
    for s in samples:
        total += s * s
    return math.sqrt(total / n)


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE, channels: int = 1, bits: int = 16) -> bytes:
    """Wrap raw 8 kHz mono 16-bit PCM in a canonical 44-byte WAV header."""
    byte_rate = (sample_rate * channels * bits) // 8
    block_align = (channels * bits) // 8
    header = (
        b"RIFF"
        + (36 + len(pcm)).to_bytes(4, "little")
        + b"WAVE"
        + b"fmt "
        + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little")
        + channels.to_bytes(2, "little")
        + sample_rate.to_bytes(4, "little")
        + byte_rate.to_bytes(4, "little")
        + block_align.to_bytes(2, "little")
        + bits.to_bytes(2, "little")
        + b"data"
        + len(pcm).to_bytes(4, "little")
    )
    return header + pcm


def wav_to_pcm8k_mono16(buf: bytes) -> bytes:
    """Decode a WAV to 8 kHz mono 16-bit PCM (only for an older app build that sends WAV)."""
    if len(buf) < 44 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        return buf  # not a WAV we recognise — assume it is already raw slin
    offset = 12
    fmt = None
    data = None
    while offset + 8 <= len(buf):
        chunk_id = buf[offset : offset + 4]
        size = int.from_bytes(buf[offset + 4 : offset + 8], "little")
        body = buf[offset + 8 : offset + 8 + size]
        if chunk_id == b"fmt " and len(body) >= 16:
            fmt = {
                "channels": int.from_bytes(body[2:4], "little"),
                "sample_rate": int.from_bytes(body[4:8], "little"),
                "bits": int.from_bytes(body[14:16], "little"),
            }
        elif chunk_id == b"data":
            data = body
        offset += 8 + size + (size % 2)  # chunks are word-aligned
        if fmt and data is not None:
            break
    if data is None:
        return b""
    if not fmt:
        return data
    pcm = data
    if fmt["bits"] != 16:
        log(f"playback: {fmt['bits']}-bit WAV unsupported — sending best-effort")
        return pcm
    if fmt["channels"] == 2:
        pcm = downmix_stereo16(pcm)
    if fmt["sample_rate"] != SAMPLE_RATE:
        pcm = resample16(pcm, fmt["sample_rate"], SAMPLE_RATE)
    return pcm


def _int16(pcm: bytes, i: int) -> int:
    return int.from_bytes(pcm[i * 2 : i * 2 + 2], "little", signed=True)


def downmix_stereo16(pcm: bytes) -> bytes:
    frames = len(pcm) // 4
    out = bytearray(frames * 2)
    for i in range(frames):
        left = int.from_bytes(pcm[i * 4 : i * 4 + 2], "little", signed=True)
        right = int.from_bytes(pcm[i * 4 + 2 : i * 4 + 4], "little", signed=True)
        out[i * 2 : i * 2 + 2] = ((left + right) >> 1).to_bytes(2, "little", signed=True)
    return bytes(out)


def resample16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Linear-interpolation resample of 16-bit mono PCM."""
    src_samples = len(pcm) // 2
    if src_samples < 2:
        return pcm
    dst_samples = max(1, (src_samples * dst_rate) // src_rate)
    out = bytearray(dst_samples * 2)
    for i in range(dst_samples):
        pos = (i * src_rate) / dst_rate
        i0 = math.floor(pos)
        i1 = min(i0 + 1, src_samples - 1)
        frac = pos - i0
        s0 = _int16(pcm, i0)
        s1 = _int16(pcm, i1)
        value = math.floor(s0 + (s1 - s0) * frac + 0.5)  # Math.round
        out[i * 2 : i * 2 + 2] = max(-32768, min(32767, value)).to_bytes(2, "little", signed=True)
    return bytes(out)


def format_uuid(payload: bytes) -> str:
    if len(payload) != 16:
        return payload.hex()
    h = payload.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


# ── server ──────────────────────────────────────────────────────────


async def handle_connection(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, client: httpx.AsyncClient
) -> None:
    sock = writer.get_extra_info("socket")
    if sock is not None:
        with contextlib.suppress(OSError):
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            if hasattr(socket, "TCP_KEEPIDLE"):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 15)

    conn = Connection(writer, client)
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            conn.buffer = conn.buffer + chunk if conn.buffer else chunk
            drain(conn)
    except (ConnectionError, OSError) as err:
        log("socket error:", err)
    finally:
        conn.closed = True
        cancel_turn(conn)
        await finish(conn)
        with contextlib.suppress(Exception):
            writer.close()
        # Let the call's own tasks wind down (playback loops see `closed` and stop).
        if conn.tasks:
            await asyncio.wait(list(conn.tasks), timeout=5)


async def main() -> None:
    limits = httpx.Limits(max_keepalive_connections=20, keepalive_expiry=30)
    async with httpx.AsyncClient(timeout=None, limits=limits) as client:
        try:
            server = await asyncio.start_server(
                lambda r, w: handle_connection(r, w, client), host="0.0.0.0", port=CONFIG.port
            )
        except OSError as err:
            log("server error:", err)
            sys.exit(1)

        vad = CONFIG.vad
        log(f"AudioSocket bridge listening on 0.0.0.0:{CONFIG.port}")
        log(
            f"next={CONFIG.next_base_url}  secret={'set' if CONFIG.secret else 'MISSING'}  "
            f"to={CONFIG.to_number or '(unset)'}  from={CONFIG.from_number}"
        )
        log(
            f"vad: rms>=max({vad.min_rms}, floor×{vad.rms_factor:g})  silence={vad.silence_ms}ms  "
            f"min={vad.min_voiced_ms}ms  max={vad.max_utterance_ms}ms  preroll={vad.preroll_ms}ms"
        )
        log(
            f"barge-in: {vad.barge_ms}ms over floor×{vad.barge_rms_factor:g}"
            f"{' (also while thinking)' if vad.barge_while_thinking else ''}  rearm={vad.rearm_ms}ms  "
            f"fillers={'after ' + str(CONFIG.filler_after_ms) + 'ms' if CONFIG.fillers_enabled else 'off'}"
        )
        if not CONFIG.secret:
            log("WARNING: BRIDGE_SHARED_SECRET empty — endpoints will 401 (or 503 if unset app-side).")
        if not CONFIG.to_number:
            log("WARNING: BRIDGE_TO_NUMBER unset — number→agent lookup will 404 until set (v1 static mapping).")

        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, lambda s=sig: (log(f"{s.name} — shutting down"), stop.set()))
        async with server:
            await stop.wait()
            server.close()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(server.wait_closed(), timeout=2)


if __name__ == "__main__":
    # The log has non-ASCII text (×, —, Uzbek and Russian replies). A pipe or service manager with a
    # non-UTF-8 locale would otherwise raise UnicodeEncodeError on the first line and stop the bridge.
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
