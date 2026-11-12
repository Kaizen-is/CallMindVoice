"""
IDs and timestamps in exactly the formats the TypeScript code writes
(`src/lib/db.ts`), so rows written by either app look the same.
"""

import secrets
from datetime import UTC, datetime

_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"


def new_id(prefix: str) -> str:
    """`<prefix>_` + 16 characters from 0-9a-z (a random byte modulo 36, as in db.ts)."""
    return f"{prefix}_" + "".join(_ALPHABET[b % 36] for b in secrets.token_bytes(16))


def now_iso() -> str:
    """JavaScript's `new Date().toISOString()`: UTC, milliseconds, `Z` — e.g. 2026-11-12T07:01:54.123Z."""
    return to_iso(datetime.now(UTC))


def to_iso(moment: datetime) -> str:
    moment = moment.astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_iso(value: str) -> datetime:
    """Parse a timestamp the TypeScript code wrote (`...Z`)."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
