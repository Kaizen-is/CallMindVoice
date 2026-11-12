"""
Health, readiness, "who am I", and two streaming checks.

Through the Next.js rewrite these are reachable as /api/core/healthz,
/api/core/readyz, /api/core/me, /api/core/diagnostics/{ndjson,sse}.
"""

import asyncio
import json
import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from app import db
from app.auth import LoggedIn, session_secret

router = APIRouter()

# The newest TypeScript migration this backend was written against (src/lib/db.ts).
EXPECTED_MIGRATION = "010_agent_tts"

_STREAM_HEADERS = {"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"}


@router.get("/healthz")
def healthz() -> dict:
    """The process is up."""
    return {"ok": True}


@router.get("/readyz")
def readyz() -> JSONResponse:
    """Ready to serve: the shared database opens, has the expected schema, and a session secret exists."""
    checks: dict[str, bool | str] = {}
    try:
        with db.connect() as conn:
            applied = {r["id"] for r in db.fetch_all(conn, "SELECT id FROM _migrations")}
        checks["database"] = True
        checks["schema"] = EXPECTED_MIGRATION in applied
    except Exception as err:  # noqa: BLE001 - reported, not raised
        checks["database"] = f"error: {type(err).__name__}"
        checks["schema"] = False
    checks["session_secret"] = session_secret() is not None
    ready = all(value is True for value in checks.values())
    return JSONResponse({"ready": ready, "checks": checks}, status_code=200 if ready else 503)


@router.get("/me")
def me(session: LoggedIn) -> dict:
    """The logged-in user and their company — proves the shared login works."""
    tenant = session.tenant
    return {
        "user": {k: session.user[k] for k in ("id", "name", "email", "role", "locale")},
        "tenant": {k: tenant.get(k) for k in ("id", "name", "slug", "plan", "timezone", "locale")},
    }


async def _ticks(count: int, every: float):
    started = time.perf_counter()
    for i in range(count):
        yield i, round((time.perf_counter() - started) * 1000)
        await asyncio.sleep(every)


@router.get("/diagnostics/ndjson")
async def diagnostics_ndjson(_session: LoggedIn) -> StreamingResponse:
    """Five NDJSON lines 300 ms apart; through the rewrite they must arrive one by one."""

    async def body():
        async for i, ms in _ticks(5, 0.3):
            yield json.dumps({"t": "tick", "i": i, "serverMs": ms}) + "\n"

    return StreamingResponse(body(), media_type="application/x-ndjson", headers=_STREAM_HEADERS)


@router.get("/diagnostics/sse")
async def diagnostics_sse(_session: LoggedIn) -> StreamingResponse:
    """Five server-sent events 300 ms apart — the format the live dashboard will use."""

    async def body():
        async for i, ms in _ticks(5, 0.3):
            yield f"data: {json.dumps({'type': 'tick', 'i': i, 'serverMs': ms})}\n\n"

    return StreamingResponse(body(), media_type="text/event-stream", headers=_STREAM_HEADERS)
