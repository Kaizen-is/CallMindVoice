"""
POST /agents/defaults — make sure the logged-in company has the default agents
(app/default_agents.py). The Playground page calls it before listing agents;
through the site it is /api/core/agents/defaults.
"""

from fastapi import APIRouter

from app.auth import LoggedIn
from app.default_agents import ensure_default_agents

router = APIRouter(prefix="/agents")


@router.post("/defaults")
async def defaults(session: LoggedIn) -> dict[str, list[str]]:
    return {"created": ensure_default_agents(session.tenant["id"])}
