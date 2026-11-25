# CallMind — handoff (state on 17 Nov 2026)

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
| Web UI | `src/` — Next.js 16 (App Router) | Pages and components only; server actions are thin proxies to Python (`src/app/actions/`, `src/lib/core.ts`). **Not the Next.js you know**: read `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). |
| Backend (all server code) | `backend/` — FastAPI, Python 3.12 | Calls, turn engine, speech, knowledge base, console data and actions, login, public API, phone line (section 4). |
| Phone bridge | `telephony-bridge/bridge.py` (Python; `bridge.mjs` kept until the server switches) | Asterisk AudioSocket side; calls `/api/telephony/bridge/*`. The only phone path: the unused Twilio webhook was removed on 17 Nov. |
| Database | `data/ovoz.db` (SQLite, WAL) | Created and migrated by the API at start (`backend/app/schema.py`); new schema changes: Alembic in `backend/alembic/` only. |
| Disk TTS cache | `data/tts-cache/<sha1>.pcm` | Written by the API. |
| Uzbek STT model | `models/uzbek-zipformer/` | In git (~70 MB int8 ONNX). |

## 2. Where it runs

**Production**: one Linux server (`10.10.50.4`, Ubuntu 24.04, user `m.jumanazarov`,
code in `~/callmind`, branch `develop`) behind the edge nginx (`10.10.50.10`) →
https://callmind.brb-tech.uz

| systemd **user** service | What | Port |
|---|---|---|
| `callmind.service` | `next start` (the site), `EnvironmentFile=~/callmind/.env` | 9925 |
| `callmind-api.service` | uvicorn `app.main:app` from `backend/.venv` (unit file: `backend/deploy/`) | 127.0.0.1:8100 |

The browser only talks to Next.js; `next.config.ts` forwards `/api/core/*` and the
original API paths (`pythonRoutes`: Playground, speech, telephony, demos, `/api/stream`,
`/api/v1/*`) to the Python API, cookie included, streaming unbuffered. Pages get their
data from Python (`GET /views/<page>`) and every server action forwards to it, so **the
site does not work without `callmind-api.service`** (signed-out pages still render).

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

- **Branch**: `main` is the one shared branch (GitHub `Kaizen-is/CallMindVoice`); work
  on it, or on a short branch per task that is merged into `main` and deleted. **Push
  only when the user asks.**
- **Secrets**: `.env` is never committed (names are in `.env.example`); `.vscode/`
  stays untracked. Never print key values.
- **Production**: never `npm run build` in `~/callmind` while `callmind.service`
  runs, except as the build-and-restart command above; restarts are the user's.
- **Edge proxy**: the edge refuses `POST` with `Content-Type: text/plain` (403).
  Every browser → server call sends JSON or multipart. Server actions are
  relabelled by `src/instrumentation-client.ts`; `sendBeacon`/`keepalive` hang-ups
  must send an `application/json` Blob.
  It also refuses (403) any multipart field whose **name contains a colon**. React adds
  hidden `$ACTION_n:m` fields to forms with a bound or `useActionState` action; the same
  file drops them from server-action requests, the login and signup buttons stay
  disabled until the page has loaded (`useHydrated`), and the language switcher sends
  its language as a plain field. Seen as "This page couldn't load" after pressing
  login on a phone. The office network (192.168.77.x) skips this filter, so check
  from outside — or from the server through `https://callmind.brb-tech.uz`.
- **Ported code must match the TypeScript exactly** (golden fixtures + parity
  tests; section 5). CI (`.gitlab-ci.yml`) runs `tsc`, `npm audit`, ruff + pytest
  for `backend/`, the build, and an isolated smoke test.
- **Schema**: only via Alembic migrations in `backend/alembic/` (baseline
  `0001_baseline` = the schema of 12 Nov 2026). The original ten migrations
  (`001_core` … `010_agent_tts`, from the former `src/lib/db.ts`) are applied by
  `backend/app/schema.py` when the API starts; never add to that list.

## 4. The move to Python — done (17 Nov 2026)

All server code is in FastAPI; Next.js is only the UI. SQLite, the pages and the
components are unchanged. Every step was tested on the site before the next one.
Work is on the local branch `server` of `D:\WORK\callmind-server` (not pushed).

| Phase | What moved to Python | Commits |
|---|---|---|
| 0–1c | Foundation, shared login, ports of search / text / LLM / speech / turn engine, Playground call behind `?py=1` | `9a8d024` … `779f979` |
| 1 | Playground call (`/api/playground/*`), live Zipformer (`/api/speech/live`), TTS / STT (`/api/speech/{tts,stt}`, `/api/models/stt`) at their original paths | `dce03b0` |
| 2 | Phone line: `/api/telephony/bridge/{turn,filler,end}`; the bridge itself as `telephony-bridge/bridge.py` (+ `backend/deploy/callmind-bridge.service`) | `e2147f8` |
| 3 | Public demos `/api/demo/*`, `/api/logistics/*` and their page data | `c47d1d8` |
| 4 | Every console page's data (`GET /views/<page>`) and all 53 server actions; `/api/stream`; public API `/api/v1/*` (calls, answer, documents); knowledge-base ingest (PDF text identical to pdf.js) | `b68a116` … `1377346` |
| 5 | Login / sign-up / sign-out; `src/lib/auth.ts` asks `GET /session`; the TypeScript backend (`src/lib/{db,engine,llm,rag,speech,…}`, every `src/app/api/*` route, `src/instrumentation*.ts`) deleted; schema created by the API at start; benchmark scheduled by the API | `550d18a`, `017dc75` … `d363d06` |

What is left in TypeScript is UI: pages, components, hooks, translations, the
types the pages use (`src/lib/types.ts`), browser helpers (`audio.ts`,
`playground-shared.ts`, `demo-shared.ts`) and the server-action proxies.

**How it was checked**: golden fixtures from the original TypeScript and parity tests
for every area (section 5); side-by-side runs of TypeScript and Python on copies of
the real database (identical results and rows); the TypeScript and Python phone
bridges against a simulated Asterisk call (same requests, byte-identical audio);
then the production build (`next build`) on this PC with only Python behind it:
every page, sign-in / sign-out / sign-up and onboarding, knowledge upload and
retrieval, and the voice checks (TTS, streaming TTS, GAPI, Scribe, a full Playground
call, live Zipformer) — all passing.

**Deploying this** (the user; production is theirs). New Python dependencies
(`pdfminer.six`, `mammoth`, `ada-url`, `python-multipart`, …); npm packages removed
(`@anthropic-ai/sdk`, `mammoth`, `unpdf`). In this order:

```bash
cd ~/callmind && git pull && backend/.venv/bin/pip install -e "backend[zipformer]"
```
```bash
systemctl --user restart callmind-api.service && curl -s http://127.0.0.1:8100/readyz
```
```bash
cd ~/callmind && npm ci && npm run build && systemctl --user restart callmind.service
```
```bash
systemctl --user restart callmind-api.service
```

The API goes first (the new API also serves the old site), then build + restart the
site in one command, then the API once more so it sees the new build id and runs
the deploy benchmark once (`callmind-api.service` now sets `NODE_ENV=production`).
The phone bridge can stay on `bridge.mjs` (same paths, now answered by Python);
switch to `bridge.py` separately with a test call, as described in
`backend/deploy/callmind-bridge.service` (roll back the same way).

**Risks the ports noted** (behaviour kept exactly as the TypeScript had it; worth
fixing later as separate changes): webhook secrets are visible to analysts on the
Developers page; `setMemberStatusAction` signs out sessions without checking the
tenant; the client address falls back to `127.0.0.1` without `x-forwarded-for`;
Python PDF text extraction is 3–4× slower than unpdf (runs off the event loop);
a knowledge term `constructor` makes BM25 NaN for that tenant (JavaScript quirk, kept).

### The phone bridge routes

`/api/telephony/bridge/{turn,filler,end}` are served by `backend/app/routers/telephony.py`
at the same paths the bridge always called (the site forwards them), behind the same
`x-bridge-secret` gate (`BRIDGE_SHARED_SECRET`: unset ⇒ 503, wrong ⇒ 401). The bridge
needs no change: `bridge.mjs` and `bridge.py` both keep calling the site.

- Proven twice: `test_telephony_routes.py`, and `test_bridge_parity.py` — 80 requests
  (`backend/tools/golden/scenarios-bridge.json`) replayed against the recorded TypeScript
  (`fixtures/golden_bridge.json`, `make-golden-bridge.cjs`), comparing every response,
  the calls and turns touched, daily usage, the wallet and escalations. (Two ports of
  these routes were made in parallel on 17 Nov; the merge kept one router and runs
  both test sets against it.)
- JavaScript details reproduced: `Number()` parsing of `spokenRatio` / `i`, the first
  value of a repeated form field or query parameter, JavaScript's `\s` when trimming a
  reply after barge-in, `lines[i % n]` going `undefined` for negative or fractional `i`,
  the ms truncation of the end time, `JSON.parse` refusing `NaN`, a 500 for a `null`
  body or a non-string `callId`.
- `BRIDGE_SHARED_SECRET` is **not set on production** yet, so the phone routes answer
  503 there until it is put in the server `.env` (the API reads the same file).
- Phone calls voice with the own TTS server (`TTS_BASE_URL`). Locally, without it,
  `/filler` answers `503 filler_failed`, exactly like the TypeScript.

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

API guide (endpoints, formats, errors, what is known about limits):
`docs/brb-speech-api.md`.

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
### BRB Whisper STT (through the proxy since 23 Nov)

Our own speech-to-text, engine id `brb` ("BRB Whisper" in the pickers), served by the
**same proxy and account** as BRB TTS: `POST /stt/transcribe`, multipart `file` +
Bearer → `{text}` (Swagger: `https://tts-stt-proxy-test.brb.uz/docs`). No language
field: the model decides. The proxy stores every request too.

- Code: `brb_transcribe` in `backend/app/speech/brb.py` (shares the login and token
  renewal with TTS: renewed once on a 401, `brb_limit` on 429, `brb_stt_<status>`
  otherwise); `_brb_whisper` in `stt.py` sends the utterance as a 16 kHz mono WAV and
  turns spoken numbers into digits. Tests: `backend/tests/test_brb_stt.py`.
- `.env`: nothing new — `BRB_SPEECH_URL`, `BRB_SPEECH_LOGIN`, `BRB_SPEECH_PASSWORD`.
  `BRB_STT_URL` / `BRB_STT_MODEL` are no longer read.
- Replaces the first version (commit `8b424c2`): gRPC straight to Triton at
  `stt-service.brb.uz:443`, which never accepted a connection (TLS reset, see
  `docs/brb-connection-test.txt`). Its code, golden fixture and the `grpcio`
  dependency are removed.
- **Status**: works from a PC on the VPN (23 Nov): BRB TTS sentences, also cut to
  8 kHz like a phone line, came back word for word in about 0.3–0.4 s. Not tried on
  real noisy calls yet. Production needs the same route as BRB TTS (above).

## 7. Running it locally (Windows)

Prerequisites: Git, Node.js 22 LTS (≥ 22.5), and for the backend Python 3.12.
GlobalProtect connected if you want the BRB model.

**Corporate HTTPS inspection**: the office network re-signs TLS with its own CA
("Organization Certificate Authority"). Node does not trust it by default, so every
outside call (Claude, Gemini, ElevenLabs/Speko, BRB) fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` and the Playground silently falls back to the
browser voice / local answers. Fix once per PC: `setx NODE_USE_SYSTEM_CA 1` (new
terminals pick it up), or start the dev server with `NODE_USE_SYSTEM_CA=1`.

```bash
git clone -b develop https://gitlab.brb-tech.uz/Q.Raximov/callmind.git
cd callmind
npm ci
```

1. Put a `.env` next to `package.json` (copy the server's, or fill in
   `.env.example`). `SEED_ADMIN_PASSWORD` is the local admin's password.
2. `npm run dev` → http://localhost:3000.
3. Start the Python API (below); it creates `data\ovoz.db` with every table on start.
4. In a second terminal (in the folder with `package.json`): `npm run seed` —
   creates the bank company and `admintest@callmind.uz` (the API must have started once).
5. Log in as `admintest@callmind.uz` / `SEED_ADMIN_PASSWORD`.

The deploy benchmark does not run in `npm run dev` (it would spend the BRB limit).

Python backend (required: the site gets all its data from it; `.claude/launch.json`
has `site` and `api` entries that start both):

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

## 8. Recent commits (all on `develop`, pushed)

| Commit | What | In production |
|---|---|---|
| `cb8d89e` | Playground latency marks and waterfall, Gemini/Claude streaming, earlier first audio, Claude Haiku fallback, server-action fix for the edge proxy, architecture doc | yes |
| `9a8d024` | FastAPI foundation behind `/api/core` | yes (`callmind-api.service`) |
| `92d6bae`, `4ab9069`, `51f403e` | Python ports (search, text, LLM, speech, turn engine) | code only, no endpoint uses it |
| `d3fb787` | BRB TTS engine (site + backend) | **no** — waits for the network route |
| `1238fa6` | This handoff doc, `CLAUDE.md`, the golden generators | docs only |
| `8b424c2` (13 Nov) | Claude Haiku (`claude-haiku-5-5`) is the default LLM (agent model → account default → server default); spoken payment dates worked out in code (`namedDay` / `named_day` in `loan-call`, the model only gets the result); 24 kHz audio in Playground voice calls; a toast when BRB fails and the browser voice takes over; BRB Whisper STT. New Python deps: `grpcio`, `tzdata` (Windows) | **no** — needs `pip install` + build + restarts |
| `b5f814d` (16 Nov) | Login, signup and the public language switch get past the edge's colon-field rule (section 3); the language menu on the auth pages takes taps again | yes (site build of 17 Nov) |

## 9. Open items

1. **Deploy the Python-only version** (section 4, "Deploying this") and check the
   live site: sign in, a Playground call, a knowledge upload. For phone calls, put
   `BRIDGE_SHARED_SECRET` in the server `.env`, place one call, then switch the phone
   bridge to `bridge.py`.
2. Ask the network admins for the route to the BRB proxy (section 6; TTS and STT both
   go through it now), then deploy and run one TTS render and one BRB Whisper
   transcription on the live site.
3. BRB's limit, measured 23 Nov: 20 requests per 60 s for TTS and, separately, for STT
   (`docs/brb-speech-api.md`, section 6) — about one live call at a time. Ask BRB for
   more for live calls, and whether there will be a production URL (today's is `-test`).
4. Audio pipeline and turn gating (25 Nov, `docs/audio-pipeline.md`): background speech
   while the agent thinks no longer cancels or becomes a turn — in `bridge.py` only, so
   the phone gets it with the switch in item 1. Voice isolation (Inworld sidecar) and
   Silero VAD are wired up but need installing; then measure with real recordings in the
   STT page's Audio Processing Lab.
5. Small parity gap, harmless today: the Playground, speech, live, demo and voices routes
   read the **last** value of a repeated form field or query parameter where the
   TypeScript read the first (the phone routes were fixed on 18 Nov). The pages never
   repeat a field.
6. Not confirmed yet: `https://callmind.brb-tech.uz/api/core/me` shows the
   logged-in user (Step 0 check), and the GitLab pipeline of the 12 Nov push.
7. Leftovers on the server only (untracked, can be deleted): `deploy/brb-vpn/`
   (the dropped VPN setup). If the VPN packages were installed there:
   `sudo apt remove openconnect vpnc-scripts`, and remove the
   `tts-stt-proxy-test.brb.uz` line from `/etc/hosts` until the admin route exists.
