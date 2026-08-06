# Ovoz — AI Customer Service Platform

Upload your documents. Ovoz turns them into a voice agent that answers your phones in
**Uzbek, Russian and English**, answers only what your documents actually say, and hands
the hard calls to a person with the transcript already summarised.

This is a working multi-tenant SaaS, not a mockup: real authentication, real retrieval over
real files, real escalation decisions, real call records, real analytics.

```bash
npm install
npm run dev          # http://localhost:3000
```

**No API keys are required.** Every engine has a local implementation that runs offline
(see [Engines](#engines)). Add keys only when you want to swap one out.

---

## Try it in two minutes

1. `npm run dev`, open `http://localhost:3000`, click **Start free**.
2. Sign up. You land in a four-step setup wizard.
3. Hit **Load starter knowledge** — a realistic clinic knowledge base in three languages.
4. Ask it something in step 3 (`Ish vaqtingiz qanday?` / `Сколько стоит приём?` /
   `What documents do I need?`). That is the real engine on your real index.
5. Take the agent live, then in the console press **Simulate a call** → **Backfill 30 days**
   to populate the analytics.

To hear it out loud, open **Playground → Speak** in Chrome or Edge and hold the microphone
button. Speech recognition and synthesis run in your browser via the Web Speech API — no
key, no upload.

---

## What is actually built

| Area | What works |
|---|---|
| **Multi-tenancy** | Tenant per company, hard `tenant_id` scoping on every query, roles (owner / admin / operator / analyst) |
| **Auth** | scrypt password hashing, HMAC-signed httpOnly session cookies, audit log, no third-party auth dependency |
| **Knowledge base** | PDF · DOCX · TXT · MD · CSV · JSON · HTML upload, URL import, pasted text, FAQ builder; structure-aware chunking; live indexing state |
| **Retrieval** | Hybrid BM25 + dense vectors fused with Reciprocal Rank Fusion, cross-language concept bridging, calibrated confidence, per-answer citations |
| **Answering** | Local extractive synthesiser out of the box; Claude via the Anthropic SDK when a key is present, with automatic fallback |
| **Voice** | Real browser STT/TTS in the playground; Twilio webhook wired end-to-end and signature-verified; call simulator driving the same engine |
| **Escalation** | Confidence threshold, explicit request, sentiment, repeated failure, after-hours — each independently switchable |
| **Operator workspace** | Live queue, AI summary, full transcript, the exact passages the AI read, take-over and resolution logging |
| **Analytics** | Deflection, latency percentiles, intent mix, escalation reasons, hour × weekday heatmap, language split, unanswered-question backlog, cost model |
| **Admin** | Numbers, team & roles, plans & invoices, API keys, webhooks, audit log, four-way localised console |
| **Console languages** | Uzbek (Latin), Uzbek (Cyrillic), Russian, English — switchable per user; Uzbek Cyrillic falls back to Uzbek Latin then English for any un-translated key |

---

## Architecture

```
Caller ──► Twilio SIP / simulator ──► Turn engine ──► Reply (spoken)
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
              Hybrid retrieval      Answer generation    Escalation policy
              BM25 ⊕ dense          local | Claude       confidence · intent
              + concept bridge                            sentiment · hours
                     │                    │                    │
                     └──────────► Call record, transcript, citations, latencies
                                          │
                          ┌───────────────┴───────────────┐
                          ▼                               ▼
                   Operator inbox                    Analytics
                   (summary + sources)               (deflection, cost, gaps)
```

Everything runs in one Next.js process. `src/lib/engine/conversation.ts` is the single turn
engine — the telephony webhook, the simulator and the browser playground all call it, which
is why the playground is a genuine rehearsal rather than a separate demo path.

### Layout

```
src/
  app/
    page.tsx                 marketing site
    login/ signup/           authentication
    onboarding/              four-step setup wizard
    app/                     the console (dashboard, knowledge, agent, playground,
                             live, inbox, calls, analytics, numbers, team,
                             billing, developers, settings)
    api/stream/              SSE feed for live updates
    api/telephony/twilio/    inbound voice webhook (signature-verified)
    actions/                 server actions — auth, knowledge, agent, ops
  lib/
    db.ts                    node:sqlite, migrations, typed query helpers
    auth.ts                  scrypt + HMAC sessions, roles, audit, API keys
    rag/                     text.ts · chunk.ts · embed.ts · retrieve.ts · ingest.ts
    llm/                     local.ts (extractive synthesiser) · provider.ts (Claude)
    engine/                  conversation.ts · calls.ts · simulator.ts · bus.ts · demo-data.ts
    telephony/twilio.ts      TwiML, signature verification, REST helpers
    analytics.ts             every roll-up the dashboards use
  components/
    ui/                      button, card, forms, modal, toast, menu, tabs…
    charts/                  hand-rolled SVG charts, themed and accessible
    console/                 shell, stat card, live hook, simulate button
```

---

## The retrieval engine

Contact-centre knowledge is short, factual and multilingual. Three decisions follow from that.

**Chunking follows the document, not a character count.** A price list split at 500
characters loses half its prices and orphans the heading that gave them meaning.
`chunk.ts` detects headings from their surroundings (a short, unpunctuated line that opens
a block — Uzbek and Russian headings are sentence case, so a capitalisation test finds
almost none), keeps each line its own unit unless it is a wrapped continuation, and carries
the heading into every chunk it produces.

**Retrieval is hybrid.** Dense vectors alone miss `ЛОР`, an MRT price or a policy number —
exactly what callers ask about. BM25 alone misses paraphrase. `retrieve.ts` runs both and
fuses them with Reciprocal Rank Fusion, then breaks ties on query coverage.

**Languages are bridged explicitly.** Uzbek is written in two alphabets, and callers mix
Uzbek and Russian in one sentence. Everything is folded into a single normalised Latin
space, then high-frequency contact-centre concepts get a shared canonical token: `narx`,
`цена`, `price`, `qancha`, `сколько` and `how much` all emit `~price`. Both the indexer and
the query path emit it, so an English question finds an Uzbek price list — while an exact
same-language match still outranks it.

Measured on the built-in clinic knowledge base:

| Question | Language of the answer | Retrieved | Confidence |
|---|---|---|---|
| `Manzilingiz qayerda?` | Uzbek | Ish vaqti va manzil | 0.84 |
| `How much is a consultation?` | **Uzbek** | Qabul narxlari | 0.51 |
| `Сколько стоит приём кардиолога?` | **Uzbek** | Qabul narxlari | 0.47 |
| `Do you work on Saturday?` | **Uzbek** | Ish vaqti va manzil | 0.47 |

Cross-language answers score lower by design — the default escalation threshold is 0.45, so
they answer, but a slightly harder question hands over instead of guessing.

One honest limit of the **local** generation path: it is extractive, so a Russian question
answered from an Uzbek price list comes back with Russian framing around the quoted Uzbek
figures ("По нашим данным: Kardiolog qabuli — 180 000 so'm"). Correct and grounded, but not
translated. Set `ANTHROPIC_API_KEY` and Claude answers fully in the caller's language from
the same retrieved passages.

**Confidence is built to be conservative.** It combines query coverage, the margin between
the best and second-best passage, absolute lexical strength, and a penalty for query terms
the corpus has never seen. It never returns near-certainty. Everything that decides whether
a human gets involved is visible in `calibrateConfidence`.

---

## Engines

Each row runs locally unless you supply a key. The console shows which is active.

| Engine | Default (no key) | With a key |
|---|---|---|
| **Answer generation** | Extractive synthesiser: intent classification, query-focused sentence selection from retrieved passages, spoken-register templates per language | Claude via `@anthropic-ai/sdk` (`ANTHROPIC_API_KEY`), structured output, thinking off and effort low for voice latency, automatic fallback to local on any error |
| **Embeddings** | 384-dim hashed random projection over stems, character n-grams and concept tokens — real cosine geometry, deterministic, morphology-tolerant | OpenAI embeddings (`OPENAI_API_KEY`) |
| **Speech (browser)** | Web Speech API — real recognition and synthesis, no key | — |
| **Telephony** | Call simulator driving the real turn engine | Twilio Elastic SIP (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) |

The local generation path is not a placeholder. On FAQ- and policy-shaped knowledge bases —
what contact centres actually run on — it produces correct, grounded, spoken-register
answers at zero marginal cost. The hosted path is better on open-ended questions.

See `.env.example` for every variable.

---

## What is simulated, and how honestly

Two things are modelled rather than carried, both clearly labelled in the UI:

**Telephony transport.** Without Twilio credentials, the call simulator generates inbound
calls from realistic caller scripts. Those calls go through the *same* `runTurn` as a real
phone call: real retrieval against your documents, real generation, real escalation
decisions, real latency measurement, real call records. Only the audio transport is
modelled. The Twilio webhook is fully implemented and signature-verified — it activates the
moment credentials exist.

**Historical volume.** *Simulate → Backfill 30 days* writes metadata-only call records with
realistic distributions so the analytics have something to show, plus a dozen calls replayed
through the real engine with genuine transcripts and citations. It is user-triggered,
labelled "demo", and *Erase all call history* removes it.

Nothing else is faked. Every number on every dashboard is computed from stored call records.

---

## Security

- **Tenant isolation at the data layer.** Every tenant-scoped table carries `tenant_id` and
  every query filters on it. There is no code path that reads across tenants.
- **Passwords**: scrypt, per-user salt, N=16384. **Sessions**: HMAC-SHA256-signed httpOnly
  cookies, server-side session records, 30-day expiry, revoked on disable.
- **API keys** are stored as SHA-256 hashes and shown exactly once.
- **Twilio webhooks** are HMAC-SHA1 verified against the full URL and sorted body before
  anything is read.
- **Audit log** records who changed what, with actor and timestamp.
- With local engines, no document text leaves the deployment — not for embedding, not for
  generation.

---

## Production notes

What this build deliberately does not include, and what it would take:

| Gap | What is needed |
|---|---|
| Streaming telephony audio | Twilio Media Streams over a WebSocket in a long-lived Node process; `mediaStreamTwiml()` already emits the TwiML |
| Server-side STT/TTS | Deepgram/Google for recognition, ElevenLabs or a local Uzbek voice for synthesis; the browser path proves the pipeline |
| Horizontal scale | `node:sqlite` → Postgres + pgvector, and the in-process event bus → Redis pub/sub. Both are single files: `db.ts` and `engine/bus.ts` |
| Payments | Plan changes are recorded, not charged. Wire Payme/Click or Stripe into `changePlanAction` |
| Real invoices | Generated on demand from usage; no PDF rendering or dunning |

---

## Commands

```bash
npm install         # install dependencies (Node ≥ 22.5 required)
npm run dev         # dev server (webpack — see note below)
npm run build       # production build
npm start           # serve the production build on :3000
npm run typecheck   # tsc --noEmit
npm run reset       # wipe the local database + uploads (add -- --all to drop the secret too)
```

**Why webpack in dev:** Turbopack fails to write route manifests when the project path
contains spaces on Windows, which this one does. `npm run dev:turbo` is kept for
environments where that is not a problem.

State lives in `data/` (SQLite database, uploads, session secret). It is gitignored, so it
never leaves the machine. `npm run reset` clears it; the schema is recreated on next boot.

---

## Deploy to a server

```bash
git clone <your-remote-url> ovoz && cd ovoz
cp .env.example .env        # optional — every key is optional; local engines run keyless
npm ci                      # clean install from package-lock.json
npm run build
npm start                   # listens on :3000 — put nginx/Caddy in front for TLS
```

- **Node ≥ 22.5** is required (`node:sqlite`). Node 20 will not boot.
- **First boot self-initialises.** `data/` is created, migrations run, and a session secret
  is generated automatically — there is no separate install/migrate step. Open the site and
  click **Start free** to create the first tenant.
- **`data/` is the database.** Put it on persistent storage and back it up; it holds every
  tenant, document and call record. Because it is SQLite (single writer), run **one** app
  instance per `data/` directory. To run several instances, migrate to Postgres — that swap
  is isolated to `db.ts` (see the production-gaps table above).
- **Keep it running** with a process manager (`pm2 start "npm start" --name ovoz`, a
  `systemd` unit, or Docker). Set `OVOZ_SESSION_SECRET` in the environment so sessions
  survive a `data/` reset, and set `NODE_ENV=production` so session cookies are `Secure`.
- **For real telephony**, set `TWILIO_WEBHOOK_BASE_URL` to the server's public HTTPS origin
  and point your Twilio number's voice webhook at `/api/telephony/twilio/voice`.
