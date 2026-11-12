"""
Authentication, compatible with the Next.js app (`src/lib/auth.ts`,
`src/lib/api-auth.ts`), so one login works for both apps during the move.

- Session cookie `ovoz_session` = `<sid>.<base64url(HMAC-SHA256(secret, sid))>`
  (no padding; split at the last dot). The secret is OVOZ_SESSION_SECRET (or
  `data/.secret`), used as UTF-8 text. The session row must exist and not be
  expired; expired rows are deleted when seen. Disabled users are refused.
- Passwords: `scrypt$N$r$p$<salt b64>$<hash b64>` (N=16384, r=8, p=1, 64 bytes).
- API keys: `ovoz_sk_…`, looked up by SHA-256 hex, not revoked, scope-checked.
"""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from app import db
from app.config import get_settings
from app.ids import now_iso, parse_iso

COOKIE = "ovoz_session"

Role = Literal["analyst", "operator", "admin", "owner"]
_RANK: dict[str, int] = {"analyst": 1, "operator": 2, "admin": 3, "owner": 4}

# The user columns the TypeScript app exposes (SafeUser: everything but password_hash).
_SAFE_USER_COLUMNS = (
    "id, tenant_id, email, name, role, avatar_hue, locale, status, presence, last_seen_at, created_at, updated_at"
)


# ── secret ──────────────────────────────────────────────────────────


def session_secret() -> str | None:
    """The cookie-signing secret, or None when neither the env var nor the file exists.

    Unlike the TypeScript code this never creates `data/.secret`: a secret made
    here would not match the Next.js app's, and every login would silently fail.
    """
    settings = get_settings()
    if settings.ovoz_session_secret:
        return settings.ovoz_session_secret
    try:
        return (settings.callmind_data_dir / ".secret").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign(payload: str, secret: str) -> str:
    return _b64url(hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).digest())


def encode_session(session_id: str, secret: str) -> str:
    return f"{session_id}.{sign(session_id, secret)}"


def decode_session(token: str, secret: str) -> str | None:
    """The session id inside a valid cookie value, else None."""
    dot = token.rfind(".")
    if dot < 1:
        return None
    session_id, mac = token[:dot], token[dot + 1 :]
    expected = sign(session_id, secret)
    if len(mac) != len(expected) or not hmac.compare_digest(mac.encode(), expected.encode()):
        return None
    return session_id


# ── passwords ───────────────────────────────────────────────────────


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64)
    return "$".join(["scrypt", "16384", "8", "1", base64.b64encode(salt).decode(), base64.b64encode(derived).decode()])


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        n_i, r_i, p_i = int(n), int(r), int(p)
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt),
            n=n_i,
            r=r_i,
            p=p_i,
            dklen=64,
            maxmem=256 * n_i * r_i,
        )
        expected = base64.b64decode(digest)
        return len(derived) == len(expected) and hmac.compare_digest(derived, expected)
    except (ValueError, TypeError):
        return False


# ── sessions ────────────────────────────────────────────────────────


@dataclass
class Session:
    user: dict[str, Any]
    tenant: dict[str, Any]


def current_session(request: Request) -> Session | None:
    """The logged-in user and tenant for this request, or None. Never raises."""
    token = request.cookies.get(COOKIE)
    secret = session_secret()
    if not token or not secret:
        return None
    session_id = decode_session(token, secret)
    if not session_id:
        return None

    with db.connect() as conn:
        row = db.fetch_one(conn, "SELECT user_id, expires_at FROM sessions WHERE id = :id", id=session_id)
        if row is None:
            return None
        try:
            expired = parse_iso(row["expires_at"]) < datetime.now(UTC)
        except ValueError:
            expired = True
        if expired:
            with db.transaction() as tx:
                db.execute(tx, "DELETE FROM sessions WHERE id = :id", id=session_id)
            return None

        user = db.fetch_one(
            conn,
            f"SELECT {_SAFE_USER_COLUMNS} FROM users WHERE id = :id AND status != 'disabled'",
            id=row["user_id"],
        )
        if user is None:
            return None
        tenant = db.fetch_one(conn, "SELECT * FROM tenants WHERE id = :id", id=user["tenant_id"])
        if tenant is None:
            return None
    return Session(user=user, tenant=tenant)


def require_session(request: Request) -> Session:
    """FastAPI dependency: the logged-in session, or 401."""
    session = current_session(request)
    if session is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    return session


# Use in an endpoint signature: `def handler(session: LoggedIn): ...`
LoggedIn = Annotated[Session, Depends(require_session)]


def can(role: str, minimum: Role) -> bool:
    return _RANK.get(role, 0) >= _RANK[minimum]


def require_role(minimum: Role):
    """FastAPI dependency factory: the session, if its role is at least `minimum`, else 403.

    Use as `session: Annotated[Session, Depends(require_role("admin"))]`.
    """

    def dependency(session: LoggedIn) -> Session:
        if not can(session.user["role"], minimum):
            raise HTTPException(status_code=403, detail="forbidden")
        return session

    return dependency


# ── API keys (public /v1 API) ───────────────────────────────────────


@dataclass
class ApiAuth:
    tenant_id: str
    key_id: str
    scopes: list[str]


def api_key_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ApiKeyError(Exception):
    def __init__(self, status: int, kind: str, message: str):
        super().__init__(message)
        self.status, self.kind, self.message = status, kind, message

    def response(self) -> JSONResponse:
        # Same body as `fail()` in src/lib/api-auth.ts.
        return JSONResponse({"error": {"type": self.kind, "message": self.message}}, status_code=self.status)


def check_api_key(authorization: str | None, scope: Literal["read", "write", "admin"]) -> ApiAuth:
    """Resolve a `Bearer ovoz_sk_…` header and check its scope, like `requireApiKey`."""
    header = (authorization or "").strip()
    parts = header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise ApiKeyError(401, "unauthorized", "Provide an API key as `Authorization: Bearer ovoz_sk_...`.")
    raw = parts[1]
    if not raw.startswith("ovoz_sk_"):
        raise ApiKeyError(401, "unauthorized", "Malformed API key. Keys start with `ovoz_sk_`.")

    with db.connect() as conn:
        key = db.fetch_one(
            conn,
            "SELECT id, tenant_id, scopes FROM api_keys WHERE hash = :hash AND revoked_at IS NULL",
            hash=api_key_hash(raw),
        )
    if key is None:
        raise ApiKeyError(401, "unauthorized", "Invalid or revoked API key.")

    scopes = [s.strip() for s in key["scopes"].split(",") if s.strip()]
    if scope not in scopes:
        raise ApiKeyError(403, "forbidden", f"This API key is missing the `{scope}` scope.")

    # Best-effort last-used stamp, as in the TypeScript code.
    try:
        with db.transaction() as tx:
            db.execute(tx, "UPDATE api_keys SET last_used = :now WHERE id = :id", now=now_iso(), id=key["id"])
    except Exception:  # noqa: BLE001 - bookkeeping must never fail an authorised request
        pass
    return ApiAuth(tenant_id=key["tenant_id"], key_id=key["id"], scopes=scopes)
