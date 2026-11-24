# BRB knowledge scraper

Reads **brb.uz** and **brb-tech.uz** (rates every 15 min, edited pages daily, everything weekly) into clean,
grouped pages for the CallMind BRB agent's knowledge base.
How and why it is built this way: [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup

Python 3.12+.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Commands

```powershell
python -m brb_scraper run                              # weekly: every site, every page
python -m brb_scraper run --changed-only               # daily: only new pages and pages whose date moved
python -m brb_scraper run --site brb_rates             # every 15 min: brb.uz exchange rates
python -m brb_scraper run --site brb --limit 20 --dry-run   # quick test, writes nothing
python -m brb_scraper show https://brb.uz/ru/fizicheskim-litsam/vklady   # one page as the scraper sees it
python -m brb_scraper status                           # pages per site / group / language, last runs
python -m pytest -q                                    # tests
```

Exit codes: `0` ok, `1` partial (some pages failed, or the safety brake held),
`2` failed.

## What it produces (`data/`, not in git)

| Path | What |
|---|---|
| `output/pages/<site>/<id>.json` | one cleaned page (the contract with CallMind — see ARCHITECTURE.md §5) |
| `output/manifest.json` | every live page: id, url, site, lang, group, title, fingerprint |
| `output/groups.json` | the groups with descriptions and keywords |
| `reports/<job>/latest.md` | the job's last run: counts, changes, failures, pages that need a rule (`all` = weekly, `all-changed` = daily, `brb_rates` = rates; last 50 kept per job) |
| `state.db` | fingerprints from the last run (how "changed" is detected) |
| `logs/` | one log file per day |

## Sending pages to CallMind

Put two lines in `.env` next to this README (git-ignored):

```
CALLMIND_URL=http://127.0.0.1:8100
CALLMIND_API_KEY=ovoz_sk_...
```

The key belongs to the BRB company in CallMind (`python -m app.brb_setup --new-key`
in CallMind's `backend/`). With both set, every run also sends new and changed
pages to CallMind's import API and then **reconciles**: it re-sends whatever
CallMind is missing or holds in an older version, and removes pages that are no
longer live (never on a partial run, and never more than 20% at once). The
report gets a "Sent to CallMind" section. Without them, only files are written.

## Schedules: three jobs

| Job | When | Command | What it reads |
|---|---|---|---|
| rates | every 15 min | `run --site brb_rates` | brb.uz exchange rates (individuals, businesses, mobile app): 2 JSON requests |
| daily | 07:00 | `run --changed-only` | the sitemap and API lists, then only new or edited pages (news, promotions, changed product pages) |
| weekly | Sunday 03:00 | `run` | everything; the only run that removes pages from CallMind |

Each site has its own lock (`data/locks/`), so the jobs can overlap safely. Why these
three: ARCHITECTURE.md §7.

On Windows (Task Scheduler):

```powershell
schtasks /Create /TN "BRB rates" /SC MINUTE /MO 15 /TR "cmd /c cd /d \"D:\WORK\callmind\brb-scraper\" && python -m brb_scraper run --site brb_rates"
```

```powershell
schtasks /Create /TN "BRB scraper daily" /SC DAILY /ST 07:00 /TR "cmd /c cd /d \"D:\WORK\callmind\brb-scraper\" && python -m brb_scraper run --changed-only"
```

```powershell
schtasks /Create /TN "BRB knowledge scraper" /SC WEEKLY /D SUN /ST 03:00 /TR "cmd /c cd /d \"D:\WORK\callmind\brb-scraper\" && python -m brb_scraper run"
```

On the CallMind server, systemd timers in `deploy/`: `brb-scraper-rates.timer`,
`brb-scraper-daily.timer`, `brb-scraper.timer` (install steps in `deploy/brb-scraper.service`).

## Changing what is scraped

Everything about the websites lives in [config/sites.yaml](config/sites.yaml).
Only **Uzbek** pages are kept (`keep_langs: [uz]` for brb.uz, `languages: {uz: uz}`
for brb-tech.uz): the Russian and English pages are mostly translations. Known cost:
Russian questions about products with translated names ("Мечта" = "Orzu") are often
missed (6 of 12 Russian test questions found, 10 of 12 with Russian pages). To bring a
language back, add it there and run once; to drop more than 20% of pages in one run,
add `--allow-mass-removal`.

- **a page lands in the wrong group / in `other`** → add its URL pattern under that site's `groups:` (first match wins);
- **a section should not be indexed** → add a pattern to `exclude:`;
- **menu or footer text shows up in pages** → add a CSS selector to `drop_selectors:` or a line to `drop_lines:`;
- after a change, check one page with `show`, then run.

Each run's report lists the pages in no group, thin pages (possible extraction
problems) and lines repeated on many pages (likely template text), so you know
what to tune.

## Network notes

- Uses certifi's certificate bundle. If a company firewall re-signs HTTPS,
  set `SCRAPER_TLS=system` to trust the operating system's certificates.
- The scraper obeys robots.txt, sends at most ~4 requests per second per site,
  and identifies itself as `BRB-CallMind-KnowledgeBot/1.0`.
