"""
The Playground's text chat and its saved conversations — ports of `playgroundTurnAction`,
`endPlaygroundCallAction`, `listPlaygroundChatsAction` and `loadPlaygroundChatAction`
(src/app/actions/agent.ts) — and the data the Playground page (src/app/app/playground/page.tsx)
loads. The voice call itself is `app/playground.py` + `app/routers/playground.py`.
"""

from typing import Any

from app import db
from app.agent_studio import agent_by_id
from app.auth import Session
from app.bank_agent import ensure_bank_agent
from app.catalog import VOICES
from app.engine.calls import list_agents, live_agent, start_call
from app.engine.conversation import run_turn
from app.jscompat import js_trim
from app.llm.choice import agent_engine_label, safe_json, tenant_default_llm
from app.llm.provider import engine_is_hosted, engine_label
from app.playground import close_playground_call
from app.speech.speko import ELEVEN_VOICES, GEMINI_VOICES, speko_configured
from app.speech.stt import stt_engines
from app.speech.tts import tts_engines
from app.voices import list_custom_voices

_CITATION_KEYS = ("documentTitle", "heading", "snippet", "score")


def _citation(c: dict[str, Any]) -> dict[str, Any]:
    """`{documentTitle, heading, snippet, score}` of a citation (a missing field stays missing, as undefined)."""
    return {k: c[k] for k in _CITATION_KEYS if k in c}


async def playground_turn(session: Session, params: dict[str, Any]) -> dict[str, Any]:
    """One typed turn in the Playground (and the onboarding test chat)."""
    tenant_id = session.tenant["id"]
    agent_id = params.get("agentId")
    agent = agent_by_id(tenant_id, agent_id) if agent_id else live_agent(tenant_id)
    if not agent:
        return {"ok": False, "message": "Create an agent first."}
    utterance = params["utterance"]
    if not js_trim(utterance):
        return {"ok": False, "message": "Nothing was said."}

    call_id = params.get("callId")
    if not call_id:
        call_id = start_call(
            tenant_id=tenant_id,
            agent_id=agent["id"],
            from_="playground",
            to="playground",
            caller_name=f"{session.user['name']} (test)",
            channel="web",
        )
    else:
        with db.connect() as conn:
            owned = db.fetch_one(
                conn, "SELECT id FROM calls WHERE id = :id AND tenant_id = :t", id=call_id, t=tenant_id
            )
        if not owned:
            return {"ok": False, "message": "That test session has expired."}

    stt_ms = params.get("sttMs")
    result = await run_turn(
        tenant_id=tenant_id,
        call_id=call_id,
        agent=agent,
        utterance=utterance,
        stt_ms=stt_ms if stt_ms is not None else 0,
    )
    reply: dict[str, Any] = {
        "ok": True,
        "callId": call_id,
        "reply": result["reply"],
        "language": result["language"],
        "intent": result["intent"],
        "confidence": result["confidence"],
        "answered": result["answered"],
        "escalate": result["escalate"],
    }
    if result.get("summary") is not None:
        reply["summary"] = result["summary"]
    reply["timings"] = result["timings"]
    reply["citations"] = [_citation(c) for c in result["citations"]]
    reply["retrieval"] = result["retrievalDebug"]
    reply["engine"] = result["engine"]
    return reply


def end_playground_call(session: Session, call_id: object, csat: object = None) -> bool:
    """Billed once, up to the last message; a chat that was already closed is left alone. True when closed now."""
    return close_playground_call(session.tenant["id"], call_id, csat)


def list_playground_chats(session: Session, agent_id: object) -> list[dict[str, Any]]:
    """Saved playground conversations with one agent, most recent first."""
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            """SELECT c.id AS callId, c.turns AS turns,
                 COALESCE((SELECT text FROM turns t WHERE t.call_id = c.id AND t.role = 'caller'
                           ORDER BY t.ordinal LIMIT 1), '') AS title,
                 COALESCE((SELECT MAX(created_at) FROM turns t WHERE t.call_id = c.id), c.started_at) AS lastAt
               FROM calls c
               WHERE c.tenant_id = :t AND c.agent_id = :agent AND c.channel = 'web' AND c.from_e164 = 'playground'
                 AND c.turns > 0
               ORDER BY lastAt DESC
               LIMIT 30""",
            t=session.tenant["id"],
            agent=agent_id,
        )


def load_playground_chat(session: Session, call_id: object) -> dict[str, Any]:
    """The transcript of one saved playground conversation, for reopening it."""
    tenant_id = session.tenant["id"]
    with db.connect() as conn:
        owned = db.fetch_one(
            conn,
            "SELECT id FROM calls WHERE id = :id AND tenant_id = :t AND channel = 'web' AND from_e164 = 'playground'",
            id=call_id,
            t=tenant_id,
        )
    if not owned:
        return {"ok": False, "message": "That conversation no longer exists."}

    # A chat left open (tab closed, or escalated) is billed now, up to its last message — before the
    # new messages land, so the days it sat idle are free.
    close_playground_call(tenant_id, call_id)

    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            "SELECT * FROM turns WHERE call_id = :id AND role IN ('caller', 'agent') ORDER BY ordinal ASC",
            id=call_id,
        )
    turns = []
    for r in rows:
        turn: dict[str, Any] = {"role": r["role"], "text": r["text"], "language": r["language"]}
        if r["role"] == "agent":
            reply: dict[str, Any] = {"ok": True, "callId": call_id, "reply": r["text"]}
            if r["language"] is not None:
                reply["language"] = r["language"]
            if r["confidence"] is not None:
                reply["confidence"] = r["confidence"]
            reply["timings"] = safe_json(r["timings_json"], {})
            reply["citations"] = [_citation(c) for c in safe_json(r["citations_json"], [])]
            turn["reply"] = reply
        turns.append(turn)
    return {"ok": True, "turns": turns}


# ── the Playground page ─────────────────────────────────────────────


def playground_page(session: Session) -> dict[str, Any]:
    """
    What src/app/app/playground/page.tsx passes to <Playground>, minus `locale`. `engine` is the
    account default's label, or None when it is the local synthesiser (the page words that itself).
    """
    tenant_id = session.tenant["id"]
    # Every account gets the /demo banking agent to try, once (see bank_agent.py).
    ensure_bank_agent(tenant_id)
    agent = live_agent(tenant_id)
    agents = list_agents(tenant_id)
    default_llm = tenant_default_llm(tenant_id)

    agent_voices: dict[str, Any] = {}
    agent_engines: dict[str, Any] = {}
    for a in agents:
        row = agent_by_id(tenant_id, a["id"])
        # The BRB model has no voice to pick, so its agents carry the engine alone.
        if row and row["tts_engine"] and (row["tts_voice_id"] or row["tts_engine"] == "brb"):
            agent_voices[a["id"]] = {"engine": row["tts_engine"], "voice": row["tts_voice_id"]}
    for a in agents:
        row = agent_by_id(tenant_id, a["id"])
        agent_engines[a["id"]] = agent_engine_label(row) if row else engine_label(default_llm)

    stt = stt_engines()
    return {
        "industry": session.tenant["industry"],
        "engine": engine_label(default_llm) if engine_is_hosted(default_llm) else None,
        "agentVoices": agent_voices,
        "agentEngines": agent_engines,
        "speech": {
            "stt": stt,
            "tts": tts_engines(),
            # Live words: the in-app Zipformer model, or a streaming Speko model (/api/speech/live).
            "streamUrl": "/api/speech/live" if stt_engines()["local"] or speko_configured() else None,
        },
        "agents": agents,
        "elevenVoices": [{"id": v["id"], "name": v["name"]} for v in ELEVEN_VOICES],
        "geminiVoices": [{"id": v["id"], "name": v["name"]} for v in GEMINI_VOICES],
        "allVoices": [
            *({"id": v["id"], "name": v["name"], "group": "builtin"} for v in VOICES),
            *({"id": v["id"], "name": v["name"], "group": v["mode"]} for v in list_custom_voices(tenant_id)),
        ],
        "agent": {
            "id": agent["id"],
            "name": agent["name"],
            "greeting": agent["greeting"],
            "voiceId": agent["voice_id"],
            "speakingRate": agent["speaking_rate"],
            "primaryLang": agent["primary_lang"],
            "languages": safe_json(agent["languages_json"], ["uz", "ru", "en"]),
            "threshold": agent["confidence_threshold"],
            "status": agent["status"],
        }
        if agent
        else None,
    }
