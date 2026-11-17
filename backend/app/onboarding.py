"""
Onboarding — ports of `completeOnboardingAction` and `skipOnboardingAction`
(src/app/actions/agent.ts) and the data the onboarding wizard (src/app/onboarding/page.tsx) loads.
"""

import json
from typing import Any

from app import db
from app.audit import audit
from app.auth import Session
from app.engine.calls import live_agent
from app.ids import now_iso
from app.jscompat import js_json, js_truthy

# Titles and descriptions of the starter knowledge packs (src/lib/starter-packs.ts); the wizard shows
# the one for the account's industry. The pack texts themselves belong to the knowledge base.
_PACKS = {
    "clinic": (
        "Clinic starter knowledge (UZ/RU/EN)",
        "Hours, price list, lab turnaround, insurance, paediatrics and booking rules.",
    ),
    "insurance": (
        "Insurance starter knowledge (RU/UZ/EN)",
        "Policy types, pricing, claim process, exclusions and contact hours.",
    ),
    "retail": (
        "Retail starter knowledge (UZ/RU/EN)",
        "Delivery, returns, payment, instalments and order status.",
    ),
}
_GENERIC_PACK = (
    "Starter knowledge (UZ/RU/EN)",
    "Hours, services, pricing, booking and payment — a general-purpose base to replace.",
)


def starter_pack_heading(industry: str) -> tuple[str, str]:
    """(title, description) of `starterPackFor(industry)`."""
    return _PACKS.get(industry, _GENERIC_PACK)


def _mark_onboarded(tenant_id: str) -> None:
    with db.transaction() as tx:
        db.execute(
            tx, "UPDATE tenants SET onboarded = 1, updated_at = :now WHERE id = :id", now=now_iso(), id=tenant_id
        )


def complete_onboarding(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """The wizard's choices saved on the live agent; the tenant is onboarded. {ok: true} → the proxy redirects."""
    tenant_id = session.tenant["id"]
    agent = live_agent(tenant_id)
    if not agent:
        return {"ok": False, "message": "No agent to configure."}
    languages = payload["languages"]
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE agents SET greeting = :greeting, primary_lang = :lang, languages_json = :languages,
                 voice_id = :voice, persona = :persona, status = :status, updated_at = :now WHERE id = :id""",
            greeting=payload["greeting"],
            lang=payload["primaryLang"],
            languages=js_json(languages if len(languages) else ["uz"]),
            voice=payload["voiceId"],
            persona=payload["persona"],
            status="live" if js_truthy(payload.get("goLive")) else "draft",
            now=now_iso(),
            id=agent["id"],
        )
    _mark_onboarded(tenant_id)
    # `{goLive: payload.goLive}`: a missing value is left out, as JSON.stringify leaves out undefined.
    audit(
        tenant_id,
        session.user,
        "onboarding.completed",
        agent["id"],
        {k: payload[k] for k in ("goLive",) if k in payload},
    )
    return {"ok": True}


def skip_onboarding(session: Session) -> dict[str, Any]:
    _mark_onboarded(session.tenant["id"])
    return {"ok": True}


def onboarding_page(session: Session) -> dict[str, Any]:
    """What src/app/onboarding/page.tsx passes to <OnboardingWizard> beyond the session's own fields."""
    tenant_id = session.tenant["id"]
    agent = live_agent(tenant_id)
    with db.connect() as conn:
        documents = db.fetch_all(
            conn,
            """SELECT id, title, source_type, chunk_count, status FROM documents WHERE tenant_id = :t
               ORDER BY created_at DESC""",
            t=tenant_id,
        )
        numbers = db.fetch_all(conn, "SELECT * FROM phone_numbers WHERE tenant_id = :t", t=tenant_id)
    title, description = starter_pack_heading(session.tenant["industry"])
    return {
        "packTitle": title,
        "packDescription": description,
        "agent": {
            "id": agent["id"],
            "name": agent["name"],
            "greeting": agent["greeting"],
            "persona": agent["persona"],
            "voiceId": agent["voice_id"],
            "primaryLang": agent["primary_lang"],
            "languages": json.loads(agent["languages_json"] or '["uz","ru","en"]'),
        }
        if agent
        else None,
        "documents": [
            {"id": d["id"], "title": d["title"], "chunks": d["chunk_count"], "status": d["status"]} for d in documents
        ],
        "phoneNumber": numbers[0]["e164"] if numbers and numbers[0]["e164"] is not None else None,
    }
