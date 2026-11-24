"""
Workspace administration and dashboards served by Python (`app/routers/{dashboard_views,
workspace_actions}.py`): who may call what, malformed arguments, and that what the actions write
works with the rest of the backend (the API key authenticates, the password verifies). The
behaviour itself is compared with the TypeScript in test_workspace_parity.py.
"""

import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import analytics
from app.auth import COOKIE, check_api_key, encode_session, verify_password
from tests.conftest import SECRET

TENANT = "ten_routes"
NOW = "2026-11-17T09:30:00.000Z"
ROLES = ("analyst", "operator", "admin", "owner")
VIEWS = ("overview", "analytics", "numbers", "team", "settings", "developers", "billing")
ACTIONS = {
    # action: (minimum role, arguments)
    "addNumberAction": ("admin", {"input": {"e164": "+998712000777", "label": "L", "provider": "sip"}}),
    "removeNumberAction": ("admin", {"numberId": "num_x"}),
    "inviteMemberAction": ("admin", {"input": {"name": "N", "email": "n@x.uz", "role": "analyst", "password": "x"}}),
    "changeRoleAction": ("admin", {"userId": "usr_x", "role": "operator"}),
    "setMemberStatusAction": ("admin", {"userId": "usr_x", "status": "active"}),
    "createApiKeyAction": ("admin", {"name": "k", "scopes": "read"}),
    "revokeApiKeyAction": ("admin", {"keyId": "key_x"}),
    "saveWebhookAction": ("admin", {"url": "http://x", "events": "call.completed"}),
    "deleteWebhookAction": ("admin", {"hookId": "whk_x"}),
    "saveSpeechTestAction": ("analyst", {"input": {"kind": "nope"}}),
    "updateTenantAction": ("admin", {"input": {"name": "T", "industry": "other", "timezone": "UTC", "country": "UZ"}}),
    "changePlanAction": ("owner", {"plan": "pro"}),
    "topUpAction": ("owner", {"amountUzs": 0}),
    "resolveGapAction": ("admin", {"gapId": "gap_x", "answer": "a"}),
    "ignoreGapAction": ("admin", {"gapId": "gap_x"}),
}  # fmt: skip


def _sql(path: Path, statement: str, *params) -> list[tuple]:
    con = sqlite3.connect(path)
    try:
        rows = con.execute(statement, params).fetchall()
        con.commit()
        return rows
    finally:
        con.close()


@pytest.fixture
def db_path(data_dir: Path) -> Path:
    path = data_dir / "ovoz.db"
    _sql(path, "INSERT INTO tenants (id, name, slug, balance_uzs, created_at, updated_at) VALUES (?,?,?,?,?,?)",
         TENANT, "Routes", "routes", 1000, NOW, NOW)  # fmt: skip
    for role in ROLES:
        _sql(
            path,
            "INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            f"usr_{role}", TENANT, f"{role}@example.uz", role.title(), "x", role, NOW, NOW,
        )  # fmt: skip
        _sql(path, "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at) VALUES (?,?,?,?,?)",
             f"ses_{role}", f"usr_{role}", TENANT, NOW, "2099-01-01T00:00:00.000Z")  # fmt: skip
    return path


@pytest.fixture
def api(db_path: Path) -> Iterator[TestClient]:
    from app.main import create_app

    with TestClient(create_app()) as client:
        yield client


def _as(client: TestClient, role: str | None) -> TestClient:
    client.cookies.clear()
    if role:
        client.cookies.set(COOKIE, encode_session(f"ses_{role}", SECRET))
    return client


# ── who may call what ───────────────────────────────────────────────


@pytest.mark.parametrize("view", VIEWS)
def test_views_need_a_login_and_any_role_will_do(api: TestClient, view: str) -> None:
    assert (_as(api, None).get(f"/views/{view}").status_code, api.get(f"/views/{view}").json()) == (
        401,
        {"error": "unauthorized"},
    )
    for role in ROLES:
        assert _as(api, role).get(f"/views/{view}").status_code == 200, (view, role)


@pytest.mark.parametrize("action", sorted(ACTIONS))
def test_action_role_checks(api: TestClient, action: str) -> None:
    minimum, args = ACTIONS[action]
    res = _as(api, None).post(f"/actions/{action}", json=args)
    assert (res.status_code, res.json()) == (401, {"error": "unauthorized"})
    for role in ROLES:
        res = _as(api, role).post(f"/actions/{action}", json=args)
        if ROLES.index(role) < ROLES.index(minimum):
            assert (res.status_code, res.json()) == (403, {"error": "forbidden"}), (action, role)
        else:
            assert res.status_code == 200 and "ok" in res.json(), (action, role, res.text)


@pytest.mark.parametrize(
    ("action", "args"),
    [
        ("addNumberAction", {}),  # input.e164 of undefined: the TypeScript threw
        ("addNumberAction", {"input": {"e164": 998712000000, "label": "x", "provider": "sip"}}),
        ("inviteMemberAction", {"input": {"name": "N", "email": None, "role": "analyst", "password": "longenough"}}),
        ("createApiKeyAction", {"scopes": "read"}),
        ("saveSpeechTestAction", {"input": "stt"}),
        ("saveSpeechTestAction", {"input": {"kind": "stt", "input": 5}}),
        ("updateTenantAction", {"input": {"industry": "x"}}),
        ("saveWebhookAction", {"url": ["https://x.com"], "events": "e"}),
    ],
)
def test_malformed_arguments_are_refused(api: TestClient, action: str, args: dict) -> None:
    res = _as(api, "owner").post(f"/actions/{action}", json=args)
    assert (res.status_code, res.json()) == (400, {"error": "bad_request"})


def test_no_body_is_no_arguments(api: TestClient) -> None:
    res = _as(api, "owner").post("/actions/topUpAction")
    assert res.json() == {"ok": False, "message": "Enter an amount greater than zero."}


# ── what the actions write works with the rest of the backend ───────


def test_created_api_key_authenticates_with_its_scopes(api: TestClient, db_path: Path) -> None:
    res = _as(api, "admin").post("/actions/createApiKeyAction", json={"name": " CI ", "scopes": "read,write"})
    body = res.json()
    assert body["ok"] is True and body["key"].startswith("ovoz_sk_") and len(body["key"]) == 40
    auth = check_api_key(f"Bearer {body['key']}", "write")
    assert (auth.tenant_id, auth.scopes) == (TENANT, ["read", "write"])
    [(name, prefix, created_by)] = _sql(db_path, "SELECT name, prefix, created_by FROM api_keys")
    assert (name, prefix, created_by) == ("CI", body["key"][:16], "usr_admin")


def test_invited_member_can_log_in_with_the_password(api: TestClient, db_path: Path) -> None:
    res = _as(api, "admin").post(
        "/actions/inviteMemberAction",
        json={
            "input": {"name": "Nodira", "email": " Nodira@Example.UZ ", "role": "operator", "password": "parol-123ў"}
        },
    )
    assert res.json() == {"ok": True, "message": "Nodira added as operator."}
    [(email, password_hash, hue, locale)] = _sql(
        db_path, "SELECT email, password_hash, avatar_hue, locale FROM users WHERE name='Nodira'"
    )
    assert (email, locale) == ("nodira@example.uz", "en")
    assert verify_password("parol-123ў", password_hash) and 0 <= hue < 360
    [(actor, meta)] = _sql(db_path, "SELECT actor_name, meta_json FROM audit_log WHERE action='team.invited'")
    assert (actor, meta) == ("Admin", '{"email":"nodira@example.uz","role":"operator"}')


def test_webhook_gets_a_signing_secret(api: TestClient, db_path: Path) -> None:
    res = _as(api, "admin").post("/actions/saveWebhookAction", json={"url": "https://h.example.com/x", "events": "e"})
    assert res.json() == {"ok": True, "message": "Webhook registered."}
    [(secret,)] = _sql(db_path, "SELECT secret FROM webhooks")
    assert secret.startswith("whsec_") and len(secret) == 38


def test_top_up_moves_the_balance_and_the_billing_view(api: TestClient) -> None:
    _as(api, "owner")
    assert api.get("/views/billing").json()["low"] is True
    res = api.post("/actions/topUpAction", json={"amountUzs": 150000})
    assert res.json() == {"ok": True, "balance": 151000, "message": "Balance topped up."}
    view = api.get("/views/billing").json()
    assert (view["balance"], view["low"], view["negative"]) == (151000, False, False)
    assert view["ledger"][0]["note"] == "Manual top-up" and view["ledger"][0]["balance_after"] == 151000


def test_disabling_a_member_ends_their_sessions(api: TestClient, db_path: Path) -> None:
    res = _as(api, "admin").post(
        "/actions/setMemberStatusAction", json={"userId": "usr_operator", "status": "disabled"}
    )
    assert res.json() == {"ok": True, "message": "Access revoked."}
    assert _sql(db_path, "SELECT id FROM sessions WHERE user_id='usr_operator'") == []
    assert _as(api, "operator").get("/views/overview").status_code == 401


# ── local time for the heat map ─────────────────────────────────────


def test_hourly_heat_buckets_by_local_time_sunday_first(db_path: Path) -> None:
    # 2026-11-15 is a Sunday. 20:30 UTC on Saturday is 01:30 on Sunday in Tashkent (UTC+5).
    for i, started in enumerate(("2026-11-14T20:30:00.000Z", "2026-11-15T12:00:00.000Z", "2026-11-16T00:10:00.000Z")):
        _sql(db_path, "INSERT INTO calls (id, tenant_id, from_e164, to_e164, started_at) VALUES (?,?,?,?,?)",
             f"call_{i}", TENANT, "+1", "+2", started)  # fmt: skip
    now = datetime(2026, 11, 17, tzinfo=UTC)
    grid = analytics.hourly_heat(TENANT, 30, now, ZoneInfo("Asia/Tashkent"))
    assert (grid[0][1], grid[0][17], grid[1][5]) == (1, 1, 1) and sum(map(sum, grid)) == 3
    utc = analytics.hourly_heat(TENANT, 30, now, UTC)
    assert (utc[6][20], utc[0][12], utc[1][0]) == (1, 1, 1)
