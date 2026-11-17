"""
Accounts and sessions — ports of src/app/actions/auth.ts (sign in, sign out, the language
switches) and of the session lifecycle in src/lib/auth.ts (createSession, destroySession,
currentSession), plus the console layout's data.

  GET  /session                     the visitor's {user, tenant} (as currentSession() returned), or null
  GET  /views/console-layout        closes idle Playground calls; the sidebar counts
  POST /actions/signInAction        {email, password} → {token, expires, redirect} | {errorKey}
  POST /actions/signOutAction       audit + end the session → {ok}
  POST /actions/setLocaleAction     {locale} → the user's and company's language
  POST /actions/setPublicLocaleAction {locale} → the same, when signed in (the cookie is set by the site)

The browser cookie itself is set by the thin TypeScript proxy (a server action's response is
the site's), with the same attributes as before: HttpOnly, SameSite=Lax, Secure over HTTPS,
expiring with the session. Error messages are translated there too: Python returns their keys.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app import db
from app.audit import audit
from app.auth import COOKIE, LoggedIn, current_session, decode_session, encode_session, session_secret, verify_password
from app.ids import new_id, now_iso, to_iso
from app.jscompat import js_trim
from app.playground import close_idle_playground_calls
from app.views_common import action_args, js_response

router = APIRouter()

LOCALES = ("uz", "uz-Cyrl", "ru", "en")
SESSION_DAYS = 30


# ── sessions ────────────────────────────────────────────────────────


@router.get("/session")
def session(request: Request) -> Response:
    """`currentSession()`: {user, tenant} for a valid cookie, else null (never an error)."""
    found = current_session(request)
    return js_response({"user": found.user, "tenant": found.tenant} if found else None)


def create_session(request: Request, user_id: str, tenant_id: str) -> dict[str, str]:
    """`createSession`: a 30-day session row; returns the cookie value and its expiry for the site to set."""
    secret = session_secret()
    if not secret:
        raise RuntimeError("session secret missing")
    sid = new_id("ses")
    expires = to_iso(datetime.now(UTC) + timedelta(days=SESSION_DAYS))
    stamp = now_iso()
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO sessions (id, user_id, tenant_id, user_agent, ip, created_at, expires_at)
               VALUES (:id, :user_id, :tenant_id, :user_agent, :ip, :created_at, :expires_at)""",
            id=sid,
            user_id=user_id,
            tenant_id=tenant_id,
            user_agent=request.headers.get("user-agent"),
            ip=request.headers.get("x-forwarded-for") or "127.0.0.1",
            created_at=stamp,
            expires_at=expires,
        )
        db.execute(
            tx, "UPDATE users SET presence = 'online', last_seen_at = :now WHERE id = :id", now=now_iso(), id=user_id
        )
    return {"token": encode_session(sid, secret), "expires": expires}


def destroy_session(request: Request) -> None:
    """`destroySession`: the user goes offline and the session row is deleted (the site drops the cookie)."""
    token = request.cookies.get(COOKIE)
    secret = session_secret()
    if not token or not secret:
        return
    sid = decode_session(token, secret)
    if not sid:
        return
    with db.transaction() as tx:
        row = db.fetch_one(tx, "SELECT user_id FROM sessions WHERE id = :id", id=sid)
        if row:
            db.execute(tx, "UPDATE users SET presence = 'offline' WHERE id = :id", id=row["user_id"])
        db.execute(tx, "DELETE FROM sessions WHERE id = :id", id=sid)


# ── the console layout ──────────────────────────────────────────────


@router.get("/views/console-layout")
def console_layout(session: LoggedIn) -> Response:
    tenant_id = session.tenant["id"]
    # Playground tests left open (closed tab, dropped line) must not count as live calls.
    close_idle_playground_calls(tenant_id)
    with db.connect() as conn:

        def count(sql: str) -> int:
            row = db.fetch_one(conn, sql, t=tenant_id)
            return row["c"] if row and row["c"] is not None else 0

        counts = {
            "waitingEscalations": count(
                "SELECT COUNT(*) AS c FROM escalations WHERE tenant_id = :t AND status = 'waiting'"
            ),
            "activeCalls": count(
                "SELECT COUNT(*) AS c FROM calls WHERE tenant_id = :t "
                "AND status IN ('ringing','active','escalating','with_operator')"
            ),
            "documents": count("SELECT COUNT(*) AS c FROM documents WHERE tenant_id = :t"),
        }
    return js_response({"counts": counts})


# ── actions ─────────────────────────────────────────────────────────


def _string(value: Any) -> str:
    """`String(formData.get(name) ?? '')`."""
    return "" if value is None else value if isinstance(value, str) else str(value)


@router.post("/actions/signInAction")
async def sign_in(request: Request) -> Response:
    args = await action_args(request)
    email = js_trim(_string(args.get("email"))).lower()
    password = _string(args.get("password"))

    with db.connect() as conn:
        user = db.fetch_one(conn, "SELECT * FROM users WHERE email = :email", email=email)
    if user is None or not verify_password(password, user["password_hash"]):
        # Same message either way — never reveal whether an address is registered.
        return js_response({"errorKey": "auth.err.credentials"})
    if user["status"] == "disabled":
        return js_response({"errorKey": "auth.err.disabled"})

    cookie = create_session(request, user["id"], user["tenant_id"])
    audit(user["tenant_id"], {"id": user["id"], "name": user["name"]}, "auth.signin", user["id"])
    with db.connect() as conn:
        tenant = db.fetch_one(conn, "SELECT onboarded FROM tenants WHERE id = :id", id=user["tenant_id"])
    return js_response({**cookie, "redirect": "/app" if tenant and tenant["onboarded"] else "/onboarding"})


@router.post("/actions/signOutAction")
def sign_out(request: Request) -> Response:
    found = current_session(request)
    if found:
        audit(found.tenant["id"], {"id": found.user["id"], "name": found.user["name"]}, "auth.signout")
    destroy_session(request)
    return js_response({"ok": True})


def _save_locale(user_id: str, tenant_id: str, locale: str) -> None:
    with db.transaction() as tx:
        db.execute(
            tx, "UPDATE users SET locale = :l, updated_at = :now WHERE id = :id", l=locale, now=now_iso(), id=user_id
        )
        db.execute(
            tx,
            "UPDATE tenants SET locale = :l, updated_at = :now WHERE id = :id",
            l=locale,
            now=now_iso(),
            id=tenant_id,
        )


@router.post("/actions/setLocaleAction")
async def set_locale(request: Request) -> Response:
    args = await action_args(request)
    locale = args.get("locale")
    if locale not in LOCALES:
        return js_response(None)
    found = current_session(request)
    if found is None:
        return js_response({"error": "unauthorized"}, status=401)
    _save_locale(found.user["id"], found.tenant["id"], locale)
    return js_response(None)


@router.post("/actions/setPublicLocaleAction")
async def set_public_locale(request: Request) -> Response:
    args = await action_args(request)
    locale = _string(args.get("locale"))
    if locale not in LOCALES:
        return js_response(None)
    found = current_session(request)
    if found:
        _save_locale(found.user["id"], found.tenant["id"], locale)
    return js_response(None)
