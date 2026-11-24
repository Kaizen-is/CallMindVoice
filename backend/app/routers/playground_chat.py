"""
Playground extras for goal-led agents:

    POST /playground/say        a typed turn, same reply shape as `playgroundTurnAction`
                                (app/playground_chats.py), which the page itself uses; kept
                                for API clients and tests
    GET  /playground/scenario   ?agentId= — who the tester plays when a goal agent calls them
    POST /playground/collect    {callId} — what the goal agent collected in that call (stored)

Through the site: /api/core/playground/{say,scenario,collect}.
"""

import json
import random
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app import db
from app.auth import LoggedIn
from app.engine.calls import start_call
from app.engine.conversation import run_turn
from app.ids import now_iso
from app.jscompat import js_trim
from app.llm.choice import agent_llm
from app.llm.goal_call import agent_goal, extract_collected, scenario
from app.playground import is_outbound, owned_playground_call, playground_agent

router = APIRouter(prefix="/playground")


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def _fail(message: str) -> JSONResponse:
    return JSONResponse({"ok": False, "message": message})


@router.post("/say")
async def say(request: Request, session: LoggedIn) -> JSONResponse:
    body = await _body(request)
    tenant_id = session.tenant["id"]
    agent = playground_agent(tenant_id, body.get("agentId"))
    if not agent:
        return _fail("Create an agent first.")
    utterance = body.get("utterance") if isinstance(body.get("utterance"), str) else ""
    if not js_trim(utterance):
        return _fail("Nothing was said.")

    call_id = body.get("callId") if isinstance(body.get("callId"), str) else None
    if call_id:
        # A chat reopened from the chats rail continues even after it was closed, as in `playgroundTurnAction`.
        if not owned_playground_call(tenant_id, call_id, agent["id"]):
            return _fail("That test session has expired.")
    else:
        call_id = start_call(
            tenant_id=tenant_id,
            agent_id=agent["id"],
            from_="playground",
            to="playground",
            caller_name=f"{session.user['name']} (test)",
            channel="web",
            direction="outbound" if is_outbound(agent) else "inbound",
        )

    stt_ms = body.get("sttMs") if isinstance(body.get("sttMs"), (int, float)) else 0
    result = await run_turn(tenant_id=tenant_id, call_id=call_id, agent=agent, utterance=utterance, stt_ms=stt_ms)
    reply: dict[str, Any] = {
        "ok": True,
        "callId": call_id,
        "reply": result["reply"],
        "language": result["language"],
        "intent": result["intent"],
        "confidence": result["confidence"],
        "answered": result["answered"],
        "escalate": result["escalate"],
        "timings": result["timings"],
        "citations": [
            {"documentTitle": c["documentTitle"], "heading": c["heading"], "snippet": c["snippet"], "score": c["score"]}
            for c in result["citations"]
        ],
        "retrieval": result["retrievalDebug"],
        "engine": result["engine"],
    }
    if "summary" in result:
        reply["summary"] = result["summary"]
    return JSONResponse(reply)


@router.get("/scenario")
async def get_scenario(request: Request, session: LoggedIn) -> JSONResponse:
    agent = playground_agent(session.tenant["id"], request.query_params.get("agentId"))
    goal = agent_goal(agent) if agent else None
    if goal is None:
        return JSONResponse({"scenario": None})
    seed = request.query_params.get("seed")
    return JSONResponse(
        {"scenario": scenario(goal, int(seed) if seed and seed.isdigit() else random.randrange(1 << 30))}
    )


@router.post("/collect")
async def collect(request: Request, session: LoggedIn) -> JSONResponse:
    body = await _body(request)
    tenant_id = session.tenant["id"]
    owned = owned_playground_call(tenant_id, body.get("callId"))
    if not owned:
        return JSONResponse({"error": "no_call"}, status_code=404)
    agent = playground_agent(tenant_id, owned["agent_id"])
    goal = agent_goal(agent) if agent else None
    if goal is None:
        return JSONResponse({"error": "no_goal"}, status_code=400)
    with db.connect() as conn:
        turns = db.fetch_all(
            conn, "SELECT role, text FROM turns WHERE call_id = :id ORDER BY ordinal ASC", id=owned["id"]
        )
    result = await extract_collected(goal, turns, agent_llm(agent))
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO call_results (call_id, tenant_id, agent_id, data_json, created_at)
               VALUES (:c, :t, :a, :d, :now)
               ON CONFLICT(call_id) DO UPDATE SET data_json = excluded.data_json, created_at = excluded.created_at""",
            c=owned["id"],
            t=tenant_id,
            a=agent["id"],
            d=json.dumps(result, ensure_ascii=False),
            now=now_iso(),
        )
    labels = {c["key"]: c["label"] for c in goal["collect"]}
    return JSONResponse({"result": result, "labels": labels})
