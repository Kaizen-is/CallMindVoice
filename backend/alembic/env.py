"""
Alembic: schema changes for the shared database, from now on written here
instead of in the TypeScript migrations (src/lib/db.ts, frozen at
010_agent_tts). Migrations are plain SQL via `op.execute` / `op.add_column`.
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
