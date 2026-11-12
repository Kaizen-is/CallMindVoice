"""
Outbound webhook delivery — port of src/lib/webhooks.ts. Fire-and-forget: a
slow or dead customer endpoint never delays the call path. Each POST carries
`x-ovoz-signature: sha256=<hex>`, an HMAC-SHA256 of the exact body keyed with
the webhook's own secret.
"""

import asyncio
import hashlib
import hmac
import logging

from app import background, db, http
from app.ids import new_id, now_iso
from app.jscompat import js_json, js_trim

log = logging.getLogger("callmind.webhooks")

DELIVERY_TIMEOUT_S = 5.0


async def _dispatch(tenant_id: str, event: str, payload: dict) -> None:
    try:
        with db.connect() as conn:
            rows = db.fetch_all(
                conn,
                "SELECT id, url, events, secret FROM webhooks WHERE tenant_id = :t AND status = 'active'",
                t=tenant_id,
            )
    except Exception:  # noqa: BLE001
        return
    subscribed = [r for r in rows if event in (js_trim(e) for e in (r["events"] or "").split(","))]
    if not subscribed:
        return
    # One canonical body for all subscribers; each is signed with its own secret.
    body = js_json({"id": new_id("evt"), "event": event, "createdAt": now_iso(), "data": payload})
    await asyncio.gather(*(_deliver(hook, body) for hook in subscribed))


async def _deliver(hook: dict, body: str) -> None:
    try:
        signature = hmac.new(hook["secret"].encode(), body.encode(), hashlib.sha256).hexdigest()
        async with asyncio.timeout(DELIVERY_TIMEOUT_S):
            await http.client().post(
                hook["url"],
                headers={
                    "content-type": "application/json",
                    "x-ovoz-signature": f"sha256={signature}",
                    "user-agent": "Ovoz-Webhooks/1.0",
                },
                content=body.encode(),
            )
    except Exception:  # noqa: BLE001 - a failed delivery must not surface to the caller
        pass


def dispatch_webhook(tenant_id: str, event: str, payload: dict) -> None:
    """Notify every active webhook subscribed to `event`, in the background. Never raises."""
    background.spawn(_dispatch(tenant_id, event, payload))
