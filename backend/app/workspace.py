"""
Workspace administration — the server actions of src/app/actions/ops.ts for phone numbers, the
team, API keys and webhooks, speech-lab history, company settings, the plan and wallet, and
knowledge gaps. Each function takes the session and the action's arguments (by their TypeScript
parameter names) and returns exactly what the TypeScript action returned; the role checks are
the routes' dependencies (`app/routers/workspace_actions.py`).

Arguments arrive as JSON, so a missing one is UNDEFINED (JSON.stringify drops `undefined`).
Values that go straight into a column are bound the way node:sqlite binds them (`js_sql_param`).
Where the TypeScript would have thrown on a malformed argument (`.trim()` of a non-string), this
raises 400 `bad_request`, which the thin TypeScript proxy rethrows.
"""

import base64
import hashlib
import math
import re
import secrets
from typing import Any

from fastapi import HTTPException
from sqlalchemy.exc import DBAPIError

from app import db
from app.audit import audit
from app.auth import Session, hash_password
from app.engine.calls import live_agent
from app.ids import new_id, now_iso
from app.jscompat import (
    UNDEFINED,
    js_round,
    js_sql_param,
    js_string,
    js_to_number,
    js_trim,
    js_url_protocol,
    js_well_formed,
    utf16_len,
    utf16_slice,
)

_E164 = re.compile(r"\+[0-9]{7,15}")  # /^\+\d{7,15}$/ (JavaScript's \d is ASCII only)


def bad_request() -> HTTPException:
    return HTTPException(status_code=400, detail="bad_request")


def arg(args: dict[str, Any], name: str) -> Any:
    """An argument by name; UNDEFINED when it was not sent."""
    return args.get(name, UNDEFINED)


def text_arg(args: dict[str, Any], name: str) -> str:
    """An argument the TypeScript called a string method on (it threw for anything else)."""
    value = arg(args, name)
    if not isinstance(value, str):
        raise bad_request()
    return value


def object_arg(args: dict[str, Any], name: str) -> dict[str, Any]:
    """An object argument whose fields the TypeScript read (`input.e164`)."""
    value = arg(args, name)
    if not isinstance(value, dict):
        raise bad_request()
    return value


def _meta(**fields: Any) -> dict[str, Any]:
    """An audit `meta` object literal: JSON.stringify leaves out the fields that are undefined."""
    return {k: v for k, v in fields.items() if v is not UNDEFINED}


def _actor(session: Session) -> dict[str, Any]:
    return session.user


def _tenant(session: Session) -> str:
    return session.tenant["id"]


def _db_error_message(err: Exception) -> str:
    """`err.message` as node:sqlite words it (the SQLite message), or the error's own text."""
    if isinstance(err, DBAPIError) and err.orig is not None:
        return str(err.orig)
    return str(err)


def _js_number(value: int | float) -> int | float:
    """A whole number as JavaScript holds it: beyond 2^53 it is a double."""
    if isinstance(value, int) and abs(value) > 2**53:
        return float(value)
    return value


def generate_api_key() -> dict[str, str]:
    """`generateApiKey` in auth.ts: `ovoz_sk_` + 24 random bytes base64url; the first 16 characters; SHA-256 hex."""
    raw = "ovoz_sk_" + base64.urlsafe_b64encode(secrets.token_bytes(24)).rstrip(b"=").decode("ascii")
    return {"raw": raw, "prefix": raw[:16], "hash": hashlib.sha256(raw.encode("utf-8")).hexdigest()}


# ── numbers ─────────────────────────────────────────────────────────


def add_number(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    data = object_arg(args, "input")
    e164 = js_trim(text_arg(data, "e164"))
    if not _E164.fullmatch(e164):
        return {"ok": False, "message": "Use international format, for example +998712000000."}
    tenant_id = _tenant(session)
    with db.connect() as conn:
        taken = db.fetch_one(conn, "SELECT id FROM phone_numbers WHERE tenant_id=:t AND e164=:e", t=tenant_id, e=e164)
    if taken:
        return {"ok": False, "message": "That number is already connected."}
    label = js_trim(text_arg(data, "label")) or "Line"
    agent = live_agent(tenant_id)
    number_id = new_id("num")
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO phone_numbers (id, tenant_id, e164, label, provider, region, agent_id, status,
                 capabilities, monthly_cost, created_at)
               VALUES (:id, :t, :e164, :label, :provider, 'Tashkent', :agent, 'active', 'voice', 3.0, :now)""",
            id=number_id,
            t=tenant_id,
            e164=e164,
            label=js_well_formed(label),
            provider=js_sql_param(arg(data, "provider")),
            agent=agent["id"] if agent else None,
            now=now_iso(),
        )
    audit(tenant_id, _actor(session), "number.added", number_id, {"e164": e164})
    return {"ok": True, "message": f"{e164} connected."}


def remove_number(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    number_id = js_sql_param(arg(args, "numberId"))
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(tx, "DELETE FROM phone_numbers WHERE id=:id AND tenant_id=:t", id=number_id, t=tenant_id)
    audit(tenant_id, _actor(session), "number.removed", number_id)
    return {"ok": True, "message": "Number released."}


# ── team ────────────────────────────────────────────────────────────


def invite_member(*, tenant_id: str, email: str, name: str, role: str, password: str, actor: dict[str, Any]) -> str:
    """`inviteMember` in provision.ts. Raises ValueError when the email is taken."""
    email = js_trim(email).lower()
    with db.connect() as conn:
        if db.fetch_one(conn, "SELECT id FROM users WHERE email=:e", e=js_well_formed(email)):
            raise ValueError("That email is already in use.")
    user_id = new_id("usr")
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
                 status, presence, created_at, updated_at)
               VALUES (:id, :t, :email, :name, :hash, :role, :hue, 'en', 'active', 'offline', :created, :updated)""",
            id=user_id,
            t=tenant_id,
            email=js_well_formed(email),
            name=js_well_formed(js_trim(name)),
            hash=hash_password(js_well_formed(password)),  # Node hashes the UTF-8 bytes, lone surrogates as U+FFFD
            role=js_sql_param(role),
            hue=secrets.randbelow(360),  # Math.floor(Math.random() * 360)
            created=now_iso(),
            updated=now_iso(),
        )
    audit(tenant_id, actor, "team.invited", user_id, {"email": email, "role": role})
    return user_id


def invite_member_action(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    data = object_arg(args, "input")
    password = text_arg(data, "password")
    if utf16_len(password) < 8:
        return {"ok": False, "message": "Password must be 8+ characters."}
    name, email, role = text_arg(data, "name"), text_arg(data, "email"), text_arg(data, "role")
    try:
        invite_member(
            tenant_id=_tenant(session),
            email=email,
            name=name,
            role=role,
            password=password,
            actor={"id": session.user["id"], "name": session.user["name"]},
        )
    except Exception as err:  # noqa: BLE001 - the TypeScript returned any error's message
        return {"ok": False, "message": _db_error_message(err)}
    return {"ok": True, "message": f"{name} added as {role}."}


def change_role(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    user_id, role = arg(args, "userId"), arg(args, "role")
    if user_id == session.user["id"]:
        return {"ok": False, "message": "You cannot change your own role."}
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE users SET role=:role, updated_at=:now WHERE id=:id AND tenant_id=:t",
            role=js_sql_param(role),
            now=now_iso(),
            id=js_sql_param(user_id),
            t=tenant_id,
        )
    audit(tenant_id, _actor(session), "team.role_changed", js_sql_param(user_id), _meta(role=role))
    return {"ok": True, "message": "Role updated."}


def set_member_status(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    user_id, status = arg(args, "userId"), arg(args, "status")
    if user_id == session.user["id"]:
        return {"ok": False, "message": "You cannot disable yourself."}
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE users SET status=:status, updated_at=:now WHERE id=:id AND tenant_id=:t",
            status=js_sql_param(status),
            now=now_iso(),
            id=js_sql_param(user_id),
            t=tenant_id,
        )
        if status == "disabled":
            # As in the TypeScript: by user id alone (the UPDATE above is the tenant-scoped part).
            db.execute(tx, "DELETE FROM sessions WHERE user_id=:id", id=js_sql_param(user_id))
    audit(tenant_id, _actor(session), "team.status_changed", js_sql_param(user_id), _meta(status=status))
    return {"ok": True, "message": "Access revoked." if status == "disabled" else "Access restored."}


# ── developers ──────────────────────────────────────────────────────


def create_api_key(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    name, scopes = text_arg(args, "name"), arg(args, "scopes")
    key = generate_api_key()
    key_id = new_id("key")
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_by, created_at)
               VALUES (:id, :t, :name, :prefix, :hash, :scopes, :by, :now)""",
            id=key_id,
            t=tenant_id,
            name=js_well_formed(js_trim(name) or "API key"),
            prefix=key["prefix"],
            hash=key["hash"],
            scopes=js_sql_param(scopes),
            by=session.user["id"],
            now=now_iso(),
        )
    audit(tenant_id, _actor(session), "apikey.created", key_id, _meta(name=name, scopes=scopes))
    # Returned exactly once — only the hash is stored.
    return {"ok": True, "key": key["raw"], "message": "Copy this key now — it will not be shown again."}


def revoke_api_key(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    key_id = js_sql_param(arg(args, "keyId"))
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE api_keys SET revoked_at=:now WHERE id=:id AND tenant_id=:t",
            now=now_iso(),
            id=key_id,
            t=tenant_id,
        )
    audit(tenant_id, _actor(session), "apikey.revoked", key_id)
    return {"ok": True, "message": "Key revoked."}


def save_webhook(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    url, events = arg(args, "url"), arg(args, "events")
    if isinstance(url, list):
        raise bad_request()  # String([...]) could be a URL; the console never sends one
    protocol = js_url_protocol(url if isinstance(url, str) else js_string(url))
    if protocol is None:
        return {"ok": False, "message": "That is not a valid URL."}
    if protocol != "https:":
        return {"ok": False, "message": "Webhook URLs must use HTTPS."}
    hook_id = new_id("whk")
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO webhooks (id, tenant_id, url, events, secret, status, created_at)
               VALUES (:id, :t, :url, :events, :secret, 'active', :now)""",
            id=hook_id,
            t=tenant_id,
            url=js_well_formed(url),
            events=js_sql_param(events),
            secret="whsec_" + generate_api_key()["raw"].removeprefix("ovoz_sk_"),
            now=now_iso(),
        )
    audit(tenant_id, _actor(session), "webhook.created", hook_id, {"url": url})
    return {"ok": True, "message": "Webhook registered."}


def delete_webhook(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    with db.transaction() as tx:
        db.execute(
            tx,
            "DELETE FROM webhooks WHERE id=:id AND tenant_id=:t",
            id=js_sql_param(arg(args, "hookId")),
            t=_tenant(session),
        )
    return {"ok": True, "message": "Webhook removed."}


# ── developer speech lab ────────────────────────────────────────────


def _clipped(data: dict[str, Any], name: str, limit: int) -> str | None:
    """`input.<name>?.slice(0, limit) ?? null` (UTF-16 units, as JavaScript counts)."""
    value = data.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise bad_request()
    return utf16_slice(value, 0, limit)


def save_speech_test(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    data = object_arg(args, "input")
    kind = data.get("kind")
    if kind not in ("stt", "tts"):
        return {"ok": False, "message": "Unknown test kind."}
    voice = data.get("voice")
    test = {
        "id": new_id("spt"),
        "tenant_id": session.tenant["id"],
        "user_id": session.user["id"],
        "kind": kind,
        "input": _clipped(data, "input", 4000),
        "output": _clipped(data, "output", 8000),
        "voice": voice,
        "created_at": now_iso(),
    }
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO speech_tests (id, tenant_id, user_id, kind, input, output, voice, created_at)
               VALUES (:id, :tenant_id, :user_id, :kind, :input, :output, :voice, :created_at)""",
            **{k: js_sql_param(v) if k in ("input", "output", "voice") else v for k, v in test.items()},
        )
    return {"ok": True, "test": test}


# ── settings & billing ──────────────────────────────────────────────


def update_tenant(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    data = object_arg(args, "input")
    name = js_trim(text_arg(data, "name"))
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE tenants SET name=:name, industry=:industry, timezone=:timezone, country=:country, "
            "updated_at=:now WHERE id=:id",
            name=js_well_formed(name),
            industry=js_sql_param(arg(data, "industry")),
            timezone=js_sql_param(arg(data, "timezone")),
            country=js_sql_param(arg(data, "country")),
            now=now_iso(),
            id=tenant_id,
        )
    audit(tenant_id, _actor(session), "tenant.updated", tenant_id, data)
    return {"ok": True, "message": "Saved."}


def change_plan(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    plan = arg(args, "plan")
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE tenants SET plan=:plan, plan_started=:started, updated_at=:now WHERE id=:id",
            plan=js_sql_param(plan),
            started=now_iso(),
            now=now_iso(),
            id=tenant_id,
        )
    audit(tenant_id, _actor(session), "billing.plan_changed", tenant_id, _meta(plan=plan))
    return {"ok": True, "message": f"Switched to the {js_string(plan)} plan."}


def top_up(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    """Credit the prepaid so'm balance (a manual top-up; a payment gateway is a later phase)."""
    amount_in = js_to_number(arg(args, "amountUzs"))  # Math.round(Number(amountUzs))
    if not math.isfinite(amount_in) or js_round(amount_in) <= 0:
        return {"ok": False, "message": "Enter an amount greater than zero."}
    amount = _js_number(js_round(amount_in))
    tenant_id = _tenant(session)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE tenants SET balance_uzs = balance_uzs + :amount, updated_at=:now WHERE id=:id",
            amount=float(amount),
            now=now_iso(),
            id=tenant_id,
        )
        row = db.fetch_one(tx, "SELECT balance_uzs FROM tenants WHERE id=:id", id=tenant_id)
        balance = _js_number(row["balance_uzs"] if row and row["balance_uzs"] is not None else 0)
        db.execute(
            tx,
            """INSERT INTO wallet_ledger (id, tenant_id, kind, amount_uzs, balance_after, note, created_at)
               VALUES (:id, :t, 'topup', :amount, :balance, 'Manual top-up', :now)""",
            id=new_id("wl"),
            t=tenant_id,
            amount=float(amount),
            balance=float(balance),
            now=now_iso(),
        )
    audit(tenant_id, _actor(session), "billing.topup", tenant_id, {"amount": amount})
    return {"ok": True, "balance": balance, "message": "Balance topped up."}


def resolve_gap(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE knowledge_gaps SET status='answered', answer=:answer WHERE id=:id AND tenant_id=:t",
            answer=js_sql_param(arg(args, "answer")),
            id=js_sql_param(arg(args, "gapId")),
            t=_tenant(session),
        )
    return {"ok": True, "message": "Marked as answered."}


def ignore_gap(session: Session, args: dict[str, Any]) -> dict[str, Any]:
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE knowledge_gaps SET status='ignored' WHERE id=:id AND tenant_id=:t",
            id=js_sql_param(arg(args, "gapId")),
            t=_tenant(session),
        )
    return {"ok": True, "message": "Dismissed."}
