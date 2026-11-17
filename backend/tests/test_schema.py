"""
The schema runner (app/schema.py): the TypeScript app's ten migrations, applied the way
src/lib/db.ts applied them, now when the API starts.
"""

import json
import sqlite3
from pathlib import Path

import pytest

from app import schema

FIXTURES = Path(__file__).parent / "fixtures"
IDS = [migration_id for migration_id, _ in schema.MIGRATIONS]


def _objects(db: Path) -> set[tuple[str, str, str]]:
    con = sqlite3.connect(db)
    try:
        rows = con.execute(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'alembic_version'"
        ).fetchall()
    finally:
        con.close()
    return {(t, n, s or "") for t, n, s in rows}


def test_same_migrations_as_the_typescript():
    """golden_migrations.json was extracted from MIGRATIONS in the former src/lib/db.ts."""
    golden = json.loads((FIXTURES / "golden_migrations.json").read_text(encoding="utf-8"))
    assert [(m["id"], m["sql"]) for m in golden] == schema.MIGRATIONS
    assert IDS[-1] == "010_agent_tts"


def test_fresh_install_gets_the_real_schema(tmp_path: Path):
    """An empty folder ends up with exactly the schema of the real database (fixtures/schema.sql)."""
    db = tmp_path / "data" / "ovoz.db"
    assert schema.migrate(db) == IDS
    assert (tmp_path / "data" / "uploads").is_dir()

    reference = tmp_path / "reference.db"
    con = sqlite3.connect(reference)
    con.executescript((FIXTURES / "schema.sql").read_text(encoding="utf-8"))
    con.close()
    assert _objects(db) == _objects(reference)

    con = sqlite3.connect(db)
    assert [r[0] for r in con.execute("SELECT id FROM _migrations ORDER BY id")] == IDS
    assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    con.close()


def test_up_to_date_database_is_left_alone(tmp_path: Path):
    db = tmp_path / "ovoz.db"
    schema.migrate(db)
    before = _objects(db)
    assert schema.migrate(db) == []
    assert _objects(db) == before


def test_pending_migrations_run_in_order(tmp_path: Path):
    """A database at 008 gets 009 (one login: admintest) and 010 (agent voice columns), as db.ts did."""
    db = tmp_path / "ovoz.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    for migration_id, sql in schema.MIGRATIONS[:8]:
        con.executescript(sql)
        con.execute("INSERT INTO _migrations VALUES (?, '2026-11-01T00:00:00.000Z')", (migration_id,))
    stamp = "2026-11-01T00:00:00.000Z"
    for tid, name in (("ten_small", "Small"), ("ten_big", "Big")):
        con.execute(
            "INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (tid, name, name.lower(), stamp, stamp),
        )
    for uid, tid in (("usr_a", "ten_big"), ("usr_b", "ten_big"), ("usr_c", "ten_small")):
        con.execute(
            """INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'x', 'admin', ?, ?)""",
            (uid, tid, f"{uid}@example.uz", uid, stamp, stamp),
        )
    con.execute(
        "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at)"
        " VALUES ('ses_1', 'usr_a', 'ten_big', ?, ?)",
        (stamp, stamp),
    )
    con.commit()
    con.close()

    assert schema.migrate(db) == ["009_single_admin", "010_agent_tts"]
    con = sqlite3.connect(db)
    assert con.execute("SELECT id, tenant_id, role FROM users").fetchall() == [("usr_admintest", "ten_big", "owner")]
    assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    columns = {r[1] for r in con.execute("PRAGMA table_info(agents)")}
    assert {"tts_engine", "tts_voice_id"} <= columns
    con.close()


def test_failed_migration_rolls_back(tmp_path: Path):
    """010 fails when its column already exists: nothing of it is recorded, and the error surfaces."""
    db = tmp_path / "ovoz.db"
    schema.migrate(db)
    con = sqlite3.connect(db)
    con.execute("DELETE FROM _migrations WHERE id = '010_agent_tts'")
    con.commit()
    con.close()
    with pytest.raises(sqlite3.OperationalError):
        schema.migrate(db)
    con = sqlite3.connect(db)
    assert "010_agent_tts" not in {r[0] for r in con.execute("SELECT id FROM _migrations")}
    assert not con.in_transaction
    con.close()
