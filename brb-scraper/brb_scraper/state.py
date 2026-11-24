"""The scraper's memory between runs: one SQLite file (data/state.db).

It answers one question for the next run — "what did each page look like last
time?" — through its fingerprint, and keeps a short history of runs. The page
content itself lives in the output files, not here.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .models import Page, utc_now

SCHEMA = """
CREATE TABLE IF NOT EXISTS pages (
    url            TEXT PRIMARY KEY,
    page_id        TEXT NOT NULL,
    site           TEXT NOT NULL,
    lang           TEXT NOT NULL,
    grp            TEXT NOT NULL,
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    source_lastmod TEXT,
    status         TEXT NOT NULL DEFAULT 'active',   -- active | removed
    first_seen     TEXT NOT NULL,
    last_seen      TEXT NOT NULL,
    last_changed   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(site, status);

CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,                       -- running | ok | partial | failed
    summary     TEXT NOT NULL DEFAULT '{}'
);
"""


class StateStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        # The 15-minute, daily and weekly runs can overlap: wait for the other writer instead of failing,
        # and let readers read while one writes (WAL).
        self.db = sqlite3.connect(path, timeout=120)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    # ── pages ─────────────────────────────────────────────────────
    def active_fingerprints(self, site: str) -> dict[str, str]:
        rows = self.db.execute("SELECT url, fingerprint FROM pages WHERE site=? AND status='active'", (site,))
        return {r["url"]: r["fingerprint"] for r in rows}

    def active_lastmods(self, site: str) -> dict[str, str | None]:
        rows = self.db.execute("SELECT url, source_lastmod FROM pages WHERE site=? AND status='active'", (site,))
        return {r["url"]: r["source_lastmod"] for r in rows}

    def save_page(self, page: Page, changed: bool) -> None:
        now = utc_now()
        self.db.execute(
            """INSERT INTO pages (url, page_id, site, lang, grp, kind, title, fingerprint, source_lastmod,
                                  status, first_seen, last_seen, last_changed)
               VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)
               ON CONFLICT(url) DO UPDATE SET
                 page_id=excluded.page_id, lang=excluded.lang, grp=excluded.grp, kind=excluded.kind,
                 title=excluded.title, fingerprint=excluded.fingerprint, source_lastmod=excluded.source_lastmod,
                 status='active', last_seen=excluded.last_seen,
                 last_changed=CASE WHEN ? THEN excluded.last_changed ELSE pages.last_changed END""",
            (page.url, page.page_id, page.site, page.lang, page.group, page.kind, page.title, page.fingerprint,
             page.source_lastmod, now, now, now, 1 if changed else 0),
        )

    def mark_removed(self, url: str) -> None:
        self.db.execute("UPDATE pages SET status='removed', last_seen=? WHERE url=?", (utc_now(), url))

    def page_id_of(self, url: str) -> str | None:
        row = self.db.execute("SELECT page_id FROM pages WHERE url=?", (url,)).fetchone()
        return row["page_id"] if row else None

    def active_pages(self) -> list[dict]:
        rows = self.db.execute(
            """SELECT page_id AS id, url, site, lang, grp AS "group", kind, title, fingerprint, last_changed
               FROM pages WHERE status='active' ORDER BY site, grp, lang, url"""
        )
        return [dict(r) | {"file": f"pages/{r['site']}/{r['id']}.json"} for r in rows]

    def counts(self) -> list[sqlite3.Row]:
        return self.db.execute(
            """SELECT site, grp, lang, COUNT(*) AS n FROM pages WHERE status='active'
               GROUP BY site, grp, lang ORDER BY site, grp, lang"""
        ).fetchall()

    # ── runs ──────────────────────────────────────────────────────
    def start_run(self, run_id: str) -> None:
        self.db.execute("INSERT INTO runs (id, started_at, status) VALUES (?,?, 'running')", (run_id, utc_now()))
        self.db.commit()

    def finish_run(self, run_id: str, status: str, summary: dict) -> None:
        self.db.execute(
            "UPDATE runs SET finished_at=?, status=?, summary=? WHERE id=?",
            (utc_now(), status, json.dumps(summary, ensure_ascii=False), run_id),
        )
        self.db.commit()

    def last_runs(self, n: int = 8) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (n,)).fetchall()

    def commit(self) -> None:
        self.db.commit()
