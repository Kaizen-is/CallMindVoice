"""
A simulated Asterisk call against the AudioSocket bridge (telephony-bridge/), with a fake site that
records every request the bridge makes. Used by tests/test_bridge.py (Python bridge) and, during the
port, to compare bridge.py with the original bridge.mjs on the same call.

The call, in real time (20 ms frames, like Asterisk):
  1. UUID → the bridge opens the call: /turn first=true and three /filler prefetches; the greeting plays.
  2. 0.6 s of speech, then silence → /turn with the utterance; the fake site answers after 0.7 s, so a
     filler plays first, then the reply.
  3. Speech again → a long reply; the caller talks over it → barge-in; the next /turn carries spokenRatio.
  4. The site flags an escalation → the bridge plays the handoff line, posts /end and hangs up.
"""

import asyncio
import base64
import contextlib
import hashlib
import math
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

REPO = Path(__file__).resolve().parents[2]
SECRET = "sim-secret"
TO = "+998787100001"
FROM = "+998901112233"
FRAME = 320  # 20 ms of 8 kHz 16-bit mono

GREETING = "Assalomu alaykum! Men Isomiddin."
REPLIES = [
    ("Ertaga soat o'nda.", ""),  # turn 1 (slow → filler first)
    ("Bu uzun javob. " * 12, ""),  # turn 2 (long; the caller barges in)
    ("Tushundim, gaplashamiz.", ""),  # turn 3 (after the barge-in)
    ("Operatorga ulayman.", "caller_requested"),  # turn 4 (escalation → hang-up)
]


def pcm(label: str, ms: int) -> bytes:
    """Deterministic 'audio' for a label: the same bytes on every run."""
    seed = hashlib.sha256(label.encode()).digest()
    size = ms * 16
    return (seed * (size // len(seed) + 1))[:size]


def tone(ms: int, amplitude: int) -> list[bytes]:
    """20 ms frames of a 300 Hz tone (amplitude 0 = digital silence, small = line noise)."""
    frames = []
    n = 160
    for f in range(ms // 20):
        samples = [int(amplitude * math.sin(2 * math.pi * 300 * (f * n + i) / 8000)) for i in range(n)]
        frames.append(struct.pack("<160h", *samples))
    return frames


def fake_site(log: list) -> FastAPI:
    app = FastAPI()
    state = {"turn": 0}

    @app.post("/api/telephony/bridge/turn")
    async def turn(request: Request) -> Response:
        form = await request.form()
        fields = {k: v for k, v in form.items() if isinstance(v, str)}
        audio = form.get("audio")
        entry = {"path": "turn", "secret": request.headers.get("x-bridge-secret"), **fields}
        if audio is not None and not isinstance(audio, str):
            body = await audio.read()
            entry.update(
                audio_len=len(body),
                audio_sha=hashlib.sha256(body).hexdigest()[:16],
                audio_name=audio.filename,
                audio_type=audio.content_type,
            )
        log.append(entry)
        if fields.get("first") == "true":
            text, escalate, audio_out, delay = GREETING, "", pcm("greeting", 600), 0.0
        else:
            index = state["turn"]
            state["turn"] += 1
            text, escalate = REPLIES[min(index, len(REPLIES) - 1)]
            audio_out = pcm(f"reply{index}", 2400 if index == 1 else 500)
            delay = 0.7 if index == 0 else 0.05
        await asyncio.sleep(delay)
        headers = {
            "x-ovoz-callid": "call_simulated0001",
            "x-ovoz-escalate": escalate,
            "x-ovoz-text": base64.b64encode(text.encode()).decode(),
            "x-ovoz-engine": "kotib",
        }

        async def stream():
            for i in range(0, len(audio_out), 3200):
                yield audio_out[i : i + 3200]
                await asyncio.sleep(0.02)

        return StreamingResponse(stream(), media_type="audio/L16; rate=8000; channels=1", headers=headers)

    @app.get("/api/telephony/bridge/filler")
    async def filler(request: Request) -> Response:
        log.append({"path": "filler", "secret": request.headers.get("x-bridge-secret"), **request.query_params})
        body = pcm(f"filler{request.query_params.get('i')}", 300)
        return Response(body, media_type="audio/L16; rate=8000; channels=1")

    @app.post("/api/telephony/bridge/end")
    async def end(request: Request) -> JSONResponse:
        log.append(
            {
                "path": "end",
                "secret": request.headers.get("x-bridge-secret"),
                "content_type": request.headers.get("content-type"),
                **(await request.json()),
            }
        )
        return JSONResponse({"ok": True})

    return app


def kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Stop the bridge and anything it started (on Windows a venv's python.exe is a launcher with a child)."""
    if proc.returncode is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, check=False)
    else:
        proc.terminate()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def run_call(bridge_cmd: list[str]) -> dict:
    """Run the whole simulated call against one bridge; returns what the site saw and the line heard."""
    log: list = []
    site_port, bridge_port = free_port(), free_port()
    config = uvicorn.Config(
        fake_site(log), host="127.0.0.1", port=site_port, log_level="warning", timeout_graceful_shutdown=2
    )
    server = uvicorn.Server(config)
    site = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)

    env = {
        **os.environ,
        "AUDIOSOCKET_PORT": str(bridge_port),
        "NEXT_BASE_URL": f"http://127.0.0.1:{site_port}/",
        "BRIDGE_SHARED_SECRET": SECRET,
        "BRIDGE_TO_NUMBER": TO,
        "BRIDGE_FROM_NUMBER": FROM,
        "BRIDGE_LOG": "1",
    }
    bridge = await asyncio.create_subprocess_exec(
        *bridge_cmd,
        cwd=REPO,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out_lines: list[str] = []

    async def collect_output():
        assert bridge.stdout
        async for raw in bridge.stdout:
            out_lines.append(raw.decode("utf-8", "replace").rstrip())
            if os.environ.get("BRIDGE_SIM_ECHO"):
                print("  bridge|", out_lines[-1], file=sys.stderr, flush=True)

    output = asyncio.create_task(collect_output())
    heard: list[tuple[float, int, bytes]] = []  # (time, type, payload) frames from the bridge
    try:
        # Wait for the bridge to listen; fail fast if it exits (Windows retries a refused connect ~2 s).
        deadline = time.monotonic() + 20
        while True:
            if bridge.returncode is not None or time.monotonic() > deadline:
                await asyncio.sleep(0.2)
                raise RuntimeError("bridge did not start:\n" + "\n".join(out_lines))
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", bridge_port), 0.5)
                break
            except (OSError, TimeoutError):
                await asyncio.sleep(0.05)

        t0 = time.monotonic()
        closed = asyncio.Event()

        async def listen():
            buf = b""
            while True:
                data = await reader.read(65536)
                if not data:
                    closed.set()
                    return
                buf += data
                while len(buf) >= 3:
                    kind, length = buf[0], int.from_bytes(buf[1:3], "big")
                    if len(buf) < 3 + length:
                        break
                    heard.append((time.monotonic() - t0, kind, buf[3 : 3 + length]))
                    buf = buf[3 + length :]

        listener = asyncio.create_task(listen())

        async def send_frames(frames: list[bytes]) -> None:
            start = time.monotonic()
            for i, frame in enumerate(frames):
                if closed.is_set():
                    return
                writer.write(bytes([0x10]) + len(frame).to_bytes(2, "big") + frame)
                await asyncio.sleep(max(0, start + (i + 1) * 0.02 - time.monotonic()))

        noise = lambda ms: tone(ms, 60)  # noqa: E731
        speech = lambda ms: tone(ms, 9000)  # noqa: E731

        writer.write(bytes([0x01, 0, 16]) + bytes(range(16)))  # UUID
        await send_frames(noise(1500))  # greeting plays (600 ms); noise floor settles
        await send_frames(speech(600) + noise(1800))  # turn 1: filler, then the reply
        await send_frames(speech(600) + noise(900))  # turn 2: long reply starts
        # Barge-in over the long reply: 240 ms stops it; the rest makes the barge-in its own utterance
        # (the frames that triggered it are preroll, not counted as voiced — 400 ms would be dropped).
        await send_frames(speech(700))
        await send_frames(noise(900))  # the barge-in utterance ends → turn 3 (with spokenRatio)
        await send_frames(noise(800))
        await send_frames(speech(600) + noise(2500))  # turn 4: escalation → the bridge hangs up
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(closed.wait(), timeout=5)
        hung_up_by_bridge = closed.is_set()
        if not closed.is_set():
            writer.write(bytes([0x00, 0, 0]))  # TERMINATE
            await asyncio.wait_for(closed.wait(), timeout=5)
        await asyncio.sleep(0.5)
        listener.cancel()
        writer.close()
    finally:
        kill_tree(bridge)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(bridge.wait(), timeout=5)
        output.cancel()
        server.should_exit = True
        try:
            await asyncio.wait_for(asyncio.shield(site), timeout=10)
        except TimeoutError:
            server.force_exit = True
            with contextlib.suppress(Exception):
                await asyncio.wait_for(site, timeout=5)

    return {"requests": log, "frames": heard, "output": out_lines, "hung_up_by_bridge": hung_up_by_bridge}


def python_bridge() -> list[str]:
    return [sys.executable, "telephony-bridge/bridge.py"]


def node_bridge() -> list[str]:
    return ["node", "telephony-bridge/bridge.mjs"]
