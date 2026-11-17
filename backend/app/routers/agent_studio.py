"""
Agents, the Playground's data and chat history, and onboarding — the server actions of
src/app/actions/agent.ts (`POST /actions/<name>`, arguments by their TypeScript names) and the
data of the Agent studio, Playground and onboarding pages (`GET /views/<page>`). Through the site
they are /api/core/...; the TypeScript actions and pages call them with `corePost` / `coreGet`.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from app.agent_studio import agent_page, create_agent, save_agent, set_agent_status
from app.auth import LoggedIn, Session, require_role
from app.onboarding import complete_onboarding, onboarding_page, skip_onboarding
from app.playground_chats import (
    end_playground_call,
    list_playground_chats,
    load_playground_chat,
    playground_page,
    playground_turn,
)
from app.views_common import action_args, js_response

router = APIRouter()

Admin = Annotated[Session, Depends(require_role("admin"))]


# ── actions ─────────────────────────────────────────────────────────


@router.post("/actions/saveAgentAction")
async def save_agent_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(save_agent(session, args.get("agentId"), args["draft"]))


@router.post("/actions/setAgentStatusAction")
async def set_agent_status_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(set_agent_status(session, args.get("agentId"), args.get("status")))


@router.post("/actions/createAgentAction")
async def create_agent_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(create_agent(session, args.get("name")))


@router.post("/actions/playgroundTurnAction")
async def playground_turn_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(await playground_turn(session, args["params"]))


@router.post("/actions/endPlaygroundCallAction")
async def end_playground_call_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    closed = end_playground_call(session, args.get("callId"), args.get("csat"))
    # `closed` tells the proxy whether to revalidatePath('/app'); the action itself returns {ok: true}.
    return js_response({"ok": True, "closed": closed})


@router.post("/actions/listPlaygroundChatsAction")
async def list_playground_chats_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(list_playground_chats(session, args.get("agentId")))


@router.post("/actions/loadPlaygroundChatAction")
async def load_playground_chat_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(load_playground_chat(session, args.get("callId")))


@router.post("/actions/completeOnboardingAction")
async def complete_onboarding_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(complete_onboarding(session, args["payload"]))


@router.post("/actions/skipOnboardingAction")
async def skip_onboarding_action(session: LoggedIn) -> Response:
    return js_response(skip_onboarding(session))


# ── page data ───────────────────────────────────────────────────────


@router.get("/views/agent")
async def agent_view(session: LoggedIn, agent: str | None = None) -> Response:
    return js_response(agent_page(session, agent))


@router.get("/views/playground")
async def playground_view(session: LoggedIn) -> Response:
    return js_response(playground_page(session))


@router.get("/views/onboarding")
async def onboarding_view(session: LoggedIn) -> Response:
    return js_response(onboarding_page(session))
