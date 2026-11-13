"""
Live Zipformer words and the live event feed — ports of
src/app/api/speech/live/route.ts and src/app/api/stream/route.ts. Through the
Next.js rewrite: /api/core/speech/live and /api/core/stream.
"""

import asyncio
import contextlib
import logging

import numpy as np
import regex as re
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.datastructures import UploadFile

from app.auth import LoggedIn
from app.engine.bus import subscribe
from app.ids import now_iso
from app.jscompat import js_json
from app.speech import zipformer
from app.speech.wav import pcm16_to_float

log = logging.getLogger("callmind.live")

router = APIRouter()

MAX_PIECE_BYTES = 512 * 1024  # ~16 s of audio; real pieces are 8 KB
_SID = re.compile(r"^[\w-]{8,64}$", re.ASCII)  # JS `\w` is ASCII


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


@router.post("/speech/live")
async def speech_live(request: Request, session: LoggedIn) -> JSONResponse:
    """
    While the caller speaks the browser posts its microphone here in quarter-second pieces (16 kHz
    mono 16-bit PCM, multipart) and gets back the whole utterance heard so far.

      sid    the browser's session id (one per open call)
      op     feed | finish | reset | close
      audio  the PCM piece (feed, optionally finish)
    """
    if not zipformer.zipformer_available():
        return _error("zipformer_not_available", 503)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        form = None
    sid = form.get("sid") if form is not None else None
    op = form.get("op") if form is not None else None
    if not isinstance(sid, str) or not _SID.match(sid):
        return _error("bad_session", 400)
    owner = session.user["id"]

    samples: np.ndarray | None = None
    audio = form.get("audio") if form is not None else None
    if isinstance(audio, UploadFile) and audio.size:
        if audio.size > MAX_PIECE_BYTES:
            return _error("piece_too_large", 413)
        samples = pcm16_to_float(await audio.read())

    try:
        # The recogniser is CPU work under one lock: off the event loop, so other calls keep streaming.
        if op == "feed":
            piece = samples if samples is not None else np.zeros(0, dtype=np.float32)
            return JSONResponse({"text": await asyncio.to_thread(zipformer.feed_live, owner, sid, piece)})
        if op == "finish":
            return JSONResponse({"text": await asyncio.to_thread(zipformer.finish_live, owner, sid, samples)})
        if op == "reset":
            await asyncio.to_thread(zipformer.reset_live, owner, sid)
            return JSONResponse({"text": ""})
        if op == "close":
            await asyncio.to_thread(zipformer.close_live, owner, sid)
            return JSONResponse({"ok": True})
        return _error("bad_op", 400)
    except Exception as err:  # noqa: BLE001
        log.warning("[zipformer] live request failed: %s", err)
        return _error("zipformer_failed", 502)


PING_EVERY_S = 25.0

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@router.get("/stream")
async def stream(session: LoggedIn) -> StreamingResponse:
    """Server-sent events for the live wallboard and operator inbox, scoped to the caller's company."""
    tenant_id = session.tenant["id"]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict] = asyncio.Queue()

    def listener(event: dict) -> None:
        # Thread-safe: a publish may come from a worker thread.
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def body():
        unsubscribe = subscribe(tenant_id, listener)
        try:
            yield f"data: {js_json({'type': 'heartbeat', 'at': now_iso()})}\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), PING_EVERY_S)
                except TimeoutError:
                    # Proxies drop idle connections; a comment frame keeps it open.
                    yield ": ping\n\n"
                    continue
                yield f"data: {js_json(event)}\n\n"
        finally:
            with contextlib.suppress(Exception):
                unsubscribe()

    return StreamingResponse(body(), media_type="text/event-stream; charset=utf-8", headers=SSE_HEADERS)
