"""
Calls and operations in the console — the server actions of src/app/actions/ops.ts for the
simulator, demo data, escalations and the operator inbox (`POST /actions/<name>`), and the data
of the inbox, call history, call detail and live pages (`GET /views/<page>`). Through the site:
/api/core/actions/… and /api/core/views/…, called by the thin TypeScript proxies.
"""

import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from app import operations as ops
from app.audit import audit
from app.auth import LoggedIn, Session, require_role
from app.engine.calls import end_call, live_agent
from app.engine.conversation import assign_escalation, resolve_escalation
from app.engine.demo_data import clear_demo_history, seed_demo_history
from app.engine.simulator import simulate_burst, simulate_call, simulator_load
from app.jscompat import js_number
from app.telephony import telephony_status
from app.views_common import action_args, js_response

router = APIRouter()

Operator = Annotated[Session, Depends(require_role("operator"))]
Admin = Annotated[Session, Depends(require_role("admin"))]

_MISSING = object()


def _js_number(value: Any) -> float:
    """`Number(value)` for a JSON argument (a missing one is undefined, so NaN)."""
    if value is _MISSING:
        return math.nan
    if value is None:
        return 0
    if value is True or value is False:
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return js_number(value)
    return math.nan


def _js_clamp(value: float, low: float, high: float) -> float:
    """`Math.min(high, Math.max(low, value))` — NaN stays NaN (Python's min/max would drop it)."""
    if isinstance(value, float) and math.isnan(value):
        return value
    return min(high, max(low, value))


# ── simulator ───────────────────────────────────────────────────────


@router.post("/actions/simulateCallAction")
async def simulate_call_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    opts = args.get("opts")
    opts = opts if isinstance(opts, dict) else {}
    tenant_id = session.tenant["id"]
    if live_agent(tenant_id) is None:
        return js_response({"ok": False, "message": "Create an agent before running a simulated call."})
    call_id = simulate_call(tenant_id, language=opts.get("language"), difficulty=opts.get("difficulty"), speed=6)
    return js_response(
        {"ok": bool(call_id), "callId": call_id, "message": "Call started." if call_id else "Could not start a call."}
    )


@router.post("/actions/simulateBurstAction")
async def simulate_burst_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    tenant_id = session.tenant["id"]
    started = await simulate_burst(
        tenant_id, count=_js_clamp(_js_number(args.get("count", _MISSING)), 1, 24), speed=8, difficulty=0.3
    )
    audit(tenant_id, session.user, "simulator.burst", None, {"count": len(started)})
    return js_response({"ok": True, "message": f"{len(started)} calls queued.", "callIds": started})


@router.post("/actions/stopSimulationAction")
async def stop_simulation_action(session: Operator) -> Response:
    stopped = ops.stop_simulated_calls(session.tenant["id"])
    return js_response({"ok": True, "message": f"Stopped {stopped} simulated call{'' if stopped == 1 else 's'}."})


@router.post("/actions/simulatorStatusAction")
async def simulator_status_action(session: LoggedIn) -> Response:
    return js_response({"running": simulator_load(session.tenant["id"]), "telephony": telephony_status()})


# ── demo data ───────────────────────────────────────────────────────


@router.post("/actions/seedDemoHistoryAction")
async def seed_demo_history_action(session: Admin) -> Response:
    tenant_id = session.tenant["id"]
    result = await seed_demo_history(tenant_id)
    audit(tenant_id, session.user, "demo.seeded", None, {"created": result["created"]})
    return js_response(result)


@router.post("/actions/clearHistoryAction")
async def clear_history_action(session: Admin) -> Response:
    tenant_id = session.tenant["id"]
    removed = clear_demo_history(tenant_id)
    audit(tenant_id, session.user, "demo.cleared", None, {"removed": removed})
    return js_response({"ok": True, "message": f"Removed {removed} call records."})


# ── escalations ─────────────────────────────────────────────────────


@router.post("/actions/acceptEscalationAction")
async def accept_escalation_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    tenant_id = session.tenant["id"]
    escalation_id = ops.bind(args.get("escalationId"))
    call_id = assign_escalation(tenant_id, escalation_id, session.user["id"])
    if not call_id:
        return js_response({"ok": False, "message": "Someone else already took this call."})
    audit(tenant_id, session.user, "escalation.accepted", escalation_id, {"callId": call_id})
    return js_response({"ok": True, "callId": call_id, "message": "You are on the call."})


@router.post("/actions/resolveEscalationAction")
async def resolve_escalation_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    tenant_id = session.tenant["id"]
    escalation_id = ops.bind(args.get("escalationId"))
    resolution = args.get("resolution", _MISSING)
    call_id = resolve_escalation(
        tenant_id,
        escalation_id,
        ops.bind(None if resolution is _MISSING else resolution),
        ops.bind(args.get("notes", "")),  # `notes = ''` applies only when the argument is left out
    )
    if not call_id:
        return js_response({"ok": False, "message": "Escalation not found."})
    end_call(tenant_id=tenant_id, call_id=call_id, outcome="resolved_by_operator", csat=args.get("csat"))
    # JSON.stringify leaves out an undefined resolution.
    meta = {} if resolution is _MISSING else {"resolution": resolution}
    audit(tenant_id, session.user, "escalation.resolved", escalation_id, meta)
    return js_response({"ok": True, "message": "Call closed."})


@router.post("/actions/operatorReplyAction")
async def operator_reply_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    return js_response(ops.operator_reply(session.tenant["id"], args.get("callId"), args.get("text")))


@router.post("/actions/inboxAction")
async def inbox_action(session: LoggedIn) -> Response:
    return js_response(ops.inbox(session.tenant["id"]))


@router.post("/actions/refreshSummaryAction")
async def refresh_summary_action(request: Request, session: Operator) -> Response:
    args = await action_args(request)
    return js_response(await ops.refresh_summary(session.tenant["id"], args.get("escalationId")))


# ── page data ───────────────────────────────────────────────────────


@router.get("/views/inbox")
async def inbox_view(session: LoggedIn) -> Response:
    return js_response(ops.inbox(session.tenant["id"]))


@router.get("/views/calls")
async def calls_view(request: Request, session: LoggedIn) -> Response:
    params: dict[str, list[str]] = {}
    for key, value in request.query_params.multi_items():
        params.setdefault(key, []).append(value)
    return js_response(ops.calls_page(session.tenant["id"], params))


@router.get("/views/calls/{call_id:path}")
async def call_detail_view(call_id: str, session: LoggedIn) -> Response:
    return js_response(ops.call_detail(session.tenant["id"], call_id))


@router.get("/views/live")
async def live_view(session: LoggedIn) -> Response:
    return js_response(ops.live_board(session.tenant["id"]))
