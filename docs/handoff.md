# CallMind — handoff (state on 12 Nov 2026)

Read this first when you start a new session (human or Claude). It says what
CallMind is, where it runs, the rules we work by, what is done, and what comes
next. Deeper material:

- `backend/README.md` — the Python backend: layout, endpoints, how to run it.
- `backend/tools/golden/README.md` — how ported code is proven identical to the TypeScript.
- `docs/architecture/platform-architecture.md` — the long-range architecture (voice
  platform, router, runtime). Long; read the section you need.

---

## 1. What CallMind is

A voice AI call platform for companies in Uzbekistan (banking first): an AI agent
answers or makes phone calls in Uzbek, Russian and English, answers from the
company's knowledge base, hands over to a human when needed, and records
everything (calls, transcripts, analytics, billing).

| Part | Where | Notes |
|---|---|---|
| Web app (UI **and** today's backend) | `src/` — Next.js 16 (App Router, server actions) | **Not the Next.js you know**: read `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). |
| Python backend (being moved in) | `backend/` — FastAPI | Takes over the server code step by step (section 4). |
| Phone bridge | `telephony-bridge/` | Asterisk/SIP side; calls `/api/telephony/bridge/*`. |
| Database | `data/ovoz.db` (SQLite, WAL) | Shared by both apps. Schema changes: Alembic in `backend/alembic/` only. |
| Disk TTS cache | `data/tts-cache/<sha1>.pcm` | Shared by both apps (same keys). |
| Uzbek STT model | `models/uzbek-zipformer/` | In git (~70 MB int8 ONNX). |

## 2. Where it runs

**Production**: one Linux server (`10.10.50.4`, Ubuntu 24.04, user `m.jumanazarov`,
code in `~/callmind`, branch `develop`) behind the edge nginx (`10.10.50.10`) →
https://callmind.brb-tech.uz

| systemd **user** service | What | Port |
|---|---|---|
| `callmind.service` | `next start` (the site), `EnvironmentFile=~/callmind/.env` | 9925 |
| `callmind-api.service` | uvicorn `app.main:app` from `backend/.venv` (unit file: `backend/deploy/`) | 127.0.0.1:8100 |

The browser only talks to Next.js; `next.config.ts` forwards `/api/core/*` to the
Python API (`/api/core/me` → `GET /me`), cookie included, streaming unbuffered.

**Deploying** (done by the user, who owns production):

```bash
cd ~/callmind && npm run build && systemctl --user restart callmind.service
```
```bash
systemctl --user restart callmind-api.service
```

Building in the live folder replaces the assets the running site serves, so the
build and the restart must run back to back (one command). Check a build first in
a separate copy of the repo. When `backend/pyproject.toml` dependencies change:
`~/callmind/backend/.venv/bin/pip install -e "backend[zipformer]"` before restarting the API.

**Local (Windows PC)**: see section 7.

## 3. Rules we work by

- **Branch**: work and commit on `develop`; no new branches. **Push only when the
  user asks.**
- **Secrets**: `.env` is never committed (names are in `.env.example`); `.vscode/`
  stays untracked. Never print key values.
- **Production**: never `npm run build` in `~/callmind` while `callmind.service`
  runs, except as the build-and-restart command above; restarts are the user's.
- **Edge proxy**: the edge refuses `POST` with `Content-Type: text/plain` (403).
  Every browser → server call sends JSON or multipart. Server actions are
  relabelled by `src/instrumentation-client.ts`; `sendBeacon`/`keepalive` hang-ups
  must send an `application/json` Blob.
- **Ported code must match the TypeScript exactly** (golden fixtures + parity
  tests; section 5). CI (`.gitlab-ci.yml`) runs `tsc`, `npm audit`, ruff + pytest
  for `backend/`, the build, and an isolated smoke test.
- **Schema**: only via Alembic migrations in `backend/alembic/` (baseline
  `0001_baseline` = the schema of 12 Nov 2026). The TypeScript migrations in
  `src/lib/db.ts` are frozen.

## 4. The move to Python — plan and status

Goal: all server logic in FastAPI (the team knows Python); Next.js stays the UI.
The live site keeps working throughout; each step is built, tested on the site,
then the next.

| Step | What | Status |
|---|---|---|
| 0 | FastAPI skeleton, shared login (`ovoz_session` cookie, same HMAC), shared SQLite, Alembic baseline, `/api/core` rewrite, systemd unit, CI job | **Live** (commit `9a8d024`) |
| 1a | Knowledge search, Uzbek numbers, spoken-form text, intents, local answers, loan identity check + calendar | Done (`92d6bae`, `4ab9069`) — no endpoint yet |
| 1b | STT/TTS engines + disk cache, LLM providers (streaming, Haiku fallback), `run_turn`, calls/billing, bus, Playground voice logic | Done (`51f403e`) — no endpoint yet |
| **1c** | **Playground served by Python behind `?py=1`** | **Next — see below** |
| 2 | Phone bridge + Twilio routes in FastAPI (same paths, `x-bridge-secret`); switch by pointing the bridge's `NEXT_BASE_URL` | |
| 3 | Public demo + logistics (`/api/demo/*`, `/api/logistics/*`, per-IP limits) | |
| 4 | Console areas one by one: each page gets one `GET /api/core/views/<page>` and its server actions become `fetch` calls (agents, knowledge + ingest, calls/inbox/escalations, analytics, team/settings, billing, developers + `/api/v1/*`, models/labs/benchmark) | |
| 5 | Login moves; delete the TypeScript backend (`src/lib/{db,auth,engine,llm,rag,speech,…}`, `src/app/api/*`, `src/app/actions/*`) | |
| later | PostgreSQL; voice roadmap (streaming runtime) in the same Python codebase | |

### Step 1c in detail (the next task)

Serve the Playground's voice call from Python, switchable per browser:

- **Endpoints** (in a new `backend/app/routers/playground.py` etc., all behind `LoggedIn`):
  - `POST /playground/call` — JSON `{agentId, lang, voice, ttsEngine}` → NDJSON
    stream: `call`, then the opening line (`reply`, `audio`…, or `voice:false`), `done`.
    Port of `src/app/api/playground/call/route.ts`.
  - `POST /playground/turn` — multipart `audio` (WAV ≤ 1 400 000 bytes) or `text`,
    `callId`, `lang`, `legacy`, `sttEngine`, `ttsEngine`, `voice`; `?prefetch=1` →
    transcribe now, answer 202. Errors: 400 `bad_audio`, 410 `ended`, 404
    `no_agent`, 409 `busy_call`. Stream: `heard`, `filler`, `reply`/`more`/`audio`,
    `final` with `ms` = `{stt, retrieval, llm, llmFirst, firstSegment, firstAudio,
    fast}`, `detail`, `done`. Port of `src/app/api/playground/turn/route.ts`.
  - `POST /playground/end` — JSON `{callId}` → 204 (`close_playground_call`).
  - `POST /speech/live` — multipart `sid`, `op` (feed|finish|reset|close), `audio`
    (16 kHz PCM) → `{text}`; Zipformer runs in a thread
    (`asyncio.to_thread`). Port of `src/app/api/speech/live/route.ts`.
  - `GET /stream` — SSE from `app.engine.bus`: a `heartbeat` event, then events,
    `: ping` every 25 s.
- All the logic exists already (`app/playground.py`, `app/playground_voice.py` —
  `event_stream`, `SpeakAsWritten`, `voice_pick`, `filler_for`, `heard_in`…,
  `app/engine/conversation.py`). FastAPI multipart needs the `python-multipart`
  package (add to `pyproject.toml`).
- **Client switch**: in `src/app/app/playground/playground.tsx` use
  `/api/core/playground/*` and `/api/core/speech/live` when the page URL has
  `?py=1`; the hang-up goes as `fetch(..., {keepalive: true, body: new Blob([json],
  {type: 'application/json'})})`.
- **Tests**: FastAPI `TestClient` with the fakes in `backend/tests/fakes.py`
  (scripted LLM/TTS/STT), checking the NDJSON event order against the TypeScript
  routes.
- **Deploy**: install the new Python deps into `backend/.venv`, restart
  `callmind-api.service`, rebuild + restart the site (client switch). Then compare
  "You stopped → agent spoke" with and without `?py=1` on the same agent.
- Later in step 1/4: the page-load side effects `closeIdlePlaygroundCalls`
  (console layout) and `ensureBankAgent` (Playground page) move into view
  endpoints; while both backends run, the TypeScript `publish()` should also post
  its events to Python so the live board sees calls from either side.

## 5. How ported code is proven identical

`backend/tests/fixtures/golden_*.json` were recorded by running the **original
TypeScript** (generators in `backend/tools/golden/`, README there). The parity
tests replay the same inputs in Python and compare everything: search scores and
embedding bytes, prompts and request bodies, Claude params, streamed pieces,
answers, usage rows, TTS cache keys, STT engine choice, rows written by
`run_turn`, bus events. Each parity test was also broken on purpose once to be sure
it fails. Zipformer (Python `sherpa-onnx`) gives identical transcripts to the Node
package on the 10 clips in `benchmarks/stt-uz/`, live sessions included.

JavaScript ↔ Python differences that matter are handled in `backend/app/jscompat.py`
(UTF-16 lengths, `Math.round`, JS `\s`/`\b`, V8 `Math.log`, `toFixed`,
`JSON.stringify` numbers, `trim`, truthiness). Python 3.12's `sum()` is compensated,
so ported numeric code uses plain loops.

## 6. Our own models: the BRB speech proxy

`BRB TTS` (engine id `brb`) is our own TTS model behind the BRB "TTS/STT Proxy
API" — `https://tts-stt-proxy-test.brb.uz` (internal IP `172.22.202.1`, only
reachable through the BRB GlobalProtect VPN). Commit `d3fb787`.

- API: `POST /auth/login {login, password}` → `{access_token, refresh_token}`;
  `POST /auth/refresh {refresh_token}`; `POST /tts/speech {input}` + Bearer → the
  whole WAV (no streaming, single voice). The account has a **request limit** and
  the proxy stores every input.
- Code: `src/lib/speech/brb.ts` and `backend/app/speech/brb.py` (same behaviour,
  parity-tested): token renewed before `exp`, renewed once on a 401 (refresh, else
  a new login), `brb_limit` on 429; one sentence per request; the WAV is decoded,
  resampled to the call's rate and cached on disk (key: text + `brb` + rate), so a
  fixed line costs one request ever.
- Where it shows: Playground voice menu (last), TTS lab ("BRB"), agent studio
  (voice model), Models ▸ Voices, model lab; the deploy benchmark renders 3
  sentences with it per deploy. Treated as Uzbek-only (assumption — other
  languages fall back to the browser voice in the Playground).
- `.env`: `BRB_SPEECH_URL`, `BRB_SPEECH_LOGIN`, `BRB_SPEECH_PASSWORD`.
- **Status**: works locally (tested in the TTS lab on a PC with the VPN, 12 Nov).
  **Not usable in production yet**: the server cannot reach `172.22.202.1`. Running
  the VPN on the server was tried and dropped (it would affect other projects on
  the shared server, needs a personal login that expires; the Linux client's login
  to the GlobalProtect portal was also refused with HTTP 512). The clean fix is a firewall route from the
  network admins: **allow 10.10.50.4 → 172.22.202.1:443**, plus one line in the
  server's `/etc/hosts`: `172.22.202.1  tts-stt-proxy-test.brb.uz`. Until then, do
  not deploy `d3fb787` expecting BRB to work there (the option would show and fail).
- **STT** from the same proxy is planned; add it like the TTS (a client in
  `brb.ts`/`brb.py`, an engine in `stt.ts`/`stt.py`, the pickers, parity scenarios).

## 7. Running it locally (Windows)

Prerequisites: Git, Node.js 22 LTS (≥ 22.5), and for the backend Python 3.12.
GlobalProtect connected if you want the BRB model.

```bash
git clone -b develop https://gitlab.brb-tech.uz/Q.Raximov/callmind.git
cd callmind
npm ci
```

1. Put a `.env` next to `package.json` (copy the server's, or fill in
   `.env.example`). `SEED_ADMIN_PASSWORD` is the local admin's password.
2. `npm run dev` → http://localhost:3000.
3. The database is created on the first query: on `/login`, try any email and
   password once (it fails, and `data\ovoz.db` now exists).
4. In a second terminal (in the folder with `package.json`): `npm run seed` —
   creates the bank company and `admintest@callmind.uz`.
5. Log in as `admintest@callmind.uz` / `SEED_ADMIN_PASSWORD`.

The deploy benchmark does not run in `npm run dev` (it would spend the BRB limit).

Python backend (optional locally; the site does not need it until step 1c):

```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -e ".[dev,zipformer]"
.venv\Scripts\pytest
.venv\Scripts\ruff check .
.venv\Scripts\ruff format --check .
.venv\Scripts\uvicorn app.main:app --reload --port 8100
```

Tests never touch `data/ovoz.db` or your `.env` keys (each test gets a throwaway
database; `CALLMIND_DOTENV=0`). With the API running locally, the site's
`/api/core/*` reaches it through the same rewrite (`CORE_API_URL`, default
`http://127.0.0.1:8100`).

## 8. Commits of 12 Nov 2026 (all on `develop`, pushed)

| Commit | What | In production |
|---|---|---|
| `cb8d89e` | Playground latency marks and waterfall, Gemini/Claude streaming, earlier first audio, Claude Haiku fallback, server-action fix for the edge proxy, architecture doc | yes |
| `9a8d024` | FastAPI foundation behind `/api/core` | yes (`callmind-api.service`) |
| `92d6bae`, `4ab9069`, `51f403e` | Python ports (search, text, LLM, speech, turn engine) | code only, no endpoint uses it |
| `d3fb787` | BRB TTS engine (site + backend) | **no** — waits for the network route |

## 9. Open items

1. **Step 1c** (section 4).
2. Ask the network admins for the route to the BRB proxy (section 6), then deploy
   `d3fb787` and run one render on the live site.
3. BRB STT, when the proxy has it. Ask what the limit is (per minute / day /
   characters) and whether there will be a production URL (today's is `-test`).
4. `npm run seed` says "start the app once" but the app only creates the database
   on its first query; make the seed script create it itself.
5. Not confirmed yet: `https://callmind.brb-tech.uz/api/core/me` shows the
   logged-in user (Step 0 check), and the GitLab pipeline of the 12 Nov push.
6. Leftovers on the server only (untracked, can be deleted): `deploy/brb-vpn/`
   (the dropped VPN setup). If the VPN packages were installed there:
   `sudo apt remove openconnect vpnc-scripts`, and remove the
   `tts-stt-proxy-test.brb.uz` line from `/etc/hosts` until the admin route exists.
