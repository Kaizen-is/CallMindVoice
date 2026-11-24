"""One run, start to finish. This file is the map of the whole scraper:

    for each site:
        discover   → every page the site says it has          (sources.py)
        scope      → drop excluded pages and old news, group the rest   (groups.py)
        load       → fetch + clean, several pages at a time   (sources.py, extract.py)
        regroup    → pages no URL rule matched get a second chance by breadcrumb
        diff       → new / changed / unchanged / removed     (diff.py)
        apply      → write changes to the sink and the state (sinks.py, state.py)
    report         → what happened, what needs a person's eye (report.py)

Each step only hands data to the next one; none of them reaches back.

Three schedules use the same code (ARCHITECTURE.md > Refresh tiers):
    run --site brb_rates    every 15 min   exchange rates only
    run --changed-only      daily          every site, but only new or edited pages are loaded
    run                     weekly         everything; the only run that removes pages from CallMind
Each site has its own lock, so these can overlap without two runs reading one site at once.
"""
from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import Config, SiteConfig, robots_allow
from .diff import Changes, plan_changes
from .groups import group_by_breadcrumb, group_by_url, is_excluded, is_news, news_too_old, page_path
from .http import FetchError, HttpClient
from .models import Page, PageRef
from .report import write_report
from .sinks import Sinks, make_sinks
from .sources import PageGone, make_source
from .state import StateStore

log = logging.getLogger(__name__)

LOCK_STALE_SEC = 6 * 3600
LOCK_WAIT_SEC = 10 * 60      # a site busy in another run: wait this long, then skip it for this run
RECENT_EDIT_DAYS = 1         # sitemap dates have no time: a page edited "today" may change again today


@dataclass
class SiteResult:
    site: str
    discovered: int = 0
    other_lang: int = 0
    excluded: int = 0
    old_news: int = 0
    in_scope: int = 0
    loaded: int = 0
    failed: dict[str, str] = field(default_factory=dict)
    gone: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    changes: Changes = field(default_factory=Changes)
    pages: list[Page] = field(default_factory=list)  # every page loaded this run, for the report
    error: str | None = None


@dataclass
class RunOptions:
    sites: list[str] | None = None
    limit: int | None = None
    dry_run: bool = False
    allow_mass_removal: bool = False
    # Load only pages that are new or whose sitemap/API date moved (the daily run).
    changed_only: bool = False


class SiteBusy(RuntimeError):
    pass


def job_name(opts: RunOptions) -> str:
    """What the run reads: "all", "brb_rates", "all-changed"... Reports are kept per job."""
    return ("+".join(sorted(opts.sites)) if opts.sites else "all") + ("-changed" if opts.changed_only else "")


def run(cfg: Config, opts: RunOptions) -> tuple[str, list[SiteResult], Path]:
    data = cfg.run.data_dir
    data.mkdir(parents=True, exist_ok=True)
    job = job_name(opts)
    run_id = datetime.now().strftime("run-%Y%m%d-%H%M%S-") + job
    state = StateStore(data / "state.db")
    sink = make_sinks(data / "output", cfg.groups, cfg.run.max_removed_share)
    started = time.monotonic()
    results: list[SiteResult] = []
    try:
        if not opts.dry_run:
            state.start_run(run_id)
        with HttpClient(cfg.run.user_agent, cfg.run.timeout_sec, cfg.run.retries, cfg.run.min_delay_sec,
                        robots_allow=robots_allow(cfg)) as http:
            for site_id, site in cfg.sites.items():
                if opts.sites and site_id not in opts.sites:
                    continue
                log.info("── %s (%s)", site.name, site.base_url)
                lock = data / "locks" / f"{site_id}.lock"
                try:
                    _take_lock(lock, LOCK_WAIT_SEC)
                except SiteBusy as err:
                    log.error("%s: %s", site_id, err)
                    results.append(SiteResult(site=site_id, error=str(err)))
                    continue
                try:
                    results.append(_run_site(site, http, state, sink, cfg, opts))
                finally:
                    lock.unlink(missing_ok=True)
        callmind = sink.callmind
        if not opts.dry_run:
            # Removing pages from CallMind is only safe when every site was fully read.
            full_run = (not opts.limit and not opts.sites and not opts.changed_only
                        and not any(r.error for r in results))
            # The 15-minute rates run only sends its own pages; the daily and weekly runs also heal CallMind.
            heal = not opts.sites
            if callmind:
                log.info("── CallMind: sending changes%s", " and reconciling" if heal else "")
            sink.finalize(state.active_pages(), allow_deletes=full_run, allow_mass=opts.allow_mass_removal,
                          heal=heal)
        status = _status(results)
        if callmind and callmind.stats["errors"] and status == "ok":
            status = "partial"
        delivery = {"stats": callmind.stats, "notes": callmind.notes} if callmind else None
        report_path = write_report(data / "reports" / job, run_id, results, time.monotonic() - started, opts,
                                   status, delivery)
        if not opts.dry_run:
            state.finish_run(run_id, status, _summary(results))
        return status, results, report_path
    finally:
        state.close()


def _run_site(site: SiteConfig, http: HttpClient, state: StateStore, sink: Sinks,
              cfg: Config, opts: RunOptions) -> SiteResult:
    res = SiteResult(site=site.id)
    source = make_source(site, http)

    # 1. discover
    try:
        refs = source.discover()
    except (FetchError, ValueError) as err:
        # Without the list of pages we cannot tell "removed" from "not found";
        # change nothing for this site and say so in the report.
        res.error = f"discovery failed: {err}"
        log.error("%s: %s", site.id, res.error)
        return res
    res.discovered = len(refs)
    res.notes = source.notes

    # 2. scope + group by URL
    scoped: list[PageRef] = []
    for ref in refs:
        path = page_path(ref.url, site)
        if site.keep_langs and ref.lang not in site.keep_langs:
            res.other_lang += 1
            continue
        if is_excluded(path, site):
            res.excluded += 1
            continue
        if is_news(path, site) and news_too_old(ref.lastmod, site):
            res.old_news += 1
            continue
        ref.group = group_by_url(path, site)
        if is_news(path, site):
            ref.kind = "news"
        scoped.append(ref)
    res.in_scope = len(scoped)
    in_scope_urls = {r.url for r in scoped}
    to_load = scoped
    if opts.changed_only:
        # Pages not loaded stay as they are: the diff only touches what was loaded or left the site.
        to_load = edited_since(scoped, state.active_lastmods(site.id))
    to_load = to_load[: opts.limit] if opts.limit else to_load
    log.info("%s: %d found, %d other languages, %d excluded, %d old news, %d in scope, loading %d",
             site.id, res.discovered, res.other_lang, res.excluded, res.old_news, res.in_scope, len(to_load))

    # 3. load, several at a time
    loaded: dict[str, Page] = {}
    with ThreadPoolExecutor(max_workers=cfg.run.concurrency) as pool:
        futures = {pool.submit(source.load, ref): ref for ref in to_load}
        for i, fut in enumerate(as_completed(futures), 1):
            ref = futures[fut]
            try:
                page = fut.result()
            except PageGone as err:
                res.gone.append(ref.url)
                log.warning("gone %s (%s)", ref.url, err)
                continue
            except Exception as err:  # one bad page must not stop the run
                res.failed[ref.url] = f"{type(err).__name__}: {err}"
                log.warning("failed %s: %s", ref.url, err)
                continue
            # 4. second chance for pages no URL rule placed
            if page.group == site.default_group and site.default_group == "other":
                page.group = group_by_breadcrumb(page.breadcrumb, site) or page.group
            loaded[page.url] = page
            if i % 50 == 0:
                log.info("%s: %d/%d loaded", site.id, i, len(to_load))
    res.loaded = len(loaded)
    res.pages = list(loaded.values())

    # 5. diff
    res.changes = plan_changes(
        known=state.active_fingerprints(site.id),
        loaded=loaded,
        in_scope=in_scope_urls,
        gone=set(res.gone),
        max_removed_share=cfg.run.max_removed_share,
        allow_mass_removal=opts.allow_mass_removal,
    )
    c = res.changes
    log.info("%s: %d new, %d changed, %d unchanged, %d removed%s", site.id, len(c.new), len(c.changed),
             len(c.unchanged), len(c.removed), " (removal blocked)" if c.removal_blocked else "")

    # 6. apply
    if opts.dry_run:
        return res
    for page in c.new + c.changed:
        sink.upsert(page)
        state.save_page(page, changed=True)
    for page in c.unchanged:
        state.save_page(page, changed=False)  # refreshes last_seen and the group
    for url in c.removed:
        page_id = state.page_id_of(url)
        if page_id:
            sink.delete(page_id, site.id, url)
        state.mark_removed(url)
    state.commit()
    return res


def edited_since(refs: list[PageRef], known: dict[str, str | None], today: date | None = None) -> list[PageRef]:
    """The pages worth loading in a daily run: new ones, and those whose date in the sitemap/API moved.

    A page without a date gives no signal and waits for the weekly run. Sitemap dates have no time
    of day, so a page dated today or yesterday is loaded again in case it changed after our last look.
    """
    recent = ((today or date.today()) - timedelta(days=RECENT_EDIT_DAYS)).isoformat()
    out = []
    for ref in refs:
        if ref.url not in known:
            out.append(ref)
        elif ref.lastmod and (ref.lastmod != known[ref.url] or ref.lastmod[:10] >= recent):
            out.append(ref)
    return out


def _status(results: list[SiteResult]) -> str:
    if any(r.error for r in results):
        return "failed" if all(r.error for r in results) else "partial"
    if any(r.failed or r.changes.removal_blocked for r in results):
        return "partial"
    return "ok"


def _summary(results: list[SiteResult]) -> dict:
    return {
        r.site: {
            "in_scope": r.in_scope, "loaded": r.loaded, "failed": len(r.failed), "gone": len(r.gone),
            "new": len(r.changes.new), "changed": len(r.changes.changed),
            "removed": len(r.changes.removed), "error": r.error,
        }
        for r in results
    }


def _take_lock(lock: Path, wait_sec: float = 0) -> None:
    """One run per site at a time (two would race on the same pages). A busy site is waited for,
    then skipped; a lock older than LOCK_STALE_SEC is left over from a crash and is removed."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + wait_sec
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
            except FileNotFoundError:
                continue  # released between the two calls
            if age >= LOCK_STALE_SEC:
                log.warning("removing a stale lock %s (%d h old)", lock.name, age // 3600)
                lock.unlink(missing_ok=True)
                continue
            if time.monotonic() >= deadline:
                raise SiteBusy(f"another run has been reading this site for {int(age)} s; skipped this time")
            time.sleep(2)
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
