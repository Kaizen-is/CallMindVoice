"""
The console's dashboards and workspace pages — `GET /views/<page>`, reached through the site as
`/api/core/views/<page>` (the page's server side calls it with the visitor's cookie, see
src/lib/core.ts). Each returns the data the page used to compute itself (`app.dashboards`).
Any signed-in member may load them, as before (the pages only called requireSession).
"""

from fastapi import APIRouter
from fastapi.responses import Response

from app.auth import LoggedIn
from app.dashboards import (
    analytics_view,
    billing_view,
    developers_view,
    numbers_view,
    overview_view,
    settings_view,
    team_view,
)
from app.views_common import js_response

router = APIRouter(prefix="/views")


@router.get("/overview")
def overview(session: LoggedIn) -> Response:
    return js_response(overview_view(session))


@router.get("/analytics")
def analytics(session: LoggedIn) -> Response:
    return js_response(analytics_view(session))


@router.get("/numbers")
def numbers(session: LoggedIn) -> Response:
    return js_response(numbers_view(session))


@router.get("/team")
def team(session: LoggedIn) -> Response:
    return js_response(team_view(session))


@router.get("/settings")
def settings(session: LoggedIn) -> Response:
    return js_response(settings_view(session))


@router.get("/developers")
def developers(session: LoggedIn) -> Response:
    return js_response(developers_view(session))


@router.get("/billing")
def billing(session: LoggedIn) -> Response:
    return js_response(billing_view(session))
