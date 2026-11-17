@AGENTS.md

# CallMind — notes for Claude sessions

Start with `docs/handoff.md`: what CallMind is, where it runs, what is done, and the
next steps (deploying the Python-only backend). Backend details:
`backend/README.md`; proving ports identical to the TypeScript:
`backend/tools/golden/README.md`.

Rules:
- Work and commit on `develop`; no new branches. Push only when the user asks.
- Never commit `.env` or print key values; leave `.vscode/` untracked.
- Production (server `10.10.50.4`, `~/callmind`): never run `npm run build` there while
  `callmind.service` runs, except as build-and-restart in one command; restarts are the
  user's. Check builds in a separate copy.
- The edge proxy rejects `POST` with `Content-Type: text/plain`: browser calls send JSON
  or multipart (hang-up beacons: an `application/json` Blob). It also rejects multipart
  fields whose name contains `:` (React's no-JS `$ACTION_n:m` fields); see
  `src/instrumentation-client.ts`. Visitors from the office network skip this filter, so
  test from outside (or through the public address from the server).
- Python ports must behave exactly like the TypeScript: golden fixtures from
  `backend/tools/golden/`, parity tests in `backend/tests/`, JS/Python differences in
  `backend/app/jscompat.py`. Schema changes only as Alembic migrations in `backend/alembic/`.
- Checks before committing: `npm test` (tsc) for the site; `ruff check .`,
  `ruff format --check .` and `pytest` in `backend/`.
