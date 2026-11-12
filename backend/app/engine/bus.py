"""
In-process pub/sub for live console updates, sent to browsers over SSE — port
of src/lib/engine/bus.ts. One process (uvicorn runs one worker on purpose), so
an in-memory broker is the right size; Redis pub/sub would replace `publish`
and `subscribe` only.

Events are dicts shaped like the TypeScript `BusEvent` union (`type` first).
"""

import logging
from collections.abc import Callable

log = logging.getLogger("callmind.bus")

Listener = Callable[[dict], None]
_listeners: dict[str, set[Listener]] = {}


def publish(tenant_id: str, event: dict) -> None:
    for fn in list(_listeners.get(tenant_id, ())):
        try:
            fn(event)
        except Exception:  # noqa: BLE001 - a broken listener must not take down the publisher
            log.debug("[bus] listener failed", exc_info=True)


def subscribe(tenant_id: str, fn: Listener) -> Callable[[], None]:
    listeners = _listeners.setdefault(tenant_id, set())
    listeners.add(fn)

    def unsubscribe() -> None:
        listeners.discard(fn)
        if not listeners and _listeners.get(tenant_id) is listeners:
            del _listeners[tenant_id]

    return unsubscribe


def subscriber_count(tenant_id: str) -> int:
    return len(_listeners.get(tenant_id, ()))
