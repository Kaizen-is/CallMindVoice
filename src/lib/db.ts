/**
 * Ovoz AI — persistence layer.
 *
 * Backed by node:sqlite (Node ≥22.5), so the platform runs with zero native
 * build steps and zero external services while still being a real relational
 * database with transactions, indexes and foreign keys.
 *
 * Every tenant-scoped table carries `tenant_id`. Reads go through the helpers in
 * `src/lib/tenancy.ts`, which refuse to build a query without one.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'ovoz.db');

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

let _db: DatabaseSync | null = null;

/** Migration statements, applied in order and recorded in `_migrations`. */
const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_core',
    sql: `
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
      locale        TEXT NOT NULL DEFAULT 'en',
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
      locale        TEXT NOT NULL DEFAULT 'en',
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
    `,
  },
];

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        m.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function db(): DatabaseSync {
  if (_db) return _db;
  ensureDirs();
  const handle = new DatabaseSync(DB_PATH);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  migrate(handle);
  _db = handle;
  return handle;
}

/* ── typed query helpers ─────────────────────────────────────── */

type Param = string | number | bigint | null | Uint8Array;

function normalise(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Uint8Array) return p;
    if (typeof p === 'number' || typeof p === 'bigint' || typeof p === 'string') return p;
    return JSON.stringify(p);
  });
}

/**
 * node:sqlite hands back null-prototype objects. React refuses to serialise
 * those across the server/client boundary, so every row is re-homed onto a
 * plain object on the way out. Cheap, and it removes a whole class of
 * "Only plain objects can be passed to Client Components" failures.
 */
function plain<T>(row: unknown): T {
  return Object.assign({}, row) as T;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return (db().prepare(sql).all(...normalise(params)) as unknown[]).map((r) => plain<T>(r));
}

export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  const row = db().prepare(sql).get(...normalise(params));
  return row === undefined || row === null ? undefined : plain<T>(row);
}

export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...normalise(params));
}

export function tx<T>(fn: () => T): T {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/* ── id + time ───────────────────────────────────────────────── */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function id(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const now = () => new Date().toISOString();

export function isSeeded(): boolean {
  const row = get<{ c: number }>('SELECT COUNT(*) AS c FROM tenants');
  return (row?.c ?? 0) > 0;
}
