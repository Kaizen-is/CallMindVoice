# ruff: noqa: E501 - the migrations are SQL copied verbatim, long lines included
"""
The database schema: the ten migrations the TypeScript app applied on first use
(`MIGRATIONS` in the former src/lib/db.ts, 001_core … 010_agent_tts), copied
verbatim and applied the same way — in order, each in its own transaction, and
recorded in `_migrations` — when the API starts. A fresh install gets the whole
schema; an existing database only gets what it has not had yet (usually nothing).

Later schema changes are Alembic revisions in `backend/alembic/` (baseline
`0001_baseline` = the state after these ten), never new entries here.
`tests/fixtures/golden_migrations.json` is the list extracted from the
TypeScript file; a test keeps this copy equal to it.
"""

import logging
import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI

from app.config import get_settings
from app.ids import now_iso

log = logging.getLogger("callmind.schema")

# fmt: off
MIGRATIONS: list[tuple[str, str]] = [
    (
        "001_core",
        """
    CREATE TABLE tenants (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      industry      TEXT NOT NULL DEFAULT 'other',
      country       TEXT NOT NULL DEFAULT 'UZ',
      timezone      TEXT NOT NULL DEFAULT 'Asia/Tashkent',
      plan          TEXT NOT NULL DEFAULT 'trial',
      plan_started  TEXT,
      trial_ends_at TEXT,
      locale        TEXT NOT NULL DEFAULT 'uz',
      status        TEXT NOT NULL DEFAULT 'active',
      onboarded     INTEGER NOT NULL DEFAULT 0,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email         TEXT NOT NULL,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'owner',   -- owner | admin | operator | analyst
      avatar_hue    INTEGER NOT NULL DEFAULT 210,
      locale        TEXT NOT NULL DEFAULT 'uz',
      status        TEXT NOT NULL DEFAULT 'active',  -- active | invited | disabled
      presence      TEXT NOT NULL DEFAULT 'offline', -- online | away | offline
      last_seen_at  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_users_email ON users(email);
    CREATE INDEX idx_users_tenant ON users(tenant_id);

    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id  TEXT NOT NULL,
      user_agent TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_sessions_user ON sessions(user_id);

    CREATE TABLE agents (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'draft',  -- draft | live | paused
      persona        TEXT NOT NULL DEFAULT 'professional',
      greeting       TEXT NOT NULL DEFAULT '',
      fallback_line  TEXT NOT NULL DEFAULT '',
      instructions   TEXT NOT NULL DEFAULT '',
      languages_json TEXT NOT NULL DEFAULT '["uz","ru","en"]',
      primary_lang   TEXT NOT NULL DEFAULT 'uz',
      voice_id       TEXT NOT NULL DEFAULT 'nilufar',
      speaking_rate  REAL NOT NULL DEFAULT 1.0,
      temperature    REAL NOT NULL DEFAULT 0.3,
      max_turns      INTEGER NOT NULL DEFAULT 24,
      confidence_threshold REAL NOT NULL DEFAULT 0.45,
      escalation_json TEXT NOT NULL DEFAULT '{}',
      hours_json     TEXT NOT NULL DEFAULT '{}',
      tools_json     TEXT NOT NULL DEFAULT '[]',
      version        INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX idx_agents_tenant ON agents(tenant_id);

    CREATE TABLE documents (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      source_type   TEXT NOT NULL,   -- pdf | docx | txt | md | csv | url | faq
      source_ref    TEXT,            -- filename or URL
      byte_size     INTEGER NOT NULL DEFAULT 0,
      language      TEXT NOT NULL DEFAULT 'auto',
      status        TEXT NOT NULL DEFAULT 'queued', -- queued | parsing | chunking | embedding | ready | failed
      progress      REAL NOT NULL DEFAULT 0,
      error         TEXT,
      chunk_count   INTEGER NOT NULL DEFAULT 0,
      token_count   INTEGER NOT NULL DEFAULT 0,
      char_count    INTEGER NOT NULL DEFAULT 0,
      content       TEXT,
      uploaded_by   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX idx_documents_tenant ON documents(tenant_id, created_at DESC);

    CREATE TABLE chunks (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal     INTEGER NOT NULL,
      heading     TEXT,
      text        TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      embedding   BLOB,
      terms_json  TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_chunks_tenant ON chunks(tenant_id);
    CREATE INDEX idx_chunks_doc ON chunks(document_id, ordinal);

    CREATE TABLE phone_numbers (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      e164         TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT '',
      provider     TEXT NOT NULL DEFAULT 'simulator', -- simulator | twilio | sip
      region       TEXT NOT NULL DEFAULT 'Tashkent',
      agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      capabilities TEXT NOT NULL DEFAULT 'voice',
      monthly_cost REAL NOT NULL DEFAULT 3.0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_numbers_tenant ON phone_numbers(tenant_id);

    CREATE TABLE calls (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
      number_id       TEXT REFERENCES phone_numbers(id) ON DELETE SET NULL,
      direction       TEXT NOT NULL DEFAULT 'inbound',
      channel         TEXT NOT NULL DEFAULT 'voice',  -- voice | web | chat
      from_e164       TEXT NOT NULL,
      to_e164         TEXT NOT NULL,
      caller_name     TEXT,
      status          TEXT NOT NULL DEFAULT 'ringing', -- ringing|active|escalating|with_operator|completed|abandoned|failed
      outcome         TEXT,                            -- resolved_by_ai | resolved_by_operator | abandoned | voicemail
      language        TEXT NOT NULL DEFAULT 'uz',
      intent          TEXT,
      sentiment       REAL,
      confidence      REAL,
      csat            INTEGER,
      turns           INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      first_response_ms INTEGER,
      avg_latency_ms  INTEGER,
      p95_latency_ms  INTEGER,
      cost_usd        REAL NOT NULL DEFAULT 0,
      escalated       INTEGER NOT NULL DEFAULT 0,
      escalation_reason TEXT,
      operator_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      summary         TEXT,
      recording_url   TEXT,
      started_at      TEXT NOT NULL,
      answered_at     TEXT,
      ended_at        TEXT
    );
    CREATE INDEX idx_calls_tenant ON calls(tenant_id, started_at DESC);
    CREATE INDEX idx_calls_status ON calls(tenant_id, status);

    CREATE TABLE turns (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      call_id       TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      ordinal       INTEGER NOT NULL,
      role          TEXT NOT NULL,  -- caller | agent | operator | system
      text          TEXT NOT NULL,
      language      TEXT,
      confidence    REAL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      timings_json  TEXT NOT NULL DEFAULT '{}',
      latency_ms    INTEGER,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_turns_call ON turns(call_id, ordinal);

    CREATE TABLE escalations (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      reason      TEXT NOT NULL,
      priority    TEXT NOT NULL DEFAULT 'normal',
      status      TEXT NOT NULL DEFAULT 'waiting', -- waiting | assigned | resolved | missed
      summary     TEXT,
      operator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      waited_ms   INTEGER,
      handled_ms  INTEGER,
      resolution  TEXT,
      notes       TEXT,
      created_at  TEXT NOT NULL,
      assigned_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX idx_esc_tenant ON escalations(tenant_id, status);

    CREATE TABLE api_keys (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      prefix     TEXT NOT NULL,
      hash       TEXT NOT NULL,
      scopes     TEXT NOT NULL DEFAULT 'read',
      last_used  TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX idx_keys_tenant ON api_keys(tenant_id);

    CREATE TABLE webhooks (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      events     TEXT NOT NULL DEFAULT 'call.completed',
      secret     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE audit_log (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      actor_id   TEXT,
      actor_name TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      meta_json  TEXT NOT NULL DEFAULT '{}',
      ip         TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

    CREATE TABLE usage_daily (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      day           TEXT NOT NULL,
      calls         INTEGER NOT NULL DEFAULT 0,
      ai_resolved   INTEGER NOT NULL DEFAULT 0,
      escalated     INTEGER NOT NULL DEFAULT 0,
      abandoned     INTEGER NOT NULL DEFAULT 0,
      minutes       REAL NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0,
      avg_latency_ms INTEGER NOT NULL DEFAULT 0,
      csat_sum      INTEGER NOT NULL DEFAULT 0,
      csat_count    INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_usage_day ON usage_daily(tenant_id, day);

    CREATE TABLE invoices (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period      TEXT NOT NULL,
      plan        TEXT NOT NULL,
      base_usd    REAL NOT NULL DEFAULT 0,
      usage_usd   REAL NOT NULL DEFAULT 0,
      total_usd   REAL NOT NULL DEFAULT 0,
      minutes     REAL NOT NULL DEFAULT 0,
      calls       INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'paid',
      issued_at   TEXT NOT NULL
    );
    CREATE INDEX idx_invoices_tenant ON invoices(tenant_id, period DESC);

    CREATE TABLE knowledge_gaps (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      question   TEXT NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 1,
      best_score REAL NOT NULL DEFAULT 0,
      status     TEXT NOT NULL DEFAULT 'open', -- open | answered | ignored
      answer     TEXT,
      last_seen  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_gaps_tenant ON knowledge_gaps(tenant_id, hits DESC);
    """,
    ),
    (
        "002_wallet",
        """
    ALTER TABLE tenants ADD COLUMN balance_uzs INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE wallet_ledger (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,               -- topup | debit
      amount_uzs    INTEGER NOT NULL,
      balance_after INTEGER,
      note          TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_wallet_tenant ON wallet_ledger(tenant_id, created_at DESC);
    """,
    ),
    (
        "003_speech_tests",
        """
    CREATE TABLE speech_tests (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id    TEXT,
      kind       TEXT NOT NULL,   -- stt | tts
      input      TEXT,
      output     TEXT,
      voice      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_speech_tests_tenant ON speech_tests(tenant_id, created_at DESC);
    """,
    ),
    (
        "004_custom_voices",
        """
    CREATE TABLE custom_voices (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      mode           TEXT NOT NULL,   -- clone | design
      voice_design   TEXT,            -- design mode: attribute string
      ref_audio_path TEXT,            -- clone mode: stored sample (relative to uploads dir)
      ref_text       TEXT,            -- clone mode: exact transcript of the sample
      created_at     TEXT NOT NULL
    );
    CREATE INDEX idx_custom_voices_tenant ON custom_voices(tenant_id, created_at DESC);
    """,
    ),
    (
        "005_agent_target",
        """
    ALTER TABLE agents ADD COLUMN target_json TEXT NOT NULL DEFAULT '{}';
    """,
    ),
    (
        "006_model_lab",
        """
    CREATE TABLE lab_clips (
      id          TEXT PRIMARY KEY,
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id     TEXT,
      audio_path  TEXT NOT NULL,            -- relative to the uploads dir
      duration_ms INTEGER NOT NULL,
      reference   TEXT NOT NULL,            -- the correct text
      language    TEXT NOT NULL DEFAULT 'uz',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_lab_clips_tenant ON lab_clips(tenant_id, created_at DESC);

    CREATE TABLE lab_runs (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      batch_id   TEXT NOT NULL,             -- one Run click
      kind       TEXT NOT NULL,             -- stt | tts
      engine     TEXT NOT NULL,
      voice      TEXT,                      -- tts: the voice id
      clip_id    TEXT,                      -- stt: a saved test phrase, if any
      input      TEXT,                      -- tts: the sentence
      output     TEXT,                      -- stt: transcript; tts: what Zipformer heard back
      reference  TEXT,
      wer        REAL,
      cer        REAL,
      ms         INTEGER,
      first_ms   INTEGER,
      audio_ms   INTEGER,
      cost_usd   REAL,
      ok         INTEGER NOT NULL DEFAULT 1,
      error      TEXT,
      rating     INTEGER,                   -- tts: 1–5 from a listener
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_lab_runs_tenant ON lab_runs(tenant_id, kind, created_at DESC);
    CREATE INDEX idx_lab_runs_clip ON lab_runs(clip_id, engine, created_at DESC);

    CREATE TABLE model_usage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id  TEXT,
      source     TEXT NOT NULL DEFAULT 'live',  -- live | lab
      kind       TEXT NOT NULL,                 -- stt | tts | llm
      engine     TEXT NOT NULL,
      model      TEXT,
      ms         INTEGER NOT NULL,
      first_ms   INTEGER,
      audio_ms   INTEGER,
      chars      INTEGER,
      cost_usd   REAL,
      ok         INTEGER NOT NULL,
      error      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_model_usage_time ON model_usage(source, created_at);
    """,
    ),
    (
        "007_llm_choice",
        """
    ALTER TABLE agents ADD COLUMN llm_model TEXT NOT NULL DEFAULT '';
    ALTER TABLE model_usage ADD COLUMN tokens_in INTEGER;
    ALTER TABLE model_usage ADD COLUMN tokens_out INTEGER;
    """,
    ),
    (
        "008_benchmark",
        """
    CREATE TABLE benchmark_runs (
      build       TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running'   -- running | done | partial
    );
    CREATE TABLE benchmark_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      build      TEXT NOT NULL,
      kind       TEXT NOT NULL,                     -- stt | tts | llm
      engine     TEXT NOT NULL,                     -- engine id, or provider:model for llm
      passed     INTEGER NOT NULL,
      samples    INTEGER NOT NULL,
      latency_ms INTEGER,
      first_ms   INTEGER,
      wer        REAL,
      cer        REAL,
      clarity    REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_benchmark_results ON benchmark_results(kind, engine, id);
    """,
    ),
    (
        "009_single_admin",
        """
    INSERT INTO users (id, tenant_id, email, name, password_hash, role, avatar_hue, locale,
                       status, presence, created_at, updated_at)
    SELECT 'usr_admintest', t.id, 'admintest@callmind.uz', 'Admin', 'scrypt$16384$8$1$xBH2GtL9F+SKdOcksWdlKw==$S+ix4cc/1onsPSsiMHFeNOpAi4yjvdhaNtYE929uo5CXqbuKEH/lzQ1whwndl86wyGffhyBuv0dzr+MO1OJrMA==', 'owner', 210, 'uz',
           'active', 'offline', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM tenants t
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = 'admintest@callmind.uz')
     ORDER BY (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) DESC,
              (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id) DESC, t.created_at ASC
     LIMIT 1;
    UPDATE users
       SET password_hash = 'scrypt$16384$8$1$xBH2GtL9F+SKdOcksWdlKw==$S+ix4cc/1onsPSsiMHFeNOpAi4yjvdhaNtYE929uo5CXqbuKEH/lzQ1whwndl86wyGffhyBuv0dzr+MO1OJrMA==', role = 'owner', status = 'active',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE lower(email) = 'admintest@callmind.uz';
    DELETE FROM users WHERE lower(email) <> 'admintest@callmind.uz';
    DELETE FROM sessions;
    """,
    ),
    (
        "010_agent_tts",
        """
    ALTER TABLE agents ADD COLUMN tts_engine TEXT NOT NULL DEFAULT '';
    ALTER TABLE agents ADD COLUMN tts_voice_id TEXT NOT NULL DEFAULT '';
    """,
    ),
]
# fmt: on

_MIGRATIONS_TABLE = """CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )"""


def migrate(db_path: Path) -> list[str]:
    """Apply the migrations `db_path` has not had yet; returns the ids applied (`migrate` in db.ts)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    (db_path.parent / "uploads").mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=5, isolation_level=None)
    try:
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA busy_timeout = 5000")
        con.execute(_MIGRATIONS_TABLE)
        applied = {row[0] for row in con.execute("SELECT id FROM _migrations")}
        done: list[str] = []
        for migration_id, sql in MIGRATIONS:
            if migration_id in applied:
                continue
            # One script = one transaction: the migration and its `_migrations` row commit together.
            stamp = now_iso()
            script = (
                f"BEGIN;\n{sql}\n"
                f"INSERT INTO _migrations (id, applied_at) VALUES ('{migration_id}', '{stamp}');\nCOMMIT;"
            )
            try:
                con.executescript(script)
            except Exception:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                raise
            done.append(migration_id)
        return done
    finally:
        con.close()


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    applied = migrate(get_settings().db_path)
    if applied:
        log.warning("[schema] applied %s", ", ".join(applied))
    yield


# Mounted in app/main.py before anything else starts; tests build apps without it.
startup_router = APIRouter(lifespan=_lifespan)
