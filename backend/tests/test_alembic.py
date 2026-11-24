"""Alembic runs against the shared schema and only ever adds to it."""

from pathlib import Path

from alembic import command
from alembic.config import Config

BACKEND = Path(__file__).resolve().parents[1]
NEW_TABLES = {"knowledge_pages", "knowledge_groups", "call_results"}
NEW_AGENT_COLUMNS = ("goal_json", "knowledge_tenant_id")


def _tables(sql) -> dict[str, str]:
    return dict(
        sql("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'alembic_version' ORDER BY name")
    )


def test_baseline_stamp_and_upgrade_only_add(data_dir, sql):
    """The baseline changes nothing; later revisions add tables and agent columns, never alter old ones."""
    before = _tables(sql)
    config = Config(str(BACKEND / "alembic.ini"))
    command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")
    after = _tables(sql)
    assert set(after) - set(before) == NEW_TABLES
    for name, ddl in before.items():
        if name == "agents":
            assert all(col in after[name] for col in NEW_AGENT_COLUMNS)
        else:
            assert after[name] == ddl, name
    assert sql("SELECT version_num FROM alembic_version") == [("0003_shared_knowledge",)]

    command.downgrade(config, "0001_baseline")
    assert set(_tables(sql)) == set(before)
    assert not any(col in _tables(sql)["agents"] for col in NEW_AGENT_COLUMNS)
