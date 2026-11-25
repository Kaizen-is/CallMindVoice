"""
The console Playground's voice call — port of src/lib/playground.ts: the
public demo's experience for the signed-in team, with the agent they picked
and everything saved on it. Calls are ordinary Playground chats (from
"playground", channel web) and each is billed exactly once, for the time
actually spent talking (`close_playground_call`).
"""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from app import db
from app.catalog import VOICES
from app.engine.bus import publish
from app.engine.calls import end_call, live_agent, start_call
from app.engine.conversation import agent_hours, agent_target
from app.ids import new_id, now_iso, to_iso
from app.jscompat import js_trim
from app.llm.choice import agent_llm
from app.llm.goal_call import agent_goal
from app.llm.prompts import GenerateInput
from app.llm.provider import generate_answer
from app.rag.text import detect_language
from app.voices import list_custom_voices

# ── lookups ─────────────────────────────────────────────────────────


def playground_agent(tenant_id: str, agent_id: object) -> dict[str, Any] | None:
    if isinstance(agent_id, str) and agent_id:
        with db.connect() as conn:
            return db.fetch_one(
                conn, "SELECT * FROM agents WHERE id = :id AND tenant_id = :t", id=agent_id, t=tenant_id
            )
    return live_agent(tenant_id)


def call_agents(tenant_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        agents = db.fetch_all(conn, "SELECT * FROM agents WHERE tenant_id = :t ORDER BY created_at ASC", t=tenant_id)
    out = []
    for a in agents:
        target = agent_target(a)
        out.append(
            {
                "id": a["id"],
                "name": a["name"],
                "primaryLang": a["primary_lang"],
                "target": {"fullName": target["fullName"], "birthYear": target["birthYear"]}
                if target["fullName"]
                else None,
            }
        )
    return out


def call_lang(value: object, agent: dict[str, Any]) -> str:
    return value if value in ("uz", "ru", "en") else agent["primary_lang"]  # type: ignore[return-value]


def call_voice(agent: dict[str, Any], requested: object) -> str:
    """The voice asked for, when it is built in or this tenant's own; otherwise the agent's."""
    want = js_trim(requested) if isinstance(requested, str) else ""
    if not want:
        return agent["voice_id"]
    known = any(v["id"] == want for v in VOICES) or any(v["id"] == want for v in list_custom_voices(agent["tenant_id"]))
    return want if known else agent["voice_id"]


def owned_playground_call(tenant_id: str, call_id: object, agent_id: str | None = None) -> dict[str, Any] | None:
    if not isinstance(call_id, str) or not call_id:
        return None
    with db.connect() as conn:
        call = db.fetch_one(
            conn,
            """SELECT id, agent_id, turns, escalated, started_at, ended_at FROM calls
               WHERE id = :id AND tenant_id = :t AND channel = 'web' AND from_e164 = 'playground'""",
            id=call_id,
            t=tenant_id,
        )
    return call if call and (not agent_id or call["agent_id"] == agent_id) else None


# ── call lifecycle ──────────────────────────────────────────────────


def open_playground_call(tenant_id: str, user_name: str, agent: dict[str, Any], lang: str) -> str:
    return start_call(
        tenant_id=tenant_id,
        agent_id=agent["id"],
        from_="playground",
        to="playground",
        caller_name=f"{user_name} (test)",
        channel="web",
        direction="outbound" if is_outbound(agent) else "inbound",
        language=lang,
    )


def is_outbound(agent: dict[str, Any]) -> bool:
    """The agent places the call: a loan reminder ("Who to call") or a goal-led call (Python only)."""
    return bool(agent_target(agent)["fullName"]) or agent_goal(agent) is not None


PLAYGROUND_IDLE = timedelta(minutes=10)


def close_idle_playground_calls(tenant_id: str) -> None:
    """Close Playground calls that went quiet without a hang-up (a closed tab), billed to their last message."""
    cutoff = to_iso(datetime.now(UTC) - PLAYGROUND_IDLE)
    with db.connect() as conn:
        idle = db.fetch_all(
            conn,
            """SELECT c.id FROM calls c
               WHERE c.tenant_id = :t AND c.from_e164 = 'playground' AND c.ended_at IS NULL
                 AND COALESCE((SELECT MAX(t.created_at) FROM turns t WHERE t.call_id = c.id), c.started_at)
                     < :cutoff""",
            t=tenant_id,
            cutoff=cutoff,
        )
    for call in idle:
        close_playground_call(tenant_id, call["id"])


def close_playground_call(tenant_id: str, call_id: object, csat: int | None = None) -> bool:
    """End and bill a Playground chat — the only place that does. Whoever sets `ended_at` first bills."""
    call = owned_playground_call(tenant_id, call_id)
    if not call or call["ended_at"]:
        return False
    with db.transaction() as tx:
        last = db.fetch_one(tx, "SELECT MAX(created_at) AS at FROM turns WHERE call_id = :id", id=call["id"])
        ended_at = (last or {}).get("at") or call["started_at"]
        changed = db.execute(
            tx, "UPDATE calls SET ended_at = :e WHERE id = :id AND ended_at IS NULL", e=ended_at, id=call["id"]
        )
    if changed != 1:
        return False
    end_call(
        tenant_id=tenant_id,
        call_id=call["id"],
        ended_at=ended_at,
        csat=csat,
        outcome="abandoned"
        if call["turns"] == 0
        else "resolved_by_operator"
        if call["escalated"]
        else "resolved_by_ai",
    )
    # An escalation nobody picked up before the test call ended can no longer be answered: left "waiting",
    # it stayed in the operators' inbox and its counts for good (five such since 11 Nov 2026). The caller
    # is gone, so it was missed.
    with db.transaction() as tx:
        db.execute(
            tx, "UPDATE escalations SET status = 'missed' WHERE call_id = :id AND status = 'waiting'", id=call["id"]
        )
    return True


# ── the opening line ────────────────────────────────────────────────

# What the person "says" on picking up an outbound call.
PICKUP = {"uz": "Allo", "ru": "Алло", "en": "Hello"}

# Openings generated by the model, reused for the day.
_openings: dict[str, asyncio.Task] = {}


async def playground_opening(agent: dict[str, Any], lang: str) -> str | None:
    """
    The agent's first line. A receptionist says its greeting; an agent with a "Who to call" person
    is the one calling, so its opening comes from the model, once per day.
    """
    target = agent_target(agent)
    goal = None if target["fullName"] else agent_goal(agent)
    greeting = js_trim(agent.get("greeting") or "") or None
    if not target["fullName"] and goal is None:
        return greeting
    # The name is part of the key: a call voiced by Nadya must not reuse Isomiddin's introduction.
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    key = f"{agent['id']}:{agent['updated_at']}:{agent['name']}:{agent_llm(agent) or ''}:{lang}:{today}"
    task = _openings.get(key)
    if task is None:
        if len(_openings) > 200:
            _openings.clear()

        async def make() -> str | None:
            out = await generate_answer(
                GenerateInput(
                    question=PICKUP[lang],
                    hits=[],
                    confidence=0,
                    language=lang,
                    agent_name=agent["name"],
                    threshold=agent["confidence_threshold"],
                    history=[],
                    persona=agent.get("persona"),
                    instructions=agent.get("instructions"),
                    target=target,
                    greeting=agent.get("greeting"),
                    time_zone=agent_hours(agent)["timezone"],
                    llm=agent_llm(agent),
                    goal=goal,
                )
            )
            # The local engine knows nothing of the person: greet, and ask the model next time.
            if out["engine"] == "local":
                _openings.pop(key, None)
                return greeting
            return out["answer"]

        task = asyncio.get_running_loop().create_task(make())
        _openings[key] = task
        task.add_done_callback(lambda t: _openings.pop(key, None) if not t.cancelled() and t.exception() else None)
    return await asyncio.shield(task)


def seed_opening(agent: dict[str, Any], call_id: str, lang: str, text: str) -> None:
    """Write the opening down as the call's first exchange, as run_turn would."""
    outbound = is_outbound(agent)
    stamp = now_iso()
    with db.transaction() as tx:
        ordinal = 0
        if outbound:
            db.execute(
                tx,
                """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
                   VALUES (:id, :t, :c, :o, 'caller', :text, :lang, :at)""",
                id=new_id("trn"),
                t=agent["tenant_id"],
                c=call_id,
                o=ordinal,
                text=PICKUP[lang],
                lang=lang,
                at=stamp,
            )
            ordinal += 1
        db.execute(
            tx,
            """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
               VALUES (:id, :t, :c, :o, 'agent', :text, :lang, :at)""",
            id=new_id("trn"),
            t=agent["tenant_id"],
            c=call_id,
            o=ordinal,
            text=text,
            lang=detect_language(text) or lang,
            at=stamp,
        )
        db.execute(
            tx,
            """UPDATE calls SET turns = turns + :n, language = :lang,
                 status = CASE WHEN status = 'ringing' THEN 'active' ELSE status END,
                 answered_at = COALESCE(answered_at, :at)
               WHERE id = :id""",
            n=1 if outbound else 0,
            lang=lang,
            at=stamp,
            id=call_id,
        )
    publish(
        agent["tenant_id"],
        {
            "type": "turn",
            "callId": call_id,
            "utterance": PICKUP[lang] if outbound else "",
            "reply": text,
            "confidence": 1,
            "escalated": False,
            "latencyMs": 0,
        },
    )


def turn_detail(result: dict[str, Any]) -> dict[str, Any]:
    """The numbers and sources of one turn, for the console's side panels."""
    detail: dict[str, Any] = {
        "language": result["language"],
        "intent": result["intent"],
        "confidence": result["confidence"],
        "answered": result["answered"],
        "escalate": result["escalate"],
    }
    if "summary" in result:
        detail["summary"] = result["summary"]
    detail.update(
        {
            "timings": result["timings"],
            "citations": [
                {
                    "documentTitle": c["documentTitle"],
                    "heading": c["heading"],
                    "snippet": c["snippet"],
                    "score": c["score"],
                }
                for c in result["citations"]
            ],
            "retrieval": result["retrievalDebug"],
            "engine": result["engine"],
        }
    )
    return detail
