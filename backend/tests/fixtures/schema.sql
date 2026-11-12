-- Structure of data/ovoz.db (no data), dumped from the live database.
-- The schema is still created by the TypeScript migrations in src/lib/db.ts;
-- applied migrations at dump time: 001_core, 002_wallet, 003_speech_tests, 004_custom_voices, 005_agent_target, 006_model_lab, 007_llm_choice, 008_benchmark, 009_single_admin, 010_agent_tts

CREATE TABLE _migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
  );

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
    , target_json TEXT NOT NULL DEFAULT '{}', llm_model TEXT NOT NULL DEFAULT '', tts_engine TEXT NOT NULL DEFAULT '', tts_voice_id TEXT NOT NULL DEFAULT '');

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

CREATE TABLE benchmark_runs (
      build       TEXT PRIMARY KEY,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running'   -- running | done | partial
    );

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
    , tokens_in INTEGER, tokens_out INTEGER);

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

CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id  TEXT NOT NULL,
      user_agent TEXT,
      ip         TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

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
    , balance_uzs INTEGER NOT NULL DEFAULT 0);

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

CREATE TABLE wallet_ledger (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,               -- topup | debit
      amount_uzs    INTEGER NOT NULL,
      balance_after INTEGER,
      note          TEXT,
      created_at    TEXT NOT NULL
    );

CREATE TABLE webhooks (
      id         TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      events     TEXT NOT NULL DEFAULT 'call.completed',
      secret     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

CREATE INDEX idx_agents_tenant ON agents(tenant_id);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);

CREATE INDEX idx_benchmark_results ON benchmark_results(kind, engine, id);

CREATE INDEX idx_calls_status ON calls(tenant_id, status);

CREATE INDEX idx_calls_tenant ON calls(tenant_id, started_at DESC);

CREATE INDEX idx_chunks_doc ON chunks(document_id, ordinal);

CREATE INDEX idx_chunks_tenant ON chunks(tenant_id);

CREATE INDEX idx_custom_voices_tenant ON custom_voices(tenant_id, created_at DESC);

CREATE INDEX idx_documents_tenant ON documents(tenant_id, created_at DESC);

CREATE INDEX idx_esc_tenant ON escalations(tenant_id, status);

CREATE INDEX idx_gaps_tenant ON knowledge_gaps(tenant_id, hits DESC);

CREATE INDEX idx_invoices_tenant ON invoices(tenant_id, period DESC);

CREATE INDEX idx_keys_tenant ON api_keys(tenant_id);

CREATE INDEX idx_lab_clips_tenant ON lab_clips(tenant_id, created_at DESC);

CREATE INDEX idx_lab_runs_clip ON lab_runs(clip_id, engine, created_at DESC);

CREATE INDEX idx_lab_runs_tenant ON lab_runs(tenant_id, kind, created_at DESC);

CREATE INDEX idx_model_usage_time ON model_usage(source, created_at);

CREATE INDEX idx_numbers_tenant ON phone_numbers(tenant_id);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE INDEX idx_speech_tests_tenant ON speech_tests(tenant_id, created_at DESC);

CREATE INDEX idx_turns_call ON turns(call_id, ordinal);

CREATE UNIQUE INDEX idx_usage_day ON usage_daily(tenant_id, day);

CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE INDEX idx_wallet_tenant ON wallet_ledger(tenant_id, created_at DESC);

