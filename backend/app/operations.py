"""
Calls and operations: the operator inbox, call history, call detail and the live wallboard, plus
the operator's actions on a call — ports of the inbox/escalation actions in
src/app/actions/ops.ts and of the data src/app/app/{inbox,calls,calls/[id],live}/page.tsx read.

Every function returns exactly the rows/objects the TypeScript produced (same keys, same order),
so the pages render them unchanged.
"""

import json
import math
import re
from typing import Any

from app import db
from app.engine.calls import active_calls, reap_stale_calls
from app.engine.demo_data import iso, now_ms
from app.engine.simulator import simulator_load, stop_simulation
from app.ids import new_id, now_iso
from app.jscompat import JS_S, js_json
from app.llm.choice import agent_llm, tenant_default_llm
from app.llm.provider import summarize_call
from app.telephony import telephony_status

PAGE_SIZE = 50  # calls per page on the call history


def safe_json(raw: str | None, fallback: Any) -> Any:
    """`safeJson` from utils.ts with JSON.parse's rules: no NaN/Infinity, big integers lose precision."""
    if not raw:
        return fallback

    def no_constant(name: str) -> Any:
        raise ValueError(name)

    def js_int(digits: str) -> int | float:
        n = int(digits)
        return n if abs(n) <= 2**53 else float(digits)

    try:
        return json.loads(raw, parse_constant=no_constant, parse_int=js_int)
    except ValueError:
        return fallback


# ── operator inbox ──────────────────────────────────────────────────


def inbox(tenant_id: str) -> list[dict[str, Any]]:
    """Open escalations (most urgent first, then oldest), each with its call's transcript."""
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            """SELECT e.*, c.from_e164, c.caller_name, c.language, c.started_at, c.intent, c.sentiment, c.turns,
                      u.name AS operator_name
               FROM escalations e
               JOIN calls c ON c.id = e.call_id
               LEFT JOIN users u ON u.id = e.operator_id
               WHERE e.tenant_id = :t AND e.status IN ('waiting','assigned') AND c.channel = 'voice'
               ORDER BY CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                        e.created_at ASC""",
            t=tenant_id,
        )
        return [
            {
                **r,
                "transcript": db.fetch_all(
                    conn,
                    """SELECT ordinal, role, text, confidence, citations_json, timings_json, created_at
                       FROM turns WHERE call_id = :c AND text != '__unanswered__' ORDER BY ordinal ASC""",
                    c=r["call_id"],
                ),
            }
            for r in rows
        ]


def operator_reply(tenant_id: str, call_id: Any, text: Any) -> dict[str, Any]:
    """The operator's line, added to the call's transcript."""
    call_id = bind(call_id)
    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id AND tenant_id = :t", id=call_id, t=tenant_id)
        if call is None:
            return {"ok": False, "message": "Call not found."}
        row = db.fetch_one(conn, "SELECT COALESCE(MAX(ordinal), -1) AS n FROM turns WHERE call_id = :c", c=call_id)
    ordinal = (row["n"] if row and row["n"] is not None else -1) + 1
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, citations_json, timings_json,
                 created_at)
               VALUES (:id, :t, :c, :ordinal, 'operator', :text, :language, '[]', '{}', :now)""",
            id=new_id("trn"),
            t=tenant_id,
            c=call_id,
            ordinal=ordinal,
            text=bind(text),
            language=call["language"],
            now=now_iso(),
        )
    return {"ok": True}


async def refresh_summary(tenant_id: str, escalation_id: Any) -> dict[str, Any]:
    """Regenerate the hand-off summary — useful after the operator adds context."""
    escalation_id = bind(escalation_id)
    with db.connect() as conn:
        esc = db.fetch_one(
            conn,
            "SELECT call_id, reason FROM escalations WHERE id = :id AND tenant_id = :t",
            id=escalation_id,
            t=tenant_id,
        )
        if esc is None:
            return {"ok": False, "message": "Escalation not found."}
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id", id=esc["call_id"])
        turns = db.fetch_all(
            conn,
            "SELECT role, text FROM turns WHERE call_id = :c AND text != '__unanswered__' ORDER BY ordinal ASC",
            c=esc["call_id"],
        )
        agent = (
            db.fetch_one(
                conn, "SELECT * FROM agents WHERE id = :id AND tenant_id = :t", id=call["agent_id"], t=tenant_id
            )
            if call and call["agent_id"]
            else None
        )
    language = call["language"] if call and call["language"] is not None else "en"
    summary = await summarize_call(
        turns, language, esc["reason"], agent_llm(agent) if agent else tenant_default_llm(tenant_id)
    )
    with db.transaction() as tx:
        db.execute(tx, "UPDATE escalations SET summary = :s WHERE id = :id", s=summary, id=escalation_id)
        db.execute(tx, "UPDATE calls SET summary = :s WHERE id = :id", s=summary, id=esc["call_id"])
    return {"ok": True, "summary": summary}


def stop_simulated_calls(tenant_id: str) -> int:
    """Cancel the simulator's pending waits and abandon every call still ringing or active."""
    stopped = stop_simulation(tenant_id)
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE calls SET status='abandoned', outcome='abandoned', ended_at=:now
               WHERE tenant_id=:t AND status IN ('ringing','active')""",
            now=now_iso(),
            t=tenant_id,
        )
    return stopped


# ── call history ────────────────────────────────────────────────────


def calls_page(tenant_id: str, params: dict[str, list[str]]) -> dict[str, Any]:
    """
    One page of the call history. `params` is the page's search params as a multi-dict: a key given
    once is a string in Next.js, a repeated key an array — both treated as the page treated them.
    Playground/test sessions (channel 'web') are left out.
    """
    outcome = _param(params, "outcome")
    lang = _param(params, "lang")
    q = _param(params, "q")
    page_param = _param(params, "page")

    filters = ["tenant_id = :t", "channel != 'web'"]
    args: dict[str, Any] = {"t": tenant_id}
    if outcome and outcome != "all":
        if outcome == "escalated":
            filters.append("escalated = 1")
        else:
            filters.append("outcome = :outcome")
            args["outcome"] = bind(outcome)
    if lang and lang != "all":
        filters.append("language = :lang")
        args["lang"] = bind(lang)
    if q:
        filters.append("(from_e164 LIKE :like OR caller_name LIKE :like OR summary LIKE :like OR intent LIKE :like)")
        args["like"] = f"%{js_string(q)}%"

    where = " AND ".join(filters)
    with db.connect() as conn:
        row = db.fetch_one(conn, f"SELECT COUNT(*) AS n FROM calls WHERE {where}", **args)  # noqa: S608
        total = row["n"] if row and row["n"] is not None else 0
        pages = max(1, math.ceil(total / PAGE_SIZE))
        # `Number.parseInt(params.page ?? '1', 10) || 1`, clamped to the pages there are.
        page = min(pages, max(1, js_parse_int(js_string(page_param) if page_param is not None else "1") or 1))
        calls = db.fetch_all(
            conn,
            f"SELECT * FROM calls WHERE {where} ORDER BY started_at DESC LIMIT :limit OFFSET :offset",  # noqa: S608
            **args,
            limit=PAGE_SIZE,
            offset=(page - 1) * PAGE_SIZE,
        )
    return {"calls": calls, "paging": {"page": page, "pages": pages, "total": total, "pageSize": PAGE_SIZE}}


def call_detail(tenant_id: str, call_id: str) -> dict[str, Any] | None:
    """`callWithTurns` plus the latest escalation; None when the call is not this tenant's."""
    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id AND tenant_id = :t", id=call_id, t=tenant_id)
        if call is None:
            return None
        turns = db.fetch_all(
            conn,
            "SELECT * FROM turns WHERE call_id = :id AND text != '__unanswered__' ORDER BY ordinal ASC",
            id=call_id,
        )
        escalation = db.fetch_one(
            conn, "SELECT * FROM escalations WHERE call_id = :id ORDER BY created_at DESC LIMIT 1", id=call["id"]
        )
    return {
        "call": call,
        "turns": [
            {**t, "citations": safe_json(t["citations_json"], []), "timings": safe_json(t["timings_json"], {})}
            for t in turns
        ],
        "escalation": escalation,
    }


# ── live wallboard ──────────────────────────────────────────────────


def live_board(tenant_id: str) -> dict[str, Any]:
    """The wallboard: calls on the line with their last two lines, today's numbers, the simulator load."""
    reap_stale_calls(tenant_id)
    calls = active_calls(tenant_id)
    stats = _today(tenant_id)
    with db.connect() as conn:
        with_last = [
            {
                "call": c,
                "recent": list(
                    reversed(
                        db.fetch_all(
                            conn,
                            """SELECT role, text, confidence, created_at FROM turns
                               WHERE call_id = :c AND text != '__unanswered__' ORDER BY ordinal DESC LIMIT 2""",
                            c=c["id"],
                        )
                    )
                ),
            }
            for c in calls
        ]
    return {
        "calls": with_last,
        "todayCalls": stats["totalCalls"],
        "todayDeflection": stats["deflectionRate"],
        "waiting": stats["waitingEscalations"],
        "simulated": simulator_load(tenant_id),
        "telephony": telephony_status(),
    }


def _today(tenant_id: str) -> dict[str, Any]:
    """The three numbers the wallboard takes from `overview(tenantId, 1)` in analytics.ts, computed the same way."""
    since = iso(now_ms() - 1 * 86400000)
    with db.connect() as conn:
        totals = db.fetch_one(
            conn,
            """SELECT COUNT(*) AS calls, SUM(CASE WHEN outcome='resolved_by_ai' THEN 1 ELSE 0 END) AS ai
               FROM calls WHERE tenant_id = :t AND started_at >= :since""",
            t=tenant_id,
            since=since,
        )
        waiting = db.fetch_one(
            conn, "SELECT COUNT(*) AS c FROM escalations WHERE tenant_id = :t AND status = 'waiting'", t=tenant_id
        )
    calls = (totals or {}).get("calls") or 0
    ai = (totals or {}).get("ai") or 0
    return {
        "totalCalls": calls,
        "deflectionRate": ai / calls if calls else 0,
        "waitingEscalations": (waiting or {}).get("c") or 0,
    }


# ── JavaScript value handling ───────────────────────────────────────


def _param(params: dict[str, list[str]], key: str) -> str | list[str] | None:
    values = params.get(key) or []
    if not values:
        return None
    return values[0] if len(values) == 1 else list(values)


def js_string(value: Any) -> str:
    """`String(value)` / a template literal: an array joins with commas."""
    if isinstance(value, list):
        return ",".join("" if v is None else js_string(v) for v in value)
    if value is None:
        return "null"
    if value is True or value is False:
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        from app.jscompat import js_number_str

        return js_number_str(value)
    return str(value)


def bind(value: Any) -> Any:
    """A query parameter as db.ts binds it: booleans as 0/1, arrays and objects as their JSON."""
    if value is True or value is False:
        return 1 if value else 0
    if isinstance(value, (list, dict)):
        return js_json(value)
    return value


_PARSE_INT = re.compile(rf"^[{JS_S}]*([+-]?)([0-9]+)")


def js_parse_int(s: str) -> int | None:
    """`Number.parseInt(s, 10)`: leading digits after optional whitespace and sign; None for NaN."""
    m = _PARSE_INT.match(s)
    if not m:
        return None
    n = int(m.group(2))
    return -n if m.group(1) == "-" else n
