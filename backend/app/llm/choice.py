"""
Which language model an agent answers with — port of src/lib/llm/choice.ts.

  1. The agent's own choice (`agents.llm_model`).
  2. The account default (`tenants.settings_json.llmModel`).
  3. The server default — the first engine with a key (see `resolve_llm`).
"""

import json
from typing import Any

from app import db
from app.ids import now_iso
from app.jscompat import js_json
from app.llm.provider import engine_label, llm_provider_ready, resolve_llm
from app.registry import LLM_MODELS, llm_model_info

SETTING = "llmModel"


def safe_json(raw: str | None, fallback: Any) -> Any:
    """`safeJson` from utils.ts: the parsed value, or `fallback` for empty or bad JSON."""
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except ValueError:
        return fallback


def tenant_default_llm(tenant_id: str) -> str | None:
    with db.connect() as conn:
        row = db.fetch_one(conn, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
    settings = safe_json(row["settings_json"] if row else "{}", {})
    value = settings.get(SETTING) if isinstance(settings, dict) else None
    return value if isinstance(value, str) and llm_model_info(value) else None


def set_tenant_default_llm(tenant_id: str, choice: str | None) -> bool:
    """Set (or with None, clear) the account default. Unknown ids are refused."""
    if choice is not None and not llm_model_info(choice):
        return False
    with db.transaction() as tx:
        row = db.fetch_one(tx, "SELECT settings_json FROM tenants WHERE id = :id", id=tenant_id)
        if row is None:
            return False
        settings = safe_json(row["settings_json"], {})
        if not isinstance(settings, dict):
            settings = {}
        if choice:
            settings[SETTING] = choice
        else:
            settings.pop(SETTING, None)
        db.execute(
            tx,
            "UPDATE tenants SET settings_json = :s, updated_at = :now WHERE id = :id",
            s=js_json(settings),
            now=now_iso(),
            id=tenant_id,
        )
    return True


def agent_llm(agent: dict[str, Any]) -> str | None:
    """The choice an agent's answers go out with (before the key check)."""
    own = agent.get("llm_model")
    if own and llm_model_info(own):
        return own
    return tenant_default_llm(agent["tenant_id"])


def agent_engine_label(agent: dict[str, Any]) -> str:
    return engine_label(agent_llm(agent))


def llm_options() -> list[dict[str, Any]]:
    """Every model in the list, with whether this server can run it — for pickers."""
    return [
        {"id": m.id, "name": m.name, "vendor": m.vendor, "ready": llm_provider_ready(m.provider), "setup": m.setup}
        for m in LLM_MODELS
    ]


def server_default_llm() -> str | None:
    p, model = resolve_llm(None)
    return None if p == "local" else f"{p}:{model}"
