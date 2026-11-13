"""
The console Playground's voice call, served by Python — ports of
src/app/api/playground/{call,turn,end}/route.ts. Through the Next.js rewrite
they are /api/core/playground/*; the page uses them when its URL has `?py=1`.

Each call/turn answers with newline-delimited JSON (see `event_stream`):

  call  → call, reply, audio…|voice:false, done      (or call, done: no greeting)
  turn  → heard, filler?, reply, audio…, more…, final, detail, done
          (error {code: stt} when the recogniser fails; error {code: server} on a crash)
"""

import json
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from app.auth import LoggedIn
from app.engine.conversation import run_turn
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
    claim_call,
    event_stream,
    filler_for,
    heard_in,
    log,
    prefetch_heard,
    release_call,
    speak,
    speaking_agent,
    stt_pick,
    voice_pick,
    warm_fillers,
)
from app.rag.text import detect_language
from app.speech.numbers import uzbek_numbers_to_digits

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
    call_id = open_playground_call(tenant_id, session.user["name"], agent, lang)
    warm_fillers(agent, lang, pick)

    async def work(send: Send, signal: Signal) -> None:
        send({"t": "call", "callId": call_id})
        text = await playground_opening(agent, lang)
        if not text:
            # No greeting saved: the line is simply open for the caller to speak first.
            send({"t": "done"})
            return
        seed_opening(agent, call_id, lang, text)
        send({"t": "reply", "text": text, "lang": lang, "end": None})
        await speak(agent, text, lang, pick, send, signal)
        send({"t": "done"})

    return event_stream(work)


@router.post("/turn")
async def turn(request: Request, session: LoggedIn) -> Response:
    """
    One spoken turn in one round trip. `?prefetch=1`: the caller paused — transcribe now (202) and
    keep it for the turn that follows. Form field `legacy=1` voices the turn as before the latency
    work. The `final` event's `ms` carries the turn's marks, in ms from when the request was read.
    """
    prefetch = request.query_params.get("prefetch") == "1"
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error("bad_request", 400)
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
    if prefetch:
        if not has_audio:
            return _error("bad_audio", 400)
        prefetch_heard(call_id, wav, lang, stt)
        return Response(status_code=202)
    pick = voice_pick(saved, form.get("ttsEngine"), form.get("voice"))
    agent = speaking_agent(saved, pick)
    if not claim_call(call_id):
        return _error("busy_call", 409)

    async def work(send: Send, signal: Signal) -> None:
        # The lock guards the transcript, not the voice: released once the turn is written down,
        # so talking over the reply is never refused.
        stt_ms = 0
        result: dict[str, Any] | None = None
        voice: SpeakAsWritten | None = None
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
                    else await heard_in(call_id, wav, lang, stt)
                )
            except Exception as err:  # noqa: BLE001
                # The recogniser failed (down, unreachable, bad key): say so plainly, so the page
                # can tell the caller which part broke.
                log.warning("[playground] stt failed: %s", err)
                send({"t": "error", "code": "stt"})
                return
            stt_ms = js_round((time.perf_counter() - started) * 1000)
            send({"t": "heard", "text": heard["text"]})
            if heard["text"]:
                filler = filler_for(agent, call_id, heard["text"], pick)
                if filler:
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
                )
        finally:
            release_call(call_id)
        if not result or not voice:
            if voice:
                await voice.finish("")
            send({"t": "done"})
            return

        await voice.finish(result["reply"])
        send(
            {
                "t": "final",
                "text": result["reply"],
                "end": None,
                "ms": {
                    "stt": stt_ms,
                    "retrieval": result["timings"]["retrievalMs"],
                    "llm": result["timings"]["llmMs"],
                    **marks,
                    "fast": 1 if fast else 0,
                },
            }
        )
        send({"t": "detail", "detail": turn_detail(result)})
        send({"t": "done"})

    return event_stream(work)


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
        close_playground_call(session.tenant["id"], call_id)
    return Response(status_code=204)
