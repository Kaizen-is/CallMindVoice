"""
The public bank demo (`/demo`) — port of src/lib/demo.ts: one agent, one
fictional borrower, no login.

Anyone holding the link can open the page, so everything here is shaped by that:
  • the borrower is invented — a real customer's name and debt never reach a public page,
    whatever is saved in the agent's "Who to call" card;
  • every endpoint is rate-limited per address and in total, because each turn spends real
    STT, LLM and TTS capacity;
  • demo minutes are never drawn from the tenant's wallet;
  • the only text that can be voiced is what the agent itself just said.

Demo calls are otherwise ordinary calls in the agent's tenant (from "demo"), so every
conversation shows up in the console's call log and live board. The logistics demo
(`app/logistics.py`) runs on the same engine: the event stream, the streamed voice, the per-call
lock and the rate limits below are shared with it, as in the TypeScript.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from datetime import UTC, datetime, timedelta
from typing import Any

import regex as re
from fastapi import Request
from fastapi.responses import StreamingResponse
from starlette.datastructures import FormData, UploadFile

from app import background, db
from app.catalog import VOICES
from app.engine.bus import publish
from app.engine.calls import start_call
from app.engine.conversation import agent_hours, agent_target
from app.env import env
from app.ids import new_id, now_iso, parse_iso, to_iso
from app.jscompat import JS_S, js_json, js_trim, js_trim_end, js_trim_start, utf16_len
from app.llm.choice import agent_llm
from app.llm.local import classify_intent
from app.llm.prompts import GenerateInput
from app.llm.provider import generate_answer
from app.rag.text import detect_language
from app.speech.fillers import filler_lines, fillers_enabled
from app.speech.stt import Transcript, transcribe
from app.speech.tts import (
    SynthOptions,
    cached_pcm,
    speaking_speed,
    synthesize_pcm,
    synthesize_stream,
    tts_configured,
)
from app.voices import list_custom_voices

log = logging.getLogger("callmind.demo")


def demo_lang(value: object) -> str:
    """`demoLang` (src/lib/demo-shared.ts): 'ru' or 'uz'."""
    return "ru" if value == "ru" else "uz"


# ── who is talking to whom ──────────────────────────────────────────


def agent_id() -> str:
    """The "Banking theme" agent. DEMO_AGENT_ID points the page at another one."""
    return env("DEMO_AGENT_ID", "agt_1qi9jqhzhd7pygpd")


def demo_agent() -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id", id=agent_id())


# How the page names the agent and its bank.
DEMO_IDENTITY = {
    "agent": {"uz": "Isomiddin", "ru": "Исомиддин"},
    "org": {"uz": "Biznesni rivojlantirish banki", "ru": "Банк развития бизнеса"},
}

# The borrower the visitor plays.
DEMO_PERSONA = {
    "name": {"uz": "Aziz Karimov", "ru": "Азиз Каримов"},
    "birthYear": "1992",
    "loanAmount": "7 800 000 so'm",
}

DEFAULT_CALL_PROMPT = (
    "Siz Biznesni rivojlantirish banki nomidan qoʻngʻiroq qilyapsiz. Mijozga kredit boʻyicha "
    "muddati oʻtgan toʻlovni eslating. Agar u toʻliq toʻlay olmasa, summani uch oyga boʻlib "
    "toʻlashni taklif qiling. Toʻlovni bank ilovasi orqali yoki istalgan filialda qilish mumkin."
)


def demo_target(agent: dict[str, Any]) -> dict[str, str]:
    return {
        "fullName": DEMO_PERSONA["name"]["uz"],
        "birthYear": DEMO_PERSONA["birthYear"],
        "loanAmount": DEMO_PERSONA["loanAmount"],
        # The bank's own call script when it has written one.
        "prompt": js_trim(agent_target(agent)["prompt"]) or DEFAULT_CALL_PROMPT,
    }


# ── rate limits ─────────────────────────────────────────────────────

WINDOW_MS = 10 * 60_000

# Per address and in total, per ten minutes. A booth's visitors may all share one venue Wi-Fi
# address, so the per-address limits leave room for a crowd; the totals are what cap the spend.
LIMITS = {"call": (20, 200), "turn": (200, 1500), "prefetch": (300, 2000)}

# Process-wide state, shared by the bank and logistics demos (one uvicorn worker, as one Node process).
_hits: dict[str, list[int]] = {}
_busy: set[str] = set()
_openings: dict[str, asyncio.Task] = {}
_warmed: set[str] = set()
# How many fillers each call has heard, to rotate through the lines.
_fillers: dict[str, int] = {}
_heard: dict[str, dict[str, Any]] = {}


def now_ms() -> int:
    """`Date.now()`."""
    return time.time_ns() // 1_000_000


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def iso_ms(value: str) -> int:
    """`Date.parse(value)` for a timestamp the apps wrote."""
    return (parse_iso(value) - _EPOCH) // timedelta(milliseconds=1)


def _recent(key: str, at: int) -> list[int]:
    hits = [t for t in _hits.get(key, []) if at - t < WINDOW_MS]
    _hits[key] = hits
    return hits


def _header(request: Request, name: str) -> str | None:
    """`request.headers.get(name)` of the Fetch API: repeated headers joined by ", "."""
    values = request.headers.getlist(name)
    return ", ".join(values) if values else None


def client_address(request: Request) -> str:
    """
    nginx sits in front and sets X-Forwarded-For; its first hop is the visitor. Where nothing set
    it, Next.js filled it in from the connection before the TypeScript route read it
    (`x-forwarded-for ??= socket.remoteAddress`); here that is this connection's peer.
    """
    forwarded = _header(request, "x-forwarded-for")
    if forwarded is None and request.client:
        forwarded = request.client.host
    first = js_trim(forwarded.split(",")[0]) if forwarded is not None else ""
    return first or _header(request, "x-real-ip") or "direct"


def admit(kind: str, request: Request) -> bool:
    """Count one request of this kind, or refuse it when a limit is reached."""
    at = now_ms()
    per_address, total = LIMITS[kind]
    keys = ((f"{kind}:{client_address(request)}", per_address), (f"{kind}:*", total))
    if any(len(_recent(key, at)) >= limit for key, limit in keys):
        return False
    for key, _limit in keys:
        _recent(key, at).append(at)
    if len(_hits) > 5000:
        for key in [k for k, hits in _hits.items() if not any(at - t < WINDOW_MS for t in hits)]:
            del _hits[key]
    return True


# ── call lifecycle ──────────────────────────────────────────────────

MAX_TURNS = 40
MAX_AGE_MS = 30 * 60_000
# A demo call nobody has spoken on for this long was left open in a closed tab.
IDLE_MS = 10 * 60_000


def _find_demo_call(call_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(
            conn,
            """SELECT id, tenant_id, turns, started_at, ended_at FROM calls
               WHERE id = :id AND agent_id = :agent AND from_e164 = 'demo'""",
            id=call_id,
            agent=agent_id(),
        )


def open_demo_call(agent: dict[str, Any], lang: str) -> str:
    cutoff = to_iso(datetime.now(UTC) - timedelta(milliseconds=IDLE_MS))
    with db.connect() as conn:
        abandoned = db.fetch_all(
            conn,
            """SELECT c.id FROM calls c
               WHERE c.agent_id = :agent AND c.from_e164 = 'demo' AND c.ended_at IS NULL
                 AND COALESCE((SELECT MAX(t.created_at) FROM turns t WHERE t.call_id = c.id), c.started_at)
                     < :cutoff""",
            agent=agent["id"],
            cutoff=cutoff,
        )
    for call in abandoned:
        close_demo_call(call["id"], "abandoned")

    return start_call(
        tenant_id=agent["tenant_id"],
        agent_id=agent["id"],
        from_="demo",
        to="demo",
        caller_name="Demo",
        channel="web",
        direction="outbound",
        language=lang,
    )


def live_demo_call(call_id: str) -> dict[str, Any] | None:
    """A demo call that may take another turn, or None once it is over."""
    call = _find_demo_call(call_id)
    if not call or call["ended_at"]:
        return None
    if call["turns"] >= MAX_TURNS or now_ms() - iso_ms(call["started_at"]) > MAX_AGE_MS:
        close_demo_call(call_id)
        return None
    return call


def close_ended_call(call: dict[str, Any] | None, call_id: str, outcome: str) -> None:
    """End a demo call (bank or logistics). Unlike `end_call`, nothing is billed: demo minutes are free."""
    if not call or call["ended_at"]:
        return
    with db.connect() as conn:
        last = db.fetch_one(conn, "SELECT MAX(created_at) AS at FROM turns WHERE call_id = :id", id=call_id)
    at = last["at"] if last else None
    ended_at = at if at is not None else now_iso()
    duration_ms = max(1000, iso_ms(ended_at) - iso_ms(call["started_at"]))
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE calls SET status = 'completed', outcome = :outcome, ended_at = :ended, duration_ms = :ms
               WHERE id = :id AND ended_at IS NULL""",
            outcome=outcome,
            ended=ended_at,
            ms=duration_ms,
            id=call_id,
        )
    publish(
        call["tenant_id"],
        {"type": "call_ended", "callId": call_id, "outcome": outcome, "durationMs": duration_ms, "csat": None},
    )


def close_demo_call(call_id: str, outcome: str = "resolved_by_ai") -> None:
    """End a demo call. Unlike `end_call`, nothing is billed: demo minutes are free."""
    close_ended_call(_find_demo_call(call_id), call_id, outcome)


def claim_call(call_id: str) -> bool:
    """One turn at a time per call: two in flight would interleave the transcript."""
    if call_id in _busy:
        return False
    _busy.add(call_id)
    return True


def release_call(call_id: str) -> None:
    _busy.discard(call_id)


# ── the opening line ────────────────────────────────────────────────

# What the visitor "says" on picking up — the caller's side of a real call.
PICKUP = {"uz": "Allo", "ru": "Алло"}

FALLBACK_OPENING = {
    "uz": f"Assalomu alaykum! {DEMO_IDENTITY['org']['uz']}dan qoʻngʻiroq qilyapman. "
    f"{DEMO_PERSONA['name']['uz']} bilan gaplashyapmanmi? Iltimos, tugʻilgan yilingizni ayting.",
    # The name is declined here ("с Азизом Каримовым"), so it is not interpolated.
    "ru": f"Здравствуйте! Вас беспокоит {DEMO_IDENTITY['org']['ru']}. "
    "Я говорю с Азизом Каримовым? Пожалуйста, назовите год вашего рождения.",
}


def _js_str(value: object) -> str:
    """`${value}` for a database value."""
    return "null" if value is None else str(value)


def opening_key(agent: dict[str, Any], lang: str) -> str:
    # Today's date is part of the loan-call prompt, so the opening can change daily.
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    return f"{agent['id']}:{_js_str(agent['updated_at'])}:{lang}:{today}"


async def opening_line(agent: dict[str, Any], lang: str) -> str:
    """
    The agent's first line once the visitor picks up. Generated by the model once and then reused,
    so picking up is instant instead of a model round-trip — and its audio, rendered once, comes
    straight from the TTS disk cache.
    """
    key = opening_key(agent, lang)
    task = _openings.get(key)
    if task is None:

        async def make() -> str:
            out = await generate_answer(
                GenerateInput(
                    question=PICKUP[lang],
                    hits=[],
                    confidence=0,
                    language=lang,
                    agent_name=agent["name"],
                    threshold=agent["confidence_threshold"],
                    history=[],
                    persona=agent.get("persona"),
                    instructions=agent.get("instructions"),
                    target=demo_target(agent),
                    greeting=agent.get("greeting"),
                    time_zone=agent_hours(agent)["timezone"],
                    llm=agent_llm(agent),
                )
            )
            # The local engine is the no-model fallback and knows nothing of the borrower: use a
            # fixed line this time, and ask the model again next call.
            if out["engine"] == "local":
                if _openings.get(key) is task:
                    del _openings[key]
                return FALLBACK_OPENING[lang]
            return out["answer"]

        task = asyncio.get_running_loop().create_task(make())
        _openings[key] = task

        def forget_failure(t: asyncio.Task) -> None:
            if (t.cancelled() or t.exception() is not None) and _openings.get(key) is t:
                del _openings[key]

        task.add_done_callback(forget_failure)
    return await asyncio.shield(task)


def seed_opening(agent: dict[str, Any], call_id: str, lang: str, text: str) -> None:
    """Record the pickup and the opening as the call's first exchange, as `run_turn` would."""
    stamp = now_iso()
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
               VALUES (:id, :t, :c, 0, 'caller', :text, :lang, :at)""",
            id=new_id("trn"),
            t=agent["tenant_id"],
            c=call_id,
            text=PICKUP[lang],
            lang=lang,
            at=stamp,
        )
        db.execute(
            tx,
            """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
               VALUES (:id, :t, :c, 1, 'agent', :text, :lang, :at)""",
            id=new_id("trn"),
            t=agent["tenant_id"],
            c=call_id,
            text=text,
            lang=lang,
            at=stamp,
        )
        db.execute(
            tx,
            """UPDATE calls SET turns = turns + 1, language = :lang,
                 status = CASE WHEN status = 'ringing' THEN 'active' ELSE status END,
                 answered_at = COALESCE(answered_at, :at)
               WHERE id = :id""",
            lang=lang,
            at=stamp,
            id=call_id,
        )
    publish(
        agent["tenant_id"],
        {
            "type": "turn",
            "callId": call_id,
            "utterance": PICKUP[lang],
            "reply": text,
            "confidence": 1,
            "escalated": False,
            "latencyMs": 0,
        },
    )


# ── the agent's voice ───────────────────────────────────────────────


def demo_voices(agent: dict[str, Any]) -> list[dict[str, str]]:
    """Voices a visitor may pick: the built-in speakers plus the bank's own saved voices."""
    return [
        *({"id": v["id"], "name": v["name"], "group": "builtin"} for v in VOICES),
        *({"id": v["id"], "name": v["name"], "group": v["mode"]} for v in list_custom_voices(agent["tenant_id"])),
    ]


def demo_voice(agent: dict[str, Any], requested: object) -> str:
    """
    The voice a request asked for, when it is one of `demo_voices`; otherwise the agent's own. The
    id arrives from a public page, so it is checked against the list rather than handed to the TTS
    layer as-is.
    """
    want = js_trim(requested) if isinstance(requested, str) else ""
    return want if want and any(v["id"] == want for v in demo_voices(agent)) else agent["voice_id"]


def voice_options(agent: dict[str, Any], lang: str, voice_id: str | None = None) -> SynthOptions:
    # Cached: in a scripted call the same sentences recur ("Tasdiqlaganingiz uchun rahmat."), and a
    # cache hit is a file read instead of a render.
    return SynthOptions(
        tenant_id=agent["tenant_id"],
        voice_id=agent["voice_id"] if voice_id is None else voice_id,
        language=lang,
        tag="demo",
        cache=True,
        speed=speaking_speed(agent),
    )


def warm_demo(agent: dict[str, Any]) -> None:
    """
    Render both openings ahead of the first visitor, so even their pickup is instant. One language
    after the other: rendering both at once would crowd the TTS server just as a visitor might be
    picking up.
    """
    pending = [lang for lang in ("uz", "ru") if opening_key(agent, lang) not in _warmed]
    if not pending:
        return
    for lang in pending:
        _warmed.add(opening_key(agent, lang))

    async def warm() -> None:
        for lang in pending:
            try:
                text = await opening_line(agent, lang)
                if not tts_configured():
                    continue
                async with aclosing(synthesize_stream(text, voice_options(agent, lang))) as pieces:
                    async for _pcm in pieces:
                        pass
            except Exception as err:  # noqa: BLE001
                _warmed.discard(opening_key(agent, lang))
                log.warning("[demo] warm-up failed: %s", err)
        # Then the fillers, which are only ever played from the cache.
        for lang in pending if fillers_enabled() else []:
            for line in filler_lines(lang):
                with contextlib.suppress(Exception):  # `.catch(() => null)`
                    await synthesize_pcm(line, voice_options(agent, lang))

    background.spawn(warm())


# Turns where "let me check" would be absurd: hello, yes, thanks, goodbye.
NO_FILLER = {"greeting", "goodbye", "affirm", "human"}


def _b64(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode("ascii")


def filler_for(agent: dict[str, Any], call_id: str, heard: str, voice_id: str | None = None) -> str | None:
    """
    A short "bir daqiqa" while the agent thinks. Without one the line goes quiet for the seconds the
    model and the voice take, and on a call silence sounds like a dropped line. Lines rotate so none
    repeats back to back, and only a cached rendering is ever used: rendering one now would queue in
    front of the real answer on the TTS server, which works one request at a time.
    """
    if not fillers_enabled() or not tts_configured() or classify_intent(heard) in NO_FILLER:
        return None
    language = detect_language(heard)
    lines = filler_lines(language)
    turn = _fillers.get(call_id, 0)
    # Fillers are pre-rendered in the agent's own voice only; a visitor's other pick simply gets no
    # filler rather than a mismatched one.
    pcm = cached_pcm(lines[turn % len(lines)], voice_options(agent, language, voice_id))
    if not pcm:
        return None
    _fillers[call_id] = turn + 1
    if len(_fillers) > 2000:
        _fillers.clear()
    return _b64(pcm)


# ── the wire format (see src/lib/demo-shared.ts) ────────────────────

Send = Callable[[dict], None]


class Signal:
    """AbortSignal: set once the visitor hangs up or talks over the agent."""

    def __init__(self) -> None:
        self.aborted = False

    def abort(self) -> None:
        self.aborted = True


NDJSON_HEADERS = {
    "Cache-Control": "no-store, no-transform",
    # nginx buffers proxied responses by default, which would hold every sentence of audio back
    # until the last one had rendered.
    "X-Accel-Buffering": "no",
}


def event_stream(work: Callable[[Send, Signal], Awaitable[None]]) -> StreamingResponse:
    """
    Newline-delimited JSON events from `work(send, signal)`. When the visitor goes away the signal
    is aborted and further events are dropped; the work itself carries on.
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
            log.warning("[demo] request failed: %s", err, exc_info=True)
            send({"t": "error", "code": "server"})
        finally:
            queue.put_nowait(None)

    async def body() -> AsyncIterator[bytes]:
        background.spawn(runner())
        try:
            while (item := await queue.get()) is not None:
                yield item
        finally:
            # The visitor hung up or talked over the agent: stop rendering its voice.
            signal.abort()

    return StreamingResponse(body(), media_type="application/x-ndjson; charset=utf-8", headers=NDJSON_HEADERS)


async def speak(
    agent: dict[str, Any], text: str, lang: str, send: Send, signal: Signal, voice_id: str | None = None
) -> None:
    """Stream the agent's voice for `text`, sentence by sentence."""
    if not tts_configured():
        send({"t": "voice", "ok": False})
        return
    sent = 0
    try:
        async with aclosing(synthesize_stream(text, voice_options(agent, lang, voice_id))) as pieces:
            async for pcm in pieces:
                if signal.aborted:
                    break
                send({"t": "audio", "pcm": _b64(pcm)})
                sent += 1
    except Exception as err:  # noqa: BLE001
        log.warning("[demo] tts failed: %s", err)
    # Nothing rendered: the browser speaks the line itself rather than go silent.
    if not sent and not signal.aborted:
        send({"t": "voice", "ok": False})


_SENTENCE_END = re.compile(f"[.!?…]+(?=[{JS_S}])")


class SpeakAsWritten:
    """
    Voice a reply while the model is still writing it. Each complete sentence goes to the TTS as
    soon as the voice is free, so the visitor hears the first one while the rest is generated. The
    text shown grows with what is voiced: `reply` with the first sentence, then `more` with each
    next one. `push` each delta; `await finish(reply)` once the reply is complete.
    """

    def __init__(
        self, agent: dict[str, Any], lang: str, send: Send, signal: Signal, voice_id: str | None = None
    ) -> None:
        self.agent, self.lang, self.send, self.signal = agent, lang, send, signal
        self.voice_id = agent["voice_id"] if voice_id is None else voice_id
        self.text = ""
        self.taken = 0  # how much of `text` has been handed to the voice
        self.finished = False
        self.shown = False
        self.sent = 0
        self._wake = asyncio.Event()
        self._worker = asyncio.get_running_loop().create_task(self._run())

    def _next_segment(self) -> str | None:
        """The next run of complete sentences, or None to wait for more text."""
        rest = self.text[self.taken :]
        if self.finished:
            self.taken = len(self.text)
            return js_trim(rest) or None
        ends = list(_SENTENCE_END.finditer(rest))
        if not ends:
            return None
        cut = ends[-1].end()
        # A lone "Ha." sounds clipped on its own; it waits for the next sentence.
        if utf16_len(js_trim(rest[:cut])) < 12:
            return None
        self.taken += cut
        return js_trim(rest[:cut])

    async def _run(self) -> None:
        while True:
            if self.signal.aborted:
                return
            segment = self._next_segment()
            if not segment:
                if self.finished:
                    return
                self._wake.clear()
                await self._wake.wait()
                continue
            said = js_trim(self.text[: self.taken])
            self.send(
                {"t": "more", "text": said}
                if self.shown
                else {"t": "reply", "text": said, "lang": self.lang, "end": None}
            )
            self.shown = True
            if not tts_configured():
                continue
            try:
                opts = voice_options(self.agent, self.lang, self.voice_id)
                async with aclosing(synthesize_stream(segment, opts)) as pieces:
                    async for pcm in pieces:
                        if self.signal.aborted:
                            break
                        self.send({"t": "audio", "pcm": _b64(pcm)})
                        self.sent += 1
            except Exception as err:  # noqa: BLE001
                log.warning("[demo] tts failed: %s", err)

    def push(self, delta: str) -> None:
        if self.finished:
            return
        self.text = self.text + delta if self.taken else js_trim_start(self.text + delta)
        self._wake.set()

    async def finish(self, reply: str) -> None:
        """The reply is complete; returns once all of it has been voiced."""
        # The final reply begins with what streamed (see `generate_answer`); when nothing streamed
        # it is the whole reply, voiced the old way.
        if not js_trim(self.text) or reply.startswith(js_trim_end(self.text)):
            self.text = reply
        self.finished = True
        self._wake.set()
        await self._worker
        if not self.sent and self.shown and not self.signal.aborted:
            self.send({"t": "voice", "ok": False})


# ── reading a request as the Fetch API does ─────────────────────────


def _reject_constant(name: str) -> None:
    raise ValueError(f"not JSON: {name}")


def parse_json(raw: bytes) -> Any:
    """`JSON.parse(await request.text())`: UTF-8 (BOM dropped), strict JSON — NaN/Infinity are errors."""
    text = raw.decode("utf-8", errors="replace").removeprefix("﻿")
    return json.loads(text, parse_constant=_reject_constant)


async def json_body(request: Request) -> Any:
    """`await request.json().catch(() => ({}))`."""
    try:
        return parse_json(await request.body())
    except Exception:  # noqa: BLE001 - any failure reads as `{}`
        return {}


def prop(body: Any, name: str) -> Any:
    """`body[name]` in JavaScript: a TypeError on null (the TypeScript route crashed), undefined on non-objects."""
    if body is None:
        raise TypeError(f"Cannot read properties of null (reading '{name}')")
    return body.get(name) if isinstance(body, dict) else None


async def form_data(request: Request) -> FormData | None:
    """
    `await request.formData()`, or None where it throws: a body that is not multipart/form-data or
    urlencoded, or that does not parse. (Starlette alone would hand back an empty form instead.)
    """
    essence = (request.headers.get("content-type") or "").split(";")[0].strip(" \t\r\n").lower()
    if essence not in ("multipart/form-data", "application/x-www-form-urlencoded"):
        return None
    try:
        return await request.form()
    except Exception:  # noqa: BLE001
        return None


def form_get(form: FormData, name: str) -> Any:
    """`form.get(name)`: the first value under that name, or None."""
    values = form.getlist(name)
    return values[0] if values else None


def form_string(value: Any) -> str:
    """`String(value ?? '')` for a form value."""
    if value is None:
        return ""
    if isinstance(value, UploadFile):
        return "[object File]"
    return str(value)


def first_query(request: Request, name: str) -> str | None:
    """`new URL(request.url).searchParams.get(name)`: the first value."""
    values = request.query_params.getlist(name)
    return values[0] if values else None


# About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s.
MAX_AUDIO_BYTES = 1_400_000


def utterance_file(value: Any) -> UploadFile | None:
    """The recorded utterance, when the form carries a non-empty file of at most MAX_AUDIO_BYTES."""
    if isinstance(value, UploadFile) and value.size and value.size <= MAX_AUDIO_BYTES:
        return value
    return None


# ── transcribing during the pause ───────────────────────────────────

PREFETCH_TTL_MS = 20_000


def audio_key(audio: bytes, lang: str) -> str:
    return f"{lang}:{hashlib.sha1(audio).hexdigest()}"


def quiet(task: asyncio.Task) -> None:
    """`transcript.catch(() => {})`: a failure is retried by the turn itself."""
    if not task.cancelled():
        task.exception()


def remember_prefetch(heard: dict[str, dict[str, Any]], call_id: str, key: str, task: asyncio.Task) -> None:
    task.add_done_callback(quiet)
    heard[call_id] = {"key": key, "at": now_ms(), "transcript": task}
    if len(heard) > 500:
        stale = now_ms() - PREFETCH_TTL_MS
        for cid in [c for c, entry in heard.items() if entry["at"] < stale]:
            del heard[cid]


async def take_prefetch(heard: dict[str, dict[str, Any]], call_id: str, key: str) -> Transcript | None:
    """The prefetched transcript when it matches these bytes and is fresh; None to transcribe again."""
    entry = heard.pop(call_id, None)
    if entry and entry["key"] == key and now_ms() - entry["at"] < PREFETCH_TTL_MS:
        try:
            return await entry["transcript"]
        except Exception:  # noqa: BLE001 - transcribe again below
            return None
    return None


def prefetch_heard(call_id: str, audio: bytes, lang: str, words: list[str] | None = None) -> None:
    """
    Start transcribing an utterance the page offered at an early pause (see EARLY_SILENCE_MS). If
    the pause holds, the turn arrives with the same bytes and picks the transcript up — already
    done, or well under way.
    """
    task = asyncio.get_running_loop().create_task(transcribe(audio, language=lang, clean=True, vocabulary=words))
    remember_prefetch(_heard, call_id, audio_key(audio, lang), task)


async def heard_in(call_id: str, audio: bytes, lang: str, words: list[str] | None = None) -> Transcript:
    """What the visitor said: the prefetched transcript when it matches, else a fresh one."""
    found = await take_prefetch(_heard, call_id, audio_key(audio, lang))
    if found is not None:
        return found
    return await transcribe(audio, language=lang, clean=True, vocabulary=words)
