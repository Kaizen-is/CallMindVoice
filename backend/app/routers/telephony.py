"""
The phone line — ports of src/app/api/telephony/bridge/{turn,filler,end}/route.ts.
The AudioSocket bridge (`telephony-bridge/`) calls them at /api/telephony/bridge/*,
which the Next.js rewrite forwards here (also reachable as /api/core/telephony/*).

  POST /telephony/bridge/turn    multipart {to, from, first?, callId?, spokenRatio?, audio?}
        first leg (first=true | no callId): start the call → the greeting, from the TTS cache
        later legs: STT → run_turn → the reply, streamed sentence by sentence
        → raw 8 kHz mono PCM (`audio/L16`) with x-ovoz-callid, x-ovoz-escalate,
          x-ovoz-text (base64 UTF-8) and x-ovoz-engine headers
  GET  /telephony/bridge/filler?to=&i=   a short holding line in the agent's voice (8 kHz PCM)
  POST /telephony/bridge/end     JSON {callId, durationSec?, outcome?} → closes the call row

Every route checks the shared `x-bridge-secret` first (`app.telephony.authorize_bridge`).
"""

import base64
import logging
import math
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import regex as re
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.datastructures import UploadFile

from app import db
from app.audio.pipeline import prepare_live
from app.engine.calls import end_call, start_call
from app.engine.conversation import run_turn
from app.env import env
from app.ids import parse_iso, to_iso
from app.jscompat import JS_S, js_json, js_json_parse, js_number, js_trim, js_utf8
from app.speech.fillers import filler_lines
from app.speech.stt import SttError, transcribe
from app.speech.tts import SynthOptions, TtsError, speaking_speed, synthesize_pcm, synthesize_stream
from app.speech.vocabulary import recognition_words
from app.telephony import BridgeTarget, authorize_bridge, resolve_target, secret_matches

log = logging.getLogger("callmind.bridge")

router = APIRouter(prefix="/telephony/bridge")

# Never hand empty text to the TTS service — fall back per spoken language.
GREETING_FALLBACK = {
    "uz": "Assalomu alaykum! Sizni tinglayapman.",
    "ru": "Здравствуйте! Чем могу помочь?",
    "en": "Hello! How can I help you?",
}

# Said when STT returns nothing intelligible — re-prompt without burning a turn.
REPROMPT = {
    "uz": "Uzr, eshitolmadim. Iltimos, takrorlang.",
    "ru": "Извините, я не расслышал. Повторите, пожалуйста.",
    "en": "Sorry, I didn't catch that — could you say it again?",
}

OUTCOMES = ("resolved_by_ai", "resolved_by_operator", "abandoned", "voicemail")

_WHITESPACE = re.compile(f"[{JS_S}]+")


def _error(body: dict[str, Any], status: int) -> JSONResponse:
    return JSONResponse(body, status_code=status)


def _field(value: object) -> str:
    """`typeof v === 'string' ? v : ''` — a file in a text field reads as ''."""
    return value if isinstance(value, str) else ""


def _first(values: Any, key: str) -> Any:
    """`form.get(key)` / `searchParams.get(key)`: the FIRST value of a repeated field (Starlette's `.get`
    returns the last), or None."""
    found = values.getlist(key)
    return found[0] if found else None


def _is_form(request: Request) -> bool:
    """`request.formData()` only parses these two bodies; anything else throws."""
    content_type = request.headers.get("content-type") or ""
    return "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type


# ── turn ────────────────────────────────────────────────────────────


@router.post("/turn")
async def turn(request: Request) -> Response:
    denied = authorize_bridge(request)
    if denied is not None:
        return denied
    if not _is_form(request):
        return _error({"error": "expected_multipart_form"}, 400)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error({"error": "expected_multipart_form"}, 400)

    to = _field(_first(form, "to"))
    from_ = _field(_first(form, "from"))
    first = _field(_first(form, "first")) == "true"
    call_id_in = _field(_first(form, "callId"))
    spoken_ratio = js_number(_field(_first(form, "spokenRatio")))
    audio_field = _first(form, "audio")
    audio = audio_field if isinstance(audio_field, UploadFile) else None

    target = resolve_target(to)
    if isinstance(target, JSONResponse):
        return target
    number, agent, lang = target.number, target.agent, target.language

    try:
        # ── First leg: open the call and greet. No STT on the opening leg. ──
        if first or not call_id_in:
            call_id = start_call(
                tenant_id=number["tenant_id"],
                agent_id=agent["id"],
                number_id=number["id"],
                from_=from_,
                to=to,
                language=lang,
                channel="voice",
            )
            greeting = js_trim(agent.get("greeting") or "") or GREETING_FALLBACK.get(lang) or GREETING_FALLBACK["uz"]
            # Identical on every call, so it comes from the TTS disk cache.
            pcm = await synthesize_pcm(greeting, _voice(target, lang, "greeting", cache=True))
            return _pcm_response(pcm, call_id=call_id, escalate="", text=greeting, engine="none")

        # ── Barge-in bookkeeping, before anything else touches the transcript. ──
        if 0 < spoken_ratio < 1:
            _truncate_last_agent_turn(number["tenant_id"], call_id_in, spoken_ratio)

        # ── Later legs need the caller's finished utterance. ──
        if audio is None:
            return _error({"error": "missing_audio"}, 400)

        t0 = time.perf_counter()
        # Phone audio is the noisiest the agent hears: cleaned first (a no-op without DENOISE_URL),
        # and the recognisers told which names and terms to expect.
        heard = await transcribe(
            # Voice isolation / server VAD when VOICE_ISOLATION_PHONE or SERVER_VAD is on (else as is).
            await prepare_live(await audio.read(), "phone"),
            language=lang,
            clean=True,
            vocabulary=recognition_words(number["tenant_id"], agent),
        )
        stt_ms = (time.perf_counter() - t0) * 1000

        # Nothing recognised — re-prompt without advancing the transcript (fixed text, a cache hit).
        if not heard["text"]:
            line = REPROMPT.get(lang) or REPROMPT["uz"]
            pcm = await synthesize_pcm(line, _voice(target, lang, "reprompt", cache=True))
            return _pcm_response(pcm, call_id=call_id_in, escalate="", text=line, engine=heard["engine"])

        # ── The turn engine: retrieval + generation + escalation + persistence. ──
        result = await run_turn(
            tenant_id=number["tenant_id"],
            call_id=call_id_in,
            agent=agent,
            utterance=heard["text"],
            stt_ms=stt_ms,
        )
        # On escalate the reply is already the spoken handoff line; the bridge plays it and hangs up.
        stream = synthesize_stream(result["reply"], _voice(target, result["language"], "reply", cache=False))
        return _stream_response(
            stream,
            call_id=call_id_in,
            escalate=result.get("escalate") or "",
            text=result["reply"],
            engine=heard["engine"],
        )
    except Exception as err:  # noqa: BLE001
        status = err.status if isinstance(err, TtsError | SttError) else 502
        message = str(err) or "bridge_error"
        log.warning("[bridge/turn] %s", message)
        return _error({"error": message}, status)


def _voice(target: BridgeTarget, language: str, tag: str, *, cache: bool) -> SynthOptions:
    return SynthOptions(
        tenant_id=target.number["tenant_id"],
        voice_id=target.agent.get("voice_id"),
        language=language,
        tag=tag,
        cache=cache,
        speed=speaking_speed(target.agent),
    )


def _truncate_last_agent_turn(tenant_id: str, call_id: str, ratio: float) -> None:
    """Cut the last agent turn down to the fraction the caller actually heard (word-proportional, with '…')."""
    with db.connect() as conn:
        row = db.fetch_one(
            conn,
            """SELECT id, text FROM turns WHERE tenant_id = :t AND call_id = :c AND role = 'agent'
               ORDER BY ordinal DESC LIMIT 1""",
            t=tenant_id,
            c=call_id,
        )
    if row is None:
        return
    words = [w for w in _WHITESPACE.split(row["text"]) if w]
    keep = max(1, math.floor(len(words) * ratio))
    if keep >= len(words):
        return
    with db.transaction() as tx:
        db.execute(tx, "UPDATE turns SET text = :text WHERE id = :id", text=f"{' '.join(words[:keep])}…", id=row["id"])


def _headers(*, call_id: str, escalate: str, text: str, engine: str) -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "x-ovoz-callid": call_id,
        "x-ovoz-escalate": escalate,
        # HTTP headers cannot safely carry raw multi-byte UTF-8. `Buffer.from(text, 'utf8')`: a lone
        # surrogate becomes U+FFFD instead of an encoding error.
        "x-ovoz-text": base64.b64encode(js_utf8(text)).decode(),
        "x-ovoz-engine": engine,
    }


PCM_TYPE = "audio/L16; rate=8000; channels=1"


def _pcm_response(pcm: bytes, **meta: str) -> Response:
    return Response(pcm, media_type=PCM_TYPE, headers=_headers(**meta))


def _stream_response(chunks: AsyncIterator[bytes], **meta: str) -> StreamingResponse:
    async def body() -> AsyncIterator[bytes]:
        try:
            async for piece in chunks:
                yield piece
        except Exception as err:  # noqa: BLE001
            # Close rather than error: the caller keeps whatever was already spoken.
            log.warning("[bridge/turn] stream aborted: %s", err)

    return StreamingResponse(body(), media_type=PCM_TYPE, headers=_headers(**meta))


# ── filler ──────────────────────────────────────────────────────────


@router.get("/filler")
async def filler(request: Request) -> Response:
    denied = authorize_bridge(request)
    if denied is not None:
        return denied

    to = _first(request.query_params, "to") or ""
    index = js_number(_first(request.query_params, "i") or "0")

    target = resolve_target(to)
    if isinstance(target, JSONResponse):
        return target

    lines = filler_lines(target.language)
    # `lines[index % lines.length]`: a JavaScript remainder; anything but a whole in-range index is
    # `undefined`, which the TypeScript TTS then fails on.
    position = math.fmod(index if math.isfinite(index) else 0, len(lines))
    try:
        if not (position.is_integer() and 0 <= position < len(lines)):
            raise ValueError("filler index out of range")
        pcm = await synthesize_pcm(
            lines[int(position)],
            SynthOptions(
                tenant_id=target.number["tenant_id"],
                voice_id=target.agent.get("voice_id"),
                language=target.language,
                tag="filler",
                cache=True,
                speed=speaking_speed(target.agent),
            ),
        )
    except Exception as err:  # noqa: BLE001
        status = err.status if isinstance(err, TtsError) else 502
        log.warning("[bridge/filler] %s", err)
        return _error({"error": "filler_failed"}, status)
    return Response(
        pcm,
        media_type=PCM_TYPE,
        headers={"Cache-Control": "no-store", "x-ovoz-count": str(len(lines))},
    )


# ── end ─────────────────────────────────────────────────────────────


@router.post("/end")
async def end(request: Request) -> Response:
    # Auth before touching the body.
    secret = env("BRIDGE_SHARED_SECRET")
    if not secret:
        return _error({"error": "bridge_not_configured"}, 503)
    if not secret_matches(request.headers.get("x-bridge-secret"), secret):
        return _error({"error": "unauthorized"}, 401)

    try:
        # `await request.json()`: UTF-8 (BOM dropped, bad bytes replaced), and NaN / Infinity refused.
        body = js_json_parse(await request.body())
    except ValueError:
        return _error({"error": "invalid_json"}, 400)
    if body is None:
        # `null.callId` throws in the TypeScript: Next.js answered 500.
        raise TypeError("Cannot read properties of null (reading 'callId')")
    if not isinstance(body, dict):
        body = {}  # a string, number or array has no `callId`: undefined

    # `(body.callId ?? '').trim()`: a number, boolean or object has no .trim() and throws (500).
    raw_id = body.get("callId")
    if raw_id is not None and not isinstance(raw_id, str):
        raise TypeError("body.callId.trim is not a function")
    call_id = js_trim(raw_id or "")
    if not call_id:
        return _error({"error": "missing_callId"}, 400)

    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id", id=call_id)
    if call is None:
        return _error({"error": "call_not_found"}, 404)

    # Idempotent: a hangup can be signalled twice (0x00, then the socket closing).
    if call["ended_at"] or call["status"] in ("completed", "abandoned"):
        return _json({"ok": True, "alreadyClosed": True, "callId": call_id})

    # Pin the end time from the reported duration when it is sane; otherwise end_call stamps "now".
    ended_at: str | None = None
    duration = body.get("durationSec")
    is_number = isinstance(duration, int | float) and not isinstance(duration, bool)
    if is_number and math.isfinite(duration) and duration >= 0:
        ended_at = _plus_seconds(call["started_at"], duration)

    # No in-call transfer in v1, so even an escalated call closes as resolved_by_ai.
    wanted = body.get("outcome")
    outcome = wanted if isinstance(wanted, str) and wanted in OUTCOMES else "resolved_by_ai"

    result = end_call(tenant_id=call["tenant_id"], call_id=call_id, outcome=outcome, ended_at=ended_at)
    return _json({"ok": True, "callId": call_id, "outcome": outcome, **(result or {})})


_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _plus_seconds(started_at: str, seconds: float) -> str:
    """`new Date(new Date(started_at).getTime() + seconds * 1000).toISOString()`.

    Same float64 sum as JavaScript, then truncated to whole milliseconds (`new Date(x)` does that);
    the epoch arithmetic stays in integers so no millisecond is lost to float rounding.
    """
    start_ms = (parse_iso(started_at) - _EPOCH) // timedelta(milliseconds=1)
    total_ms = math.trunc(start_ms + seconds * 1000)
    return to_iso(_EPOCH + timedelta(milliseconds=total_ms))


def _json(body: dict[str, Any], status: int = 200) -> Response:
    """JSON exactly as `Response.json` writes it (number formatting included)."""
    return Response(js_json(body), status_code=status, media_type="application/json")
