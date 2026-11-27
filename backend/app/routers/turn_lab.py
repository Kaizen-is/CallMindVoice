"""
The turn lab (L3): recordings of people saying set phrases, to test an end-of-turn model on Uzbek.

No end-of-turn model knows Uzbek, so before one decides when a Playground caller has finished, it is
measured on real Uzbek speech: phrases said once straight through and once with a pause in the middle,
recorded through the same browser microphone settings the Playground uses. Every pause inside a phrase
is a place where the caller had not finished; its end is where they had (`backend/tools/turn_lab_eval.py`).

Off unless `TURN_LAB=on`: the recordings are people's voices, kept only on this computer, in
`data/turn-lab/` (never in git), with one line each in `data/turn-lab/labels.jsonl`.

  GET  /turn-lab/status   {"enabled", "saved": n, "mine": [promptId…]}
  POST /turn-lab/clip     multipart: audio (16 kHz mono WAV), promptId, text, kind, asked?
                          → {"ok": true, "file", "saved": n}
"""

import json
import re
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from app.auth import LoggedIn
from app.config import get_settings
from app.env import env

router = APIRouter(prefix="/turn-lab")

# A phrase is at most ~15 s; 30 s of 16 kHz 16-bit mono is ~1 MB.
MAX_CLIP_BYTES = 1_000_000
KINDS = ("short", "full", "pause", "number", "mixed")
_write_lock = threading.Lock()


def enabled() -> bool:
    return (env("TURN_LAB") or "").strip().lower() in ("on", "1", "true", "yes")


def lab_dir() -> Path:
    return get_settings().callmind_data_dir / "turn-lab"


def _labels() -> list[dict]:
    path = lab_dir() / "labels.jsonl"
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _wav_seconds(data: bytes) -> float | None:
    """The length of a 16 kHz mono 16-bit PCM WAV, or None if it is not one."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    channels = int.from_bytes(data[22:24], "little")
    rate = int.from_bytes(data[24:28], "little")
    bits = int.from_bytes(data[34:36], "little")
    if channels != 1 or rate != 16000 or bits != 16:
        return None
    return (len(data) - 44) / (rate * 2)


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


@router.get("/status")
async def status(session: LoggedIn) -> Response:
    if not enabled():
        return JSONResponse({"enabled": False, "saved": 0, "mine": []})
    rows = _labels()
    user_id = session.user["id"]
    mine = sorted({r.get("promptId") for r in rows if r.get("speaker") == user_id and r.get("promptId")})
    return JSONResponse({"enabled": True, "saved": len(rows), "mine": mine})


@router.post("/clip")
async def clip(request: Request, session: LoggedIn) -> Response:
    if not enabled():
        return _error("not_found", 404)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error("bad_request", 400)
    audio = form.get("audio")
    prompt_id = str(form.get("promptId") or "")
    text = str(form.get("text") or "").strip()
    kind = str(form.get("kind") or "")
    asked = str(form.get("asked") or "").strip()
    if not isinstance(audio, UploadFile) or not re.fullmatch(r"[a-z0-9-]{1,40}", prompt_id):
        return _error("bad_request", 400)
    if kind not in KINDS or not text or len(text) > 300 or len(asked) > 300:
        return _error("bad_request", 400)
    data = await audio.read()
    if len(data) > MAX_CLIP_BYTES:
        return _error("too_large", 413)
    seconds = _wav_seconds(data)
    if seconds is None or seconds < 0.3:
        return _error("bad_audio", 400)

    user_id = session.user["id"]
    folder = lab_dir()
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}-{prompt_id}.wav"
    row = {
        "file": name,
        "promptId": prompt_id,
        "text": text,
        "kind": kind,
        "asked": asked or None,
        "speaker": user_id,
        "seconds": round(seconds, 2),
        "at": int(time.time() * 1000),
    }
    with _write_lock:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
        with (folder / "labels.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return JSONResponse({"ok": True, "file": name, "saved": len(_labels())})
