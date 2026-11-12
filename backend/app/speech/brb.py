"""
BRB speech proxy — our own TTS (and, later, STT) models behind the "TTS/STT
Proxy API" (BRB_SPEECH_URL, reachable through the BRB VPN). Port of
src/lib/speech/brb.ts.

    POST /auth/login   {login, password}   → {access_token, refresh_token}
    POST /auth/refresh {refresh_token}     → a new pair
    POST /tts/speech   {input} + Bearer    → the whole WAV (no streaming)

The account (BRB_SPEECH_LOGIN / BRB_SPEECH_PASSWORD) has a request limit and
the proxy stores every input, so text goes one sentence at a time (`tts`
caches renders on disk: a fixed line costs one request ever). Tokens live in
memory: renewed shortly before they expire, renewed once on a 401, and the
login repeated when the refresh token is no longer accepted.
"""

import asyncio
import base64
import json
import logging
import math
import time
from dataclasses import dataclass

import regex as re

from app import http
from app.env import env, env_raw
from app.jscompat import js_json, js_trim
from app.streams import error_body

log = logging.getLogger("callmind.brb")

LOGIN_TIMEOUT_S = 10.0
SPEECH_TIMEOUT_S = 30.0
EARLY_S = 60.0  # renew this long before the access token's `exp`


class BrbError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _base() -> str:
    return re.sub(r"/+$", "", js_trim(env("BRB_SPEECH_URL")))


def brb_configured() -> bool:
    return bool(_base() and js_trim(env("BRB_SPEECH_LOGIN")) and env("BRB_SPEECH_PASSWORD"))


# ── tokens ──────────────────────────────────────────────────────────


@dataclass
class _Tokens:
    access: str
    refresh: str
    renew_at: float  # epoch seconds; inf when the token carries no `exp`


_tokens: _Tokens | None = None
_pending: asyncio.Future | None = None


def _expires_at(jwt: str) -> float | None:
    """The `exp` claim of a JWT (epoch seconds), or None. The signature is the proxy's business."""
    try:
        part = jwt.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    return float(exp) if isinstance(exp, (int, float)) and not isinstance(exp, bool) else None


def _to_tokens(data: object) -> _Tokens:
    access = data.get("access_token") if isinstance(data, dict) else None
    if not isinstance(access, str) or not access:
        raise BrbError("brb_auth_failed")
    refresh = data.get("refresh_token")
    exp = _expires_at(access)
    return _Tokens(access, refresh if isinstance(refresh, str) else "", math.inf if exp is None else exp - EARLY_S)


async def _post(path: str, body: object, timeout: float, token: str | None = None):  # noqa: ANN202
    headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})}
    async with asyncio.timeout(timeout):
        res = await http.client().post(f"{_base()}{path}", headers=headers, content=js_json(body).encode())
        await res.aread()
    return res


async def _login() -> _Tokens:
    res = await _post(
        "/auth/login",
        {"login": js_trim(env("BRB_SPEECH_LOGIN")), "password": env_raw("BRB_SPEECH_PASSWORD") or ""},
        LOGIN_TIMEOUT_S,
    )
    if not res.is_success:
        log.warning("[brb] login %s: %s", res.status_code, res.text[:160])
        raise BrbError("brb_auth_failed", 503 if res.status_code in (401, 403) else 502)
    return _to_tokens(res.json())


async def _renew(current: _Tokens | None) -> _Tokens:
    """A new pair from the refresh token, or a fresh login when that is refused."""
    if current and current.refresh:
        try:
            res = await _post("/auth/refresh", {"refresh_token": current.refresh}, LOGIN_TIMEOUT_S)
        except Exception:  # noqa: BLE001 - fall back to logging in
            res = None
        if res is not None and res.is_success:
            return _to_tokens(res.json())
    return await _login()


async def _access_token(stale: str | None = None) -> str:
    """A usable access token; `stale` is one the proxy just refused. One renewal at a time."""
    global _tokens, _pending
    if _tokens and _tokens.access != stale and time.time() < _tokens.renew_at:
        return _tokens.access
    if _pending is None:
        current = _tokens

        async def renew() -> _Tokens:
            global _tokens, _pending
            try:
                _tokens = await _renew(current)
                return _tokens
            finally:
                _pending = None

        _pending = asyncio.ensure_future(renew())
    return (await asyncio.shield(_pending)).access


def reset() -> None:
    """Forget the tokens (tests)."""
    global _tokens, _pending
    _tokens = None
    _pending = None


# ── speech ──────────────────────────────────────────────────────────


async def brb_speech(text: str) -> bytes:
    """
    Render one piece of text (already in spoken form) → the WAV the proxy returns. Raises
    BrbError: `brb_limit` when the account's limit is reached (429), `brb_<status>` otherwise.
    """
    if not brb_configured():
        raise BrbError("brb_not_configured", 503)
    token = await _access_token()
    res = await _post("/tts/speech", {"input": text}, SPEECH_TIMEOUT_S, token)
    if res.status_code == 401:
        # Expired or revoked early: renew once and try again.
        token = await _access_token(token)
        res = await _post("/tts/speech", {"input": text}, SPEECH_TIMEOUT_S, token)
    if not res.is_success:
        log.warning("[brb] tts %s: %s", res.status_code, await error_body(res, 200))
        raise BrbError(
            "brb_limit" if res.status_code == 429 else f"brb_{res.status_code}", 429 if res.status_code == 429 else 502
        )
    if not res.content:
        raise BrbError("brb_empty_audio")
    return res.content
