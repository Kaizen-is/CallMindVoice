"""Health, readiness, `/me` with the shared session cookie, API keys, and the streaming checks."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.auth import COOKIE, ApiKeyError, api_key_hash, check_api_key, encode_session
from app.ids import to_iso
from tests.conftest import SECRET


def _seed_user(sql, *, status: str = "active", expires_in: timedelta = timedelta(days=30)) -> str:
    now = "2026-11-12T00:00:00.000Z"
    sql(
        "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)",
        "ten_test000000000001", "Test Bank", "test-bank", now, now,
    )
    sql(
        "INSERT INTO users (id, tenant_id, email, name, password_hash, role, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        "usr_test000000000001", "ten_test000000000001", "aziz@example.uz", "Aziz", "x", "admin",
        status, now, now,
    )
    sid = "ses_test000000000001"
    sql(
        "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at) VALUES (?,?,?,?,?)",
        sid, "usr_test000000000001", "ten_test000000000001", now, to_iso(datetime.now(UTC) + expires_in),
    )
    return sid


def test_healthz(client: TestClient):
    assert client.get("/healthz").json() == {"ok": True}


def test_readyz_reports_ready(client: TestClient):
    res = client.get("/readyz")
    assert res.status_code == 200, res.json()
    assert res.json()["checks"] == {"database": True, "schema": True, "session_secret": True}


def test_readyz_fails_without_expected_schema(client: TestClient, sql):
    sql("DELETE FROM _migrations")
    res = client.get("/readyz")
    assert res.status_code == 503
    assert res.json()["checks"]["schema"] is False


def test_me_requires_login(client: TestClient):
    res = client.get("/me")
    assert res.status_code == 401
    assert res.json() == {"error": "unauthorized"}


def test_me_with_cookie_minted_like_typescript(client: TestClient, sql):
    sid = _seed_user(sql)
    client.cookies.set(COOKIE, encode_session(sid, SECRET))
    res = client.get("/me")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["email"] == "aziz@example.uz"
    assert body["user"]["role"] == "admin"
    assert body["tenant"]["name"] == "Test Bank"
    assert "password_hash" not in body["user"]


def test_expired_session_is_refused_and_deleted(client: TestClient, sql):
    sid = _seed_user(sql, expires_in=timedelta(minutes=-1))
    client.cookies.set(COOKIE, encode_session(sid, SECRET))
    assert client.get("/me").status_code == 401
    assert sql("SELECT COUNT(*) FROM sessions WHERE id = ?", sid) == [(0,)]


def test_disabled_user_is_refused(client: TestClient, sql):
    sid = _seed_user(sql, status="disabled")
    client.cookies.set(COOKIE, encode_session(sid, SECRET))
    assert client.get("/me").status_code == 401


def test_cookie_signed_with_another_secret_is_refused(client: TestClient, sql):
    sid = _seed_user(sql)
    client.cookies.set(COOKIE, encode_session(sid, "not-the-secret"))
    assert client.get("/me").status_code == 401


def test_api_key_scopes(data_dir, sql):
    _seed_user(sql)
    raw = "ovoz_sk_yv66vgARIjNEVWZ3iJmqu8zd7v8AESIz"
    sql(
        "INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)",
        "key_test000000000001", "ten_test000000000001", "test", raw[:16], api_key_hash(raw), "read",
        "2026-11-12T00:00:00.000Z",
    )
    auth = check_api_key(f"Bearer {raw}", "read")
    assert auth.tenant_id == "ten_test000000000001"
    assert sql("SELECT last_used IS NOT NULL FROM api_keys") == [(1,)]

    with pytest.raises(ApiKeyError) as missing_scope:
        check_api_key(f"Bearer {raw}", "write")
    assert missing_scope.value.status == 403

    for header in (None, "Token abc", "Bearer not_a_key", "Bearer ovoz_sk_unknown"):
        with pytest.raises(ApiKeyError) as bad:
            check_api_key(header, "read")
        assert bad.value.status == 401

    sql("UPDATE api_keys SET revoked_at = '2026-11-12T01:00:00.000Z'")
    with pytest.raises(ApiKeyError):
        check_api_key(f"Bearer {raw}", "read")


STREAMS = [("/diagnostics/ndjson", "application/x-ndjson"), ("/diagnostics/sse", "text/event-stream")]


@pytest.mark.parametrize("path, kind", STREAMS)
def test_streams_need_login_and_stream(client: TestClient, sql, path, kind):
    assert client.get(path).status_code == 401
    client.cookies.set(COOKIE, encode_session(_seed_user(sql), SECRET))
    with client.stream("GET", path) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith(kind)
        lines = [line for line in res.iter_lines() if line]
    assert len(lines) == 5
