"""
Models and voices — the server actions of src/app/actions/models.ts and src/app/actions/voices.ts
(`POST /actions/<name>`; the voice clone is multipart, as its FormData) and the data of the Model
lab, Voices, and For-developers speech pages (`GET /views/<page>`).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from starlette.datastructures import UploadFile

from app.auth import LoggedIn, Session, require_role
from app.custom_voices import (
    create_clone_voice,
    create_design_voice,
    delete_custom_voice,
    dev_tts_page,
    voice_clone_page,
    voice_design_page,
    voices_page,
)
from app.model_lab import dev_stt_page, lab_page, set_default_llm
from app.views_common import action_args, js_response

router = APIRouter()

Admin = Annotated[Session, Depends(require_role("admin"))]


# ── actions ─────────────────────────────────────────────────────────


@router.post("/actions/setDefaultLlmAction")
async def set_default_llm_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(set_default_llm(session, args.get("choice")))


@router.post("/actions/createDesignVoiceAction")
async def create_design_voice_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(create_design_voice(session, args["input"]))


def _first(form, name: str) -> object:  # noqa: ANN001 - starlette FormData
    """`form.get(name)`: the first value (Starlette's .get gives the last), or None."""
    values = form.getlist(name)
    return values[0] if values else None


def _string(value: object) -> str:
    """`String(form.get(name) ?? '')`."""
    if value is None:
        return ""
    if isinstance(value, UploadFile):
        return "[object File]"
    return str(value)


@router.post("/actions/createCloneVoiceAction")
async def create_clone_voice_action(request: Request, session: LoggedIn) -> Response:
    form = await request.form(max_part_size=32 * 1024 * 1024)
    upload = _first(form, "refAudio")
    return js_response(
        await create_clone_voice(
            session, _string(_first(form, "name")), upload if isinstance(upload, UploadFile) else None
        )
    )


@router.post("/actions/deleteCustomVoiceAction")
async def delete_custom_voice_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(delete_custom_voice(session, args.get("voiceId")))


# ── page data ───────────────────────────────────────────────────────


@router.get("/views/models/lab")
async def lab_view(session: LoggedIn) -> Response:
    return js_response(lab_page(session))


@router.get("/views/models/voices")
async def voices_view(session: LoggedIn, model: str | None = None) -> Response:
    return js_response(voices_page(session, model))


@router.get("/views/dev/stt")
async def dev_stt_view(session: LoggedIn, model: str | None = None) -> Response:
    return js_response(dev_stt_page(session, model))


@router.get("/views/dev/tts")
async def dev_tts_view(session: LoggedIn) -> Response:
    return js_response(dev_tts_page(session))


@router.get("/views/dev/voice-clone")
async def voice_clone_view(session: LoggedIn) -> Response:
    return js_response(voice_clone_page(session))


@router.get("/views/dev/voice-design")
async def voice_design_view(session: LoggedIn) -> Response:
    return js_response(voice_design_page(session))
