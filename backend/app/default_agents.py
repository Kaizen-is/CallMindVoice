"""
The agents every company has: "BRB ma'lumot xizmati" and "Isomiddin — kredit arizasi".

The third default agent, "Isomiddin — bank kredit eslatmasi", is added by the
Next.js app (src/lib/bank-agent.ts) the same way: once per company, the first time
its Playground opens.

Each company gets its own copy of the agents (so it can rename, edit or delete
them), created as drafts so the company's live agent and phone number are never
taken over. The copies read the website knowledge from the "BRB — website agents"
company, a shared library (app/rag/library.py): the pages are stored once, and no
other agent of the company sees them. A note in the company's settings records
the seeding, so agents a company deletes stay deleted.
"""

import json

from app import db
from app.brb_setup import DEFAULT_AGENTS, TENANT_ID, upsert_agent
from app.ids import new_id, now_iso
from app.rag.library import is_shared_library

SEEDED_FLAG = "brbAgentsSeeded"


def _ready(tx) -> bool:  # noqa: ANN001
    """Migration 0003 has run (agents.knowledge_tenant_id exists)."""
    return any(col["name"] == "knowledge_tenant_id" for col in db.fetch_all(tx, "PRAGMA table_info(agents)"))


def ensure_default_agents(tenant_id: str) -> list[str]:
    """Give this company its copies of the default agents, once. Returns the ids created now."""
    if tenant_id == TENANT_ID:
        return []  # the library company holds the originals (app/brb_setup.py)
    with db.transaction() as tx:
        if not _ready(tx) or not is_shared_library(tx, TENANT_ID):
            return []  # nothing to read from yet: run `python -m app.brb_setup` first
        row = db.fetch_one(tx, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
        if row is None:
            return []
        try:
            settings = json.loads(row["settings_json"] or "{}")
        except ValueError:
            settings = {}
        if settings.get(SEEDED_FLAG):
            return []
        stamp = now_iso()
        created = []
        for template in DEFAULT_AGENTS:
            agent_id = new_id("agt")
            upsert_agent(tx, tenant_id, agent_id, template, "draft", TENANT_ID, stamp)
            created.append(agent_id)
        settings[SEEDED_FLAG] = True
        db.execute(
            tx,
            "UPDATE tenants SET settings_json = :s, updated_at = :now WHERE id = :id",
            s=json.dumps(settings),
            now=stamp,
            id=tenant_id,
        )
    return created
