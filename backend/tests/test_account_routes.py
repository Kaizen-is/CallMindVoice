"""
Accounts and sessions served by Python (`app/routers/account.py`): what currentSession(),
createSession()/destroySession() and the sign-in / sign-out / language actions of
src/app/actions/auth.ts did, plus the console layout's counts.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE, decode_session, encode_session, hash_password
from app.ids import to_iso
from tests.conftest import SECRET

TENANT = "ten_acct00000000001"
USER = "usr_acct00000000001"
NOW = "2026-11-12T00:00:00.000Z"
PASSWORD = "test-password-123"  # a test value for this throwaway database


def _seed(sql, *, onboarded: int = 1, status: str = "active") -> None:  # noqa: ANN001
    sql(
        "INSERT INTO tenants (id, name, slug, onboarded, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        TENANT,
        "Test Bank",
        "test-bank",
        onboarded,
        NOW,
        NOW,
    )
    sql(
        "INSERT INTO users (id, tenant_id, email, name, password_hash, role, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        USER,
        TENANT,
        "aziz@example.uz",
        "Aziz",
        hash_password(PASSWORD),
        "owner",
        status,
        NOW,
        NOW,
    )


def _login(sql, client: TestClient, *, expires: str | None = None) -> str:  # noqa: ANN001
    sid = "ses_acct00000000001"
    sql(
        "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at) VALUES (?,?,?,?,?)",
        sid,
        USER,
        TENANT,
        NOW,
        expires or to_iso(datetime.now(UTC) + timedelta(days=1)),
    )
    client.cookies.set(COOKIE, encode_session(sid, SECRET))
    return sid


@pytest.fixture
def client(data_dir) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


# ── /session ────────────────────────────────────────────────────────


def test_session_without_cookie_is_null(client) -> None:  # noqa: ANN001
    res = client.get("/session")
    assert (res.status_code, res.json()) == (200, None)


def test_session_returns_safe_user_and_full_tenant(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    _login(sql, client)
    body = client.get("/session").json()
    assert body["user"]["id"] == USER and body["user"]["email"] == "aziz@example.uz"
    assert "password_hash" not in body["user"]
    assert set(body["user"]) == {
        "id", "tenant_id", "email", "name", "role", "avatar_hue", "locale", "status", "presence",
        "last_seen_at", "created_at", "updated_at",
    }  # fmt: skip
    assert body["tenant"]["id"] == TENANT and body["tenant"]["onboarded"] == 1


def test_expired_session_is_null_and_deleted(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    _login(sql, client, expires="2020-01-01T00:00:00.000Z")
    assert client.get("/session").json() is None
    assert sql("SELECT COUNT(*) FROM sessions")[0][0] == 0


def test_disabled_user_has_no_session(client, sql) -> None:  # noqa: ANN001
    _seed(sql, status="disabled")
    _login(sql, client)
    assert client.get("/session").json() is None


# ── console layout ──────────────────────────────────────────────────


def test_console_layout_counts_and_closes_idle_playground_calls(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    _login(sql, client)
    old = to_iso(datetime.now(UTC) - timedelta(hours=3))
    sql(
        "INSERT INTO calls (id, tenant_id, channel, from_e164, to_e164, status, started_at) VALUES (?,?,?,?,?,?,?)",
        "call_idle0000000001",
        TENANT,
        "web",
        "playground",
        "agent",
        "active",
        old,
    )
    sql(
        "INSERT INTO calls (id, tenant_id, channel, from_e164, to_e164, status, started_at) VALUES (?,?,?,?,?,?,?)",
        "call_live0000000001",
        TENANT,
        "voice",
        "+998901112233",
        "+998787100001",
        "active",
        to_iso(datetime.now(UTC)),
    )
    sql(
        "INSERT INTO documents (id, tenant_id, title, source_type, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?)",
        "doc_test00000000001",
        TENANT,
        "FAQ",
        "text",
        "ready",
        NOW,
        NOW,
    )
    res = client.get("/views/console-layout")
    assert res.status_code == 200
    assert res.json() == {"counts": {"waitingEscalations": 0, "activeCalls": 1, "documents": 1}}
    assert sql("SELECT ended_at IS NOT NULL FROM calls WHERE id = 'call_idle0000000001'")[0][0] == 1


def test_console_layout_needs_a_login(client) -> None:  # noqa: ANN001
    assert client.get("/views/console-layout").status_code == 401


# ── sign in / out ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("email", "password"), [("nobody@example.uz", PASSWORD), ("aziz@example.uz", "wrong-password")]
)
def test_sign_in_wrong_credentials_same_message(client, sql, email, password) -> None:  # noqa: ANN001
    _seed(sql)
    res = client.post("/actions/signInAction", json={"email": email, "password": password})
    assert res.json() == {"errorKey": "auth.err.credentials"}
    assert sql("SELECT COUNT(*) FROM sessions")[0][0] == 0


def test_sign_in_disabled(client, sql) -> None:  # noqa: ANN001
    _seed(sql, status="disabled")
    res = client.post("/actions/signInAction", json={"email": "aziz@example.uz", "password": PASSWORD})
    assert res.json() == {"errorKey": "auth.err.disabled"}


@pytest.mark.parametrize(("onboarded", "target"), [(1, "/app"), (0, "/onboarding")])
def test_sign_in_creates_a_session(client, sql, onboarded, target) -> None:  # noqa: ANN001
    _seed(sql, onboarded=onboarded)
    res = client.post(
        "/actions/signInAction",
        json={"email": "  AZIZ@example.uz ", "password": PASSWORD},
        headers={"user-agent": "TestBrowser/1.0", "x-forwarded-for": "203.0.113.7"},
    )
    body = res.json()
    assert body["redirect"] == target
    sid = decode_session(body["token"], SECRET)
    assert sid and sid.startswith("ses_")
    ((user_agent, ip, expires_at),) = sql("SELECT user_agent, ip, expires_at FROM sessions WHERE id = ?", sid)
    assert (user_agent, ip) == ("TestBrowser/1.0", "203.0.113.7")
    assert expires_at == body["expires"]
    days = (datetime.fromisoformat(expires_at.replace("Z", "+00:00")) - datetime.now(UTC)).days
    assert days in (29, 30)
    assert sql("SELECT presence FROM users WHERE id = ?", USER)[0][0] == "online"
    assert sql("SELECT action, target, actor_name FROM audit_log")[-1] == ("auth.signin", USER, "Aziz")


def test_sign_in_without_forwarded_for_records_localhost(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    body = client.post("/actions/signInAction", json={"email": "aziz@example.uz", "password": PASSWORD}).json()
    sid = decode_session(body["token"], SECRET)
    assert sql("SELECT ip FROM sessions WHERE id = ?", sid)[0][0] == "127.0.0.1"


def test_sign_out(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    _login(sql, client)
    sql("UPDATE users SET presence = 'online'")
    assert client.post("/actions/signOutAction").json() == {"ok": True}
    assert sql("SELECT COUNT(*) FROM sessions")[0][0] == 0
    assert sql("SELECT presence FROM users")[0][0] == "offline"
    assert sql("SELECT action FROM audit_log")[-1] == ("auth.signout",)


def test_sign_out_without_a_session(client, sql) -> None:  # noqa: ANN001
    assert client.post("/actions/signOutAction").json() == {"ok": True}
    assert sql("SELECT COUNT(*) FROM audit_log")[0][0] == 0


# ── language ────────────────────────────────────────────────────────


def test_set_locale(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    assert client.post("/actions/setLocaleAction", json={"locale": "ru"}).status_code == 401
    _login(sql, client)
    assert client.post("/actions/setLocaleAction", json={"locale": "de"}).json() is None
    assert sql("SELECT locale FROM users")[0][0] != "de"
    assert client.post("/actions/setLocaleAction", json={"locale": "uz-Cyrl"}).json() is None
    assert sql("SELECT locale FROM users")[0][0] == "uz-Cyrl"
    assert sql("SELECT locale FROM tenants")[0][0] == "uz-Cyrl"


def test_set_public_locale(client, sql) -> None:  # noqa: ANN001
    _seed(sql)
    assert client.post("/actions/setPublicLocaleAction", json={"locale": "en"}).json() is None  # signed out: no rows
    assert sql("SELECT locale FROM users")[0][0] != "en"
    _login(sql, client)
    client.post("/actions/setPublicLocaleAction", json={"locale": "en"})
    assert (sql("SELECT locale FROM users")[0][0], sql("SELECT locale FROM tenants")[0][0]) == ("en", "en")
