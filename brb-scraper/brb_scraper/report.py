"""The run report: what happened, and what needs a person's eye.

A scraper that runs unattended every night is only trustworthy if someone can
see, in one minute, that it did the right thing. So every run writes
data/reports/<job>/<run>.md (for people) and <run>.json (for tools), and
data/reports/<job>/latest.md is the newest one. <job> is "all" for the weekly
run, "all-changed" for the daily one and "brb_rates" for the 15-minute one;
each folder keeps its last KEEP_REPORTS runs.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .pipeline import RunOptions, SiteResult

THIN_PAGE_CHARS = 200        # less text than this usually means the extractor missed the content
BOILERPLATE_SHARE = 0.3      # a line on more than 30% of a site's pages is probably template text
LIST_LIMIT = 40
KEEP_REPORTS = 50            # per job: the rates job alone writes 96 reports a day


def write_report(out_dir: Path, run_id: str, results: list["SiteResult"], seconds: float,
                 opts: "RunOptions", status: str, delivery: dict | None = None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    data = _data(run_id, results, seconds, opts, status)
    data["callmind"] = delivery
    (out_dir / f"{run_id}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    md = _markdown(data)
    path = out_dir / f"{run_id}.md"
    path.write_text(md, encoding="utf-8")
    (out_dir / "latest.md").write_text(md, encoding="utf-8")
    for old in sorted(out_dir.glob("run-*.md"))[:-KEEP_REPORTS]:
        old.unlink(missing_ok=True)
        old.with_suffix(".json").unlink(missing_ok=True)
    return path


def _data(run_id, results, seconds, opts, status) -> dict:
    sites = []
    for r in results:
        c = r.changes
        groups = Counter((p.group, p.lang) for p in r.pages)
        sites.append({
            "site": r.site,
            "error": r.error,
            "notes": r.notes,
            "discovered": r.discovered,
            "other_lang": r.other_lang,
            "excluded": r.excluded,
            "old_news_skipped": r.old_news,
            "in_scope": r.in_scope,
            "loaded": r.loaded,
            "new": [p.url for p in c.new],
            "changed": [p.url for p in c.changed],
            "unchanged": len(c.unchanged),
            "removed": c.removed,
            "removal_blocked": c.blocked_reason,
            "failed": r.failed,
            "gone": r.gone,
            "groups": [{"group": g, "lang": lang, "pages": n} for (g, lang), n in sorted(groups.items())],
            "unplaced": sorted(p.url for p in r.pages if p.group == "other"),
            # Only HTML pages: a short API news item is short by nature, not an extraction bug.
            "thin_pages": sorted(p.url for p in r.pages if p.kind == "page" and len(p.text) < THIN_PAGE_CHARS),
            "chars_total": sum(len(p.text) for p in r.pages),
            "boilerplate_candidates": _boilerplate(r.pages),
        })
    return {
        "run": run_id,
        "status": status,
        "seconds": round(seconds, 1),
        "dry_run": opts.dry_run,
        "limit": opts.limit,
        "changed_only": opts.changed_only,
        "sites": sites,
    }


def _boilerplate(pages) -> list[dict]:
    """Lines repeated across many pages: candidates for `drop_lines` / `drop_selectors`."""
    if len(pages) < 10:
        return []
    counts: Counter[str] = Counter()
    for p in pages:
        counts.update({line for line in p.text.splitlines() if len(line) > 15})
    limit = BOILERPLATE_SHARE * len(pages)
    return [{"line": line[:120], "pages": n} for line, n in counts.most_common(15) if n > limit]


def _markdown(d: dict) -> str:
    out = [f"# Scraper run {d['run']} — {d['status'].upper()}", ""]
    flags = []
    if d["dry_run"]:
        flags.append("dry run: nothing was written")
    if d["limit"]:
        flags.append(f"limited to {d['limit']} pages per site")
    out.append(f"Took {d['seconds']} s." + (f" ({'; '.join(flags)})" if flags else ""))
    if d.get("callmind"):
        st = d["callmind"]["stats"]
        out += ["", "## Sent to CallMind", "",
                f"Sent {st['sent']} pages ({st['created']} created, {st['updated']} updated, {st['unchanged']} "
                f"unchanged), re-sent {st['resent']} during reconcile, removed {st['removed']}, errors {st['errors']}."]
        out += [f"- {n}" for n in d["callmind"]["notes"][:20]]
    for s in d["sites"]:
        out += ["", f"## {s['site']}", ""]
        if s["error"]:
            out += [f"**Error:** {s['error']}", ""]
            continue
        out += [
            "| found | other languages | excluded | old news | in scope | loaded | new | changed | unchanged | removed | failed | gone |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|",
            f"| {s['discovered']} | {s['other_lang']} | {s['excluded']} | {s['old_news_skipped']} | {s['in_scope']} | {s['loaded']} | "
            f"{len(s['new'])} | {len(s['changed'])} | {s['unchanged']} | {len(s['removed'])} | {len(s['failed'])} | {len(s['gone'])} |",
            "",
            f"Text kept: {s['chars_total']:,} characters.",
        ]
        if s["removal_blocked"]:
            out += ["", f"**Safety brake:** {s['removal_blocked']}"]
        for note in s["notes"]:
            out.append(f"- Note: {note}")
        if s["groups"]:
            out += ["", "| group | lang | pages |", "|---|---|---|"]
            out += [f"| {g['group']} | {g['lang']} | {g['pages']} |" for g in s["groups"]]
        out += _url_list("Pages in no group (add a rule in config/sites.yaml)", s["unplaced"])
        out += _url_list("Thin pages (under 200 characters — check the extractor)", s["thin_pages"])
        out += _url_list("Failed (kept the previous version)", [f"{u} — {e}" for u, e in s["failed"].items()])
        out += _url_list("Gone (404/410)", s["gone"])
        out += _url_list("Changed", s["changed"])
        out += _url_list("New", s["new"])
        out += _url_list("Removed", s["removed"])
        if s["boilerplate_candidates"]:
            out += ["", "### Lines repeated on many pages (template text? consider `drop_lines`)"]
            out += [f"- {b['pages']}× {b['line']}" for b in s["boilerplate_candidates"]]
    return "\n".join(out) + "\n"


def _url_list(title: str, items: list[str]) -> list[str]:
    if not items:
        return []
    lines = ["", f"### {title} ({len(items)})"]
    lines += [f"- {x}" for x in items[:LIST_LIMIT]]
    if len(items) > LIST_LIMIT:
        lines.append(f"- … and {len(items) - LIST_LIMIT} more (see the .json report)")
    return lines
