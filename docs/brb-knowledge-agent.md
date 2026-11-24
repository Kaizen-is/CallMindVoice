# BRB website agents — knowledge import, grouped search, goal-led calls

Agents that answer questions about **BRB bank** (brb.uz) and **BRB-TECH**
(brb-tech.uz) from their websites, and an agent that **calls a person with a
goal** (follow up an online loan application) instead of waiting for "how can I
help?". Built on branch `Kaizen`. All new server logic is Python (FastAPI);
nothing changes for existing agents.

## 1. The pieces

```
 brb.uz, brb-tech.uz
        │  rates every 15 min · edited pages daily · everything weekly
        ▼
 BRB knowledge scraper (separate Python service, D:\WORK\BRB datascrapper)
        │  PUT /knowledge/pages  (API key of the BRB tenant)
        ▼
 FastAPI ── app/rag/pages.py ──▶ documents + chunks + knowledge_pages, knowledge_groups
        │
 Playground (?py=1) ─▶ run_turn ─▶ app/rag/routing.py   pick the group, search it, fall back
                              └─▶ app/llm/goal_call.py  goal-led call prompt, scenario card, results
```

| Piece | Where | What |
|---|---|---|
| Migration `0002_website_knowledge` | `backend/alembic/versions/` | adds `knowledge_pages`, `knowledge_groups`, `call_results`, `agents.goal_json`; nothing existing changes |
| Page import | `backend/app/rag/pages.py`, `routers/knowledge.py` | create-or-replace by URL (unchanged fingerprint ⇒ skipped), delete, list, group list |
| Grouped search | `backend/app/rag/routing.py` | used by `run_turn` only for tenants that have imported pages |
| Goal-led calls | `backend/app/llm/goal_call.py`, `prompts.py`, `playground.py` | the agent calls, checks identity, collects answers, answers questions from the knowledge base |
| Playground extras | `backend/app/routers/playground_chat.py`, `src/app/app/playground/scenario-card.tsx` | typed turns through Python, the tester's scenario card, "what did the agent collect?" |
| Setup | `backend/app/brb_setup.py` | company, login, two agents, scraper API key |
| Measurement | `backend/tools/eval_retrieval.py`, `tools/brb_testset.json` | flat vs grouped (vs LLM-routed) search on a question set |

## 2. Why it is shaped like this

- **Own tenant.** The website pages live in the company "BRB — website agents"
  (`ten_brb_website`). The public demo and the phone bridge still run on the
  TypeScript search, which searches a whole tenant; putting 1,100 pages into the
  bank tenant would have changed their answers. A separate tenant isolates it
  with no code change on those paths.
- **Facts only from brb.uz and brb-tech.uz** (decided 24 Nov). Both agents carry
  `SOURCES_RULE` (`backend/app/brb_setup.py`): no outside data and no answers from
  the model's own knowledge (it overrides the base prompt's general-knowledge
  rule). **Exchange rates** come from brb.uz's own `/api/currency/compare` (the
  endpoint its "Valyutalar kursi" page reads; reading it approved by BRB-TECH),
  refreshed every 15 minutes into two pages of the `currency` group; the agent
  quotes them with their "Yangilangan" date and time, picks buy or sell from what
  the caller wants, and uses individual rates unless the caller is a company.
  Gold prices are not published on the site, so the agent says so and points to
  the "Oltin quymalari" page or 1254.
- **Uzbek pages only** (decided 24 Nov). brb.uz's Russian and English pages are
  mostly translations, so only Uzbek is imported (593 pages, 3,809 chunks). A
  Russian caller is answered in Russian from the Uzbek pages, but **product names
  are translated** ("Мечта" = "Orzu", "наблюдательный совет" = "kuzatuv kengashi"),
  and the search often misses them: the Russian test questions find the right
  page 6 of 12 times, against 10 of 12 with the Russian pages imported. If Russian
  callers matter, add `ru` to `keep_langs` in the scraper and run it once.
- **Python only, opt-in.** New features go where the backend is moving. Every new
  branch in shared code runs only when a tenant has imported pages or an agent
  has a goal; the parity suites (golden TypeScript fixtures) still pass
  unchanged, so existing behaviour is proven identical.
- **Group routing without an LLM call.** The question's vector (computed for the
  search anyway) is compared with each group's centroid, weighted by how
  focused the group is, plus keyword hits and a "same group as the last turn"
  bonus; the three best groups are searched in the caller's language. If that is
  not confident, it searches all groups in that language, then everything.
  Measured on the 42-question test set (right page first / in the top five / MRR):

  | method | first | top 5 | MRR | search time |
  |---|---|---|---|---|
  | plain search (all chunks) | 55% | 90% | 0.70 | ~1 s |
  | **grouped, 3 best groups (shipped)** | **67%** | 88% | **0.76** | ~0.15 s |
  | an LLM picks the group | 67% | 83% | 0.74 | +0.8 s LLM call per turn |
  | *after keeping Uzbek pages only:* plain | 55% | 81% | 0.65 | |
  | *after keeping Uzbek pages only:* grouped | 57% | 76% | 0.65 | |

  The first three rows were measured with uz + ru + en pages. The drop in the last
  two comes from the Russian questions (see "Uzbek pages only" above).

  Searching everything is slow in Python (7,700 chunks × 1,536 dimensions); the
  grouped search does the vector maths with numpy in a worker thread. The set is
  small (one question ≈ 2.4 points): grow it and re-measure before tuning.
- **Embeddings must match.** On the office network Python does not trust the
  inspecting proxy, so OpenAI calls fail unless `SSL_CERT_FILE` points at a bundle
  with the office CA (handoff §4). An import without it silently stores local
  384-dimension vectors; `python -m app.rag.reembed --tenant ten_brb_website`
  re-embeds in place.
- **Goals as data.** The loan reminder's "Who to call" card hard-codes one
  purpose. A goal (`agents.goal_json`) describes any outbound call: purpose,
  person (identity check reused from the loan call), known facts, the fields to
  collect, the closing promise, and scenario cards for testers. Collected
  answers are extracted after the call (no latency during it).

## 3. Every company has the agents

- **Default agents.** Every company gets "BRB ma'lumot xizmati" and "Isomiddin —
  kredit arizasi" the first time its Playground opens: the page calls
  `POST /api/core/agents/defaults` (`backend/app/default_agents.py`). The third
  default, "Isomiddin — bank kredit eslatmasi", comes from `src/lib/bank-agent.ts`
  as before. The copies are **drafts**, so a company's live agent and phone number
  never change, and each company may edit or delete its copies (a settings note
  stops them coming back).
- **Shared library, not copies of the pages.** The copies read the website
  knowledge from the "BRB — website agents" company (`agents.knowledge_tenant_id`,
  migration 0003; `backend/app/rag/library.py`). The pages are stored once, and no
  other agent of the company sees them. A company is used as a library only when
  it is marked `"sharedLibrary": true` (set by `brb_setup.py`), so a wrong id can
  never read another customer's documents. Re-running `brb_setup.py` also brings
  every copy's texts up to date.
- **No `?py=1` needed.** For agents with a goal, a shared library or website pages,
  the Playground talks to the Python backend by itself (`pythonAgents` in
  `src/app/app/playground/page.tsx`).
- **No holding lines.** `FILLERS=off` in `.env` stops the "bir daqiqa" lines in
  Playground voice calls and the public demo; the phone bridge already honours the
  same variable. Unset, behaviour is as before.

## 4. Run it locally

```bash
cd backend
.venv\Scripts\alembic stamp 0001_baseline        # once, if the database was never stamped
.venv\Scripts\alembic upgrade head
.venv\Scripts\python -m app.brb_setup --password <choose one> --new-key   # prints the scraper key once
.venv\Scripts\uvicorn app.main:app --port 8100
```

Then in the scraper folder put `CALLMIND_URL=http://127.0.0.1:8100` and
`CALLMIND_API_KEY=<the key>` in `.env` and run `python -m brb_scraper run`. Its
first run sends every page; later runs send only what changed and reconcile.

Start the site (`npm run dev`), log in as `brb@callmind.uz`, open
**`/app/playground?py=1`** and pick an agent:

- **BRB ma'lumot xizmati** — ask anything about BRB bank or BRB-TECH. The reply's
  details show which group was searched (`retrieval.routing`).
- **Isomiddin — kredit arizasi** — the scenario card says who you are. Type
  "Allo", confirm the name and year of birth, answer its questions, ask yours.
  Then press **What did the agent collect?**

Measure: `.venv\Scripts\python tools\eval_retrieval.py` (add `--llm` to compare
LLM routing; needs a hosted model).

## 5. Deploying (when it is time)

1. `git pull`; `backend/.venv/bin/alembic upgrade head` (0002 and 0003 only add tables/columns).
   Put `FILLERS=off` in the server `.env` and in the phone bridge's environment.
2. Restart `callmind-api.service`; build + restart the site (the Playground change).
3. `python -m app.brb_setup --password … --new-key`, give the key to the scraper.
4. Schedule the scraper's three jobs (timers in the scraper project's `deploy/`): rates every 15 min,
   edited pages daily at 07:00, everything on Sunday 03:00.

## 6. Not done yet

- Goals are set by `brb_setup.py`; the Agent studio has no editor for them yet
  (step 4 of the move to Python ports the console pages).
- Collected answers are shown in the Playground; the Calls page does not show
  `call_results` yet.
- The TypeScript Playground path (without `?py=1`) and the phone bridge do not
  have grouped search or goals; the phone bridge gets them when it is switched to
  Python (handoff, step 2).
- The ATM map is loaded by JavaScript from brb.uz `/api/locations`; only the office list
  page is in the knowledge base.
- brb.uz robots.txt still closes `/api`; the web team should add
  `Allow: /api/currency/compare` so the scraper's exception can go.
