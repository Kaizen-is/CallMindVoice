"""The data that moves through the pipeline.

Two shapes only:

  PageRef  a page we know exists (found in a sitemap or an API) but have not
           loaded yet. Cheap: just a URL plus what discovery already knows.
  Page     a loaded, cleaned page. This is the unit the scraper hands over to
           CallMind, so its `to_record()` output is the contract between them.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


@dataclass
class PageRef:
    url: str
    site: str
    lang: str
    # page | news | project | team | partners
    kind: str = "page"
    # Last-modified date from the sitemap or the API, when the source has one.
    lastmod: str | None = None
    # Filled in by grouping (groups.py) before the page is loaded.
    group: str | None = None
    # API sources already hold the content after discovery; HTML sources don't.
    data: dict | None = field(default=None, repr=False)


@dataclass
class Page:
    url: str
    site: str
    lang: str
    group: str
    kind: str
    title: str
    breadcrumb: list[str]
    # Markdown: `#` headings, `- ` list items, one fact per line.
    text: str
    source_lastmod: str | None
    fetched_at: str = field(default_factory=utc_now)

    @property
    def fingerprint(self) -> str:
        """Changes only when what a reader sees changes.

        Built from the cleaned text, never from raw HTML: raw HTML differs on
        every request (tokens, timestamps, ad slots), which would make every
        page look "changed" on every run.
        """
        body = "\n".join([self.title, " > ".join(self.breadcrumb), self.text])
        return "sha256:" + hashlib.sha256(body.encode("utf-8")).hexdigest()

    @property
    def page_id(self) -> str:
        return hashlib.sha1(self.url.encode("utf-8")).hexdigest()[:16]

    def to_record(self) -> dict:
        return {
            "id": self.page_id,
            "url": self.url,
            "site": self.site,
            "lang": self.lang,
            "group": self.group,
            "kind": self.kind,
            "title": self.title,
            "breadcrumb": self.breadcrumb,
            "text": self.text,
            "chars": len(self.text),
            "fingerprint": self.fingerprint,
            "source_lastmod": self.source_lastmod,
            "fetched_at": self.fetched_at,
        }
