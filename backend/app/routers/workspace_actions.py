"""
Workspace administration server actions — `POST /actions/<name>`, the work of the actions of the
same name in src/app/actions/ops.ts (which are now thin proxies: corePost + revalidatePath).
The body is the action's arguments by their TypeScript parameter names; the answer is what the
TypeScript action returned. Role checks as before: admin for numbers, team, API keys, webhooks,
company settings and knowledge gaps; owner for the plan and top-ups; any member for speech tests.
A failed check is 403 {"error": "forbidden"} (the TypeScript threw ForbiddenError).
"""

from collections.abc import Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from app import workspace
from app.auth import LoggedIn, Session, require_role
from app.views_common import action_args, js_response

router = APIRouter(prefix="/actions")

Admin = Annotated[Session, Depends(require_role("admin"))]
Owner = Annotated[Session, Depends(require_role("owner"))]

Handler = Callable[[Session, dict[str, Any]], dict[str, Any]]


async def _run(handler: Handler, session: Session, request: Request) -> Response:
    return js_response(handler(session, await action_args(request)))


# ── numbers ─────────────────────────────────────────────────────────


@router.post("/addNumberAction")
async def add_number(session: Admin, request: Request) -> Response:
    return await _run(workspace.add_number, session, request)


@router.post("/removeNumberAction")
async def remove_number(session: Admin, request: Request) -> Response:
    return await _run(workspace.remove_number, session, request)


# ── team ────────────────────────────────────────────────────────────


@router.post("/inviteMemberAction")
async def invite_member(session: Admin, request: Request) -> Response:
    return await _run(workspace.invite_member_action, session, request)


@router.post("/changeRoleAction")
async def change_role(session: Admin, request: Request) -> Response:
    return await _run(workspace.change_role, session, request)


@router.post("/setMemberStatusAction")
async def set_member_status(session: Admin, request: Request) -> Response:
    return await _run(workspace.set_member_status, session, request)


# ── developers ──────────────────────────────────────────────────────


@router.post("/createApiKeyAction")
async def create_api_key(session: Admin, request: Request) -> Response:
    return await _run(workspace.create_api_key, session, request)


@router.post("/revokeApiKeyAction")
async def revoke_api_key(session: Admin, request: Request) -> Response:
    return await _run(workspace.revoke_api_key, session, request)


@router.post("/saveWebhookAction")
async def save_webhook(session: Admin, request: Request) -> Response:
    return await _run(workspace.save_webhook, session, request)


@router.post("/deleteWebhookAction")
async def delete_webhook(session: Admin, request: Request) -> Response:
    return await _run(workspace.delete_webhook, session, request)


# ── developer speech lab ────────────────────────────────────────────


@router.post("/saveSpeechTestAction")
async def save_speech_test(session: LoggedIn, request: Request) -> Response:
    return await _run(workspace.save_speech_test, session, request)


# ── settings & billing ──────────────────────────────────────────────


@router.post("/updateTenantAction")
async def update_tenant(session: Admin, request: Request) -> Response:
    return await _run(workspace.update_tenant, session, request)


@router.post("/changePlanAction")
async def change_plan(session: Owner, request: Request) -> Response:
    return await _run(workspace.change_plan, session, request)


@router.post("/topUpAction")
async def top_up(session: Owner, request: Request) -> Response:
    return await _run(workspace.top_up, session, request)


@router.post("/resolveGapAction")
async def resolve_gap(session: Admin, request: Request) -> Response:
    return await _run(workspace.resolve_gap, session, request)


@router.post("/ignoreGapAction")
async def ignore_gap(session: Admin, request: Request) -> Response:
    return await _run(workspace.ignore_gap, session, request)
