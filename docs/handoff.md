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
| Web app (UI **and** today's backend) | `src/` — Next.js 16 (App Router, server actions) | **Not the Next.js you know**: read `node_modules/next/dist/docs/` before writing Next code (`AGENTS.md`). |
| Python backend (being moved in) | `backend/` — FastAPI | Takes over the server code step by step (section 4). |
| Phone bridge | `telephony-bridge/` | Asterisk/SIP side; calls `/api/telephony/bridge/*`. The only phone path: the unused Twilio webhook was removed on 17 Nov. |
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
| 1c | Playground voice call served by Python behind `?py=1` | **Live** since 13 Nov (`779f979`), tested on the live site 17 Nov |
| 2 | Phone bridge routes in FastAPI (`/api/telephony/bridge/{turn,filler,end}`, same paths, `x-bridge-secret`); switch by pointing the bridge's `NEXT_BASE_URL` | Done 17 Nov — **not switched on yet** (see below) |
| **3** | **Public demo + logistics (`/api/demo/*`, `/api/logistics/*`, per-IP limits)** | **Next** |
| 4 | Console areas one by one: each page gets one `GET /api/core/views/<page>` and its server actions become `fetch` calls (agents, knowledge + ingest, calls/inbox/escalations, analytics, team/settings, billing, developers + `/api/v1/*`, models/labs/benchmark) | |
| 5 | Login moves; delete the TypeScript backend (`src/lib/{db,auth,engine,llm,rag,speech,…}`, `src/app/api/*`, `src/app/actions/*`) | |
| later | PostgreSQL; voice roadmap (streaming runtime) in the same Python codebase | |

### Step 1c — the Playground call from Python (done, 13 Nov)

Open the Playground with **`?py=1`** in the address
(`https://callmind.brb-tech.uz/app/playground?py=1`) and the voice call goes to
FastAPI instead of the Next.js routes; without it nothing changes.

| Through the site | Python (`backend/app/routers/`) | Port of |
|---|---|---|
| `POST /api/core/playground/call` | `playground.py` | `src/app/api/playground/call/route.ts` |
| `POST /api/core/playground/turn` (`?prefetch=1`) | `playground.py` | `…/playground/turn/route.ts` |
| `POST /api/core/playground/end` | `playground.py` | `…/playground/end/route.ts` |
| `POST /api/core/speech/live` | `live.py` (Zipformer in a thread) | `src/app/api/speech/live/route.ts` |
| `GET /api/core/stream` | `live.py` (SSE from `app.engine.bus`) | `src/app/api/stream/route.ts` |

- Same request fields, status codes (`bad_request`, `bad_audio`, `ended`, `no_agent`,
  `busy_call`; live: `bad_session`, `piece_too_large`, `bad_op`,
  `zipformer_not_available`, `zipformer_failed`) and NDJSON events as the TypeScript.
- Page: `callApi()` / `pythonBackend()` in `src/app/app/playground/playground.tsx`.
  The hang-up (`keepalive` fetch and the `pagehide` beacon) now sends an
  `application/json` Blob on **both** backends — it was a text/plain string, which the
  edge proxy refuses, so closing the tab mid-call may not have ended the call before.
- Tests: `backend/tests/test_playground_routes.py` (TestClient, scripted TTS/STT,
  local engine): event order per route, refusals, the prefetched transcript reused,
  STT failure, legacy mode, billing once, live ops, SSE heartbeat/events/ping.
- New Python dependency: `python-multipart`.
- **Deploy** (user): `git pull`, `backend/.venv/bin/pip install -e "backend[zipformer]"`,
  restart `callmind-api.service`, build + restart the site. Then on the same agent compare
  "You stopped → agent spoke" with and without `?py=1`, and hang up to check the call
  is billed once (Calls page).
- **Not moved yet**: the wallboard/inbox still use the Next.js `/api/stream`. Python's
  bus only sees calls Python handled, so until the TypeScript `publish()` also posts
  its events to Python (or everything is in Python), don't switch the wallboard.
  Page-load side effects `closeIdlePlaygroundCalls` (console layout) and
  `ensureBankAgent` (Playground page) still run in Next.js — fine, same database.
- **Local PC**: Python's HTTPS (httpx, certifi) does not trust the office CA either.
  Point it at a bundle that includes the Windows store: build it once with
  `python -c "import ssl,certifi;open('ca.pem','w').write(open(certifi.where()).read()+''.join(ssl.DER_cert_to_PEM_cert(c) for s in ('ROOT','CA') for c,e,t in ssl.enum_certificates(s) if e=='x509_asn'))"`
  and start uvicorn with `SSL_CERT_FILE=<path>\ca.pem`. Without it Claude/Gemini fail
  and the Python side answers with the local engine.

### Step 2 — the phone bridge from Python (done 17 Nov, not switched on yet)

The three endpoints the Asterisk bridge (`telephony-bridge/bridge.mjs`) calls now also
exist in FastAPI, **at the same paths**, in `backend/app/routers/bridge.py`:

| Path | Port of | What |
|---|---|---|
| `POST /api/telephony/bridge/turn` | `src/app/api/telephony/bridge/turn/route.ts` | first leg: open the call, play the greeting; later legs: barge-in trim, STT → `run_turn` → streamed 8 kHz PCM, metadata in `x-ovoz-*` headers |
| `GET /api/telephony/bridge/filler` | `…/bridge/filler/route.ts` | one holding line (`?to=&i=`), `x-ovoz-count` |
| `POST /api/telephony/bridge/end` | `…/bridge/end/route.ts` | close and bill the call once (`durationSec` pins the end time) |

- Same `x-bridge-secret` gate (`BRIDGE_SHARED_SECRET`: unset ⇒ 503, wrong ⇒ 401), same
  status codes, headers and bodies. Proven by `backend/tests/test_bridge_parity.py`:
  80 requests (`backend/tools/golden/scenarios-bridge.json`) replayed against the
  recorded TypeScript (`fixtures/golden_bridge.json`, made by `make-golden-bridge.cjs`)
  on a real database with scripted TTS/STT. Every response must match, along with the
  calls and turns each request touched, daily usage, the wallet and escalations.
- JavaScript details reproduced: `Number()` parsing of `spokenRatio` / `i`, the first value
  of a repeated form field or query parameter, JavaScript's `\s` when trimming a reply
  after barge-in, `lines[i % n]` going `undefined` for negative or fractional `i`, the
  ms truncation of the end time, `JSON.parse` refusing `NaN`.
- **Switching** (not done; nothing uses these routes yet, and `BRIDGE_SHARED_SECRET` is
  not set on production):
  1. Put `BRIDGE_SHARED_SECRET` in the server `.env` (the API reads it like the site does)
     and restart `callmind-api.service`.
  2. Point the bridge's `NEXT_BASE_URL` at Python, then restart the bridge. Use
     `http://127.0.0.1:8100` if the bridge runs on the CallMind server, or
     `https://callmind.brb-tech.uz/api/core` if it runs elsewhere (through the site's rewrite).
  3. Going back to Next.js is the same change undone: the TypeScript routes stay in place.
- Phone calls voice with the own TTS server (`TTS_BASE_URL`), as before. Locally,
  without it, `/filler` answers `503 filler_failed`, exactly like the TypeScript.
- Also fixed: `js_trim` in `backend/app/jscompat.py` stripped `-` from the ends of a string
  (and missed the U+2001–U+2009 spaces), so `"-5"` became `"5"`. It now trims exactly like
  JavaScript's `trim()`; the whole suite still matches the TypeScript.

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
### BRB Whisper STT (commit `8b424c2`)

Our own speech-to-text: Whisper on a Triton server, `stt-service.brb.uz:443`, model
`stt`, KServe v2 **gRPC** (TLS). Engine id `brb` ("BRB Whisper" in the pickers).

- Code: `src/lib/speech/brb-stt.ts` (Node `http2`, hand-written protobuf for
  `ModelMetadata`/`ModelInfer`) and `backend/app/speech/brb_stt.py` (`grpcio`, raw
  bytes). It asks the model's metadata once, then fills each input by its datatype
  (FP32 waveform, INT32/INT64 length, BYTES language/prompt/WAV, UINT8 WAV).
  Timeouts 5 s connect / 20 s answer. Errors: `brb_stt_unreachable` (gRPC 14),
  `brb_stt_timeout` (4), `brb_stt_grpc_<code>: <detail>`.
- Parity: `make-golden-brb-stt.cjs` → `golden_brb_stt.json`, replayed against a
  fake Triton by `test_brb_stt_parity.py`.
- `.env`: `BRB_STT_URL` (e.g. `stt-service.brb.uz:443`), `BRB_STT_MODEL` (default `stt`).
- **Status: built, not yet tried against the real host** — from the dev PC the
  connection is reset (VPN/route). Needs the same kind of network route on the server.

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
3. The database is created on the first query: on `/login`, try any email and
   password once (it fails, and `data\ovoz.db` now exists).
4. In a second terminal (in the folder with `package.json`): `npm run seed` —
   creates the bank company and `admintest@callmind.uz`.
5. Log in as `admintest@callmind.uz` / `SEED_ADMIN_PASSWORD`.

The deploy benchmark does not run in `npm run dev` (it would spend the BRB limit).

Python backend (needed locally for `?py=1` in the Playground; `.claude/launch.json`
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

## 9. Open items

1. Step 2 is code only: switch the phone bridge to Python when a real phone line is
   connected (section 4, "Switching"), then start step 3. Small parity gap found on the
   way: the Playground routes (`routers/playground.py`) read the **last** value of a
   repeated form field where the TypeScript reads the first (the bridge routes do it right).
   The page never repeats a field, so nothing breaks today.
2. Ask the network admins for the routes to the BRB proxy and to
   `stt-service.brb.uz:443` (section 6), then deploy and run one TTS render and one
   BRB Whisper transcription on the live site.
3. Try BRB Whisper against the real host. Ask BRB what the TTS limit is (per minute /
   day / characters) and whether there will be a production URL (today's is `-test`).
4. `npm run seed` says "start the app once" but the app only creates the database
   on its first query; make the seed script create it itself.
5. Not confirmed yet: `https://callmind.brb-tech.uz/api/core/me` shows the
   logged-in user (Step 0 check), and the GitLab pipeline of the 12 Nov push.
6. Leftovers on the server only (untracked, can be deleted): `deploy/brb-vpn/`
   (the dropped VPN setup). If the VPN packages were installed there:
   `sudo apt remove openconnect vpnc-scripts`, and remove the
   `tts-stt-proxy-test.brb.uz` line from `/etc/hosts` until the admin route exists.
