# CallMind backend (FastAPI)

The Python backend. It takes over the Next.js app's server code one area at a
time (plan: `docs/architecture/platform-architecture.md`); the Next.js app
stays as the web UI.

## How it is wired

- Runs on **127.0.0.1:8100** only (systemd user service `callmind-api.service`).
- The browser never calls it directly. Next.js forwards **`/api/core/*`** here
  (`rewrites` in `next.config.ts`), so `/api/core/me` → `GET /me`.
- **Same login** as the web app: it reads the `ovoz_session` cookie and checks
  it exactly like `src/lib/auth.ts` (same `OVOZ_SESSION_SECRET` from `.env`).
- **Same database**: `data/ovoz.db` (SQLite, WAL), shared with Next.js while
  both run. Do not change the schema from TypeScript any more; write an Alembic
  migration here instead.

## Develop

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -e ".[dev,zipformer]"
.venv/bin/pytest                  # tests use a throwaway copy of the schema, never data/ovoz.db
.venv/bin/ruff check .
.venv/bin/uvicorn app.main:app --reload --port 8100   # local run, against data/ovoz.db
```

Set `API_DOCS=true` in your shell to get interactive docs at http://127.0.0.1:8100/docs.

## Layout

| Path | What |
|---|---|
| `app/main.py` | FastAPI app; mounts the routers |
| `app/config.py` | Settings from the environment / repo `.env` |
| `app/db.py` | Shared SQLite access: `connect()`, `transaction()`, `fetch_one/fetch_all/execute` with `:named` params |
| `app/auth.py` | Session cookie, roles (`LoggedIn`, `require_role("admin")`), API keys, password hashes |
| `app/ids.py` | IDs (`agt_…`) and timestamps in the TypeScript formats |
| `app/jscompat.py` | Where Python and JavaScript differ (string length, rounding, `Math.log`, `JSON.stringify`, …) |
| `app/env.py` | Provider keys and URLs, read like `process.env` (falls back to the repo `.env`) |
| `app/http.py` | One shared HTTP client for outside services (connections stay open between turns) |
| `app/registry.py`, `app/usage_log.py` | Every STT/TTS/LLM engine with its price; one `model_usage` row per use |
| `app/rag/` | Knowledge-base search: text folding, embeddings (local, or OpenAI), chunking, ranking |
| `app/llm/` | Answers: prompts, Gemini / Claude (SDK) / OpenAI / Ollama with streaming, the Claude Haiku fallback, the local engine, the loan-call identity check and calendar |
| `app/speech/` | STT (Kotib, Whisper, GAPI, Zipformer, Speko gemini-3.5 / Scribe, Gemini), TTS (own server, ElevenLabs via Speko) with the shared disk cache, number words, spoken-form text |
| `app/engine/` | The turn (`run_turn`), call start / end / billing, the live event bus |
| `app/playground.py`, `app/playground_voice.py` | The Playground call: opening line, fillers, voicing a reply while it is written |
| `app/routers/` | One router per area (`system.py` today) |
| `alembic/` | Schema migrations from now on (baseline `0001_baseline` = today's schema) |
| `tests/` | pytest; `fixtures/schema.sql` is the database structure without data; `fixtures/golden_*.json` are outputs of the original TypeScript the Python must reproduce exactly |
| `deploy/callmind-api.service` | systemd unit |

## Endpoints so far

| Through the site | Here | |
|---|---|---|
| `/api/core/healthz` | `GET /healthz` | process is up |
| `/api/core/readyz` | `GET /readyz` | database, schema and session secret OK |
| `/api/core/me` | `GET /me` | logged-in user and company |
| `/api/core/diagnostics/ndjson`, `/sse` | `GET /diagnostics/…` | streaming checks (login required) |

## Deploy (on the server)

```bash
cd ~/callmind/backend && python3 -m venv .venv && .venv/bin/pip install -e ".[zipformer]"
.venv/bin/alembic stamp 0001_baseline          # once: marks the existing database
cp deploy/callmind-api.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now callmind-api.service
curl -s http://127.0.0.1:8100/readyz
```

## Parity with the TypeScript

Ported code must behave exactly like the TypeScript it replaces: both apps share
the database and the TTS cache, and callers must not notice which one answered.
The `golden_*.json` fixtures were recorded by running the original TypeScript on
fixed inputs (with scripted provider responses for the LLM, TTS and STT
clients); the `test_*_parity.py` tests replay the same inputs in Python and
compare requests, prompts, streamed pieces, answers, rows written and events.
