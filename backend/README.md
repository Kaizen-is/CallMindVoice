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
.venv/bin/pip install -e ".[dev]"
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
| `app/routers/` | One router per area (`system.py` today) |
| `alembic/` | Schema migrations from now on (baseline `0001_baseline` = today's schema) |
| `tests/` | pytest; `fixtures/schema.sql` is the database structure without data |
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
cd ~/callmind/backend && python3 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/alembic stamp 0001_baseline          # once: marks the existing database
cp deploy/callmind-api.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now callmind-api.service
curl -s http://127.0.0.1:8100/readyz
```
