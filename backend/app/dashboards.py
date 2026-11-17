"""
The data behind the console's dashboards and workspace pages (`GET /views/<page>`): exactly what
each Next.js page used to compute from src/lib, so the page only renders it.

  overview    src/app/app/page.tsx
  analytics   src/app/app/analytics/page.tsx
  numbers     src/app/app/numbers/page.tsx
  team        src/app/app/team/page.tsx           (and the @settings/(.)team modal)
  settings    src/app/app/settings/page.tsx       (and the @settings/(.)settings modal)
  developers  src/app/app/developers/page.tsx     (and the @settings/(.)developers modal)
  billing     src/app/app/billing/billing-view.tsx (the page and the @settings/(.)billing modal)

Translated labels stay in the pages; the numbers, rows and engine names come from here.
"""

from datetime import datetime, tzinfo
from typing import Any

from app import db
from app.analytics import (
    daily,
    escalation_reasons,
    hourly_heat,
    intents,
    knowledge_gaps,
    knowledge_stats,
    language_split,
    operator_leaderboard,
    overview,
)
from app.audit import recent_audit
from app.auth import Session
from app.catalog import AI_MINUTE_UZS, UZS_RATES
from app.engine.calls import (
    COST_PER_MINUTE,
    OPERATOR_ASSUMPTIONS,
    OPERATOR_COST_PER_MINUTE,
    RATE_CARD,
    live_agent,
    percentile,
)
from app.llm.choice import tenant_default_llm
from app.llm.provider import engine_is_hosted, engine_label
from app.rag.embed import LOCAL_ENGINE_ID, hosted_engine_id
from app.telephony import telephony_status

# Below this the billing balance card warns the owner to top up (so'm).
LOW_BALANCE_UZS = 100_000

# The example number on the Developers page when the account has no active line.
EXAMPLE_NUMBER = "+998712000000"


def _llm(tenant_id: str) -> dict[str, Any]:
    """The answer engine as the Overview and Settings show it."""
    choice = tenant_default_llm(tenant_id)
    return {
        # engineIsHosted(tenantDefaultLlm(tenant.id)) / engineLabel(tenantDefaultLlm(tenant.id))
        "hosted": engine_is_hosted(choice),
        "label": engine_label(choice),
        # engineIsHosted(): the server default, without the account's choice
        "serverHosted": engine_is_hosted(),
    }


def overview_view(session: Session, now: datetime | None = None) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    stats = overview(tenant_id, 30, now)
    prev = overview(tenant_id, 60, now)
    kb = knowledge_stats(tenant_id)
    agent = live_agent(tenant_id)
    with db.connect() as conn:
        recent = db.fetch_all(
            conn, "SELECT * FROM calls WHERE tenant_id=:t ORDER BY started_at DESC LIMIT 8", t=tenant_id
        )

    # Second 30-day window, derived by subtracting the recent window from 60 days.
    prior_calls = max(0, prev["totalCalls"] - stats["totalCalls"])
    calls_delta = ((stats["totalCalls"] - prior_calls) / prior_calls) * 100 if prior_calls > 0 else None

    return {
        "stats": stats,
        "trend": daily(tenant_id, 30, now),
        "kb": kb,
        "gaps": knowledge_gaps(tenant_id, 5),
        "topIntents": intents(tenant_id, 30, 5, now),
        "recent": recent,
        "callsDelta": calls_delta,
        "setupDone": {
            "knowledge": kb["ready"] > 0,
            "agent": agent is not None and agent["status"] == "live",
            "number": True,
            "tested": stats["totalCalls"] > 0,
        },
        "llm": _llm(tenant_id),
        "telephony": telephony_status(),
    }


def analytics_view(session: Session, now: datetime | None = None, tz: tzinfo | None = None) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    stats = overview(tenant_id, 30, now)
    with db.connect() as conn:
        latencies = [
            r["v"]
            for r in db.fetch_all(
                conn,
                """SELECT avg_latency_ms AS v FROM calls WHERE tenant_id=:t AND avg_latency_ms IS NOT NULL
                   ORDER BY avg_latency_ms ASC""",
                t=tenant_id,
            )
        ]

    # Like-for-like: the same deflected minutes priced as wages versus priced as AI handling.
    # Telephony sits on both sides, so it cancels and is excluded.
    ai_minutes = stats["minutes"] * stats["deflectionRate"] if stats["totalCalls"] else 0
    human_equivalent = ai_minutes * OPERATOR_COST_PER_MINUTE
    actual_spend = ai_minutes * (COST_PER_MINUTE - RATE_CARD["telephonyPerMin"])

    return {
        "stats": stats,
        "trend": daily(tenant_id, 30, now),
        "heat": hourly_heat(tenant_id, 30, now, tz),
        "topIntents": intents(tenant_id, 30, 8, now),
        "langs": language_split(tenant_id, 30, now),
        "reasons": escalation_reasons(tenant_id, 30, now),
        "gaps": knowledge_gaps(tenant_id, 8),
        "operators": operator_leaderboard(tenant_id, 30, now),
        "latency": {
            "p50": percentile(latencies, 50),
            "p90": percentile(latencies, 90),
            "p95": percentile(latencies, 95),
            "p99": percentile(latencies, 99),
        },
        "aiMinutes": ai_minutes,
        "humanEquivalent": human_equivalent,
        "actualSpend": actual_spend,
        "operatorAssumptions": OPERATOR_ASSUMPTIONS,
        "operatorCostPerMinute": OPERATOR_COST_PER_MINUTE,
    }


def numbers_view(session: Session) -> dict[str, Any]:
    with db.connect() as conn:
        numbers = db.fetch_all(
            conn,
            """SELECT n.*, a.name AS agent_name,
                      (SELECT COUNT(*) FROM calls c WHERE c.number_id = n.id) AS call_count
               FROM phone_numbers n
               LEFT JOIN agents a ON a.id = n.agent_id
               WHERE n.tenant_id=:t ORDER BY n.created_at ASC""",
            t=session.tenant["id"],
        )
    return {"numbers": numbers, "telephony": telephony_status()}


def team_view(session: Session) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    with db.connect() as conn:
        members = db.fetch_all(
            conn,
            """SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.avatar_hue, u.locale, u.status,
                      u.presence, u.last_seen_at, u.created_at, u.updated_at,
                      (SELECT COUNT(*) FROM escalations e WHERE e.operator_id = u.id AND e.status='resolved')
                        AS handled
               FROM users u WHERE u.tenant_id=:t ORDER BY
                 CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
                 u.created_at ASC""",
            t=tenant_id,
        )
    return {"members": members, "audit": recent_audit(tenant_id, 25)}


def settings_view(session: Session) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    hosted_embedding = hosted_engine_id()
    return {
        "llm": _llm(tenant_id),
        # embeddingEngine(): OpenAI when OPENAI_API_KEY is set, else the local hashed n-grams
        "embedding": {"id": hosted_embedding or LOCAL_ENGINE_ID, "hosted": hosted_embedding is not None},
        "telephony": telephony_status(),
        "stats": knowledge_stats(tenant_id),
    }


def developers_view(session: Session) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    with db.connect() as conn:
        keys = db.fetch_all(conn, "SELECT * FROM api_keys WHERE tenant_id=:t ORDER BY created_at DESC", t=tenant_id)
        hooks = db.fetch_all(conn, "SELECT * FROM webhooks WHERE tenant_id=:t ORDER BY created_at DESC", t=tenant_id)
        # primaryNumber() in calls.ts
        number = db.fetch_one(
            conn,
            "SELECT * FROM phone_numbers WHERE tenant_id=:t AND status='active' ORDER BY created_at ASC LIMIT 1",
            t=tenant_id,
        )
    example = number["e164"] if number and number["e164"] is not None else EXAMPLE_NUMBER
    return {"keys": keys, "hooks": hooks, "exampleNumber": example}


def billing_view(session: Session) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    balance = session.tenant["balance_uzs"]
    with db.connect() as conn:
        ledger = db.fetch_all(
            conn,
            "SELECT * FROM wallet_ledger WHERE tenant_id=:t ORDER BY created_at DESC LIMIT 15",
            t=tenant_id,
        )
    negative = balance < 0
    return {
        "balance": balance,
        "negative": negative,
        "low": not negative and balance < LOW_BALANCE_UZS,
        "ledger": ledger,
        "uzsRates": UZS_RATES,
        "aiMinuteUzs": AI_MINUTE_UZS,
    }
