"""
Test fixtures: every test gets its own throwaway database built from the real
schema (`fixtures/schema.sql`, dumped from data/ovoz.db without data), so tests
never touch the live database.
"""

import sqlite3
from collections.abc import Iterator
from pathlib import Path

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
