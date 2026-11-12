"""
Voice resolution for the internal Uzbek TTS v2 API — port of src/lib/voices.ts.

A voice id is a built-in speaker (laylo / isomiddin), a legacy catalog id, or
a tenant's saved custom voice (clone or design) from `custom_voices`. This
turns it into the generate_v2 form fields.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app import db
from app.catalog import LEGACY_VOICE_IDS, VOICES
from app.config import get_settings
from app.jscompat import js_trim, utf16_slice


@dataclass(frozen=True)
class ResolvedVoice:
    kind: str  # speaker | design | clone
    speaker: str = ""
    design: str = ""
    ref_audio_path: str = ""
    ref_text: str = ""
    file_name: str = ""


def list_custom_voices(tenant_id: str, mode: str | None = None) -> list[dict[str, Any]]:
    with db.connect() as conn:
        if mode:
            return db.fetch_all(
                conn,
                "SELECT * FROM custom_voices WHERE tenant_id = :t AND mode = :m ORDER BY created_at DESC",
                t=tenant_id,
                m=mode,
            )
        return db.fetch_all(
            conn, "SELECT * FROM custom_voices WHERE tenant_id = :t ORDER BY created_at DESC", t=tenant_id
        )


def _voices_dir() -> Path:
    return get_settings().callmind_data_dir / "voices"


def _upload_dir() -> Path:
    return get_settings().callmind_data_dir / "uploads"


def _builtin_override(speaker: str) -> ResolvedVoice | None:
    """`data/voices/<speaker>.(wav|ogg|…)` + `<speaker>.txt` make that speaker a clone of the real recording."""
    for ext in (".wav", ".ogg", ".mp3", ".flac", ".opus"):
        audio = _voices_dir() / f"{speaker}{ext}"
        txt = _voices_dir() / f"{speaker}.txt"
        if audio.exists() and txt.exists():
            ref_text = js_trim(txt.read_text(encoding="utf-8"))
            if ref_text:
                return ResolvedVoice("clone", ref_audio_path=str(audio), ref_text=ref_text, file_name=f"{speaker}{ext}")
    return None


def _laylo() -> ResolvedVoice:
    return _builtin_override("laylo") or ResolvedVoice("speaker", speaker="laylo")


def resolve_voice(tenant_id: str, voice_id: str | None = None) -> ResolvedVoice:
    vid = js_trim(voice_id) if voice_id else ""
    if not vid:
        return _laylo()
    builtin = LEGACY_VOICE_IDS.get(vid) or next((v["id"] for v in VOICES if v["id"] == vid), None)
    if builtin:
        return _builtin_override(builtin) or ResolvedVoice("speaker", speaker=builtin)
    with db.connect() as conn:
        custom = db.fetch_one(
            conn, "SELECT * FROM custom_voices WHERE tenant_id = :t AND id = :id", t=tenant_id, id=vid
        )
    if custom and custom["mode"] == "design" and custom["voice_design"]:
        return ResolvedVoice("design", design=custom["voice_design"])
    if custom and custom["mode"] == "clone" and custom["ref_audio_path"] and custom["ref_text"]:
        # path.join(UPLOAD_DIR, rel) — normalised like Node's path.join.
        absolute = os.path.normpath(os.path.join(_upload_dir(), custom["ref_audio_path"]))
        if os.path.exists(absolute):
            return ResolvedVoice(
                "clone", ref_audio_path=absolute, ref_text=custom["ref_text"], file_name=custom["ref_audio_path"]
            )
    return _laylo()


_MIME = {".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".flac": "audio/flac"}


Part = tuple[str, str | tuple[str, bytes, str]]


def build_tts_form(*, user_id: str, text: str, voice: ResolvedVoice, speed: float | None = None) -> list[Part]:
    """
    The multipart body for POST /api/v1/tts/generate_v2, in FormData order: (name, value) with
    value a string field or (filename, bytes, mime) for the reference sample.
    """
    parts: list[Part] = [
        ("user_id", user_id),
        ("phone", "+000000000"),
        ("text", utf16_slice(text, 0, 2000)),
        ("normalize_numbers", "true"),
    ]
    if speed:
        parts.append(("speed", _js_num(min(2, max(0.5, speed)))))
    if voice.kind == "clone":
        data = Path(voice.ref_audio_path).read_bytes()
        mime = _MIME.get(Path(voice.file_name).suffix.lower(), "application/octet-stream")
        parts.append(("ref_audio", (os.path.basename(voice.file_name), data, mime)))
        parts.append(("ref_text", voice.ref_text))
    elif voice.kind == "design":
        parts.append(("voice_design", voice.design))
    else:
        parts.append(("speaker", voice.speaker))
    return parts


def _js_num(x: float) -> str:
    from app.jscompat import js_number_str

    return js_number_str(float(x))


def voice_picker_options(tenant_id: str) -> dict[str, list[dict[str, Any]]]:
    return {
        "builtin": [{"id": v["id"], "name": v["name"]} for v in VOICES],
        "custom": [{"id": v["id"], "name": v["name"], "mode": v["mode"]} for v in list_custom_voices(tenant_id)],
    }
