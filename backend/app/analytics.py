"""
Analytics roll-ups — port of src/lib/analytics.ts.

Everything here derives from the calls / escalations / usage_daily / documents
tables, so what the dashboards show is what the engine actually did.

Differences from JavaScript handled here:
  • `new Date(Date.now() - days * 864e5).toISOString()` → `_since` (UTC, milliseconds, `Z`).
  • Sums of floats add left to right like `reduce` (Python 3.12's `sum()` compensates).
  • `hourlyHeat` buckets by the server's LOCAL time with Sunday = 0, like `getDay()` / `getHours()`.

One intentional change (approved by the owner): `intents()` groups by `COALESCE(intent,'general')`,
so calls with no intent and calls whose intent is 'general' are one row (the TypeScript grouped
by the raw column and could show "General enquiry" twice).
"""

from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any

from app import db
from app.engine.calls import SAVING_PER_DEFLECTED_MINUTE, percentile
from app.ids import parse_iso, to_iso
from app.jscompat import js_round
from app.llm.local import INTENT_LABEL


def _now(now: datetime | None) -> datetime:
    return now if now is not None else datetime.now(UTC)


def _since(days: float, now: datetime | None) -> str:
    """`new Date(Date.now() - days * 864e5).toISOString()`."""
    return to_iso(_now(now) - timedelta(milliseconds=days * 864e5))


def _js_sum(values: list[float]) -> float:
    total: float = 0
    for v in values:
        total += v
    return total


def day_keys_back(n: int, now: datetime | None = None) -> list[str]:
    """`dayKeysBack` from utils.ts: the last n UTC dates (YYYY-MM-DD), oldest first, today last."""
    start = _now(now)
    return [to_iso(start - timedelta(milliseconds=i * 864e5))[:10] for i in range(n - 1, -1, -1)]


def overview(tenant_id: str, days: float = 30, now: datetime | None = None) -> dict[str, Any]:
    since = _since(days, now)
    with db.connect() as conn:
        totals = db.fetch_one(
            conn,
            """SELECT COUNT(*) AS calls,
                      SUM(CASE WHEN outcome='resolved_by_ai' THEN 1 ELSE 0 END) AS ai,
                      SUM(escalated) AS esc,
                      SUM(CASE WHEN outcome='abandoned' THEN 1 ELSE 0 END) AS aband,
                      COALESCE(SUM(duration_ms),0) AS ms,
                      COALESCE(SUM(cost_usd),0) AS cost,
                      COALESCE(SUM(csat),0) AS csatSum,
                      SUM(CASE WHEN csat IS NOT NULL THEN 1 ELSE 0 END) AS csatCount
               FROM calls WHERE tenant_id=:t AND started_at >= :since""",
            t=tenant_id,
            since=since,
        )
        latencies = [
            r["v"]
            for r in db.fetch_all(
                conn,
                """SELECT avg_latency_ms AS v FROM calls
                   WHERE tenant_id=:t AND started_at >= :since AND avg_latency_ms IS NOT NULL
                   ORDER BY avg_latency_ms ASC""",
                t=tenant_id,
                since=since,
            )
        ]
        active = db.fetch_one(
            conn,
            "SELECT COUNT(*) AS c FROM calls WHERE tenant_id=:t "
            "AND status IN ('ringing','active','escalating','with_operator')",
            t=tenant_id,
        )
        waiting = db.fetch_one(
            conn, "SELECT COUNT(*) AS c FROM escalations WHERE tenant_id=:t AND status='waiting'", t=tenant_id
        )

    totals = totals or {}

    def val(key: str) -> Any:
        """`totals?.<key> ?? 0`."""
        v = totals.get(key)
        return 0 if v is None else v

    calls = val("calls")
    ai = val("ai")
    ms = val("ms")
    minutes = ms / 60000
    ai_minutes = minutes * (ai / calls) if calls else 0
    csat_count = totals.get("csatCount")
    return {
        "totalCalls": calls,
        "aiResolved": ai,
        "escalated": val("esc"),
        "abandoned": val("aband"),
        "deflectionRate": ai / calls if calls else 0,
        "minutes": minutes,
        "costUsd": val("cost"),
        "avgLatencyMs": js_round(_js_sum(latencies) / len(latencies)) if latencies else 0,
        "p95LatencyMs": js_round(percentile(latencies, 95)) if latencies else 0,
        "csat": val("csatSum") / csat_count if csat_count else None,
        "csatResponses": val("csatCount"),
        "avgHandleSec": ms / calls / 1000 if calls else 0,
        "operatorHoursSaved": ai_minutes / 60,
        # Only fully-deflected minutes count: an escalated call was paid for twice, so it is not a
        # saving. Telephony is excluded from both sides.
        "savingsUsd": ai_minutes * SAVING_PER_DEFLECTED_MINUTE,
        "activeNow": (active or {}).get("c") or 0,
        "waitingEscalations": (waiting or {}).get("c") or 0,
    }


def daily(tenant_id: str, days: int = 30, now: datetime | None = None) -> list[dict[str, Any]]:
    keys = day_keys_back(days, now)
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            "SELECT * FROM usage_daily WHERE tenant_id=:t AND day >= :day ORDER BY day ASC",
            t=tenant_id,
            day=keys[0] if keys else None,
        )
    by_day = {r["day"]: r for r in rows}

    def field(r: dict[str, Any] | None, key: str) -> Any:
        v = r.get(key) if r else None
        return 0 if v is None else v

    out = []
    for day in keys:
        r = by_day.get(day)
        out.append(
            {
                "day": day,
                "calls": field(r, "calls"),
                "aiResolved": field(r, "ai_resolved"),
                "escalated": field(r, "escalated"),
                "abandoned": field(r, "abandoned"),
                "minutes": field(r, "minutes"),
                "cost": field(r, "cost_usd"),
                "avgLatencyMs": field(r, "avg_latency_ms"),
                "csat": r["csat_sum"] / r["csat_count"] if r and r["csat_count"] else None,
            }
        )
    return out


def intents(tenant_id: str, days: float = 30, limit: int = 8, now: datetime | None = None) -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            """SELECT COALESCE(intent,'general') AS intent, COUNT(*) AS c,
                      SUM(CASE WHEN outcome='resolved_by_ai' THEN 1 ELSE 0 END) AS resolved
               FROM calls WHERE tenant_id=:t AND started_at >= :since
               GROUP BY COALESCE(intent,'general') ORDER BY c DESC LIMIT :limit""",
            t=tenant_id,
            since=_since(days, now),
            limit=limit,
        )
    return [
        {
            "intent": r["intent"],
            "label": INTENT_LABEL.get(r["intent"], r["intent"]),
            "count": r["c"],
            "resolvedRate": r["resolved"] / r["c"] if r["c"] else 0,
        }
        for r in rows
    ]


def language_split(tenant_id: str, days: float = 30, now: datetime | None = None) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT language, COUNT(*) AS c FROM calls WHERE tenant_id=:t AND started_at >= :since
               GROUP BY language ORDER BY c DESC""",
            t=tenant_id,
            since=_since(days, now),
        )


def hourly_heat(
    tenant_id: str, days: float = 14, now: datetime | None = None, tz: tzinfo | None = None
) -> list[list[int]]:
    """Calls per [weekday][hour] in the server's local time (`tz` overrides it, for tests); Sunday = 0."""
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            "SELECT started_at FROM calls WHERE tenant_id=:t AND started_at >= :since",
            t=tenant_id,
            since=_since(days, now),
        )
    grid = [[0] * 24 for _ in range(7)]
    for r in rows:
        moment = parse_iso(r["started_at"]).astimezone(tz)
        grid[(moment.weekday() + 1) % 7][moment.hour] += 1
    return grid


def escalation_reasons(tenant_id: str, days: float = 30, now: datetime | None = None) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT reason, COUNT(*) AS c, AVG(waited_ms) AS avgWait
               FROM escalations WHERE tenant_id=:t AND created_at >= :since
               GROUP BY reason ORDER BY c DESC""",
            t=tenant_id,
            since=_since(days, now),
        )


def knowledge_gaps(tenant_id: str, limit: int = 10) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT id, question, hits, best_score, last_seen FROM knowledge_gaps
               WHERE tenant_id=:t AND status='open' ORDER BY hits DESC, last_seen DESC LIMIT :limit""",
            t=tenant_id,
            limit=limit,
        )


def operator_leaderboard(tenant_id: str, days: float = 30, now: datetime | None = None) -> list[dict[str, Any]]:
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT u.id, u.name, u.avatar_hue,
                      COUNT(e.id) AS handled,
                      AVG(e.handled_ms) AS avgHandle,
                      AVG(e.waited_ms) AS avgWait
               FROM users u LEFT JOIN escalations e
                 ON e.operator_id = u.id AND e.status='resolved' AND e.created_at >= :since
               WHERE u.tenant_id=:t AND u.role IN ('operator','admin','owner')
               GROUP BY u.id ORDER BY handled DESC""",
            since=_since(days, now),
            t=tenant_id,
        )


def knowledge_stats(tenant_id: str) -> dict[str, Any]:
    with db.connect() as conn:
        docs = db.fetch_one(
            conn,
            """SELECT COUNT(*) AS c,
                      SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
                      COALESCE(SUM(chunk_count),0) AS chunks,
                      COALESCE(SUM(token_count),0) AS tokens,
                      COALESCE(SUM(byte_size),0) AS bytes
               FROM documents WHERE tenant_id=:t""",
            t=tenant_id,
        )
    docs = docs or {}

    def val(key: str) -> Any:
        v = docs.get(key)
        return 0 if v is None else v

    return {
        "documents": val("c"),
        "ready": val("ready"),
        "chunks": val("chunks"),
        "tokens": val("tokens"),
        "bytes": val("bytes"),
    }
