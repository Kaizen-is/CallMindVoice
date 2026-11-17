"""
The phone side, shared by the bridge routes (`app/routers/telephony.py`) — a port
of src/lib/telephony/{bridge,status}.ts.

Every /telephony/bridge/* route needs the same two things before it can do
anything: prove the caller is our own bridge process (the `x-bridge-secret`
header), and turn the dialled number into a tenant and a live agent.

Gating: BRIDGE_SHARED_SECRET unset ⇒ 503 (the feature is not provisioned),
header mismatch ⇒ 401.
"""

import hmac
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from app import db
from app.engine.calls import live_agent
from app.env import env


def authorize_bridge(request: Request) -> JSONResponse | None:
    """None when the request comes from our bridge; otherwise the response to return at once."""
    secret = env("BRIDGE_SHARED_SECRET")
    if not secret:
        return JSONResponse({"error": "bridge_not_configured"}, status_code=503)
    if not secret_matches(request.headers.get("x-bridge-secret"), secret):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return None


def secret_matches(provided: str | None, expected: str) -> bool:
    """Constant-time comparison of the UTF-8 bytes, like `timingSafeEqual` after a length check."""
    return hmac.compare_digest((provided or "").encode(), expected.encode())


@dataclass
class BridgeTarget:
    number: dict[str, Any]
    agent: dict[str, Any]
    language: str


def resolve_target(to: str) -> BridgeTarget | JSONResponse:
    """The dialled number's tenant and live agent, or the error response."""
    with db.connect() as conn:
        number = db.fetch_one(conn, "SELECT * FROM phone_numbers WHERE e164 = :to AND status = 'active' LIMIT 1", to=to)
        if number is None:
            return JSONResponse({"error": "number_not_configured", "to": to}, status_code=404)
        agent = db.fetch_one(
            conn,
            "SELECT * FROM agents WHERE id = :id AND tenant_id = :t",
            id=number["agent_id"],
            t=number["tenant_id"],
        )
    if agent is None:
        agent = live_agent(number["tenant_id"])
    if agent is None or agent["status"] != "live":
        return JSONResponse({"error": "agent_unavailable"}, status_code=409)
    language = agent["primary_lang"] if agent.get("primary_lang") is not None else "uz"
    return BridgeTarget(number=number, agent=agent, language=language)


def telephony_status() -> dict[str, Any]:
    """The self-hosted Asterisk bridge when its shared secret is set, otherwise the built-in simulator."""
    configured = bool(env("BRIDGE_SHARED_SECRET"))
    return {"configured": configured, "mode": "asterisk" if configured else "simulator"}
