"""Website knowledge and goal-led calls.

  knowledge_pages   one row per page imported from a website (the BRB scraper):
                    which document it became, its URL, group, language and the
                    content fingerprint used to skip unchanged pages.
  knowledge_groups  the groups ("shelves") a tenant's pages are sorted into, with
                    the description and keywords used to route a question.
  call_results      what an agent with a goal collected during a call.
  agents.goal_json  an agent's call goal ('{}' = none, behaves as before).

Only adds; no existing column or table changes, so the Next.js app keeps working
against the same database.

Revision ID: 0002_website_knowledge
Revises: 0001_baseline
Create Date: 2026-11-23
"""

from alembic import op

revision = "0002_website_knowledge"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE knowledge_pages (
            document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
            tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            url          TEXT NOT NULL,
            site         TEXT NOT NULL,
            grp          TEXT NOT NULL,
            lang         TEXT NOT NULL,
            kind         TEXT NOT NULL DEFAULT 'page',
            fingerprint  TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX idx_kpages_url ON knowledge_pages(tenant_id, url)")
    op.execute("CREATE INDEX idx_kpages_group ON knowledge_pages(tenant_id, grp, lang)")
    op.execute(
        """
        CREATE TABLE knowledge_groups (
            tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            id            TEXT NOT NULL,
            title         TEXT NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            keywords_json TEXT NOT NULL DEFAULT '[]',
            updated_at    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE call_results (
            call_id    TEXT PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
            tenant_id  TEXT NOT NULL,
            agent_id   TEXT,
            data_json  TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        )
        """
    )
    op.execute("ALTER TABLE agents ADD COLUMN goal_json TEXT NOT NULL DEFAULT '{}'")


def downgrade() -> None:
    op.execute("DROP TABLE call_results")
    op.execute("DROP TABLE knowledge_groups")
    op.execute("DROP INDEX idx_kpages_group")
    op.execute("DROP INDEX idx_kpages_url")
    op.execute("DROP TABLE knowledge_pages")
    op.execute("ALTER TABLE agents DROP COLUMN goal_json")
