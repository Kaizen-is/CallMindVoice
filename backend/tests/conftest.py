"""
Test fixtures: every test gets its own throwaway database built from the real
schema (`fixtures/schema.sql`, dumped from data/ovoz.db without data), so tests
never touch the live database.
"""

import os
import sqlite3
from collections.abc import Iterator
from pathlib import Path

# Never read the developer's real .env (API keys) in tests.
os.environ["CALLMIND_DOTENV"] = "0"

import pytest
from fastapi.testclient import TestClient

FIXTURES = Path(__file__).parent / "fixtures"
SECRET = "test-secret-öçü-2026"  # same secret as the TypeScript reference values in test_auth_parity.py


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    con = sqlite3.connect(tmp_path / "ovoz.db")
    con.executescript((FIXTURES / "schema.sql").read_text(encoding="utf-8"))
    con.execute("INSERT INTO _migrations (id, applied_at) VALUES ('010_agent_tts', '2026-11-12T00:00:00.000Z')")
    con.commit()
    con.close()

    monkeypatch.setenv("CALLMIND_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("OVOZ_SESSION_SECRET", SECRET)
    _reset_caches()
    yield tmp_path
    _reset_caches()


def _reset_caches() -> None:
    from app.config import get_settings
    from app.db import get_engine

    get_settings.cache_clear()
    get_engine.cache_clear()


@pytest.fixture
def client(data_dir: Path) -> TestClient:
    from app.main import create_app

    return TestClient(create_app())


@pytest.fixture
def sql(data_dir: Path):
    """Run SQL directly against the test database."""

    def run(statement: str, *params) -> list[tuple]:
        con = sqlite3.connect(data_dir / "ovoz.db")
        try:
            rows = con.execute(statement, params).fetchall()
            con.commit()
            return rows
        finally:
            con.close()

    return run


PROVIDER_ENV = (
    "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_STT_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY",
    "OPENAI_MODEL", "OPENAI_BASE_URL", "OPENAI_TIMEOUT_MS", "OPENAI_EMBEDDING_MODEL", "OLLAMA_BASE_URL", "OLLAMA_MODEL",
    "OLLAMA_API_KEY", "OLLAMA_KEEP_ALIVE", "OLLAMA_TIMEOUT_MS", "LLM_PROVIDER", "LLM_FALLBACK_MODEL", "TTS_BASE_URL",
    "TTS_CLIENT_ID", "TTS_CLIENT_SECRET", "TTS_JWT_TOKEN", "TTS_STREAM_CHUNK_SEC", "SPEKO_API_KEY", "SPEKO_BASE_URL",
    "SPEKO_TTS_VOICE", "STT_TRANSCRIBE_URL", "WHISPER_TRANSCRIBE_URL", "WHISPER_MODEL", "WHISPER_API_KEY",
    "GAPI_API_KEY", "GAPIAPI", "GAPI_BASE_URL", "DENOISE_URL", "ZIPFORMER_MODEL_DIR", "BRB_SPEECH_URL",
    "BRB_SPEECH_LOGIN", "BRB_SPEECH_PASSWORD", "BRB_STT_URL", "BRB_STT_MODEL",
)  # fmt: skip


@pytest.fixture(autouse=True)
def _clean_providers(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No provider is configured unless a test says so; module caches start empty."""
    for key in PROVIDER_ENV:
        monkeypatch.delenv(key, raising=False)
    _reset_provider_state()
    yield
    _reset_provider_state()


def _reset_provider_state() -> None:
    from app import http
    from app.llm import claude
    from app.speech import brb, tts

    brb.reset()
    http.set_transport(None)
    claude._client = None
    claude._client_key = None
    tts._token = None
