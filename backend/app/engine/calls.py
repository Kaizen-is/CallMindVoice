"""
Call lifecycle and usage accounting — port of src/lib/engine/calls.ts
(start, end + bill, daily roll-up, wallet debit, lookups).
"""

import math
from datetime import UTC, datetime, timedelta
from typing import Any

from app import db
from app.catalog import AI_MINUTE_UZS
from app.engine.bus import publish
from app.ids import new_id, now_iso, parse_iso, to_iso
from app.jscompat import js_fixed_number, js_round, js_to_fixed
from app.webhooks import dispatch_webhook

# What a minute costs us (not the customer price).
RATE_CARD = {
    "telephonyPerMin": 0.018,
    "sttPerMin": 0.004,
    "llmPerMin": 0.002,
    "ttsPerMin": 0.003,
    "platformPerMin": 0.005,
}
COST_PER_MINUTE = (
    RATE_CARD["telephonyPerMin"]
    + RATE_CARD["sttPerMin"]
    + RATE_CARD["llmPerMin"]
    + RATE_CARD["ttsPerMin"]
    + RATE_CARD["platformPerMin"]
)


def percentile(sorted_values: list[float], p: float) -> float:
    """`percentile` from utils.ts (nearest rank)."""
    if not sorted_values:
        return 0
    idx = min(max(math.ceil((p / 100) * len(sorted_values)) - 1, 0), len(sorted_values) - 1)
    return sorted_values[idx]


def start_call(
    *,
    tenant_id: str,
    agent_id: str | None,
    from_: str,
    to: str,
    number_id: str | None = None,
    caller_name: str | None = None,
    channel: str = "voice",
    direction: str = "inbound",
    language: str = "uz",
    started_at: str | None = None,
) -> str:
    call_id = new_id("call")
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO calls (id, tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164,
                 caller_name, status, language, started_at)
               VALUES (:id, :tenant_id, :agent_id, :number_id, :direction, :channel, :from_e164, :to_e164,
                 :caller_name, 'ringing', :language, :started_at)""",
            id=call_id,
            tenant_id=tenant_id,
            agent_id=agent_id,
            number_id=number_id,
            direction=direction,
            channel=channel,
            from_e164=from_,
            to_e164=to,
            caller_name=caller_name,
            language=language,
            started_at=started_at or now_iso(),
        )
    publish(tenant_id, {"type": "call_started", "callId": call_id, "from": from_, "to": to, "language": language})
    dispatch_webhook(tenant_id, "call.started", {"callId": call_id, "from": from_, "to": to, "language": language})
    return call_id


def _ms_between(later: str, earlier: str) -> int:
    return (parse_iso(later) - parse_iso(earlier)) // timedelta(milliseconds=1)


def end_call(
    *, tenant_id: str, call_id: str, outcome: str, csat: int | None = None, ended_at: str | None = None
) -> dict[str, Any] | None:
    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id AND tenant_id = :t", id=call_id, t=tenant_id)
        if call is None:
            return None
        latencies = sorted(
            r["latency_ms"]
            for r in db.fetch_all(
                conn,
                "SELECT latency_ms FROM turns WHERE call_id = :id AND role = 'agent' AND latency_ms IS NOT NULL",
                id=call_id,
            )
        )
    ended = ended_at or now_iso()
    duration_ms = max(1000, _ms_between(ended, call["started_at"]))
    avg = js_round(_js_sum(latencies) / len(latencies)) if latencies else None
    p95 = js_round(percentile(latencies, 95)) if latencies else None
    minutes = duration_ms / 60000
    cost = js_fixed_number(minutes * COST_PER_MINUTE, 4)
    debit = js_round(minutes * AI_MINUTE_UZS)

    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE calls SET status='completed', outcome=:outcome, ended_at=:ended_at, duration_ms=:duration_ms,
                 avg_latency_ms=:avg, p95_latency_ms=:p95, cost_usd=:cost, csat=:csat WHERE id=:id""",
            outcome=outcome,
            ended_at=ended,
            duration_ms=duration_ms,
            avg=avg,
            p95=p95,
            cost=cost,
            csat=csat,
            id=call_id,
        )
        _roll_up_usage(
            tx,
            tenant_id=tenant_id,
            day=ended[:10],
            outcome=outcome,
            escalated=bool(call["escalated"]),
            minutes=minutes,
            cost=cost,
            latency=avg or 0,
            csat=csat,
        )
        # Draw the handled minutes from the prepaid so'm wallet; the balance may go negative.
        if debit > 0:
            _debit_wallet(tx, tenant_id, debit, f"AI call · {js_to_fixed(minutes, 1)} min")

    publish(
        tenant_id,
        {"type": "call_ended", "callId": call_id, "outcome": outcome, "durationMs": duration_ms, "csat": csat},
    )
    dispatch_webhook(
        tenant_id,
        "call.completed",
        {"callId": call_id, "outcome": outcome, "durationMs": duration_ms, "avgLatencyMs": avg, "csat": csat},
    )
    return {"durationMs": duration_ms, "cost": cost, "avg": avg, "p95": p95}


def _js_sum(values: list[float]) -> float:
    total = 0
    for v in values:
        total += v
    return total


def abandon_call(tenant_id: str, call_id: str) -> dict[str, Any] | None:
    return end_call(tenant_id=tenant_id, call_id=call_id, outcome="abandoned")


def _roll_up_usage(
    tx,  # noqa: ANN001 - SQLAlchemy connection
    *,
    tenant_id: str,
    day: str,
    outcome: str,
    escalated: bool,
    minutes: float,
    cost: float,
    latency: float,
    csat: int | None,
) -> None:
    row = db.fetch_one(
        tx,
        "SELECT id, calls, avg_latency_ms FROM usage_daily WHERE tenant_id = :t AND day = :day",
        t=tenant_id,
        day=day,
    )
    ai_resolved = 1 if outcome == "resolved_by_ai" else 0
    esc = 1 if escalated else 0
    abandoned = 1 if outcome == "abandoned" else 0
    if row is None:
        db.execute(
            tx,
            """INSERT INTO usage_daily (id, tenant_id, day, calls, ai_resolved, escalated, abandoned,
                 minutes, cost_usd, avg_latency_ms, csat_sum, csat_count)
               VALUES (:id, :t, :day, 1, :ai, :esc, :ab, :minutes, :cost, :lat, :csat_sum, :csat_count)""",
            id=new_id("usg"),
            t=tenant_id,
            day=day,
            ai=ai_resolved,
            esc=esc,
            ab=abandoned,
            minutes=minutes,
            cost=cost,
            lat=js_round(latency),
            csat_sum=csat or 0,
            csat_count=1 if csat else 0,
        )
        return
    # Running mean, so the stored average stays correct without re-scanning calls.
    new_avg = js_round((row["avg_latency_ms"] * row["calls"] + latency) / (row["calls"] + 1))
    db.execute(
        tx,
        """UPDATE usage_daily SET calls = calls + 1, ai_resolved = ai_resolved + :ai, escalated = escalated + :esc,
             abandoned = abandoned + :ab, minutes = minutes + :minutes, cost_usd = cost_usd + :cost,
             avg_latency_ms = :avg, csat_sum = csat_sum + :csat_sum, csat_count = csat_count + :csat_count
           WHERE id = :id""",
        ai=ai_resolved,
        esc=esc,
        ab=abandoned,
        minutes=minutes,
        cost=cost,
        avg=new_avg,
        csat_sum=csat or 0,
        csat_count=1 if csat else 0,
        id=row["id"],
    )


def _debit_wallet(tx, tenant_id: str, amount_uzs: int, note: str) -> None:  # noqa: ANN001
    """Subtract so'm from the prepaid wallet and record it in `wallet_ledger` with the new balance."""
    db.execute(tx, "UPDATE tenants SET balance_uzs = balance_uzs - :a WHERE id = :t", a=amount_uzs, t=tenant_id)
    row = db.fetch_one(tx, "SELECT balance_uzs FROM tenants WHERE id = :t", t=tenant_id)
    db.execute(
        tx,
        """INSERT INTO wallet_ledger (id, tenant_id, kind, amount_uzs, balance_after, note, created_at)
           VALUES (:id, :t, 'debit', :a, :balance, :note, :now)""",
        id=new_id("wl"),
        t=tenant_id,
        a=amount_uzs,
        balance=(row or {}).get("balance_uzs", 0),
        note=note,
        now=now_iso(),
    )


# ── lookups ─────────────────────────────────────────────────────────


def live_agent(tenant_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(
            conn,
            "SELECT * FROM agents WHERE tenant_id = :t AND status = 'live' ORDER BY updated_at DESC LIMIT 1",
            t=tenant_id,
        ) or db.fetch_one(
            conn, "SELECT * FROM agents WHERE tenant_id = :t ORDER BY updated_at DESC LIMIT 1", t=tenant_id
        )


def list_agents(tenant_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn, "SELECT id, name, status FROM agents WHERE tenant_id = :t ORDER BY created_at ASC", t=tenant_id
        )


def active_calls(tenant_id: str) -> list[dict[str, Any]]:
    """Calls on the line now. Playground sessions are excluded: a forgotten tab is not a caller."""
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT * FROM calls WHERE tenant_id = :t AND channel = 'voice'
                 AND status IN ('ringing','active','escalating','with_operator') ORDER BY started_at DESC""",
            t=tenant_id,
        )


def reap_stale_calls(tenant_id: str, older_than_ms: int = 15 * 60_000) -> int:
    """Close voice calls stuck open (a crashed simulator, say). Playground and demo calls close themselves."""
    cutoff = to_iso(datetime.now(UTC) - timedelta(milliseconds=older_than_ms))
    with db.connect() as conn:
        stale = db.fetch_all(
            conn,
            """SELECT id FROM calls WHERE tenant_id = :t AND status IN ('ringing','active') AND started_at < :cutoff
                 AND NOT (channel = 'web' AND from_e164 IN ('playground','demo'))""",
            t=tenant_id,
            cutoff=cutoff,
        )
    for s in stale:
        end_call(tenant_id=tenant_id, call_id=s["id"], outcome="abandoned")
    return len(stale)
