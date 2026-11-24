"""
Which company's knowledge base an agent searches.

Normally its own. An agent may point at a *shared library* instead
(`agents.knowledge_tenant_id`, migration 0003): the BRB website pages live once,
in the "BRB — website agents" company, and every company's copy of the BRB agents
reads them from there. A library must be marked as one
(`tenants.settings_json` → `"sharedLibrary": true`); any other value falls back to
the agent's own company, so a wrong or forged id can never read another
customer's documents.
"""

import json
from typing import Any

from sqlalchemy import Connection

from app import db


def is_shared_library(conn: Connection, tenant_id: str) -> bool:
    row = db.fetch_one(conn, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
    try:
        settings = json.loads((row or {}).get("settings_json") or "{}")
    except ValueError:
        return False
    return isinstance(settings, dict) and settings.get("sharedLibrary") is True


def knowledge_tenant(conn: Connection, agent: dict[str, Any], tenant_id: str) -> str:
    """The company whose knowledge `agent` (of `tenant_id`) searches."""
    other = (agent.get("knowledge_tenant_id") or "").strip()
    if not other or other == tenant_id:
        return tenant_id
    return other if is_shared_library(conn, other) else tenant_id
