"""
The public logistics demo (`/logistics`) — port of src/lib/logistics.ts: a
customer calls a cargo company that delivers from China to Uzbekistan and asks
where their parcel is.

Built on the bank demo's call engine (`app/demo.py` — event stream, streamed voice, per-call
lock, rate limits), with three differences (and no "bir daqiqa" fillers):
  • Uzbek speech is transcribed by GAPI (`app/speech/gapi.py`) as recorded, instead of the
    internal Kotib model (Russian keeps the app's own path: GAPI writes Latin-script Uzbek only);
  • the visitor is the caller, so the agent answers with a greeting;
  • every turn looks the caller's tracking or phone number up in the demo shipment system
    (`app/logistics_data.py`) and hands the model only that.

It runs in its own tenant and agent, created on first use, so its calls and knowledge never mix
with the bank demo's. Demo minutes are never billed.
"""

import asyncio
import contextlib
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from app import background, db, demo
from app.demo import (
    MAX_AGE_MS,
    MAX_TURNS,
    audio_key,
    close_ended_call,
    iso_ms,
    remember_prefetch,
    take_prefetch,
)
from app.engine.bus import publish
from app.engine.calls import start_call
from app.ids import new_id, now_iso, to_iso
from app.jscompat import js_json
from app.logistics_data import LOGISTICS_VOCABULARY, TRY_TRACKS, logistics_context, lookup_note
from app.speech.gapi import gapi_transcribe
from app.speech.stt import Transcript, transcribe
from app.speech.tts import SynthOptions, cached_pcm, synthesize_pcm, tts_configured

__all__ = ["TRY_TRACKS"]

# ── the demo's own tenant and agent ─────────────────────────────────

TENANT_ID = "ten_logistics_demo"
AGENT_ID = "agt_logistics_demo"

# No knowledge-base escalations: every answer comes from the shipment system.
ESCALATION = {
    "onLowConfidence": False,
    "onExplicitRequest": True,
    "onNegativeSentiment": False,
    "onRepeatedFailure": False,
    "maxFailedTurns": 2,
    "afterHoursAction": "answer_anyway",
    "ringTimeoutSec": 30,
    "fallbackNumber": "",
}


def _agent_row() -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id", id=AGENT_ID)


def logistics_agent() -> dict[str, Any]:
    """The demo's agent, created (once, idempotently) the first time it is needed."""
    existing = _agent_row()
    if existing:
        return existing
    stamp = now_iso()
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT OR IGNORE INTO tenants (id, name, slug, industry, created_at, updated_at)
               VALUES (:id, 'Logistics demo', 'logistics-demo', 'logistics', :at, :at2)""",
            id=TENANT_ID,
            at=stamp,
            at2=stamp,
        )
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT OR IGNORE INTO agents (id, tenant_id, name, status, persona, greeting, fallback_line,
                 instructions, languages_json, primary_lang, voice_id, escalation_json, hours_json, tools_json,
                 created_at, updated_at)
               VALUES (:id, :t, 'Logistika operatori', 'live', 'friendly', '', '', '', '["uz","ru"]', 'uz',
                 'isomiddin', :esc, '{}', '[]', :at, :at2)""",
            id=AGENT_ID,
            t=TENANT_ID,
            esc=js_json(ESCALATION),
            at=stamp,
            at2=stamp,
        )
    return _agent_row()  # type: ignore[return-value]


# ── voices: the two built-in speakers only ──────────────────────────

LOGISTICS_VOICES = [
    {"id": "isomiddin", "name": "Isomiddin", "group": "builtin"},
    {"id": "laylo", "name": "Laylo", "group": "builtin"},
]


def logistics_voice(requested: object) -> str:
    return requested if any(v["id"] == requested for v in LOGISTICS_VOICES) else "isomiddin"  # type: ignore[return-value]


def voice_name(voice_id: str) -> str:
    """The agent introduces itself by the name of the voice it speaks with."""
    return next((v["name"] for v in LOGISTICS_VOICES if v["id"] == voice_id), "Isomiddin")


def turn_context(voice_id: str) -> Callable[[list[str]], dict[str, str]]:
    """The system-prompt part for one turn, from everything the caller has said."""
    return lambda caller_lines: {
        "facts": logistics_context(caller_lines, voice_name(voice_id)),
        "note": lookup_note(caller_lines),
    }


# ── call lifecycle (mirrors the bank demo; never billed) ────────────

IDLE_MS = 10 * 60_000


def _find_call(call_id: str) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(
            conn,
            """SELECT id, tenant_id, turns, started_at, ended_at FROM calls
               WHERE id = :id AND agent_id = :agent AND from_e164 = 'logistics'""",
            id=call_id,
            agent=AGENT_ID,
        )


def open_logistics_call(agent: dict[str, Any], lang: str) -> str:
    cutoff = to_iso(datetime.now(UTC) - timedelta(milliseconds=IDLE_MS))
    with db.connect() as conn:
        abandoned = db.fetch_all(
            conn,
            """SELECT c.id FROM calls c
               WHERE c.agent_id = :agent AND c.from_e164 = 'logistics' AND c.ended_at IS NULL
                 AND COALESCE((SELECT MAX(t.created_at) FROM turns t WHERE t.call_id = c.id), c.started_at)
                     < :cutoff""",
            agent=agent["id"],
            cutoff=cutoff,
        )
    for call in abandoned:
        close_logistics_call(call["id"], "abandoned")

    return start_call(
        tenant_id=agent["tenant_id"],
        agent_id=agent["id"],
        from_="logistics",
        to="logistics",
        caller_name="Logistics demo",
        channel="web",
        direction="inbound",
        language=lang,
    )


def live_logistics_call(call_id: str) -> dict[str, Any] | None:
    call = _find_call(call_id)
    if not call or call["ended_at"]:
        return None
    if call["turns"] >= MAX_TURNS or demo.now_ms() - iso_ms(call["started_at"]) > MAX_AGE_MS:
        close_logistics_call(call_id)
        return None
    return call


def close_logistics_call(call_id: str, outcome: str = "resolved_by_ai") -> None:
    """End a logistics demo call. Nothing is billed: demo minutes are free."""
    close_ended_call(_find_call(call_id), call_id, outcome)


# ── the greeting ────────────────────────────────────────────────────


def greeting_for(lang: str, voice_id: str) -> str:
    """The visitor rings the company, so the agent answers — no model call needed."""
    name = voice_name(voice_id)
    if lang == "ru":
        return (
            f"Здравствуйте! Служба доставки, меня зовут {name}. Подскажите номер отслеживания или номер "
            "телефона, и я проверю, где ваш груз."
        )
    return (
        f"Assalomu alaykum! Yetkazib berish xizmati, men {name}. Track raqamingizni yoki telefon raqamingizni "
        "ayting, yukingiz qayerdaligini tekshirib beraman."
    )


def seed_greeting(agent: dict[str, Any], call_id: str, lang: str, text: str) -> None:
    """Record the greeting as the call's first line, so the model knows it was said."""
    stamp = now_iso()
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, created_at)
               VALUES (:id, :t, :c, 0, 'agent', :text, :lang, :at)""",
            id=new_id("trn"),
            t=agent["tenant_id"],
            c=call_id,
            text=text,
            lang=lang,
            at=stamp,
        )
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE calls SET language = :lang, status = CASE WHEN status = 'ringing' THEN 'active' ELSE status END,
                 answered_at = COALESCE(answered_at, :at) WHERE id = :id""",
            lang=lang,
            at=stamp,
            id=call_id,
        )
    publish(
        agent["tenant_id"],
        {
            "type": "turn",
            "callId": call_id,
            "utterance": "",
            "reply": text,
            "confidence": 1,
            "escalated": False,
            "latencyMs": 0,
        },
    )


# ── warming: the greetings in both voices ───────────────────────────

_state: dict[str, bool] = {"warmed": False}
_heard: dict[str, dict[str, Any]] = {}


def voice_options(agent: dict[str, Any], lang: str, voice_id: str) -> SynthOptions:
    return SynthOptions(tenant_id=agent["tenant_id"], voice_id=voice_id, language=lang, tag="demo", cache=True)


def warm_logistics(agent: dict[str, Any]) -> None:
    """Render the greetings once, so the first visitor hears one instantly. (No fillers on this demo.)"""
    if _state["warmed"] or not tts_configured():
        return
    _state["warmed"] = True

    async def warm() -> None:
        for voice in LOGISTICS_VOICES:
            for lang in ("uz", "ru"):
                opts = voice_options(agent, lang, voice["id"])
                line = greeting_for(lang, voice["id"])
                if not cached_pcm(line, opts):
                    with contextlib.suppress(Exception):  # `.catch(() => null)`
                        await synthesize_pcm(line, opts)

    background.spawn(warm())


# ── transcribing (GAPI), also during the pause ──────────────────────


async def transcribe_logistics(audio: bytes, lang: str) -> Transcript:
    """
    Uzbek goes to GAPI, as recorded — no noise cleaning: on these calls the cleaner made GAPI's
    transcripts worse, not better. GAPI writes Latin-script Uzbek only ("no Cyrillic on output"),
    so a Russian call uses the app's own Russian path, as /demo does.
    """
    if lang == "ru":
        return await transcribe(audio, language="ru")
    return await gapi_transcribe(audio, language=lang, vocabulary=list(LOGISTICS_VOCABULARY))  # type: ignore[return-value]


def prefetch_heard(call_id: str, audio: bytes, lang: str) -> None:
    """Start transcribing at an early pause; the turn that follows picks it up if the audio matches."""
    task = asyncio.get_running_loop().create_task(transcribe_logistics(audio, lang))
    remember_prefetch(_heard, call_id, audio_key(audio, lang), task)


async def heard_in(call_id: str, audio: bytes, lang: str) -> Transcript:
    """What the visitor said: the prefetched transcript when it matches, else a fresh one."""
    found = await take_prefetch(_heard, call_id, audio_key(audio, lang))
    if found is not None:
        return found
    return await transcribe_logistics(audio, lang)
