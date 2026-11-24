"""Command line.

    python -m brb_scraper run                  scrape every site (the weekly job)
    python -m brb_scraper run --changed-only   only new or edited pages (the daily job)
    python -m brb_scraper run --site brb_rates exchange rates (the 15-minute job)
    python -m brb_scraper run --site brb --limit 20 --dry-run
    python -m brb_scraper show <url>           print one page as the scraper sees it
    python -m brb_scraper status               pages per site / group / language, last runs

Exit codes, for the scheduler: 0 ok, 1 partial (some pages failed or the
safety brake held), 2 failed.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from .config import DEFAULT_CONFIG, ROOT, load_config, robots_allow
from .groups import group_by_url, lang_of, page_path
from .http import HttpClient
from .models import PageRef
from .pipeline import RunOptions, run
from .sources import make_source
from .state import StateStore


def load_dotenv(path: Path) -> None:
    """KEY=value lines from `.env` (CALLMIND_URL, CALLMIND_API_KEY…); real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    load_dotenv(ROOT / ".env")
    ap = argparse.ArgumentParser(prog="brb_scraper")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="scrape and update the output")
    p_run.add_argument("--site", action="append", help="only this site (repeatable)")
    p_run.add_argument("--limit", type=int, help="load at most N pages per site (testing)")
    p_run.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    p_run.add_argument("--allow-mass-removal", action="store_true", help="release the safety brake for this run")
    p_run.add_argument("--changed-only", action="store_true",
                       help="load only new pages and pages whose sitemap/API date moved (the daily job)")

    p_show = sub.add_parser("show", help="print one page as the scraper sees it")
    p_show.add_argument("url")

    sub.add_parser("status", help="what is in the knowledge output now")

    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    _logging(cfg.run.data_dir, args.verbose)

    if args.cmd == "run":
        unknown = [s for s in args.site or [] if s not in cfg.sites]
        if unknown:
            logging.error("unknown site(s) %s; configured: %s", unknown, sorted(cfg.sites))
            return 2
        opts = RunOptions(sites=args.site, limit=args.limit, dry_run=args.dry_run,
                          allow_mass_removal=args.allow_mass_removal, changed_only=args.changed_only)
        status, _, report = run(cfg, opts)
        logging.info("run %s — report: %s", status, report)
        return {"ok": 0, "partial": 1}.get(status, 2)

    if args.cmd == "show":
        site = next((s for s in cfg.sites.values() if args.url.startswith(s.base_url)), None)
        if site is None:
            print("This URL belongs to none of the configured sites.")
            return 2
        with HttpClient(cfg.run.user_agent, cfg.run.timeout_sec, cfg.run.retries, cfg.run.min_delay_sec,
                        robots_allow=robots_allow(cfg)) as http:
            path = page_path(args.url, site)
            ref = PageRef(url=args.url.rstrip("/"), site=site.id, lang=lang_of(args.url, site),
                          group=group_by_url(path, site))
            page = make_source(site, http).load(ref)
        print(f"title:      {page.title}\nbreadcrumb: {' > '.join(page.breadcrumb)}\n"
              f"group:      {page.group}\nlang:       {page.lang}\nchars:      {len(page.text)}\n"
              f"fingerprint:{page.fingerprint}\n{'─' * 60}\n{page.text}")
        return 0

    if args.cmd == "status":
        state = StateStore(cfg.run.data_dir / "state.db")
        print(f"{'site':10} {'group':20} {'lang':5} pages")
        for r in state.counts():
            print(f"{r['site']:10} {r['grp']:20} {r['lang']:5} {r['n']}")
        print("\nlast runs:")
        for r in state.last_runs():
            print(f"  {r['id']}  {r['status']:8} {r['finished_at'] or '(running)'}")
        state.close()
        return 0
    return 2


def _logging(data_dir, verbose: bool) -> None:
    logs = data_dir / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    fmt = "%(asctime)s %(levelname)-7s %(message)s"
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format=fmt,
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(logs / f"{datetime.now():%Y-%m-%d}.log", encoding="utf-8"),
        ],
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


if __name__ == "__main__":
    sys.exit(main())
