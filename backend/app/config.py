"""
Settings, read from the environment and the repository's `.env` — the same
file the Next.js app and its systemd service use, so both apps always agree
on secrets, keys and paths.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py → the repository root (where `.env` and `data/` live).
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    # Where the shared SQLite database, uploads and TTS cache live (`data/` in the repo).
    callmind_data_dir: Path = REPO_ROOT / "data"

    # Signs the `ovoz_session` cookie; must be the Next.js app's value.
    ovoz_session_secret: str | None = None

    # Interactive API docs at /docs. Off in production: the API is reachable
    # from the internet through the Next.js rewrite.
    api_docs: bool = False

    @property
    def db_path(self) -> Path:
        return self.callmind_data_dir / "ovoz.db"


@lru_cache
def get_settings() -> Settings:
    return Settings()
