"""Where finished pages go: JSON files always, and CallMind when it is configured.

The pipeline calls three methods and never knows what is behind them:

    upsert(page)                       a page is new or changed
    delete(page_id, site, url)         a page is gone
    finalize(pages, allow_deletes, heal)  the run is over; `pages` is every live page

`FileSink` writes data/output/. `CallMindSink` sends the same pages to
CallMind's import API (PUT /knowledge/pages, create-or-replace by URL) and, at
the end of every run, *reconciles*: it asks CallMind which pages it has and
re-sends anything missing or outdated (from the files), and removes pages that
are no longer live. So a failed request, a wiped CallMind database or a run that
crashed half-way all heal on the next daily or weekly run (the 15-minute
rates run only sends its own pages: heal=False). `make_sinks` turns CallMind on when
CALLMIND_URL and CALLMIND_API_KEY are set.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Protocol

import httpx

from .config import GroupInfo
from .models import Page, utc_now

log = logging.getLogger(__name__)


class Sink(Protocol):
    def upsert(self, page: Page) -> None: ...

    def delete(self, page_id: str, site: str, url: str) -> None: ...

    def finalize(self, pages: list[dict], allow_deletes: bool, allow_mass: bool = False,
                 heal: bool = True) -> None: ...


def _write_json(path: Path, data: object) -> None:
    """Write to a temporary file, then rename: a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _groups_json(groups: dict[str, GroupInfo]) -> dict:
    return {gid: {"title": g.title, "description": g.description, "keywords": g.keywords} for gid, g in groups.items()}


class FileSink:
    """data/output/
         pages/<site>/<page_id>.json   one file per page (Page.to_record())
         manifest.json                 every live page: id, url, site, lang, group, title, fingerprint, file
         groups.json                   the group list with descriptions and keywords, for routing
    """

    def __init__(self, out_dir: Path, groups: dict[str, GroupInfo]):
        self.out_dir = out_dir
        self.groups = groups

    def path(self, page_id: str, site: str) -> Path:
        return self.out_dir / "pages" / site / f"{page_id}.json"

    def upsert(self, page: Page) -> None:
        _write_json(self.path(page.page_id, page.site), page.to_record())

    def delete(self, page_id: str, site: str, url: str) -> None:
        self.path(page_id, site).unlink(missing_ok=True)

    def finalize(self, pages: list[dict], allow_deletes: bool, allow_mass: bool = False,
                 heal: bool = True) -> None:
        _write_json(self.out_dir / "manifest.json", {"generated_at": utc_now(), "count": len(pages), "pages": pages})
        _write_json(self.out_dir / "groups.json", _groups_json(self.groups))


class CallMindSink:
    """Sends pages to CallMind. Needs the FileSink's files for the reconcile step."""

    BATCH = 25

    def __init__(self, base_url: str, api_key: str, files: FileSink, groups: dict[str, GroupInfo],
                 max_removed_share: float, transport: httpx.BaseTransport | None = None):
        self.files = files
        self.groups = groups
        self.max_removed_share = max_removed_share
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
            timeout=120,
            transport=transport,
        )
        self.buffer: list[dict] = []
        self.stats = {"sent": 0, "created": 0, "updated": 0, "unchanged": 0, "removed": 0, "resent": 0, "errors": 0}
        self.notes: list[str] = []

    # ── the three sink methods ─────────────────────────────────────
    def upsert(self, page: Page) -> None:
        if not page.text.strip():
            # Nothing to search (a page whose content the site loads with JavaScript): not sent.
            self.stats["skipped_empty"] = self.stats.get("skipped_empty", 0) + 1
            return
        self.buffer.append(page.to_record())
        if len(self.buffer) >= self.BATCH:
            self._flush()

    def delete(self, page_id: str, site: str, url: str) -> None:
        self._delete([url])

    def finalize(self, pages: list[dict], allow_deletes: bool, allow_mass: bool = False,
                 heal: bool = True) -> None:
        self._flush()
        if heal:
            self._call("PUT", "/knowledge/groups", {"groups": _groups_json(self.groups)})
            self._reconcile(pages, allow_deletes, allow_mass)
        self.client.close()

    # ── internals ──────────────────────────────────────────────────
    def _call(self, method: str, path: str, body: dict | None = None) -> dict | None:
        try:
            res = self.client.request(method, path, json=body)
        except httpx.HTTPError as err:
            self.stats["errors"] += 1
            self.notes.append(f"{method} {path}: {err}")
            log.error("CallMind %s %s failed: %s", method, path, err)
            return None
        if res.status_code >= 400:
            self.stats["errors"] += 1
            self.notes.append(f"{method} {path}: HTTP {res.status_code} {res.text[:200]}")
            log.error("CallMind %s %s: HTTP %s %s", method, path, res.status_code, res.text[:200])
            return None
        return res.json()

    def _send(self, records: list[dict]) -> bool:
        out = self._call("PUT", "/knowledge/pages", {"pages": records})
        if out is None:
            return False
        self.stats["sent"] += len(records)
        for key in ("created", "updated", "unchanged"):
            self.stats[key] += int(out.get(key) or 0)
        for r in out.get("rejected") or []:
            self.stats["rejected"] = self.stats.get("rejected", 0) + 1
            self.notes.append(f"rejected by CallMind: {r.get('url')} — {r.get('error')}")
        return True

    def _flush(self) -> None:
        while self.buffer:
            batch, self.buffer = self.buffer[: self.BATCH], self.buffer[self.BATCH:]
            self._send(batch)

    def _delete(self, urls: list[str]) -> None:
        if not urls:
            return
        out = self._call("POST", "/knowledge/pages/delete", {"urls": urls})
        if out:
            self.stats["removed"] += int(out.get("removed") or 0)

    def _reconcile(self, live: list[dict], allow_deletes: bool, allow_mass: bool = False) -> None:
        """Make CallMind hold exactly the live pages, at their current fingerprint."""
        remote = self._call("GET", "/knowledge/pages")
        if remote is None:
            return
        have = {p["url"]: p["fingerprint"] for p in remote.get("pages", [])}
        stale = [p for p in live if have.get(p["url"]) != p["fingerprint"]]
        records = []
        for p in stale:
            path = self.files.path(p["id"], p["site"])
            if path.exists():
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("text", "").strip():
                    records.append(record)
        for i in range(0, len(records), self.BATCH):
            if self._send(records[i:i + self.BATCH]):
                self.stats["resent"] += len(records[i:i + self.BATCH])

        # Empty pages are live here but never sent, so they do not count as "extra" in CallMind either.
        live_urls = {p["url"] for p in live}
        extra = [url for url in have if url not in live_urls]
        if not extra:
            return
        if not allow_deletes:
            self.notes.append(f"{len(extra)} pages in CallMind are not live here; not removed (partial run)")
            return
        if not allow_mass and have and len(extra) / len(have) > self.max_removed_share and len(have) >= 10:
            self.notes.append(f"safety brake: would remove {len(extra)} of {len(have)} pages from CallMind; removed none")
            return
        for i in range(0, len(extra), 100):
            self._delete(extra[i:i + 100])


class Sinks:
    """Fans the three calls out to every configured sink (files first, so they exist for the reconcile)."""

    def __init__(self, sinks: list):
        self.sinks = sinks

    def upsert(self, page: Page) -> None:
        for s in self.sinks:
            s.upsert(page)

    def delete(self, page_id: str, site: str, url: str) -> None:
        for s in self.sinks:
            s.delete(page_id, site, url)

    def finalize(self, pages: list[dict], allow_deletes: bool, allow_mass: bool = False,
                 heal: bool = True) -> None:
        for s in self.sinks:
            s.finalize(pages, allow_deletes, allow_mass, heal)

    @property
    def callmind(self) -> CallMindSink | None:
        return next((s for s in self.sinks if isinstance(s, CallMindSink)), None)


def make_sinks(out_dir: Path, groups: dict[str, GroupInfo], max_removed_share: float) -> Sinks:
    files = FileSink(out_dir, groups)
    sinks: list = [files]
    url, key = os.environ.get("CALLMIND_URL"), os.environ.get("CALLMIND_API_KEY")
    if url and key:
        sinks.append(CallMindSink(url, key, files, groups, max_removed_share))
    return Sinks(sinks)
