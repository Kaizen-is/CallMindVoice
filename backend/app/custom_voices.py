"""
Custom voices — ports of src/app/actions/voices.ts (tenant-saved voices for the own Uzbek TTS:
`clone` = a reference sample + its transcript, `design` = attribute words) and the data the voice
pages load: Voice cloning, Voice design, Text to speech (src/app/app/dev/*) and the Voices gallery
(src/app/app/models/voices/page.tsx).
"""

import asyncio
import logging
from typing import Any

from app import db, http
from app.auth import Session
from app.catalog import VOICES
from app.config import get_settings
from app.console_text import js_slice_stored, node_extname
from app.env import env
from app.ids import new_id, now_iso
from app.jscompat import js_trim
from app.registry import ENGINES
from app.speech.brb import brb_configured
from app.speech.speko import ELEVEN_VOICES, speko_configured
from app.speech.tts import tts_engines
from app.voices import list_custom_voices

log = logging.getLogger("callmind.voices")

MAX_REF_BYTES = 20 * 1024 * 1024  # the TTS server's 413 limit

# The v2 API accepts only these voice_design words (anything else → 422).
DESIGN_WORDS = frozenset(
    {
        "male", "female",
        "child", "teenager", "young adult", "middle-aged", "elderly",
        "very low pitch", "low pitch", "moderate pitch", "high pitch", "very high pitch",
        "whisper",
        "american accent", "british accent", "australian accent", "canadian accent",
        "indian accent", "chinese accent", "japanese accent", "korean accent",
        "russian accent", "portuguese accent",
    }
)  # fmt: skip


def upload_dir():  # noqa: ANN201 - a Path
    """`UPLOAD_DIR` of src/lib/db.ts: data/uploads."""
    return get_settings().callmind_data_dir / "uploads"


def _insert(row: dict[str, Any]) -> None:
    columns = ", ".join(row)
    values = ", ".join(f":{k}" for k in row)
    with db.transaction() as tx:
        db.execute(tx, f"INSERT INTO custom_voices ({columns}) VALUES ({values})", **row)  # noqa: S608 - fixed keys


def create_design_voice(session: Session, data: dict[str, Any]) -> dict[str, Any]:
    name = js_slice_stored(js_trim(data["name"]), 60)
    if not name:
        return {"ok": False, "message": "empty_name"}
    attrs = [a for a in (js_trim(a).lower() for a in data["attributes"]) if a]
    if not attrs:
        return {"ok": False, "message": "empty_design"}
    bad = next((a for a in attrs if a not in DESIGN_WORDS), None)
    if bad is not None:
        return {"ok": False, "message": f"invalid_attribute:{bad}"}

    voice_id = new_id("cv")
    _insert(
        {
            "id": voice_id,
            "tenant_id": session.tenant["id"],
            "name": name,
            "mode": "design",
            "voice_design": ", ".join(attrs),
            "created_at": now_iso(),
        }
    )
    return {"ok": True, "voiceId": voice_id}


async def transcribe_sample(audio: bytes, file_name: str) -> str | None:
    """The reference sample's words, from the own STT (STT_TRANSCRIBE_URL), so nobody types them."""
    url = env("STT_TRANSCRIBE_URL")
    if not url:
        return None
    try:
        async with asyncio.timeout(60):
            res = await http.client().post(
                url,
                files=[("file", (file_name or "sample.wav", audio, "audio/wav"))],
                headers={"accept": "application/json"},
            )
            if not res.is_success:
                log.warning("[voices] stt %s: %s", res.status_code, res.text[:160])
                return None
            data = res.json()
    except Exception as err:  # noqa: BLE001 - any failure means "no transcript", as before
        log.warning("[voices] stt failed: %s", err)
        return None
    if data is None:
        return None  # `null.text` threw in the TypeScript, which also ended in null
    text = data.get("text") if isinstance(data, dict) else None
    if text is None:
        text = ""
    if not isinstance(text, str):
        return None
    return js_trim(text) or None


async def create_clone_voice(session: Session, name_field: str, upload: Any) -> dict[str, Any]:  # noqa: ANN401
    """`upload` is the `refAudio` part: an UploadFile, or a plain string / None when no file was sent."""
    name = js_slice_stored(js_trim(name_field), 60)
    if not name:
        return {"ok": False, "message": "empty_name"}
    audio = await upload.read() if hasattr(upload, "read") else None
    if not audio:
        return {"ok": False, "message": "empty_audio"}
    if len(audio) > MAX_REF_BYTES:
        return {"ok": False, "message": "audio_too_large"}

    file_name = upload.filename or ""
    ref_text = await transcribe_sample(audio, file_name)
    if not ref_text:
        return {"ok": False, "message": "transcribe_failed"}

    voice_id = new_id("cv")
    stored_name = f"voice_{voice_id}{node_extname(file_name).lower() or '.wav'}"
    folder = upload_dir()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / stored_name).write_bytes(audio)
    _insert(
        {
            "id": voice_id,
            "tenant_id": session.tenant["id"],
            "name": name,
            "mode": "clone",
            "ref_audio_path": stored_name,
            "ref_text": ref_text,
            "created_at": now_iso(),
        }
    )
    return {"ok": True, "voiceId": voice_id}


def delete_custom_voice(session: Session, voice_id: object) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    with db.connect() as conn:
        row = db.fetch_one(
            conn, "SELECT * FROM custom_voices WHERE id = :id AND tenant_id = :t", id=voice_id, t=tenant_id
        )
    if not row:
        return {"ok": False}
    if row["ref_audio_path"]:
        (upload_dir() / row["ref_audio_path"]).unlink(missing_ok=True)
    with db.transaction() as tx:
        db.execute(tx, "DELETE FROM custom_voices WHERE id = :id AND tenant_id = :t", id=voice_id, t=tenant_id)
    # Agents pointing at the deleted voice quietly fall back to the default speaker.
    return {"ok": True}


# ── pages ───────────────────────────────────────────────────────────


def own_tts_configured() -> bool:
    """`Boolean(process.env.TTS_CLIENT_SECRET || process.env.TTS_JWT_TOKEN)`, as the voice pages check it."""
    return bool(env("TTS_CLIENT_SECRET") or env("TTS_JWT_TOKEN"))


def _saved_voices(tenant_id: str, mode: str, detail: str) -> list[dict[str, Any]]:
    return [
        {"id": v["id"], "name": v["name"], "mode": v["mode"], "detail": v[detail], "created_at": v["created_at"]}
        for v in list_custom_voices(tenant_id, mode)
    ]


def voice_clone_page(session: Session) -> dict[str, Any]:
    """src/app/app/dev/voice-clone/page.tsx → <CloneLab> (minus `locale`)."""
    return {"voices": _saved_voices(session.tenant["id"], "clone", "ref_text"), "speech": {"tts": own_tts_configured()}}


def voice_design_page(session: Session) -> dict[str, Any]:
    """src/app/app/dev/voice-design/page.tsx → <DesignLab> (minus `locale`)."""
    return {
        "voices": _saved_voices(session.tenant["id"], "design", "voice_design"),
        "speech": {"tts": own_tts_configured()},
    }


def list_speech_tests(tenant_id: str, kind: str) -> list[dict[str, Any]]:
    """`listSpeechTests` (src/lib/engine/calls.ts): the latest developer speech-lab runs, newest first."""
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            "SELECT * FROM speech_tests WHERE tenant_id = :t AND kind = :k ORDER BY created_at DESC LIMIT 20",
            t=tenant_id,
            k=kind,
        )


def dev_tts_page(session: Session) -> dict[str, Any]:
    """src/app/app/dev/tts/page.tsx → <TtsLab> (minus `locale`)."""
    tenant_id = session.tenant["id"]
    with db.connect() as conn:
        # The voice selector needs each agent's voice (list_agents has only id/name/status).
        agents = db.fetch_all(
            conn, "SELECT id, name, voice_id FROM agents WHERE tenant_id = :t ORDER BY created_at ASC", t=tenant_id
        )
    return {
        "agents": [{"id": a["id"], "name": a["name"], "voiceId": a["voice_id"]} for a in agents],
        "voices": [{"id": v["id"], "name": v["name"]} for v in VOICES],
        "customVoices": [{"id": v["id"], "name": v["name"]} for v in list_custom_voices(tenant_id)],
        "elevenVoices": [{"id": v["id"], "name": v["name"]} for v in ELEVEN_VOICES],
        "history": list_speech_tests(tenant_id, "tts"),
        "speech": {"tts": own_tts_configured(), "eleven": speko_configured(), "brb": brb_configured()},
    }


def _gendered(v: dict[str, Any]) -> str:
    return f"{'♀' if v['gender'] == 'female' else '♂'} {v['note']}"


def voices_page(session: Session, model: str | None) -> dict[str, Any]:
    """src/app/app/models/voices/page.tsx → <VoicesGallery> (minus `locale`)."""
    ready = tts_engines()
    models = [
        {"id": e.id, "name": e.name, "ready": bool(ready.get(e.id)), "setup": e.setup}
        for e in ENGINES
        if e.kind == "tts"
    ]
    # Own TTS speaks the built-in and the account's cloned/designed voices; the ElevenLabs voices
    # (through Speko) speak on every ElevenLabs model; the BRB model has one voice.
    own = [
        *({"id": v["id"], "name": v["name"], "note": _gendered(v)} for v in VOICES),
        *({"id": v["id"], "name": v["name"], "note": v["mode"]} for v in list_custom_voices(session.tenant["id"])),
    ]
    eleven = [{"id": v["id"], "name": v["name"], "note": _gendered(v)} for v in ELEVEN_VOICES]
    brb = [{"id": "brb", "name": "BRB TTS", "note": "own model"}]
    voices = [
        {**v, "model": m["id"]}
        for m in models
        for v in (own if m["id"] == "default" else brb if m["id"] == "brb" else eleven)
    ]
    return {
        "models": models,
        "voices": voices,
        "initialModel": model if any(m["id"] == model for m in models) else "all",
    }
