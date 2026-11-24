"""An agent can read its knowledge from a shared library company.

  agents.knowledge_tenant_id  the company whose knowledge base the agent searches;
                              '' = its own (as before). Honoured only when that
                              company is marked as a shared library
                              (tenants.settings_json "sharedLibrary": true), so a
                              wrong value can never read another customer's documents.

Lets every company have the BRB website agents while the website pages stay in
one place (the "BRB — website agents" company). Only adds a column.

Revision ID: 0003_shared_knowledge
Revises: 0002_website_knowledge
Create Date: 2026-11-24
"""

from alembic import op

revision = "0003_shared_knowledge"
down_revision = "0002_website_knowledge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE agents ADD COLUMN knowledge_tenant_id TEXT NOT NULL DEFAULT ''")


def downgrade() -> None:
    op.execute("ALTER TABLE agents DROP COLUMN knowledge_tenant_id")
