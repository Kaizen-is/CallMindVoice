"""Baseline: the schema as the TypeScript migrations left it (001_core … 010_agent_tts).

Nothing to create — the tables already exist in data/ovoz.db. Mark an existing
database as being at this revision once, with:

    .venv/bin/alembic stamp 0001_baseline

That only adds Alembic's own `alembic_version` table. Later schema changes are
new revisions on top of this one (`.venv/bin/alembic revision -m "..."`).

Revision ID: 0001_baseline
Revises:
Create Date: 2026-11-12
"""

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
