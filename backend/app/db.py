"""
The shared SQLite database (`data/ovoz.db`).

During the move both apps use the same file, opened the same way as
`src/lib/db.ts`: WAL journal, foreign keys on, a 5 s busy timeout. SQLite
handles two processes on one machine safely in WAL mode.

The schema is NOT created or changed here. It still comes from the TypeScript
migrations; from now on new schema changes are written as Alembic migrations
in `backend/alembic/` instead.

Queries use named parameters (`:tenant_id`), which also work on PostgreSQL
when the database moves.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from typing import Any

from sqlalchemy import Connection, Engine, create_engine, event, text

from app.config import get_settings


@lru_cache
def get_engine() -> Engine:
    path = get_settings().db_path
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False, "timeout": 5},
    )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):  # noqa: ANN001 - SQLAlchemy callback signature
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode = WAL")
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.execute("PRAGMA busy_timeout = 5000")
        cursor.close()

    return engine


@contextmanager
def connect() -> Iterator[Connection]:
    """A connection for reads; writes go through `transaction()`."""
    with get_engine().connect() as conn:
        yield conn


@contextmanager
def transaction() -> Iterator[Connection]:
    """A connection whose statements commit together (or roll back on error)."""
    with get_engine().begin() as conn:
        yield conn


def fetch_one(conn: Connection, sql: str, **params: Any) -> dict[str, Any] | None:
    row = conn.execute(text(sql), params).mappings().first()
    return dict(row) if row is not None else None


def fetch_all(conn: Connection, sql: str, **params: Any) -> list[dict[str, Any]]:
    return [dict(row) for row in conn.execute(text(sql), params).mappings().all()]


def execute(conn: Connection, sql: str, **params: Any) -> int:
    """Run a write; returns the number of rows changed."""
    return conn.execute(text(sql), params).rowcount
