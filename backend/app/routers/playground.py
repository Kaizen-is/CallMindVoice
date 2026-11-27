"""
The console Playground's voice call, served by Python — ports of
src/app/api/playground/{call,turn,end}/route.ts. Through the Next.js rewrite
they are /api/core/playground/*; the page uses them when its URL has `?py=1`.

Each call/turn answers with newline-delimited JSON (see `event_stream`):

  call  → call, reply, audio…|voice:false, done      (or call, done: no greeting)
  turn  → heard, filler?, reply, audio…, more…, final, detail, done
          (error {code: stt} when the recogniser fails; error {code: server} on a crash)
"""

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from app.auth import LoggedIn, Session
from app.engine.conversation import run_turn
from app.engine.live_turn import playground_turn
from app.jscompat import js_round, js_trim, utf16_slice
from app.playground import (
    call_lang,
    close_playground_call,
    open_playground_call,
    owned_playground_call,
    playground_agent,
    playground_opening,
    seed_opening,
    turn_detail,
)
from app.playground_voice import (
    Send,
    Signal,
    SpeakAsWritten,
    SpeakOptions,
    begin_turn_control,
    claim_call,
    cut_turn,
    drop_early,
    event_stream,
    filler_for,
    heard_in,
    log,
    prefetch_heard,
    release_call,
    speak,
    speaking_agent,
    start_early,
    stt_pick,
    take_early,
    voice_pick,
    warm_fillers,
)
from app.rag.text import detect_language
from app.speech.numbers import uzbek_numbers_to_digits
from app.speech.vocabulary import recognition_words
from app.turn_timings import latest_agent_turn, parse_body, save_laps, save_promise, summary

router = APIRouter(prefix="/playground")

# About 40 s of 16 kHz mono speech; the recorder stops itself at 30 s.
MAX_AUDIO_BYTES = 1_400_000


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def _string(value: object) -> str:
    """`String(form.get(name) ?? '')`."""
    if value is None:
        return ""
    if isinstance(value, UploadFile):
        return "[object File]"
    return str(value)


@router.post("/call")
async def call(request: Request, session: LoggedIn) -> Response:
    """Picked up: open the call and stream its id, the agent's opening line and that line's voice."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - `request.json().catch(() => ({}))`
        body = {}
    if not isinstance(body, dict):
        body = {}
    tenant_id = session.tenant["id"]
    saved = playground_agent(tenant_id, body.get("agentId"))
    if not saved:
        return _error("no_agent", 404)

    lang = call_lang(body.get("lang"), saved)
    pick = voice_pick(saved, body.get("ttsEngine"), body.get("voice"))
    # Introduces itself by the name of the voice the caller hears (see speaking_agent).
    agent = speaking_agent(saved, pick)
    call_id = await asyncio.to_thread(open_playground_call, tenant_id, session.user["name"], agent, lang)
    warm_fillers(agent, lang, pick)

    async def work(send: Send, signal: Signal) -> None:
        send({"t": "call", "callId": call_id})
        text = await playground_opening(agent, lang)
        if not text:
            # No greeting saved: the line is simply open for the caller to speak first.
            send({"t": "done"})
            return
        await asyncio.to_thread(seed_opening, agent, call_id, lang, text)
        send({"t": "reply", "text": text, "lang": lang, "end": None})
        await speak(agent, text, lang, pick, send, signal)
        send({"t": "done"})

    return event_stream(work)


@router.post("/turn")
async def turn(request: Request, session: LoggedIn) -> Response:
    """
    One spoken turn in one round trip. `?prefetch=1`: the caller paused — start on the phrase now
    (202): transcribe the recording, or take the words the live STT settled (`text`), and begin the
    answer (app/engine/early.py); the turn that follows uses both when its input is the same. Form
    field `legacy=1` voices the turn as before the latency work. The `final` event's `ms` carries the
    turn's marks, in ms from when the request was read (`early`: 1 when the early answer was used).
    """
    prefetch = request.query_params.get("prefetch") == "1"
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error("bad_request", 400)
    out = await turn_core(form, session, prefetch)
    return out if isinstance(out, Response) else event_stream(out)


async def turn_core(form, session: Session, prefetch: bool) -> Response | Callable:  # noqa: ANN001
    """
    The turn behind `POST /turn`, from its fields (a form, or the WebSocket's message, L2): an error or
    the 202 of a prefetch as a Response, else the turn's `work(send, signal)` to run and stream.
    """
    tenant_id = session.tenant["id"]
    audio = form.get("audio")
    call_id = _string(form.get("callId"))
    # Streaming STT (Zipformer) transcribes in the browser's call while the caller speaks; the
    # phrase then arrives as text and needs no STT pass here.
    streamed = utf16_slice(js_trim(_string(form.get("text"))), 0, 2000)
    has_audio = isinstance(audio, UploadFile) and 0 < (audio.size or 0) <= MAX_AUDIO_BYTES
    if not streamed and not has_audio:
        return _error("bad_audio", 400)
    owned = owned_playground_call(tenant_id, call_id)
    if not owned or owned["ended_at"]:
        return _error("ended", 410)
    saved = playground_agent(tenant_id, owned["agent_id"])
    if not saved:
        return _error("no_agent", 404)

    lang = call_lang(form.get("lang"), saved)
    fast = _string(form.get("legacy")) != "1"
    stt = stt_pick(form.get("sttEngine"))
    wav = await audio.read() if has_audio else b""  # type: ignore[union-attr]
    pick = voice_pick(saved, form.get("ttsEngine"), form.get("voice"))
    agent = speaking_agent(saved, pick)
    if prefetch:
        # The words exactly as the turn will take them (see `heard` below), so the answer can match.
        def begin(words: str) -> None:
            start_early(call_id, tenant_id, agent, words, fast)

        if not streamed and not has_audio:
            return _error("bad_audio", 400)
        with playground_turn():  # the early answer is a Playground turn too (app.engine.live_turn)
            if streamed:
                begin(uzbek_numbers_to_digits(streamed))
            else:
                prefetch_heard(call_id, wav, lang, stt, recognition_words(tenant_id, saved), then=begin)
        return Response(status_code=202)
    if not claim_call(call_id):
        return _error("busy_call", 409)

    async def work(send: Send, signal: Signal) -> None:
        with playground_turn():
            await turn_work(send, signal)

    async def turn_work(send: Send, signal: Signal) -> None:
        # The lock guards the transcript, not the voice: released once the turn is written down,
        # so talking over the reply is never refused.
        stt_ms = 0
        result: dict[str, Any] | None = None
        voice: SpeakAsWritten | None = None
        early = None
        turn_id: str | None = None
        control = begin_turn_control(call_id)  # Q7: a talk-over stops this turn (POST /playground/cut)
        filler_sent = False
        started = time.perf_counter()
        marks: dict[str, int] = {}

        def mark(key: str) -> None:
            if key not in marks:
                marks[key] = js_round((time.perf_counter() - started) * 1000)

        try:
            try:
                heard = (
                    {"text": uzbek_numbers_to_digits(streamed), "engine": "local", "language": lang}
                    if streamed
                    else await heard_in(call_id, wav, lang, stt, recognition_words(tenant_id, saved))
                )
            except Exception as err:  # noqa: BLE001
                # The recogniser failed (down, unreachable, bad key): say so plainly, so the page
                # can tell the caller which part broke.
                log.warning("[playground] stt failed: %s", err)
                send({"t": "error", "code": "stt"})
                return
            stt_ms = js_round((time.perf_counter() - started) * 1000)
            # Taken once the words are known: a recording sent ahead may only now have been heard
            # and its answer begun (prefetch → start_early). run_turn decides whether it matches.
            early = take_early(call_id)
            send({"t": "heard", "text": heard["text"]})
            if heard["text"]:
                filler = filler_for(agent, call_id, heard["text"], pick)
                if filler:
                    filler_sent = True
                    send({"t": "filler", **filler})
                speaker = SpeakAsWritten(
                    agent,
                    detect_language(heard["text"]),
                    pick,
                    send,
                    signal,
                    SpeakOptions(
                        fast=fast,
                        on_first_segment=lambda: mark("firstSegment"),
                        on_first_audio=lambda: mark("firstAudio"),
                    ),
                )
                voice = speaker

                def on_delta(delta: str) -> None:
                    mark("llmFirst")
                    speaker.push(delta)

                result = await run_turn(
                    tenant_id=tenant_id,
                    call_id=call_id,
                    agent=agent,
                    utterance=heard["text"],
                    stt_ms=stt_ms,
                    stream_llm=fast,
                    on_delta=on_delta,
                    early=early,
                    stop=control.stop,
                )
                # The turn's own row, read while the call is still locked by it (laps are saved there).
                turn_id = latest_agent_turn(call_id)
                control.turn_id = turn_id
        finally:
            control.done.set()
            release_call(call_id)
            if early is not None and not early.adopted:
                early.cancel()
        if not result or not voice:
            if voice:
                await voice.finish("")
            send({"t": "done"})
            return

        await voice.finish(result["reply"])
        ms = {
            "stt": stt_ms,
            "retrieval": result["timings"]["retrievalMs"],
            "llm": result["timings"]["llmMs"],
            **marks,
            "fast": 1 if fast else 0,
            "early": 1 if early is not None and early.adopted else 0,
        }
        # L7: SQLite writes off the event loop (each commit froze every other call on the server).
        await asyncio.to_thread(
            save_laps,
            tenant_id,
            call_id,
            turn_id,
            {**{f"srv_{k}": v for k, v in ms.items()}, "srv_filler": 1 if filler_sent else 0},
            source="server",
            engines={"stt": stt, "tts": pick.engine, "llm": result.get("engine")},
        )
        if result.get("promise") and turn_id:
            await asyncio.to_thread(save_promise, tenant_id, call_id, turn_id, result["promise"])
        send({"t": "final", "text": result["reply"], "end": None, "ms": ms, "turn": turn_id})
        send({"t": "detail", "detail": turn_detail(result)})
        send({"t": "done"})

    return work


@router.post("/cut")
async def cut(request: Request, session: LoggedIn) -> Response:
    """
    The caller talked over the agent (Q7): the turn stops writing, and its reply is kept only as far as
    it was heard (`heard`: the share of the reply's audio that played, 0–1; 0 = not heard, not kept).
    """
    body = parse_body(await request.body())
    call_id = body.get("callId")
    heard = body.get("heard")
    if not isinstance(call_id, str) or not owned_playground_call(session.tenant["id"], call_id):
        return _error("not_found", 404)
    if isinstance(heard, bool) or not isinstance(heard, int | float) or not 0 <= heard <= 1:
        return _error("bad_request", 400)
    drop_early(call_id)
    return JSONResponse({"result": await cut_turn(session.tenant["id"], call_id, float(heard))})


@router.post("/timings")
async def timings(request: Request, session: LoggedIn) -> Response:
    """The page's own lap times of a voice turn (once its reply started playing): kept with the turn."""
    body = parse_body(await request.body())
    call_id = body.get("callId")
    if not isinstance(call_id, str) or not owned_playground_call(session.tenant["id"], call_id):
        return _error("not_found", 404)
    if not save_laps(session.tenant["id"], call_id, body.get("turnId"), body.get("laps"), source="browser"):
        return _error("not_found", 404)
    return Response(status_code=204)


@router.get("/timings")
async def timing_summary(request: Request, session: LoggedIn) -> Response:
    """Typical and worst time per step over the recent timed Playground turns (optionally one LLM / TTS)."""
    q = request.query_params
    return JSONResponse(summary(session.tenant["id"], llm=q.get("llm") or None, tts=q.get("tts") or None))


@router.post("/end")
async def end(request: Request, session: LoggedIn) -> Response:
    """Hang up: end and bill the call once. The body is parsed by hand, as the unload beacon may garble it."""
    call_id = ""
    try:
        body = json.loads(await request.body())
        call_id = body["callId"] if isinstance(body, dict) and isinstance(body.get("callId"), str) else ""
    except Exception:  # noqa: BLE001 - an empty or garbled beacon: nothing to end
        pass
    if call_id:
        drop_early(call_id)
        await asyncio.to_thread(close_playground_call, session.tenant["id"], call_id)
    return Response(status_code=204)
