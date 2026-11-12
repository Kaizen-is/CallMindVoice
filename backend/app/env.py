"""
Provider settings (API keys, URLs, model names) read like `process.env` in the
Next.js app.

The systemd unit loads `.env` into the environment (`EnvironmentFile=`), so in
production this is just `os.environ`. When the API is started by hand, the
repository's `.env` fills in what the environment lacks, as `next dev` does.
Tests set CALLMIND_DOTENV=0 so a developer's real keys never reach them.
"""

import os
from functools import lru_cache

from app.config import REPO_ROOT


@lru_cache
def _dotenv() -> dict[str, str]:
    if os.environ.get("CALLMIND_DOTENV") == "0":
        return {}
    values: dict[str, str] = {}
    try:
        lines = (REPO_ROOT / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def env(name: str, default: str = "") -> str:
    """The variable's value, `default` when unset or empty (like `process.env.X || default`)."""
    value = os.environ.get(name)
    if value is None:
        value = _dotenv().get(name)
    return value if value else default


def env_raw(name: str) -> str | None:
    """The variable as set, including an empty string; None when unset (`process.env.X`)."""
    value = os.environ.get(name)
    return value if value is not None else _dotenv().get(name)
