"""
Alembic: schema changes for the database, written here. The original schema
(001_core … 010_agent_tts) is applied by app/schema.py when the API starts;
revisions build on `0001_baseline`. Plain SQL via `op.execute` / `op.add_column`.
"""

from alembic import context

from app.db import get_engine


def run_migrations() -> None:
    with get_engine().connect() as connection:
        # SQLite can't ALTER most things in place; batch mode copies the table instead.
        context.configure(connection=connection, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations()
