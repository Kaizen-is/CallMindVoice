"""
The Asterisk/FreePBX phone bridge's endpoints, served by Python — ports of
src/app/api/telephony/bridge/{turn,filler,end}/route.ts and src/lib/telephony/bridge.ts.

The paths are the TypeScript ones, so the bridge (`telephony-bridge/bridge.mjs`) switches by its
`NEXT_BASE_URL` alone: `http://127.0.0.1:8100` on the same machine, or `<site>/api/core` through
the Next.js rewrite. The bridge proves itself with the `x-bridge-secret` header
(`BRIDGE_SHARED_SECRET`): unset ⇒ 503, mismatch ⇒ 401.

  turn    POST multipart {to, from, first, callId, spokenRatio, audio}
          → raw 8 kHz s16 PCM (`audio/L16`); the reply is streamed sentence by sentence, the call
            metadata rides in x-ovoz-{callid,escalate,text,engine} ahead of the first byte.
  filler  GET ?to=&i= → one short holding line ("bir daqiqa") as PCM, x-ovoz-count lines in all.
  end     POST JSON {callId, durationSec?, outcome?} → closes and bills the call, once.
"""

import base64
import hmac
import logging
import math
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import regex as re
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from starlette.datastructures import FormData, UploadFile

from app import db
from app.engine.calls import end_call, live_agent, start_call
from app.engine.conversation import run_turn
from app.env import env
from app.ids import parse_iso, to_iso
from app.jscompat import JS_S, js_json, js_json_parse, js_number, js_trim, js_utf8
from app.speech.fillers import filler_lines, filler_pcm
from app.speech.stt import SttError, transcribe
from app.speech.tts import SynthOptions, TtsError, synthesize_pcm, synthesize_stream

log = logging.getLogger("callmind.bridge")

router = APIRouter(prefix="/api/telephony/bridge")

PCM_TYPE = "audio/L16; rate=8000; channels=1"

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

_JS_SPACES = re.compile(f"[{JS_S}]+")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def _json(value: object, status: int = 200) -> Response:
    """`Response.json(value, {status})`."""
    return Response(js_json(value), status_code=status, media_type="application/json")


# ── shared gate (src/lib/telephony/bridge.ts) ───────────────────────


def authorize_bridge(request: Request) -> Response | None:
    """None means authorised; otherwise the response to return at once."""
    secret = env("BRIDGE_SHARED_SECRET")
    if not secret:
        return _json({"error": "bridge_not_configured"}, 503)
    # `Buffer.from(header)` is the header string as UTF-8, as is the secret.
    provided = js_utf8(request.headers.get("x-bridge-secret", ""))
    return None if hmac.compare_digest(provided, js_utf8(secret)) else _json({"error": "unauthorized"}, 401)


def resolve_target(to: str) -> tuple[dict[str, Any], dict[str, Any], str] | Response:
    """The dialled DID's tenant and live agent: (number, agent, language), or the error response."""
    with db.connect() as conn:
        number = db.fetch_one(conn, "SELECT * FROM phone_numbers WHERE e164=:to AND status='active' LIMIT 1", to=to)
        if not number:
            return _json({"error": "number_not_configured", "to": to}, 404)
        agent = db.fetch_one(
            conn, "SELECT * FROM agents WHERE id=:id AND tenant_id=:t", id=number["agent_id"], t=number["tenant_id"]
        )
    agent = agent or live_agent(number["tenant_id"])
    if not agent or agent["status"] != "live":
        return _json({"error": "agent_unavailable"}, 409)
    return number, agent, agent["primary_lang"] if agent["primary_lang"] is not None else "uz"


# ── turn ────────────────────────────────────────────────────────────


async def _read_form(request: Request) -> FormData | None:
    """`await request.formData()`: multipart or urlencoded only (Starlette would read others as empty)."""
    essence = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if essence not in ("multipart/form-data", "application/x-www-form-urlencoded"):
        return None
    try:
        return await request.form()
    except Exception:  # noqa: BLE001 - a broken body, as formData() throws
        return None


def _first(form: FormData, name: str) -> object:
    """`form.get(name)`: the FIRST value (Starlette's `.get` returns the last)."""
    values = form.getlist(name)
    return values[0] if values else None


def _field(form: FormData, name: str) -> str:
    value = _first(form, name)
    return value if isinstance(value, str) else ""


def _headers(call_id: str, escalate: str, text: str, engine: str) -> dict[str, str]:
    return {
        "Cache-Control": "no-store",
        "x-ovoz-callid": call_id,
        "x-ovoz-escalate": escalate,
        # HTTP headers cannot safely carry raw multi-byte UTF-8.
        "x-ovoz-text": base64.b64encode(js_utf8(text)).decode("ascii"),
        "x-ovoz-engine": engine,
    }


def _truncate_last_agent_turn(tenant_id: str, call_id: str, ratio: float) -> None:
    """
    Cut the last agent turn down to the share of it the caller heard before talking over it
    (word-proportional, with an ellipsis), so the model never believes it said the rest.
    """
    with db.connect() as conn:
        row = db.fetch_one(
            conn,
            "SELECT id, text FROM turns WHERE tenant_id=:t AND call_id=:c AND role='agent' "
            "ORDER BY ordinal DESC LIMIT 1",
            t=tenant_id,
            c=call_id,
        )
    if not row:
        return
    words = [w for w in _JS_SPACES.split(row["text"]) if w]
    keep = max(1, math.floor(len(words) * ratio))
    if keep >= len(words):
        return
    with db.transaction() as tx:
        db.execute(tx, "UPDATE turns SET text=:text WHERE id=:id", text=" ".join(words[:keep]) + "…", id=row["id"])


async def _spoken(pieces: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Hand the reply on piece by piece; a failure mid-reply ends it cleanly instead of dropping the line."""
    try:
        async for piece in pieces:
            yield piece
    except Exception as err:  # noqa: BLE001
        log.warning("[bridge/turn] stream aborted: %s", err)
    finally:
        # The bridge hung up or the caller barged in: stop rendering the rest.
        await pieces.aclose()  # type: ignore[attr-defined]


@router.post("/turn")
async def turn(request: Request) -> Response:
    """
    One caller utterance in, the agent's spoken reply out. The first leg (`first=true` or no
    callId) opens the call and plays the greeting; later legs run STT → turn engine → TTS.
    """
    denied = authorize_bridge(request)
    if denied:
        return denied
    form = await _read_form(request)
    if form is None:
        return _json({"error": "expected_multipart_form"}, 400)

    to = _field(form, "to")
    from_ = _field(form, "from")
    first = _field(form, "first") == "true"
    call_id_in = _field(form, "callId")
    spoken_ratio = js_number(_field(form, "spokenRatio"))
    audio = _first(form, "audio")
    audio = audio if isinstance(audio, UploadFile) else None

    target = resolve_target(to)
    if isinstance(target, Response):
        return target
    number, agent, lang = target
    tenant_id = number["tenant_id"]

    def voice(tag: str, language: str, cache: bool) -> SynthOptions:
        return SynthOptions(tenant_id=tenant_id, voice_id=agent["voice_id"], language=language, tag=tag, cache=cache)

    try:
        # First leg: open the call and greet (the greeting comes from the TTS disk cache).
        if first or not call_id_in:
            call_id = start_call(
                tenant_id=tenant_id,
                agent_id=agent["id"],
                number_id=number["id"],
                from_=from_,
                to=to,
                language=lang,
                channel="voice",
            )
            greeting = js_trim(agent["greeting"] or "") or GREETING_FALLBACK.get(lang) or GREETING_FALLBACK["uz"]
            pcm = await synthesize_pcm(greeting, voice("greeting", lang, True))
            return Response(pcm, media_type=PCM_TYPE, headers=_headers(call_id, "", greeting, "none"))

        # Barge-in bookkeeping, before anything else touches the transcript.
        if 0 < spoken_ratio < 1:
            _truncate_last_agent_turn(tenant_id, call_id_in, spoken_ratio)

        if audio is None:
            return _json({"error": "missing_audio"}, 400)

        t0 = time.perf_counter()
        heard = await transcribe(await audio.read(), language=lang)
        stt_ms = (time.perf_counter() - t0) * 1000

        # Nothing recognised: re-prompt without advancing the transcript (fixed text, cached).
        if not heard["text"]:
            line = REPROMPT.get(lang) or REPROMPT["uz"]
            pcm = await synthesize_pcm(line, voice("reprompt", lang, True))
            return Response(pcm, media_type=PCM_TYPE, headers=_headers(call_id_in, "", line, heard["engine"]))

        result = await run_turn(
            tenant_id=tenant_id, call_id=call_id_in, agent=agent, utterance=heard["text"], stt_ms=stt_ms
        )
        # On escalate the reply is already the spoken handoff line: the bridge plays it and hangs up.
        pieces = synthesize_stream(result["reply"], voice("reply", result["language"], False))
        escalate = result.get("escalate")
        return StreamingResponse(
            _spoken(pieces),
            media_type=PCM_TYPE,
            headers=_headers(call_id_in, "" if escalate is None else escalate, result["reply"], heard["engine"]),
        )
    except Exception as err:  # noqa: BLE001
        status = err.status if isinstance(err, (TtsError, SttError)) else 502
        log.warning("[bridge/turn] %s", err)
        return _json({"error": str(err)}, status)


# ── filler ──────────────────────────────────────────────────────────


@router.get("/filler")
async def filler(request: Request) -> Response:
    """One holding line in the agent's voice; the bridge fetches a few while the greeting plays."""
    denied = authorize_bridge(request)
    if denied:
        return denied
    # `searchParams.get` returns the first value.
    to_values = request.query_params.getlist("to")
    i_values = request.query_params.getlist("i")
    to = to_values[0] if to_values else ""
    index = js_number(i_values[0] if i_values else "0")

    target = resolve_target(to)
    if isinstance(target, Response):
        return target
    number, agent, language = target
    try:
        pcm = await filler_pcm(number["tenant_id"], agent["voice_id"], language, index if math.isfinite(index) else 0)
        return Response(
            pcm,
            media_type=PCM_TYPE,
            headers={"Cache-Control": "no-store", "x-ovoz-count": str(len(filler_lines(language)))},
        )
    except Exception as err:  # noqa: BLE001
        status = err.status if isinstance(err, TtsError) else 502
        log.warning("[bridge/filler] %s", err)
        return _json({"error": "filler_failed"}, status)


# ── end ─────────────────────────────────────────────────────────────


def _js_prop(body: object, name: str) -> object:
    """`body[name]` on a parsed JSON value: null throws, anything but an object has no fields."""
    if body is None:
        raise TypeError(f"Cannot read properties of null (reading '{name}')")
    return body.get(name) if isinstance(body, dict) else None


def _end_time(started_at: str, duration_sec: float) -> str:
    """
    `new Date(new Date(started_at).getTime() + durationSec * 1000).toISOString()`: the time value
    truncated to whole ms; beyond ±8.64e15 ms JavaScript throws RangeError. (Years past 9999, which
    JavaScript writes as +0YYYYY, raise here too: a bridge never reports a 250-year call.)
    """
    ms = (parse_iso(started_at) - _EPOCH) // timedelta(milliseconds=1) + duration_sec * 1000
    if not math.isfinite(ms) or abs(ms) > 8.64e15:
        raise ValueError("Invalid time value")
    return to_iso(_EPOCH + timedelta(milliseconds=math.trunc(ms)))


@router.post("/end")
async def end(request: Request) -> Response:
    """The bridge saw the caller hang up: close and bill the call (idempotent — hangups come twice)."""
    denied = authorize_bridge(request)
    if denied:
        return denied
    try:
        body = js_json_parse(await request.body())
    except ValueError:
        return _json({"error": "invalid_json"}, 400)

    raw_id = _js_prop(body, "callId")
    if raw_id is not None and not isinstance(raw_id, str):
        raise TypeError("body.callId.trim is not a function")
    call_id = js_trim(raw_id or "")
    if not call_id:
        return _json({"error": "missing_callId"}, 400)

    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id=:id", id=call_id)
    if not call:
        return _json({"error": "call_not_found"}, 404)
    if call["ended_at"] or call["status"] in ("completed", "abandoned"):
        return _json({"ok": True, "alreadyClosed": True, "callId": call_id})

    # Pin the end time from the reported duration when it is sane; otherwise end_call stamps now.
    duration = _js_prop(body, "durationSec")
    ended_at = None
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        seconds = float(duration)
        if math.isfinite(seconds) and seconds >= 0:
            ended_at = _end_time(call["started_at"], seconds)

    # No in-call transfer yet, so even an escalated call closes as resolved_by_ai unless told otherwise.
    asked = _js_prop(body, "outcome")
    outcome = asked if isinstance(asked, str) and asked in OUTCOMES else "resolved_by_ai"

    result = end_call(tenant_id=call["tenant_id"], call_id=call_id, outcome=outcome, ended_at=ended_at)
    return _json({"ok": True, "callId": call_id, "outcome": outcome, **(result or {})})
