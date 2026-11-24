# BRB knowledge scraper — architecture

This document explains **what** the scraper does, **how** it is built, and above
all **why** it is built that way. Each decision lists the options we had and
the trade-off we accepted, so you can judge it yourself and change it when the
situation changes.

---

## 1. The job, in one sentence

Every week, read the public websites of BRB bank (brb.uz) and BRB-TECH
(brb-tech.uz), keep only the pages that answer customer questions, clean them
into plain text, sort them into groups, and hand CallMind exactly what changed.

## 2. Where it sits in the system

```
 brb.uz ───────┐                                        ┌───────────── CallMind ─────────────┐
 (sitemap+HTML)│      ┌──────────────────────────┐      │                                     │
               ├────▶ │  BRB knowledge scraper   │ ───▶ │ knowledge base (grouped)  ◀── agent │
 brb-tech.uz ──┘      │  (this project, Python)  │      │      ▲                       turn   │
 (JSON API)           │  15 min / daily / weekly │      │      │ phase 2: import API          │
                      └────────────┬─────────────┘      └──────┼──────────────────────────────┘
                                   │ today                     │
                                   ▼                           │
                       data/output/  (JSON files) ─────────────┘
```

**Today** the scraper writes files. **Phase 2** adds a CallMind import API
(create-or-replace by URL, delete) and a `CallMindSink` that calls it. Nothing
else in the scraper changes when that happens.

### Decision 1 — a separate service, not code inside CallMind

| Option | For | Against |
|---|---|---|
| Inside CallMind (Next.js) | one deployment | crawling competes for CPU with live phone calls; every scraper fix needs a new CallMind image through the protected deploy |
| **Separate service** ✅ | isolated load; own release cycle; the team's language (Python) | one more thing to deploy; needs an API contract |

The cost of "one more thing to deploy" is small (three scheduled jobs, no server),
and the contract between the two is a good thing in itself: it forces us to say
exactly what a "page" is (see §5).

**Where the code lives (24 Nov 2026):** in the CallMind repository, as `brb-scraper/`,
so it is reviewed and versioned with the agents it feeds. It is still a separate
process with its own dependencies (`requirements.txt`), it talks to CallMind only
through the import API, and the web image leaves it out (`.dockerignore`).

## 3. Inside one run

```
            ┌────────────────────────────── pipeline.py ───────────────────────────────┐
            │                                                                          │
 sites.yaml │  discover ─▶ scope ─▶ load (4 at a time) ─▶ regroup ─▶ diff ─▶ apply      │
     │      │     │          │            │                  │          │        │      │
     ▼      │  sources.py groups.py  sources.py+extract.py groups.py  diff.py  sinks.py │
  config.py │                             │                                  state.py │
            │                          http.py (polite)                                │
            └───────────────────────────────────────────────────────────────┬──────────┘
                                                                            ▼
                                                                    report.py → data/reports/
```

| Step | What it does | Module |
|---|---|---|
| discover | list every page the site says it has (sitemap / API) | `sources.py` |
| scope | drop excluded pages (property listings, tenders…) and news older than 180 days; give each page a group from its URL | `groups.py` |
| load | fetch and clean pages, 4 at a time, politely | `sources.py`, `extract.py`, `http.py` |
| regroup | pages no URL rule matched get a second chance from their breadcrumb | `groups.py` |
| diff | compare fingerprints with the last run: new / changed / unchanged / removed | `diff.py` |
| apply | write new and changed pages, delete removed ones, remember fingerprints | `sinks.py`, `state.py` |
| report | what happened and what needs a person's eye | `report.py` |

Each step only passes data **forward**. That is the *pipeline* pattern: you can
test every step alone, and when something breaks the report tells you which
step it was.

### Decision 2 — adapters per website

brb.uz and brb-tech.uz are built completely differently. Instead of `if site
== ...` all over the code, each site gets an **adapter** with the same two
methods (`discover`, `load`). The pipeline only knows that interface. A third
website = one new adapter class + a block in `sites.yaml`.

### Decision 3 — brb-tech.uz is read from its API, not its HTML

The site is a Nuxt app: most of its content is loaded by the browser from
`/api-client/News/GetAll`, `/Portfolio/GetAll`, `/Staff/GetAll`,
`/Partner/GetAll`. Scraping the HTML would mean running a headless browser.
The API gives clean fields in uz/ru/en with an `updatedAt` date.

> **Rule of thumb:** always look for the structured source first (API, feed,
> sitemap) before parsing HTML. HTML is a presentation format; it changes
> whenever a designer changes the page.

**Risk we accept:** the API is internal to the site and can change without
notice. If it does, discovery fails loudly (see §6) and nothing is deleted.

### Decision 4 — the rules live in config, not in code

What to skip and which group a page belongs to are facts about the *websites*,
and websites change. So they live in `config/sites.yaml`. The groups follow
the bank's own menu (Jismoniy shaxslarga › Kreditlar, Biznes uchun, Bank
haqida…): the bank already organised its content, so we reuse that
organisation instead of inventing one.

## 4. How "what changed?" is decided

### Decision 5 — fetch every in-scope page each run, compare fingerprints

| Option | For | Against |
|---|---|---|
| Trust the sitemap's `lastmod`, fetch only newer pages | fewer requests | `lastmod` is often wrong (a tariff changes in a shared block; the date does not move) → silent stale answers |
| **Fetch all ~1,100 in-scope pages, compare content** ✅ | always correct; simple | ~8 minutes and ~600 requests a week — trivial for the bank's server |

This is a *right-sizing* decision for the weekly run. The daily run (§7) does use
`lastmod` (sitemap) and `updatedAt` (API) to pick pages, because it exists only to
catch edits sooner; the weekly full pass stays as the safety net for dates that lie.

### Decision 6 — fingerprint the cleaned text, never the raw HTML

The fingerprint is a SHA-256 of title + breadcrumb + cleaned text. Raw HTML
changes on every request (tokens, timestamps, banners), which would make every
page look "changed" every day and re-index everything for nothing.

### The safety rules (diff.py)

Deleting knowledge is the dangerous direction: an agent that suddenly knows
nothing is worse than one with a day-old tariff. So:

1. **A page that fails to load is kept.** Timeout or HTTP 500 → we keep
   yesterday's version and try again tomorrow.
2. **A page is removed only when** it left the sitemap/API or answered 404/410.
3. **Safety brake:** if one run would remove more than 20% of a site's pages,
   it removes **none** and the report explains why. A broken sitemap or a
   redesigned site must not wipe the knowledge base. A person releases the
   brake with `--allow-mass-removal`.
4. **If discovery fails** (sitemap down), that site is not touched at all.

> These are examples of a general principle: **make destructive actions
> conservative and loud, and safe actions automatic.**

## 5. The contract: what a "page" is

Every page becomes one JSON record (`Page.to_record()`), and this record is the
contract with CallMind:

```json
{
  "id": "5f1c…",               // sha1(url)[:16], stable
  "url": "https://brb.uz/ru/fizicheskim-litsam/vklady",
  "site": "brb",              // brb | brbtech
  "lang": "ru",               // uz | ru | en
  "group": "personal_deposits",
  "kind": "page",             // page | news | project | team | partners
  "title": "Вклады частным лицам",
  "breadcrumb": ["Физическим лицам", "Вклады частным лицам"],
  "text": "## Надежные вклады\nГодовая процентная ставка: 14%\n…",   // Markdown
  "fingerprint": "sha256:…",
  "source_lastmod": "2026-11-05",
  "fetched_at": "2026-11-23T03:00:12+00:00"
}
```

`data/output/manifest.json` lists every live page; `groups.json` lists the
groups with descriptions and keywords (used for routing, §8).

### Decision 7 — Markdown as the exchange format

Plain text loses structure ("which product is this 14% for?"); HTML carries
noise. Markdown keeps headings, lists and "Label: value" facts, stays human
readable, and every chunker understands it. The extractor also joins product
card labels with their values (`Foiz stavkasi: 0%-12%`) and writes table rows
with their column names, so a single line still makes sense when it is cut
out into a search chunk.

## 6. Failure modes

| What goes wrong | What happens | Who notices |
|---|---|---|
| A page times out / 500 | retried 3× (1 s, 2 s, 4 s); then kept as before | report ▸ Failed |
| A page returns 404 | removed (unless the safety brake holds) | report ▸ Gone |
| Sitemap or API down | that site is skipped entirely | report ▸ Error, exit code 2 |
| Site redesign: extractor finds no content | pages become "thin" (<200 chars) | report ▸ Thin pages |
| New section on the site | its pages land in group `other` | report ▸ Pages in no group |
| Mass removal (bug or redesign) | safety brake: nothing removed | report ▸ Safety brake, exit code 1 |
| Two runs at the same time | the second stops (lock file) | log + exit code 2 |
| Crash mid-run | state is committed per site; files are written atomically (temp file + rename); next run repairs the rest | log |

Exit codes (0 ok / 1 partial / 2 failed) let the scheduler alert on problems.

## 7. Scheduling: three refresh tiers

One rule decides how often data is read: **how fast it changes × what a stale answer costs.**

| Tier | Data | Why this often | Job |
|---|---|---|---|
| **15 min** | exchange rates: individuals, businesses, mobile app (brb.uz `/api/currency/compare`) | they change during the day; a wrong rate is a wrong amount of money | `run --site brb_rates` |
| **daily 07:00** | news, promotions, any page the bank edited (sitemap `lastmod`, API `updatedAt`) | a promotion that starts on Monday should not wait until Sunday | `run --changed-only` |
| **weekly Sun 03:00** | everything, re-read and compared | catches edits whose date did not move; the only run that removes pages from CallMind | `run` |
| never scraped | the caller's own loan, card, balance; ATM working status | private or real-time: needs an authenticated lookup at answer time, not a copy | — |

How the tiers fit the existing design, without new machinery:

- **Same pipeline, different selection.** The rates are one more site (`brb_rates`, source
  `currency_api`) whose two "pages" are built from JSON. The daily run discovers every page as
  usual but loads only new ones and ones whose date moved (`edited_since` in pipeline.py);
  sitemap dates have no time, so pages dated today or yesterday are loaded again. Pages it
  does not load are untouched by the diff.
- **Push only what changed.** Fingerprints decide, as always. The rates page carries its
  "Yangilangan" time, so it changes at almost every 15-minute run: two small pages re-embedded
  in CallMind, nothing else.
- **One lock per site** (`data/locks/<site>.lock`), not one per run, so the jobs can overlap: a
  site busy in another run is waited for (10 min), then skipped. `state.db` waits for the other
  writer (busy timeout, WAL) instead of failing.
- **The 15-minute run does not heal.** It sends its own pages and stops; the reconcile with
  CallMind (re-send missing pages, delete extras) runs daily and weekly.
- **Reports per job** (`data/reports/<job>/`, last 50 each), so 96 rate reports a day do not bury
  the weekly one.

Where the jobs run:

- **Locally (Windows):** Task Scheduler, see README.
- **On the CallMind server (systemd, like the rest of CallMind):** `deploy/brb-scraper-rates.timer`
  (`*:0/15`), `deploy/brb-scraper-daily.timer` (07:00 Tashkent), `deploy/brb-scraper.timer`
  (Sunday 03:00, `Persistent=true` so a missed run happens at the next boot).
- **In Kubernetes:** three `CronJob`s (`*/15 * * * *`, `0 7 * * *`, `0 3 * * 0`,
  `timeZone: Asia/Tashkent`, `concurrencyPolicy: Forbid`) sharing a small persistent volume for
  `data/` (the state database must survive between runs).

Why not a loop inside a long-running process? A process that sleeps 15 minutes
can die silently; a timer or CronJob is restarted, logged and monitored by the platform.

## 8. Group routing in CallMind (phase 3)

### How CallMind searches today

```
 question ──▶ embed ──▶ score against EVERY chunk of the tenant (BM25 + vector) ──▶ top 5 ──▶ LLM
```

All documents of a company sit in one pool. A question about a personal car
loan competes with business-loan pages, news and deposit pages that also say
"kredit" and "foiz stavkasi".

### What we will build

```
                    ┌─ group profiles (built once from groups.json + page titles)
                    ▼
 question ──▶ embed ──▶ pick 1–2 groups ──▶ search only those groups, in the caller's language ──▶ top 5 ──▶ LLM
                    │        ▲                         │
                    │   sticky: last group of          └─ confidence low? ──▶ search everything (today's behaviour)
                    │   this call is favoured
```

**Measured, not guessed** (42 questions, right page first / in the top five / MRR):

| method | first | top 5 | MRR | search time |
|---|---|---|---|---|
| plain search over everything (today) | 55% | 90% | 0.70 | ~1 s |
| grouped, best group only | 60% | 79% | 0.68 | ~0.09 s |
| **grouped, 3 best groups + focus (shipped)** | **67%** | 88% | **0.76** | ~0.15 s |
| an LLM picks the group | 67% | 83% | 0.74 | +0.8 s per turn |

Three lessons from measuring:

1. **The original prediction "grouping is about accuracy, not speed" was wrong.**
   Searching all 7,700 chunks (1,536-number vectors, scored in Python) takes about a
   second; searching three groups takes 0.15 s. Your intuition that searching
   everything is slower was right.
2. **Searching only the single best group lost accuracy** (79% in the top five): the
   bank's own menu mixes personal and business loans, so the right page is often in
   the second-best group. Three groups recover it.
3. **The LLM router is not better than the vector router**, and costs 0.8 s per turn.

The fallback (all groups in the caller's language, then everything) means a
routing mistake is never worse than the plain search.

## 9. Phases

1. **Scraper** ✅ — this project.
2. **CallMind import** ✅ — the BRB agents have their own CallMind company
   (tenant), so the pages never mix with other agents' knowledge; import API
   (create-or-replace by URL, delete, list) with page metadata; `CallMindSink`
   here, with a reconcile step every run.
3. **Grouped search** ✅ — language filter, group routing with fallback (§8).
4. **Agent-led call** ✅ — a general "call goal" (purpose, person, facts, what
   to collect, closing) beside the loan-only "Who to call" card; the first goal
   is the online loan application follow-up; a scenario card in the Playground.
5. **Test set** ✅ — `backend/tools/brb_testset.json` + `tools/eval_retrieval.py`
   in CallMind; grow it from Playground calls and knowledge gaps.

The CallMind side is described in CallMind's `docs/brb-knowledge-agent.md`.

## 10. Concepts used here

| Concept | Where | In one line |
|---|---|---|
| Pipeline | `pipeline.py` | a chain of steps, each passing data forward only |
| Adapter | `sources.py` | different sites behind one interface |
| Contract | `Page.to_record()` | the agreed data shape between two systems |
| Content fingerprint | `models.py` | a hash of meaningful content to detect real change |
| Idempotency | whole run | running twice gives the same result as running once |
| Safety brake (circuit breaker) | `diff.py` | stop a destructive action when the numbers look wrong |
| Atomic write | `sinks.py` | write to a temp file, then rename: no half-written files |
| Exponential backoff | `http.py` | wait 1 s, 2 s, 4 s between retries |
| Politeness | `http.py` | robots.txt, rate limit, a clear User-Agent |
| Configuration over code | `sites.yaml` | facts that change often live outside the code |
| Right-sizing | Decision 5 | the simplest design that fits today's scale, with a known next step |

## 11. Live data: only from our two sites

**Rule (decided 24 Nov 2026): every fact comes from brb.uz or brb-tech.uz, nothing else** —
no outside APIs and no model "general knowledge". The CallMind agents carry the same rule
in their instructions (`SOURCES_RULE` in CallMind's `backend/app/brb_setup.py`).

What brb.uz shows that changes during the day is not in its HTML: the page loads it with
JavaScript. Where each kind of data stands:

| Data | Changes | On our sites | Now |
|---|---|---|---|
| Exchange rates (buy/sell) | during the day | brb.uz "Valyutalar kursi" loads them from `/api/currency/compare?type=jismoniy\|yuridik` (values in tiyin) | ✅ read every 15 minutes (`brb_rates`); the agent quotes them with the "Yangilangan" time |
| Gold bars and coins | daily | brb.uz "Oltin quymalari": a "narxini bilish" button, no price published | the agent says the price is not on the site and points to the page / 1254 |
| Offices, ATMs | occasionally | brb.uz loads them from `/api/locations/…` | the office list page is in the knowledge base (weekly) |
| Deposit/loan rates, tariffs, promotions | days to weeks | product and news pages (HTML) | ✅ daily for edited pages, weekly for all |
| The caller's own loan, card, balance | real time, private | not on the websites | out of scope (core banking, authenticated) |

**robots.txt.** brb.uz closes `/api` to bots. BRB-TECH, which runs the site, approved reading
`/api/currency/compare` (24 Nov 2026); the exception is one line, `robots_allow` on the
`brb_rates` site, and nothing else under `/api` is read. Ask the web team to add
`Allow: /api/currency/compare` to robots.txt, then delete that line.

**How a rate reaches the caller:**

1. Every 15 minutes the scraper reads both rate types and writes two pages in Uzbek, e.g.
   "AQSH dollari (USD): sotib olish 11 970 so'm, sotish 12 060 so'm" with
   "Yangilangan: 2026-yil 24-noyabr, soat 12:57".
2. They live in their own group, `currency`, so "dollar kursi qancha?" searches only them.
3. The agent quotes the figure **with its date and time**, picks buy or sell from what the caller
   wants to do, uses individual rates unless the caller is a company, and may multiply for a sum.
4. If brb.uz does not answer, discovery fails and nothing is changed: the last rates stay, with
   their old time, which the agent says out loud. It never guesses.

**When to move to a lookup at answer time:** if 15 minutes is ever too old (for example rates
that change every minute), the agent should call the endpoint during the conversation (a tool
call, cached 1–5 minutes) instead of reading a copy. That needs tool calling in CallMind's
conversation engine; at today's update frequency the copy is accurate enough and simpler.
