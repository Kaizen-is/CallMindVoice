# CallMind backend (FastAPI)

All of CallMind's server code: calls, the turn engine, speech, knowledge base,
console data and actions, login, the public API and the phone line. The Next.js
app (`src/`) is only the web UI: pages and components, plus thin server-action
proxies (`src/app/actions/*.ts` → `POST /actions/<name>`) and `src/lib/core.ts`,
the client that calls this API.

## How it is wired

- Runs on **127.0.0.1:8100** only (systemd user service `callmind-api.service`).
- The browser never calls it directly. Next.js forwards **`/api/core/*`** here, and
  the original public paths too (`pythonRoutes` in `next.config.ts`: `/api/playground/*`,
  `/api/speech/{live,tts,stt}`, `/api/models/stt`, `/api/telephony/*`, `/api/demo/*`,
  `/api/logistics/*`, `/api/stream`, `/api/v1/*`), so `/api/demo/call` → `POST /demo/call`.
- Pages read their data with `coreGet('/views/<page>')`; server actions forward with
  `corePost('/actions/<name>', {...})`. Both carry the visitor's cookie, address and
  user agent, so role checks and audit rows happen here.
- **Login**: the `ovoz_session` cookie (`OVOZ_SESSION_SECRET`, or `data/.secret`,
  created on a fresh install). The site asks `GET /session` who is signed in.
- **Database**: `data/ovoz.db` (SQLite, WAL). At start, `app/schema.py` applies the
  original migrations a database has not had yet (a fresh install gets every table);
  later schema changes are Alembic revisions in `alembic/`.
- **Phone line**: `telephony-bridge/bridge.py` (Asterisk AudioSocket ↔ this API,
  `callmind-bridge.service`) calls `/api/telephony/bridge/{turn,filler,end}` with
  the `x-bridge-secret` header.

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
`test_bridge.py` runs the bridge against a simulated Asterisk with 20 ms timing; on a
busy machine run it on its own.

## Layout

| Path | What |
|---|---|
| `app/main.py` | FastAPI app; mounts every router in `app/routers/`; at start: schema, then the deploy benchmark |
| `app/schema.py` | The original ten migrations (001_core … 010_agent_tts), applied at start as the TypeScript did |
| `app/config.py` | Settings from the environment / repo `.env` |
| `app/db.py` | SQLite access: `connect()`, `transaction()`, `fetch_one/fetch_all/execute` with `:named` params |
| `app/auth.py` | Session cookie, roles (`LoggedIn`, `require_role("admin")`), API keys, password hashes |
| `app/provision.py` | Sign-up: a new company with its owner, draft agent and simulator number |
| `app/audit.py`, `app/views_common.py` | Audit rows; `js_response` and the conventions shared by views and actions |
| `app/ids.py` | IDs (`agt_…`) and timestamps in the TypeScript formats |
| `app/jscompat.py` | Where Python and JavaScript differ (string length, rounding, `Math.log`, `JSON.stringify`, …) |
| `app/env.py` | Provider keys and URLs, read like `process.env` (falls back to the repo `.env`) |
| `app/http.py` | One shared HTTP client for outside services (connections stay open between turns) |
| `app/registry.py`, `app/usage_log.py` | Every STT/TTS/LLM engine with its price; one `model_usage` row per use |
| `app/rag/` | Knowledge base: text folding, embeddings (local, or OpenAI), chunking, ranking; `ingest.py` (uploads, pages, pasted text, FAQ → indexed chunks); `pdf_text.py` (PDF text laid out exactly as pdf.js/unpdf did, on pdfminer.six) |
| `app/knowledge.py`, `app/starter_packs.py` | The knowledge base's console actions, page data and public API; the starter packs |
| `app/llm/` | Answers: prompts, Gemini / Claude (SDK) / OpenAI / Ollama with streaming, the Claude Haiku fallback, the local engine, the loan-call identity check and calendar |
| `app/speech/` | STT (Kotib, Whisper, GAPI, Zipformer, gemini-3.5, Scribe via Speko, Gemini, BRB Whisper), live words (Zipformer; gemini-3.5-transcribe-live straight from Google, word by word; Scribe v3 Live via Speko), TTS (own server, Gemini 3.8 voices from Google, ElevenLabs via Speko, BRB) with the shared disk cache, number words, spoken-form text. Gemini's speech uses `GEMINI_API_KEY` (`gemini_speech.py`, `gemini_live.py`); Speko renders the same models when Google refuses a request, or for everything with `GEMINI_SPEECH_VIA=speko` |
| `app/engine/` | The turn (`run_turn`, `plan_reply`), the Playground's early start (`early.py`: the answer begins at the caller's 0.35 s pause and is used only when the turn's input is identical), call start / end / billing, the live event bus, the call simulator, demo history |
| `app/telephony.py` | The phone bridge's secret check, which agent answers a dialled number, telephony status |
| `app/playground.py`, `app/playground_voice.py`, `app/playground_chats.py` | The Playground call and its saved chats |
| `app/demo.py`, `app/logistics.py`, `app/logistics_data.py` | The public demos (`/demo`, `/logistics`): per-address limits, demo calls (never billed), the logistics shipment lookup |
| `app/agent_studio.py`, `app/onboarding.py`, `app/bank_agent.py` | Agent studio, onboarding, the bank demo agent |
| `app/operations.py` | Simulator, demo history, escalations and the operator inbox; calls pages |
| `app/dashboards.py`, `app/analytics.py`, `app/workspace.py` | Overview / analytics / numbers / team / settings / developers / billing data and their actions |
| `app/model_lab.py`, `app/custom_voices.py`, `app/benchmark.py` | Model lab, designed / cloned voices, the deploy benchmark (once per site build) |
| `app/routers/` | One router per area (table below) |
| `app/rag/pages.py`, `app/rag/routing.py`, `app/llm/goal_call.py`, `app/brb_setup.py`, `app/default_agents.py` | Website knowledge, grouped search, goal-led calls, the BRB agents (`docs/brb-knowledge-agent.md`) |
| `alembic/` | Schema changes from now on (baseline `0001_baseline` = the state after the ten migrations; `0002_website_knowledge`, `0003_shared_knowledge` add the website-knowledge tables and columns: run `alembic upgrade head`) |
| `tests/` | pytest; `fixtures/schema.sql` is the database structure without data; `fixtures/golden_*.json` are outputs of the original TypeScript the Python must reproduce exactly |
| `deploy/` | systemd units: `callmind-api.service`, `callmind-bridge.service` |

## Endpoints

| Through the site | Here (`app/routers/`) | |
|---|---|---|
| `/api/core/healthz`, `/readyz`, `/me` | `GET …` (`system.py`) | process up; database, schema and session secret OK; logged-in user |
| `/api/core/diagnostics/ndjson`, `/sse` | `GET /diagnostics/…` | streaming checks (login required) |
| (site, `src/lib/auth.ts`) | `GET /session` (`account.py`) | who is signed in: `{user, tenant}` or null |
| (sign-in pages) | `POST /actions/{signIn,signUp,signOut,setLocale,setPublicLocale}Action` | login, sign-up (new company), sign-out, language |
| `/api/playground/{call,turn,end}` | `POST /playground/…` (`playground.py`) | the Playground voice call (NDJSON; `?prefetch=1` → 202: transcribe / take the settled live words and start the answer early; end → 204) |
| `/api/speech/live`, `/api/stream` | `POST /speech/live`, `GET /stream` (`live.py`) | live words (Zipformer, Gemini from Google, Scribe via Speko; ops feed / flush / finish / begin / reset / close); SSE feed of call events (wallboard, inbox) |
| `/api/speech/tts`, `/api/speech/stt`, `/api/models/stt` | `speech.py` | TTS (WAV or 16-bit PCM stream), STT, the STT lab |
| `/api/telephony/bridge/{turn,filler,end}` | `telephony.py` | the phone bridge (`x-bridge-secret`) |
| `/api/demo/{call,turn,end}`, `/api/logistics/{call,turn,end}` | `demo.py`, `logistics.py` | the public demos (no login; per-address limits) |
| `/api/core/playground/{say,scenario,collect}` | `POST /playground/say`, `GET /playground/scenario`, `POST /playground/collect` (`playground_chat.py`) | typed turn for Python-only agents; the tester's role when a goal-led agent calls; what it collected (`call_results`) |
| `/api/core/knowledge/{pages,groups}` | `PUT`/`GET /knowledge/pages`, `POST /knowledge/pages/delete`, `PUT /knowledge/groups` (`website_knowledge.py`) | website page import by URL for the BRB scraper (API key: `write` / `read`) |
| `/api/core/agents/defaults` | `POST /agents/defaults` (`agents.py`) | copies the default BRB agents into the signed-in company once |
| `/api/v1/calls`, `/api/v1/answer`, `/api/v1/documents` | `v1_calls.py`, `knowledge.py` | public API (API key with the right scope) |
| (page data) | `GET /views/<page>` | `console-layout`, `overview`, `analytics`, `numbers`, `team`, `settings`, `developers`, `billing`, `knowledge`, `agent`, `playground`, `onboarding`, `inbox`, `calls`, `calls/<id>`, `live`, `models/lab`, `models/voices`, `dev/{stt,tts,voice-clone,voice-design}`, `demo`, `logistics` |
| (server actions in `src/app/actions/*.ts`) | `POST /actions/<name>` | all 53: agent studio + onboarding + Playground chats (`agent_studio.py`), knowledge (`knowledge.py`), simulator / escalations / inbox (`operations.py`), numbers / team / keys / webhooks / settings / billing / gaps (`workspace_actions.py`), default model + custom voices (`models_voices.py`), login (`account.py`) |

## Deploy (on the server)

First time:

```bash
cd ~/callmind/backend && python3 -m venv .venv && .venv/bin/pip install -e ".[zipformer]"
.venv/bin/alembic stamp 0001_baseline          # once: marks the existing database
cp deploy/callmind-api.service deploy/callmind-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now callmind-api.service
curl -s http://127.0.0.1:8100/readyz
```

The phone bridge switch-over (from the Node `bridge.mjs` to `bridge.py`) and its
rollback are described in `deploy/callmind-bridge.service`.

## Parity with the TypeScript

Ported code behaves exactly like the TypeScript it replaced: callers must not
notice which one answered. The `golden_*.json` fixtures were recorded by running
the original TypeScript on fixed inputs (with scripted provider responses for the
LLM, TTS and STT clients); the `test_*_parity.py` tests replay the same inputs in
Python and compare requests, prompts, streamed pieces, answers, rows written and
events. The TypeScript is no longer in the tree; the generators in
`tools/golden/` run from a checkout that still has it (see the README there).
