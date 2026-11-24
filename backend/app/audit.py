"""
The audit log — port of `audit` / `recentAudit` in src/lib/auth.ts. Every
console action that changes something writes one row (who, what, on what).
"""

from typing import Any

from app import db
from app.ids import new_id, now_iso
from app.jscompat import js_json


def audit(
    tenant_id: str,
    actor: dict[str, Any] | None,
    action: str,
    target: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    """One audit row. `actor` is the session user (id, name) or None for the system; `ip` stays null, as before."""
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO audit_log (id, tenant_id, actor_id, actor_name, action, target, meta_json, ip, created_at)
               VALUES (:id, :tenant_id, :actor_id, :actor_name, :action, :target, :meta_json, NULL, :created_at)""",
            id=new_id("aud"),
            tenant_id=tenant_id,
            actor_id=(actor or {}).get("id"),
            # `actor?.name ?? 'system'`: an empty name is kept; only a missing one becomes 'system'.
            actor_name=actor["name"] if actor and actor.get("name") is not None else "system",
            action=action,
            target=target,
            meta_json=js_json(meta if meta is not None else {}),
            created_at=now_iso(),
        )


def recent_audit(tenant_id: str, limit: int = 50) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            "SELECT * FROM audit_log WHERE tenant_id = :t ORDER BY created_at DESC LIMIT :limit",
            t=tenant_id,
            limit=limit,
        )
