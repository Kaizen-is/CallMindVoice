"""
Agent studio — ports of `saveAgentAction`, `setAgentStatusAction` and `createAgentAction`
(src/app/actions/agent.ts), the greeting and fallback lines of src/lib/provision.ts, and the data
the Agent studio page (src/app/app/agent/page.tsx) loads.
"""

import re
from typing import Any

from app import db
from app.audit import audit
from app.auth import Session
from app.console_text import js_slice_stored, js_str
from app.engine.calls import list_agents, live_agent
from app.engine.conversation import DEFAULT_ESCALATION, DEFAULT_HOURS, agent_escalation, agent_hours, agent_target
from app.ids import new_id, now_iso
from app.jscompat import js_json, js_trim, utf16_slice
from app.llm.choice import llm_options, safe_json, tenant_default_llm
from app.llm.provider import engine_label
from app.registry import ENGINES, llm_model_info
from app.speech.speko import ELEVEN_VOICES, GEMINI_VOICES, SPEKO_TTS_MODELS, speko_voices
from app.speech.tts import tts_engines
from app.voices import list_custom_voices

# src/lib/provision.ts — a new agent's first line and its "I don't know" line, per spoken language.
GREETINGS = {
    "uz": lambda c: f"Assalomu alaykum! {c} ga qo‘ng‘iroq qilganingiz uchun rahmat. Sizga qanday yordam bera olaman?",
    "ru": lambda c: f"Здравствуйте! Вы позвонили в {c}. Чем я могу помочь?",
    "en": lambda c: f"Hello, thank you for calling {c}. How can I help you today?",
}

FALLBACKS = {
    "uz": "Kechirasiz, bu savolga aniq javob topa olmadim. Mutaxassisga ulab qo‘yaymi?",
    "ru": "К сожалению, точного ответа у меня нет. Соединить вас со специалистом?",
    "en": "I couldn't find a confident answer to that. Shall I connect you to a colleague?",
}


def content_locale(ui: str) -> str:
    """`contentLocale` (types.ts): the spoken language a UI locale stands for."""
    return "uz" if ui == "uz-Cyrl" else ui


def agent_by_id(tenant_id: str, agent_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id AND tenant_id = :t", id=agent_id, t=tenant_id)


# ── actions ─────────────────────────────────────────────────────────


def agent_tts(draft: dict[str, Any]) -> tuple[str, str]:
    """The voice model and its voice (ElevenLabs' or Gemini's) to store: both valid, or both ''."""
    engine_id = draft["ttsEngine"]
    # The BRB model speaks with its one voice.
    if engine_id == "brb":
        return "brb", ""
    engine = engine_id if engine_id in SPEKO_TTS_MODELS else ""
    if not engine:
        return "", ""
    voices = speko_voices(engine)
    voice = next((v["id"] for v in voices if v["id"] == draft["ttsVoiceId"]), voices[0]["id"])
    return engine, voice


_NOT_DIGIT = re.compile(r"[^0-9]")  # JavaScript's \D


def save_agent(session: Session, agent_id: str, draft: dict[str, Any]) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    existing = agent_by_id(tenant_id, agent_id)
    if not existing:
        return {"ok": False, "message": "Agent not found."}

    target = draft["target"]
    # Inside JSON a cut emoji stays half a pair (JSON.stringify writes it as \ud83d); a column gets U+FFFD.
    stored_target = {
        "fullName": utf16_slice(js_trim(target["fullName"]), 0, 120),
        "birthYear": utf16_slice(_NOT_DIGIT.sub("", target["birthYear"]), 0, 4),
        "loanAmount": utf16_slice(js_trim(target["loanAmount"]), 0, 80),
        "prompt": utf16_slice(target["prompt"], 0, 4000),
    }
    languages = draft["languages"]
    tts_engine, tts_voice = agent_tts(draft)
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE agents SET name = :name, persona = :persona, greeting = :greeting, fallback_line = :fallback,
                 instructions = :instructions, languages_json = :languages, primary_lang = :primary_lang,
                 voice_id = :voice_id, speaking_rate = :speaking_rate, max_turns = :max_turns,
                 confidence_threshold = :threshold, status = :status, escalation_json = :escalation,
                 hours_json = :hours, target_json = :target, llm_model = :llm_model, tts_engine = :tts_engine,
                 tts_voice_id = :tts_voice_id, version = version + 1, updated_at = :now WHERE id = :id""",
            name=js_trim(draft["name"]) or existing["name"],
            persona=draft["persona"],
            greeting=draft["greeting"],
            fallback=draft["fallbackLine"],
            instructions=js_slice_stored(draft["instructions"], 4000),
            languages=js_json(languages if len(languages) else ["uz"]),
            primary_lang=draft["primaryLang"],
            voice_id=draft["voiceId"],
            speaking_rate=draft["speakingRate"],
            max_turns=draft["maxTurns"],
            threshold=draft["confidenceThreshold"],
            status=draft["status"],
            escalation=js_json(draft["escalation"]),
            hours=js_json(draft["hours"]),
            target=js_json(stored_target),
            llm_model=draft["llmModel"] if llm_model_info(draft["llmModel"]) else "",
            tts_engine=tts_engine,
            tts_voice_id=tts_voice,
            now=now_iso(),
            id=agent_id,
        )
    version = existing["version"] + 1
    audit(tenant_id, session.user, "agent.updated", agent_id, {"status": draft["status"], "version": version})
    return {"ok": True, "message": "Agent updated.", "version": version}


def set_agent_status(session: Session, agent_id: str, status: object) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE agents SET status = :status, updated_at = :now WHERE id = :id AND tenant_id = :t",
            status=status,
            now=now_iso(),
            id=agent_id,
            t=tenant_id,
        )
    audit(tenant_id, session.user, "agent.status", agent_id, {"status": status})
    return {"ok": True, "message": "Agent is live." if status == "live" else f"Agent set to {js_str(status)}."}


def insert_agent(
    tx: Any,  # noqa: ANN401 - an open transaction
    *,
    agent_id: str,
    tenant_id: str,
    name: str,
    primary_lang: str,
    company: str,
    stamp: str,
) -> None:
    """The one agent INSERT of provisionTenant / createAgentAction: a draft that is usable at once."""
    db.execute(
        tx,
        """INSERT INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line, instructions,
             languages_json, primary_lang, voice_id, speaking_rate, temperature, max_turns,
             confidence_threshold, escalation_json, hours_json, tools_json, version, created_at, updated_at)
           VALUES (:id, :t, :name, 'draft', 'professional', :greeting, :fallback, '', :languages, :lang, 'laylo',
             1.0, 0.3, 24, 0.45, :escalation, :hours, '[]', 1, :stamp, :stamp)""",
        id=agent_id,
        t=tenant_id,
        name=name,
        greeting=GREETINGS[primary_lang](company),
        fallback=FALLBACKS[primary_lang],
        languages=js_json(["uz", "ru", "en"]),
        lang=primary_lang,
        escalation=js_json(DEFAULT_ESCALATION),
        hours=js_json(DEFAULT_HOURS),
        stamp=stamp,
    )


def create_agent(session: Session, name: object = None) -> dict[str, Any]:
    """Another agent for the session's tenant, with the same defaults as the one provisioned at sign-up."""
    if name is not None and not isinstance(name, str):
        raise TypeError("name?.trim is not a function")
    tenant_id = session.tenant["id"]
    agent_id = new_id("agt")
    primary_lang = content_locale(session.tenant["locale"])
    display_name = (js_trim(name) if name is not None else "") or "New agent"
    with db.transaction() as tx:
        insert_agent(
            tx,
            agent_id=agent_id,
            tenant_id=tenant_id,
            name=display_name,
            primary_lang=primary_lang,
            company=session.tenant["name"],
            stamp=now_iso(),
        )
    audit(tenant_id, session.user, "agent.created", agent_id, {"name": display_name})
    return {"ok": True, "agentId": agent_id}


# ── the Agent studio page ───────────────────────────────────────────


def knowledge_stats(tenant_id: str) -> dict[str, Any]:
    """`knowledgeStats` (src/lib/analytics.ts)."""
    with db.connect() as conn:
        docs = db.fetch_one(
            conn,
            """SELECT COUNT(*) AS c,
                      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
                      COALESCE(SUM(chunk_count), 0) AS chunks,
                      COALESCE(SUM(token_count), 0) AS tokens,
                      COALESCE(SUM(byte_size), 0) AS bytes
               FROM documents WHERE tenant_id = :t""",
            t=tenant_id,
        )
    docs = docs or {}

    def value(key: str) -> Any:  # noqa: ANN401 - a count
        return docs.get(key) if docs.get(key) is not None else 0

    return {
        "documents": value("c"),
        "ready": value("ready"),
        "chunks": value("chunks"),
        "tokens": value("tokens"),
        "bytes": value("bytes"),
    }


def agent_page(session: Session, agent_param: str | None) -> dict[str, Any]:
    """What src/app/app/agent/page.tsx passes to <AgentStudio> (the page adds `locale`)."""
    tenant_id = session.tenant["id"]
    agents = list_agents(tenant_id)
    # The studio edits the agent in ?agent=<id> (checked against the tenant), else the live agent.
    agent = (agent_by_id(tenant_id, agent_param) if agent_param else None) or live_agent(tenant_id)
    if not agent:
        return {"agent": None}

    ready = tts_engines()
    tts_models = []
    for e in ENGINES:
        if e.kind == "tts" and e.id != "default":
            tts_models.append(
                {
                    "id": e.id,
                    "name": e.name,
                    "pricePerMin": e.price_per_min,
                    "ready": bool(ready.get(e.id)),
                    "setup": e.setup,
                }
            )
    return {
        "canEdit": session.user["role"] in ("owner", "admin"),
        "knowledgeChunks": knowledge_stats(tenant_id)["chunks"],
        "agents": agents,
        "customVoices": [{"id": v["id"], "name": v["name"], "mode": v["mode"]} for v in list_custom_voices(tenant_id)],
        "llmOptions": llm_options(),
        # What "Account default" means here, e.g. "OpenAI gpt-5.5".
        "llmDefaultLabel": engine_label(tenant_default_llm(tenant_id)),
        # ElevenLabs models (through Speko) and the BRB model an agent can speak with; '' = own TTS.
        "ttsModels": tts_models,
        "elevenVoices": [{"id": v["id"], "name": v["name"], "note": v["note"]} for v in ELEVEN_VOICES],
        "geminiVoices": [{"id": v["id"], "name": v["name"], "note": v["note"]} for v in GEMINI_VOICES],
        "agent": {
            "id": agent["id"],
            "name": agent["name"],
            "status": agent["status"],
            "persona": agent["persona"],
            "greeting": agent["greeting"],
            "fallbackLine": agent["fallback_line"],
            "instructions": agent["instructions"],
            "languages": safe_json(agent["languages_json"], ["uz", "ru", "en"]),
            "primaryLang": agent["primary_lang"],
            "voiceId": agent["voice_id"],
            "speakingRate": agent["speaking_rate"],
            "maxTurns": agent["max_turns"],
            "confidenceThreshold": agent["confidence_threshold"],
            "version": agent["version"],
            "escalation": agent_escalation(agent),
            "hours": agent_hours(agent),
            "target": agent_target(agent),
            "llmModel": agent["llm_model"] if agent["llm_model"] is not None else "",
            "ttsEngine": agent["tts_engine"] if agent["tts_engine"] is not None else "",
            "ttsVoiceId": agent["tts_voice_id"] if agent["tts_voice_id"] is not None else "",
        },
    }
