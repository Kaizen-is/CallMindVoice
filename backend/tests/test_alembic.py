"""Alembic runs against the shared schema without changing any CallMind table."""

from pathlib import Path

from alembic import command
from alembic.config import Config

BACKEND = Path(__file__).resolve().parents[1]


def test_baseline_stamp_and_upgrade_leave_tables_alone(data_dir, sql):
    before = sql("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
    config = Config(str(BACKEND / "alembic.ini"))
    command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")
    after = sql(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'alembic_version' ORDER BY name"
    )
    assert after == before
    assert sql("SELECT version_num FROM alembic_version") == [("0001_baseline",)]
