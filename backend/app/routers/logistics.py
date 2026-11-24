"""
The public logistics demo, served by Python — ports of
src/app/api/logistics/{call,turn,end}/route.ts (no login; the bank demo's rate limits and
per-call lock, shared with it) and the data the /logistics page loads (`GET /views/logistics`,
which also creates the demo's agent on first use and warms the greetings' voice, as the page did).

  call → call, reply, audio…|voice:false, done
  turn → heard, reply, audio…, more…, final, done     (no filler; an STT failure hears "")
"""

import logging
import time
from typing import Any

import regex as re
from fastapi import APIRouter, Request
from fastapi.responses import Response
from starlette.background import BackgroundTask

from app.demo import (
    Send,
    Signal,
    SpeakAsWritten,
    admit,
    claim_call,
    demo_lang,
    event_stream,
    first_query,
    form_data,
    form_get,
    form_string,
    json_body,
    parse_json,
    prop,
    release_call,
    speak,
    utterance_file,
)
from app.engine.conversation import run_turn
from app.jscompat import JS_S, js_round
from app.logistics import (
    LOGISTICS_VOICES,
    TRY_TRACKS,
    close_logistics_call,
    greeting_for,
    heard_in,
    live_logistics_call,
    logistics_agent,
    logistics_voice,
    open_logistics_call,
    prefetch_heard,
    seed_greeting,
    turn_context,
    warm_logistics,
)
from app.rag.text import detect_language
from app.routers.demo import error
from app.speech.gapi import gapi_configured
from app.views_common import js_response

log = logging.getLogger("callmind.logistics")

router = APIRouter()

_WORD_GAP = re.compile(f"[{JS_S}]+")


@router.post("/logistics/call")
async def call(request: Request) -> Response:
    """The visitor rings the company: open a call and stream its id, the greeting and its voice."""
    if not admit("call", request):
        return error("busy", 429)
    agent = logistics_agent()

    body = await json_body(request)
    if body is None:
        # `body.lang` of null: the TypeScript route crashed here, and Next.js answers an empty 500.
        return Response(status_code=500)
    lang = demo_lang(prop(body, "lang"))
    voice_id = logistics_voice(prop(body, "voice"))
    call_id = open_logistics_call(agent, lang)

    async def work(send: Send, signal: Signal) -> None:
        send({"t": "call", "callId": call_id})
        text = greeting_for(lang, voice_id)
        seed_greeting(agent, call_id, lang, text)
        send({"t": "reply", "text": text, "lang": lang, "end": None})
        await speak(agent, text, lang, send, signal, voice_id)
        send({"t": "done"})

    return event_stream(work)


@router.post("/logistics/turn")
async def turn(request: Request) -> Response:
    """
    One spoken turn: GAPI transcribes it (Russian: the app's own STT), the shipment the caller named
    is looked up, and the reply streams back with its voice. `?prefetch=1`: transcribe now (202)
    and keep it for the turn that follows.
    """
    prefetch = first_query(request, "prefetch") == "1"
    if not admit("prefetch" if prefetch else "turn", request):
        return error("busy", 429)
    agent = logistics_agent()

    form = await form_data(request)
    if form is None:
        return error("bad_request", 400)
    audio = utterance_file(form_get(form, "audio"))
    call_id = form_string(form_get(form, "callId"))
    lang = demo_lang(form_get(form, "lang"))
    voice_id = logistics_voice(form_get(form, "voice"))
    if audio is None:
        return error("bad_audio", 400)
    if not live_logistics_call(call_id):
        return error("ended", 410)

    wav = await audio.read()
    if prefetch:
        prefetch_heard(call_id, wav, lang)
        return Response(status_code=202)
    if not claim_call(call_id):
        return error("busy_call", 409)

    async def work(send: Send, signal: Signal) -> None:
        # Per-turn timing in the server log, to see where a slow reply spent its time.
        t0 = time.perf_counter()
        first_audio_ms = 0

        def timed_send(event: dict) -> None:
            nonlocal first_audio_ms
            if event["t"] == "audio" and not first_audio_ms:
                first_audio_ms = js_round((time.perf_counter() - t0) * 1000)
            send(event)

        stt_ms = 0
        result: dict[str, Any] | None = None
        voice: SpeakAsWritten | None = None
        try:
            started = time.perf_counter()
            try:
                heard = await heard_in(call_id, wav, lang)
            except Exception as err:  # noqa: BLE001
                log.warning("[logistics] stt failed: %s", err)
                heard = {"text": "", "engine": "none", "language": None}
            stt_ms = js_round((time.perf_counter() - started) * 1000)
            send({"t": "heard", "text": heard["text"]})
            if heard["text"]:
                # No "bir daqiqa" filler here: the reply itself is the first thing heard.
                speaker = SpeakAsWritten(agent, detect_language(heard["text"]), timed_send, signal, voice_id)
                voice = speaker
                result = await run_turn(
                    tenant_id=agent["tenant_id"],
                    call_id=call_id,
                    agent=agent,
                    utterance=heard["text"],
                    stt_ms=stt_ms,
                    context=turn_context(voice_id),
                    on_delta=speaker.push,
                )
        finally:
            release_call(call_id)
        if not result or not voice:
            if voice:
                await voice.finish("")
            send({"t": "done"})
            return

        # An explicit "give me a person" is a transfer to a human, who is not on this page: the
        # agent says its hand-off line and the call ends.
        end = "transfer" if result["escalate"] else None
        if end:
            close_logistics_call(call_id, "resolved_by_operator")
        await voice.finish(result["reply"])
        send(
            {
                "t": "final",
                "text": result["reply"],
                "end": end,
                "ms": {"stt": stt_ms, "retrieval": result["timings"]["retrievalMs"], "llm": result["timings"]["llmMs"]},
            }
        )
        log.info(
            "[logistics] turn %s: stt %s ms, llm %s ms, first audio %s ms, all voiced %s ms, %s words",
            call_id[-6:],
            stt_ms,
            result["timings"]["llmMs"],
            first_audio_ms,
            js_round((time.perf_counter() - t0) * 1000),
            len(_WORD_GAP.split(result["reply"])),
        )
        send({"t": "done"})

    return event_stream(work)


@router.post("/logistics/end")
async def end(request: Request) -> Response:
    """Hang up. Also the target of the page's unload beacon (text/plain), so the body is parsed by hand."""
    call_id = ""
    try:
        cid = prop(parse_json(await request.body()), "callId")
        call_id = cid if isinstance(cid, str) else ""
    except Exception:  # noqa: BLE001, S110 - an empty or garbled beacon: nothing to end
        pass
    # Only ever touches calls of the logistics demo agent; anything else is a no-op.
    if call_id:
        close_logistics_call(call_id)
    return Response(status_code=204)


@router.get("/views/logistics")
async def logistics_view(request: Request) -> Response:
    """
    What the /logistics page renders from: whether GAPI is set up (the call needs it), the two
    voices, the track numbers to try, and the voice `?voice=` picks (the page forwards it only when
    it is a single string). The demo's agent is created on first use; once answered, the greetings
    are rendered in both voices ahead of the visitor's tap, as the page's `after(warmLogistics)` did.
    """
    agent = logistics_agent()
    response = js_response(
        {
            "available": gapi_configured(),
            "voices": LOGISTICS_VOICES,
            "tracks": list(TRY_TRACKS),
            "initialVoice": logistics_voice(first_query(request, "voice")),
        }
    )

    async def warm() -> None:
        warm_logistics(agent)

    response.background = BackgroundTask(warm)
    return response
