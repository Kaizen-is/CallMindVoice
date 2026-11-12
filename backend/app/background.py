"""Fire-and-forget tasks (`void promise` in TypeScript) that are not garbage-collected mid-flight."""

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

log = logging.getLogger("callmind.background")

_tasks: set[asyncio.Task] = set()


def spawn(coro: Coroutine[Any, Any, Any]) -> asyncio.Task | None:
    """Run `coro` in the background; errors are logged, never raised. Without a running loop it is dropped."""
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        coro.close()
        return None
    _tasks.add(task)

    def done(t: asyncio.Task) -> None:
        _tasks.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.warning("[background] task failed: %s", t.exception())

    task.add_done_callback(done)
    return task


async def drain() -> None:
    """Wait for every background task (tests)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)
