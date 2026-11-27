"""
L8 pilot: a Playground call answered natively by Gemini Live (app/engine/native_call.py), over one socket.

  GET /playground/native?agentId=…&lang=uz&mode=audio|text   (through the site: /api/core/playground/native)

From the page:
  binary                     microphone audio, 16 kHz mono 16-bit PCM
  {"op": "text", "text"}     a typed line, as if the caller said it (also how the text-mode test talks)
  {"op": "end"}              hang up
To the page:
  {"t": "ready", "callId", "model"}
  binary                     the agent's voice, 24 kHz mono 16-bit PCM (audio mode)
  {"t": "caller" | "agent", "text"}   the words so far (both sides transcribed)
  {"t": "interrupted"}       the caller talked over the agent: stop its voice now
  {"t": "tool", "name", "args", "result"} · {"t": "promise", "promise"}
  {"t": "turn", "caller", "agent", "flags", "firstMs", "more", "cut"}   a turn finished; flags = the text
                             guardrail's findings; more = it called a tool, so the agent speaks again next;
                             cut = the caller talked over it (only its whole sentences were checked)
  {"t": "error", "code"} · {"t": "closed", "reason"}
"""

import asyncio
import contextlib
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import current_session
from app.engine.native_call import NativeSession, native_model
from app.playground import call_lang, close_playground_call, open_playground_call, playground_agent

log = logging.getLogger("callmind.playground.native")

router = APIRouter(prefix="/playground")


@router.websocket("/native")
async def playground_native(ws: WebSocket) -> None:
    session = current_session(ws)  # type: ignore[arg-type] - the cookie, as on any request
    if session is None:
        await ws.close(code=4401)
        return
    tenant_id = session.tenant["id"]
    agent = playground_agent(tenant_id, ws.query_params.get("agentId"))
    if agent is None:
        await ws.close(code=4404)
        return
    await ws.accept()
    lang = call_lang(ws.query_params.get("lang"), agent)
    audio = ws.query_params.get("mode") != "text"
    lock = asyncio.Lock()

    async def send(item: dict[str, Any] | bytes) -> None:
        async with lock:
            with contextlib.suppress(Exception):
                if isinstance(item, bytes):
                    await ws.send_bytes(item)
                else:
                    await ws.send_text(json.dumps(item, ensure_ascii=False))

    call_id = await asyncio.to_thread(open_playground_call, tenant_id, session.user["name"], agent, lang)
    native = NativeSession(tenant_id, call_id, agent, lang, audio=audio)
    try:
        try:
            await native.open(send)
        except Exception as err:  # noqa: BLE001
            log.warning("[native] could not open: %s", err)
            await send({"t": "error", "code": "native_unavailable", "detail": str(err)[:200]})
            return
        await send({"t": "ready", "callId": call_id, "model": native_model()})
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await native.feed_audio(message["bytes"])
                continue
            try:
                msg = json.loads(message.get("text") or "{}")
            except ValueError:
                continue
            if msg.get("op") == "text" and isinstance(msg.get("text"), str) and msg["text"].strip():
                await native.say_text(msg["text"].strip()[:500], caller=True)
            elif msg.get("op") == "end":
                break
    except WebSocketDisconnect:
        pass
    finally:
        # The call is closed (and billed) even if this handler is being cancelled.
        await asyncio.shield(asyncio.to_thread(close_playground_call, tenant_id, call_id))
        await native.close()
        with contextlib.suppress(Exception):
            await ws.close()
