"""
At start, off the event loop: the shared clients for outside services (L7).

Each client loads the CA bundle when it is made — on this server's large company bundle that took
0.6 s. Made lazily, on the first LLM request, it froze every call on the server meanwhile (and the
Claude client again, the first time the backup model joined a turn). Made here, in a worker thread,
the event loop never waits for them.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

log = logging.getLogger("callmind.warm")


def _make_clients() -> None:
    from app import http  # noqa: PLC0415
    from app.llm import claude  # noqa: PLC0415

    http.client()
    try:
        claude.client()
    except Exception as err:  # noqa: BLE001 - a broken key is the turn's problem, not the start's
        log.warning("[warm] Claude client not made: %s", err)


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(_make_clients)
    yield


startup_router = APIRouter(lifespan=_lifespan)
