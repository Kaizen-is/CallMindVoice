# BRB website agents — knowledge import, grouped search, goal-led calls

Agents that answer questions about **BRB bank** (brb.uz) and **BRB-TECH**
(brb-tech.uz) from their websites, and an agent that **calls a person with a
goal** (follow up an online loan application) instead of waiting for "how can I
help?". Built on branch `Kaizen`. All new server logic is Python (FastAPI);
nothing changes for existing agents.

## 1. The pieces

```
 brb.uz, brb-tech.uz
        │  daily
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

## 3. Run it locally

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

## 4. Deploying (when it is time)

1. `git pull`; `backend/.venv/bin/alembic upgrade head` (only adds tables/columns).
2. Restart `callmind-api.service`; build + restart the site (the Playground change).
3. `python -m app.brb_setup --password … --new-key`, give the key to the scraper.
4. Schedule the scraper daily (Kubernetes CronJob or a systemd timer).

## 5. Not done yet

- Goals are set by `brb_setup.py`; the Agent studio has no editor for them yet
  (step 4 of the move to Python ports the console pages).
- Collected answers are shown in the Playground; the Calls page does not show
  `call_results` yet.
- The TypeScript Playground path (without `?py=1`) and the phone bridge do not
  have grouped search or goals; the phone bridge gets them when it is switched to
  Python (handoff, step 2).
- Exchange rates and the ATM map are loaded by JavaScript on brb.uz, so the
  scraper cannot read them; they should become live lookups.
