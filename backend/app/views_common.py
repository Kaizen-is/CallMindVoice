"""
Shared pieces for the console's data views (`GET /views/<page>`) and server
actions (`POST /actions/<name>`), which replace the Next.js pages' direct
database reads and the TypeScript server actions.

Conventions (every area follows them):
  • A view returns exactly the data the page used to compute from src/lib, with the same
    camelCase keys, so the page's rendering code stays as it is.
  • An action takes its arguments as one JSON object (the TypeScript parameters, by name) and
    returns exactly what the TypeScript action returned. revalidatePath stays in the thin
    TypeScript proxy (it is a Next.js concern).
  • Responses go through `js_response`, so numbers are written the way JSON.stringify writes
    them (1 not 1.0) — the page receives the same values it computed before.
  • A failed role check is 403 {"error": "forbidden"} (the TypeScript threw ForbiddenError).
"""

from typing import Any

from fastapi import Request
from fastapi.responses import Response

from app.jscompat import js_json


def js_response(data: Any, status: int = 200) -> Response:
    """JSON as `Response.json(data)` / a server action's return value would serialise it."""
    return Response(js_json(data), status_code=status, media_type="application/json")


async def action_args(request: Request) -> dict[str, Any]:
    """The action's arguments: a JSON object (empty when there is no body)."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - an action without arguments sends no body
        return {}
    return body if isinstance(body, dict) else {}
