# Project brief — for an AI agent working on this codebase

Read this before touching anything. It tells you what the product is, what is real
versus simulated, and where the traps are. Facts here were verified by reading the
code, not assumed.

---

## 1. What the product is

An **AI voice agent for inbound customer-service phone calls, built Uzbek-first**.

A company uploads its own documents (price lists, FAQs, policy files). The platform
indexes them and answers that company's incoming phone calls, speaking **only what
those documents actually say**, citing the exact passage. Every answer carries a
confidence score; below the tenant's threshold the call is handed to a human
operator with a summary and full transcript attached.

Languages: **Uzbek (Latin + Cyrillic), Russian, English**, including callers who
code-switch mid-sentence. Target customers: clinics, banks, insurers and state
operators in Uzbekistan.

**The product has no official name yet.** The code uses the working name "Ovoz"
throughout (package name `ovoz-ai`, cookies `ovoz_locale` / `ovoz_session`, brand
strings in the landing copy). Treat that as a placeholder; do not invent a new one.

### The two claims that define the product
1. **Grounded and citable** — it cannot invent a price. Answers are constrained to
   retrieved passages and traceable to the source document + paragraph.
2. **It knows when to stop** — low confidence means escalate to a human, not guess.

Any change that weakens either claim is a regression, even if it improves fluency.

---

## 2. Stack and conventions

- **Next.js 16.3 (App Router) + React 19 + TypeScript strict** (`ignoreBuildErrors: false`).
- **Tailwind v4** via `@theme` tokens in `src/app/globals.css`. Use semantic tokens
  (`bg-surface`, `text-ink`, `text-ink-2`, `bg-brand`, `hairline`), never raw hex.
- **Data mutations are Server Actions** in `src/app/actions/*.ts`, not REST routes.
  The public REST surface is only `src/app/api/v1/*`.
- **SQLite via `node:sqlite`** (`DatabaseSync`) — requires **Node ≥ 22.5**. Single
  writer, so **one app instance per `data/` directory**.
- **IMPORTANT**: this Next.js version has breaking changes vs. older training data.
  Read the relevant guide in `node_modules/next/dist/docs/` before writing routing,
  caching, or config code. This instruction also lives in `AGENTS.md`/`CLAUDE.md`.

### Layout
```
src/app/          landing (/), login, signup, onboarding, console (/app/*)
src/app/actions/  server actions: auth, agent, knowledge, ops
src/app/api/      speech (stt/tts), telephony (twilio, bridge), v1 REST, stream (SSE)
src/lib/rag/      ingest → chunk → embed → retrieve  (the knowledge pipeline)
src/lib/engine/   conversation logic, call simulator, event bus, demo data
src/lib/llm/      provider selection: local | anthropic | gemini
src/lib/i18n*.ts  four dictionaries: landing, console, labels, core
telephony-bridge/ standalone Asterisk↔platform bridge service (separate process)
```

16 SQLite tables: `tenants, users, sessions, agents, documents, chunks,
phone_numbers, calls, turns, escalations, api_keys, webhooks, audit_log,
usage_daily, invoices, knowledge_gaps`.

---

## 3. What is REAL vs SIMULATED — read this carefully

This is the single most misleading thing about the codebase. The product runs
end-to-end with **zero API keys**, because every external dependency has a local
fallback. That makes demos easy and makes it easy to believe things work that do not.

| Capability | With nothing configured | To make it real |
|---|---|---|
| Answer generation | Local extractive synthesiser (`llm/local.ts`) — real code, no key | `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` |
| Embeddings | Local 384-dim hashed n-gram encoder (`rag/embed.ts`) — no key, no download | `OPENAI_API_KEY` (1536-dim) |
| Uzbek STT | **Not available** — falls back to browser Web Speech | `STT_TRANSCRIBE_URL` (private service, **not in this repo**) |
| Uzbek TTS | **Not available** — falls back to a browser voice | `TTS_BASE_URL` + `TTS_CLIENT_SECRET` (**not in this repo**) |
| Phone calls | Built-in call **simulator** generates fake inbound traffic | Twilio creds + public HTTPS, or Asterisk/SIP trunk |

**The Uzbek STT and TTS models are NOT in this repository.** `api/speech/stt` and
`api/speech/tts` are ~140 lines of proxy pointing at env-configured URLs on a
private network. No agent can implement them here; they must be pre-provisioned on
the deployment host.

**A phone number in this product is a database row, not a provisioned line.**
`addNumberAction` (`actions/ops.ts`) is a regex check plus an `INSERT`. Signup
fabricates a number from `Date.now()` with `provider='simulator'`
(`lib/provision.ts`). Nothing contacts a carrier anywhere in the codebase. The
`provider` dropdown in the numbers UI is decorative — no code reads it.

Fallbacks are **silent by design**. `llm/provider.ts` has multiple
`return synthesizeLocal(input)` paths that swallow errors, and `engineLabel()`
reports what env says, not what actually ran. When debugging "the AI gave a bad
answer", first confirm which engine actually executed.

---

## 3b. The voice latency architecture — do not undo this

A phone call is judged on turn latency far more than on answer quality. Under
about 800 ms from end-of-speech to first audio the agent reads as a person;
much past that it reads as broken software, and callers start talking over it.
The pipeline is built around that number, and several things that look like
redundant complexity are load-bearing:

- **`/api/telephony/bridge/turn` streams raw `audio/L16` PCM, not a WAV.** The
  reply is split into sentences (`lib/speech/normalize.ts`), rendered
  concurrently and written to the response as each lands. Returning a WAV would
  mean sending nothing until the last sentence finished rendering. If you change
  this response to a buffered body you will silently add seconds to every turn.
- **Fixed lines are cached as PCM on disk** (`data/tts-cache/`). Greetings,
  re-prompts and holding lines are identical on every call; they cost a file
  read, not a synthesis. `cache: true` in `lib/speech/tts.ts` is what selects
  this — pass it for any fixed text.
- **The bridge plays a holding line after 300 ms** ("bir daqiqa"), prefetched
  during the greeting. It exists purely to keep the line from going silent while
  retrieval and generation run.
- **Barge-in truncates the transcript.** When a caller talks over the agent, the
  bridge reports `spokenRatio` on the next turn and the stored agent turn is cut
  to what was actually heard. Skipping that step leaves the model believing it
  said things that never reached the caller — which corrupts every later turn of
  the conversation.
- **VAD is adaptive.** The "voiced" threshold is a multiple of the line's own
  measured noise floor, not a constant. This is what makes the 350 ms silence
  window safe; with a fixed threshold it cuts callers off mid-sentence.

Known remaining gap: generation is not streamed into synthesis — the reply text
must be complete before the first sentence is rendered. Streaming the model's
output into `splitForSpeech` is the next meaningful latency win.

## 4. How a call works (the core loop)

```
caller audio → STT → retrieve (BM25 + dense vectors, fused) → confidence score
   → above threshold: generate answer constrained to retrieved passages → TTS
   → below threshold: escalate, attach summary + transcript + consulted sources
```

- Retrieval fuses **lexical BM25 with dense vectors** so exact terms (a policy
  number) and paraphrases both land — see `rag/retrieve.ts`.
- Uzbek Latin and Cyrillic are **normalised into one index**, so «шифокор» and
  "shifokor" retrieve the same passage. Matching is morphology-tolerant. This is
  core differentiation — do not "simplify" it away.
- Unanswered questions are recorded in `knowledge_gaps` and ranked by frequency.
- Live call state is pushed to the console over **SSE** (`api/stream`, `engine/bus.ts`).

---

## 5. Deployment reality (this bit has caused real bugs)

- **Deploy with `npm run build && npm start`.** Do not serve `next dev` remotely:
  Next blocks cross-origin requests to dev-only `/_next/*` resources, so the page
  renders but **nothing hydrates and every button is dead**. `allowedDevOrigins` in
  `next.config.ts` (env `ALLOWED_DEV_ORIGINS`) exists only as a dev escape hatch.
- **HTTPS is mandatory in practice**, for two independent reasons:
  1. The session cookie is `Secure` when the request is HTTPS
     (`lib/auth.ts` derives this from `x-forwarded-proto`, **not** `NODE_ENV`).
  2. **Microphone access requires a secure context.** On `http://<ip>:3000` the
     browser refuses `getUserMedia`/Web Speech entirely. `http://localhost` counts
     as secure, so an SSH tunnel (`ssh -L 3000:localhost:3000 user@host`) is the
     testing workaround.
- Behind nginx/Caddy set `proxy_set_header Host $host;`,
  `X-Forwarded-Proto $scheme;`, and **`proxy_buffering off;`** (SSE for live calls).
  If Server Actions get rejected on an Origin/Host mismatch, set
  `SERVER_ACTIONS_ALLOWED_ORIGINS`.
- `data/` **is** the database (SQLite + uploads + the generated session secret).
  Put it on persistent storage and back it up. Set `OVOZ_SESSION_SECRET` so
  sessions survive a reset.

---

## 6. Known defects — verified, unfixed, prioritised

Fix these before a customer pilot. Each was confirmed by reading the code.

1. **Placeholder facts reach real callers.** Only 3 of 11 industries (`clinic`,
   `insurance`, `retail`) have a real starter pack; the other 8 silently get a
   GENERIC blob containing invented specifics — a Tashkent office, "150 000 som"
   consultation, `+998 71 200 00 00` (`lib/starter-packs.ts`). The agent will quote
   these confidently. **Highest-severity issue in the product.**
2. **"Skip setup" unlocks everything.** `skipOnboardingAction` (`actions/agent.ts`)
   sets `onboarded=1` with no confirmation and no role check, leaving an empty
   knowledge base and a `draft` agent — after which the Twilio route answers
   "the assistant is not available right now" and hangs up.
3. **No OCR.** A scanned/photographed PDF yields no text layer and lands in status
   `failed`. Common in this market; there is no fallback path.
4. **Signup discards the chosen locale.** `signUpAction` never passes it to
   `provisionTenant`, so a visitor who browsed the site in Russian gets an
   Uzbek-greeting agent and an Uzbek console.
5. **Silent Uzbek→Russian voice substitution.** With TTS unset, the playground
   reads Uzbek replies with a Russian browser voice, unlabelled — a buyer may
   believe they are hearing the real Uzbek stack.
6. **`phone_numbers.e164` has no UNIQUE constraint**, and the simulator generator
   derives values from the clock, so two tenants can be issued the same number.
7. **Ingest is synchronous with no retry/reaper.** A proxy timeout or restart
   mid-upload strands documents in a non-ready state; the progress UI is
   effectively dead code because indexing is awaited inside the same request.
8. **`OPENAI_API_KEY` is a one-way trapdoor.** Turning it on switches embeddings to
   1536-dim; chunks already embedded at 384-dim are skipped by dense search, and
   there is no migration tooling.

---

## 7. Working agreements

- **Match the surrounding code.** It has a consistent voice: precise comments that
  explain *why*, semantic Tailwind tokens, server actions over ad-hoc endpoints.
- **All four locales or none.** User-visible strings go in the `i18n*` dictionaries
  with keys, never hardcoded. Adding a key to one dictionary means adding it to
  `en`, `ru`, `uz`, `uz-Cyrl`. Fallback chain is `uz-Cyrl → uz → en`.
- **Default UI language is Uzbek (Latin).** Locale resolution order is
  session locale → `ovoz_locale` cookie → `uz` (`lib/locale-server.ts`).
- **Public controls must survive failed hydration.** The language switcher is a
  native `<details>` + form-per-language, and the theme toggle is driven by a
  delegated listener in the root layout's inline script — both deliberately work
  without client JS. Do not "modernise" them back into hook-driven dropdowns.
- **Run `npm run build` before claiming done** — TypeScript is strict and the build
  is the real gate. Verify behaviour rather than asserting it.
- Never weaken tenant isolation: every query is scoped by `tenant_id` at the data
  layer.

---

## 8. Quick start

```bash
npm ci
npm run build && npm start      # http://localhost:3000
npm run typecheck               # tsc --noEmit
npm run reset                   # wipe data/ and re-seed
```

No `.env` is required — every key is optional and the platform runs on local
engines. Copy `.env.example` when you need hosted models, real telephony, or the
Uzbek speech services. See `README.md` for the full engine matrix and
`INTEGRATION.md` for the Asterisk bridge and `/v1` API.
