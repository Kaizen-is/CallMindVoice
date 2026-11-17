"""
The public bank demo, served by Python — ports of src/app/api/demo/{call,turn,end}/route.ts
(no login; per-address rate limits, see `app.demo.admit`) and the data the /demo page loads
(`GET /views/demo`, which also warms the openings' voice as the page did).

Each call/turn answers with newline-delimited JSON (see `app.demo.event_stream`):

  call → call, reply, audio…|voice:false, done
  turn → heard, filler?, reply, audio…, more…, final, done     (error {code: server} on a crash)
"""

import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.background import BackgroundTask

from app.demo import (
    DEMO_IDENTITY,
    DEMO_PERSONA,
    Send,
    Signal,
    SpeakAsWritten,
    admit,
    claim_call,
    close_demo_call,
    demo_agent,
    demo_lang,
    demo_target,
    demo_voice,
    demo_voices,
    event_stream,
    filler_for,
    first_query,
    form_data,
    form_get,
    form_string,
    heard_in,
    json_body,
    live_demo_call,
    open_demo_call,
    opening_line,
    parse_json,
    prefetch_heard,
    prop,
    release_call,
    seed_opening,
    speak,
    utterance_file,
    warm_demo,
)
from app.engine.conversation import run_turn
from app.jscompat import js_round
from app.rag.text import detect_language
from app.views_common import js_response

router = APIRouter()


def error(code: str, status: int) -> JSONResponse:
    """`Response.json({ error: code }, { status })`."""
    return JSONResponse({"error": code}, status_code=status)


@router.post("/demo/call")
async def call(request: Request) -> Response:
    """The visitor has picked up: open a call and stream its id, the opening line and that line's voice."""
    if not admit("call", request):
        return error("busy", 429)
    agent = demo_agent()
    if not agent:
        return error("unavailable", 503)

    body = await json_body(request)
    if body is None:
        # `body.lang` of null: the TypeScript route crashed here, and Next.js answers an empty 500.
        return Response(status_code=500)
    lang = demo_lang(prop(body, "lang"))
    voice_id = demo_voice(agent, prop(body, "voice"))
    call_id = open_demo_call(agent, lang)

    async def work(send: Send, signal: Signal) -> None:
        send({"t": "call", "callId": call_id})
        text = await opening_line(agent, lang)
        seed_opening(agent, call_id, lang, text)
        send({"t": "reply", "text": text, "lang": lang, "end": None})
        await speak(agent, text, lang, send, signal, voice_id)
        send({"t": "done"})

    return event_stream(work)


@router.post("/demo/turn")
async def turn(request: Request) -> Response:
    """
    One spoken turn: the response streams what the STT heard, the agent's reply and the reply's
    voice, all in one round trip. `?prefetch=1`: the visitor has paused, probably at the end of the
    phrase — transcribe now (202) and keep it for the turn that follows.
    """
    prefetch = first_query(request, "prefetch") == "1"
    if not admit("prefetch" if prefetch else "turn", request):
        return error("busy", 429)
    agent = demo_agent()
    if not agent:
        return error("unavailable", 503)

    form = await form_data(request)
    if form is None:
        return error("bad_request", 400)
    audio = utterance_file(form_get(form, "audio"))
    call_id = form_string(form_get(form, "callId"))
    lang = demo_lang(form_get(form, "lang"))
    voice_id = demo_voice(agent, form_get(form, "voice"))
    if audio is None:
        return error("bad_audio", 400)
    if not live_demo_call(call_id):
        return error("ended", 410)

    wav = await audio.read()
    if prefetch:
        prefetch_heard(call_id, wav, lang)
        return Response(status_code=202)
    if not claim_call(call_id):
        return error("busy_call", 409)

    async def work(send: Send, signal: Signal) -> None:
        # The lock guards the transcript, not the voice: it is released as soon as the turn is
        # written down, so a visitor who talks over the reply is not refused while that reply is
        # still being voiced.
        stt_ms = 0
        result: dict[str, Any] | None = None
        voice: SpeakAsWritten | None = None
        try:
            started = time.perf_counter()
            heard = await heard_in(call_id, wav, lang)
            stt_ms = js_round((time.perf_counter() - started) * 1000)
            send({"t": "heard", "text": heard["text"]})
            if heard["text"]:
                filler = filler_for(agent, call_id, heard["text"], voice_id)
                if filler:
                    send({"t": "filler", "pcm": filler})
                # The reply is voiced sentence by sentence as the model writes it. Its language is
                # the one `run_turn` answers in: the caller's own.
                speaker = SpeakAsWritten(agent, detect_language(heard["text"]), send, signal, voice_id)
                voice = speaker
                result = await run_turn(
                    tenant_id=agent["tenant_id"],
                    call_id=call_id,
                    agent=agent,
                    utterance=heard["text"],
                    stt_ms=stt_ms,
                    target=demo_target(agent),
                    on_delta=speaker.push,
                )
        finally:
            release_call(call_id)
        if not result or not voice:
            # A turn that failed part-way still says what it had already written.
            if voice:
                await voice.finish("")
            send({"t": "done"})
            return

        # An escalation is a transfer to a human, who is not on this page: the agent says its
        # hand-off line and the call ends.
        end = "transfer" if result["escalate"] else None
        if end:
            close_demo_call(call_id, "resolved_by_operator")
        await voice.finish(result["reply"])
        send(
            {
                "t": "final",
                "text": result["reply"],
                "end": end,
                "ms": {"stt": stt_ms, "retrieval": result["timings"]["retrievalMs"], "llm": result["timings"]["llmMs"]},
            }
        )
        send({"t": "done"})

    return event_stream(work)


@router.post("/demo/end")
async def end(request: Request) -> Response:
    """Hang up. Also the target of the page's unload beacon (text/plain), so the body is parsed by hand."""
    call_id = ""
    try:
        cid = prop(parse_json(await request.body()), "callId")
        call_id = cid if isinstance(cid, str) else ""
    except Exception:  # noqa: BLE001, S110 - an empty or garbled beacon: nothing to end
        pass
    # Only ever touches demo calls of the demo agent; anything else is a no-op.
    if call_id:
        close_demo_call(call_id)
    return Response(status_code=204)


@router.get("/views/demo")
async def demo_view() -> Response:
    """
    What the /demo page renders from: whether the demo agent exists, how the page names it and its
    bank, the borrower the visitor plays and the voices on offer. Once answered, both opening lines
    (and the fillers) are rendered ahead of the visitor's tap, as the page's `after(warmDemo)` did.
    """
    agent = demo_agent()
    response = js_response(
        {
            "available": agent is not None,
            "identity": DEMO_IDENTITY,
            "persona": {"name": DEMO_PERSONA["name"], "birthYear": DEMO_PERSONA["birthYear"]},
            "voices": demo_voices(agent) if agent else [],
        }
    )
    if agent:

        async def warm() -> None:
            warm_demo(agent)

        response.background = BackgroundTask(warm)
    return response
