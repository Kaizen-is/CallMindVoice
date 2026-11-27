"""
The Playground call over one WebSocket (L2): `GET /playground/ws` (through the site: /api/core/playground/ws).

The page used to send its microphone as a new request every 100 ms and each turn, early start, cut-in and
timing report as requests of their own, with the agent's voice coming back base64 in text. On one open
connection the same work runs with none of that per-request cost, and the voice comes back as raw bytes.
Everything here calls the same code the HTTP routes run (`live_op`, `turn_core`, `cut_turn`, `save_laps`),
so the two ways behave alike; the page falls back to the requests when the socket cannot open.

From the page:
  binary                 a live-words audio piece (16 kHz mono 16-bit PCM) → {"t": "live", "text"}
  {"op": "live-config", "sid", "engine", "language", "agentId"}   the live-words session these go to
  {"op": "live", "id", "live": "flush|finish|begin|reset|close|endpoint"}
                         → {"t": "live", "id", "text", "endProb"?, "endMs"?}  (L3: endpoint's score)
  {"op": "turn" | "prefetch", "seq", "fields": {…form fields…}, "audio": base64 WAV?}
  {"op": "abort", "seq"}             the caller talked over that turn (its voice stops)
  {"op": "cut", "callId", "heard"}   → {"t": "cut", "result"}            (Q7)
  {"op": "timings", "callId", "turnId", "laps"}  → {"t": "timings", "ok"} (Q1)
To the page:
  {"seq", …event}        a turn's events, as in the NDJSON stream
                         (a refused turn: {"seq", "t": "error", "code", "status"})
  binary                 a turn's audio: 1 byte kind (1 audio, 2 filler) · seq · rate · afterMs (uint32 LE each) · PCM
"""

import asyncio
import base64
import contextlib
import io
import json
import logging
import struct
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from starlette.datastructures import UploadFile

from app.auth import current_session
from app.playground import owned_playground_call
from app.playground_voice import Signal, cut_turn
from app.routers.live import MAX_PIECE_BYTES, live_op
from app.routers.playground import MAX_AUDIO_BYTES, turn_core
from app.turn_timings import save_laps

log = logging.getLogger("callmind.playground.ws")

router = APIRouter(prefix="/playground")

AUDIO, FILLER = 1, 2
HEADER = struct.Struct("<BIII")  # kind, seq, rate, afterMs


class _Fields(dict):
    """The WebSocket message's fields where the routes expect a form (`.get`, an UploadFile for audio)."""


def _upload(data: bytes, name: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), size=len(data), filename=name)


def _body(res: Response) -> dict[str, Any]:
    try:
        return json.loads(res.body)  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        return {}


@router.websocket("/ws")
async def playground_ws(ws: WebSocket) -> None:
    session = current_session(ws)  # type: ignore[arg-type] - the cookie, as on any request
    if session is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    send_lock = asyncio.Lock()
    turns: dict[int, Signal] = {}
    tasks: set[asyncio.Task] = set()
    live_config: dict[str, Any] = {}
    live_queue: asyncio.Queue = asyncio.Queue()

    async def send_json(event: dict) -> None:
        async with send_lock:
            with contextlib.suppress(Exception):
                await ws.send_text(json.dumps(event, ensure_ascii=False, separators=(",", ":")))

    async def send_bytes(data: bytes) -> None:
        async with send_lock:
            with contextlib.suppress(Exception):
                await ws.send_bytes(data)

    def spawn(coro: Any) -> None:
        task = asyncio.ensure_future(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    # ── live words: one at a time, in order (a feed, then the flush that follows it) ──
    async def live_worker() -> None:
        while True:
            op, rid, pcm = await live_queue.get()
            fields = _Fields(live_config)
            fields["op"] = op
            if pcm:
                if len(pcm) > MAX_PIECE_BYTES:
                    await send_json({"t": "live", "id": rid, "text": None, "error": "piece_too_large"})
                    continue
                fields["audio"] = _upload(pcm, "piece.pcm")
            try:
                res = await live_op(fields, session)
                body = _body(res)
                end = {k: body[k] for k in ("endProb", "endMs") if k in body}
                await send_json({"t": "live", "id": rid, "text": body.get("text"), "status": res.status_code, **end})
            except Exception as err:  # noqa: BLE001
                log.warning("[ws] live %s failed: %s", op, err)
                await send_json({"t": "live", "id": rid, "text": None, "status": 500})

    # ── a turn (or a prefetch): the same core as POST /playground/turn ──
    async def run_turn(msg: dict, prefetch: bool) -> None:
        seq = int(msg.get("seq") or 0)
        fields = _Fields(msg.get("fields") or {})
        audio_b64 = msg.get("audio")
        if isinstance(audio_b64, str) and audio_b64:
            try:
                wav = base64.b64decode(audio_b64)
            except ValueError:
                wav = b""
            if 0 < len(wav) <= MAX_AUDIO_BYTES:
                fields["audio"] = _upload(wav, "speech.wav")
        out = await turn_core(fields, session, prefetch)
        if isinstance(out, Response):
            ok = out.status_code < 300
            await send_json({"seq": seq, "t": "accepted" if ok else "error", "status": out.status_code, **_body(out)})
            return
        signal = Signal()
        turns[seq] = signal

        def send(event: dict) -> None:
            if signal.aborted:
                return
            kind = {"audio": AUDIO, "filler": FILLER}.get(event.get("t"))
            if kind is not None and isinstance(event.get("pcm"), str):
                pcm = base64.b64decode(event["pcm"])
                head = HEADER.pack(kind, seq, int(event.get("rate") or 0), int(event.get("afterMs") or 0))
                spawn(send_bytes(head + pcm))
            else:
                spawn(send_json({"seq": seq, **event}))

        try:
            await out(send, signal)
        except Exception as err:  # noqa: BLE001
            log.warning("[ws] turn failed: %s", err, exc_info=True)
            send({"t": "error", "code": "server"})
        finally:
            turns.pop(seq, None)
            send({"t": "closed"})

    live_task = asyncio.ensure_future(live_worker())
    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                await live_queue.put(("feed", None, data))
                continue
            try:
                msg = json.loads(message.get("text") or "{}")
            except ValueError:
                continue
            op = msg.get("op") if isinstance(msg, dict) else None
            if op == "live-config":
                live_config = {k: msg.get(k) for k in ("sid", "engine", "language", "agentId") if msg.get(k)}
            elif op == "live":
                await live_queue.put((str(msg.get("live") or ""), msg.get("id"), b""))
            elif op in ("turn", "prefetch"):
                spawn(run_turn(msg, prefetch=op == "prefetch"))
            elif op == "abort":
                signal = turns.get(int(msg.get("seq") or 0))
                if signal is not None:
                    signal.abort()
            elif op == "cut":
                call_id, heard = msg.get("callId"), msg.get("heard")
                ok = isinstance(call_id, str) and owned_playground_call(session.tenant["id"], call_id)
                valid = isinstance(heard, int | float) and not isinstance(heard, bool) and 0 <= heard <= 1
                result = await cut_turn(session.tenant["id"], call_id, float(heard)) if ok and valid else "refused"
                await send_json({"t": "cut", "result": result})
            elif op == "timings":
                call_id = msg.get("callId")
                ok = isinstance(call_id, str) and bool(owned_playground_call(session.tenant["id"], call_id))
                saved = ok and save_laps(
                    session.tenant["id"], call_id, msg.get("turnId"), msg.get("laps"), source="browser"
                )
                await send_json({"t": "timings", "ok": bool(saved)})
    except WebSocketDisconnect:
        pass
    finally:
        # The page went away: every turn still speaking stops, as when an HTTP stream is dropped.
        for signal in turns.values():
            signal.abort()
        live_task.cancel()
