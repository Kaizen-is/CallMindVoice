"""Refresh tiers: the 15-minute rates source, the daily changed-only filter, robots exceptions, site locks."""
import os
import time
from datetime import date

import httpx
import pytest

from brb_scraper import pipeline
from brb_scraper.config import load_config, robots_allow
from brb_scraper.groups import is_excluded, page_path
from brb_scraper.http import HttpClient
from brb_scraper.models import PageRef
from brb_scraper.pipeline import RunOptions, SiteBusy, _take_lock, edited_since, job_name
from brb_scraper.sources import CurrencySource, som, uz_datetime

CFG = load_config()
RATES = CFG.sites["brb_rates"]

# The shape brb.uz returns (values in tiyin), trimmed.
JISMONIY = {
    "success": True,
    "updated_at": "2026-11-24 12:38:03",
    "data": [
        {"code": "USD", "icon": "", "buy": 1197000, "sell": 1206000, "buy_change": -2000, "sell_change": -1000},
        {"code": "EUR", "icon": "", "buy": 1280000, "sell": 1350000, "buy_change": 0, "sell_change": 0},
        {"code": "MOBIL USD", "icon": "", "buy": 1197000, "sell": 1204000, "buy_change": -2000, "sell_change": -1000},
    ],
}
YURIDIK = {"success": True, "updated_at": "2026-11-24 12:38:04",
           "data": [{"code": "RUB", "icon": "", "buy": 14234, "sell": 15114, "buy_change": 0, "sell_change": 0}]}


class FakeHttp:
    def __init__(self, bodies: dict[str, dict], status: int = 200):
        self.bodies, self.status, self.calls = bodies, status, []

    def get(self, url, params=None):
        self.calls.append((url, params))
        return httpx.Response(self.status, json=self.bodies.get((params or {}).get("type"), {}))


def test_money_and_dates_read_like_the_site():
    assert som(1197000) == "11 970"
    assert som(1289328) == "12 893,28"
    assert som(-2000) == "-20"
    assert som(5000) == "50"
    assert uz_datetime("2026-11-24 12:38:03") == "2026-yil 24-noyabr, soat 12:38"


def test_rates_become_one_page_per_type():
    src = CurrencySource(RATES, FakeHttp({"jismoniy": JISMONIY, "yuridik": YURIDIK}))
    refs = src.discover()
    assert [r.url for r in refs] == ["https://brb.uz/valyutalar-kursi#jismoniy", "https://brb.uz/valyutalar-kursi#yuridik"]
    assert src.http.calls[0] == ("https://brb.uz/api/currency/compare", {"type": "jismoniy"})
    page = src.load(refs[0])
    assert page.group == "currency" and page.kind == "rates" and page.lang == "uz"
    assert page.title == "BRB valyuta kurslari — jismoniy shaxslar uchun"
    assert "Yangilangan: 2026-yil 24-noyabr, soat 12:38 (Toshkent vaqti)" in page.text
    assert ("- AQSH dollari (USD): sotib olish 11 970 so'm, sotish 12 060 so'm "
            "(oldingi kursga nisbatan o'zgarish: sotib olish -20 so'm, sotish -10 so'm)") in page.text
    assert "- Yevro (EUR): sotib olish 12 800 so'm, sotish 13 500 so'm\n" in page.text  # no change: no note
    assert "BRB mobil ilovasida (MOBIL USD): sotib olish 11 970 so'm, sotish 12 040 so'm" in page.text
    assert "Rossiya rubli (RUB): sotib olish 142,34 so'm" in src.load(refs[1]).text


def test_a_broken_rates_answer_changes_nothing():
    # Discovery fails, so the pipeline keeps the last good rates (with their old time) instead of deleting them.
    with pytest.raises(Exception):
        CurrencySource(RATES, FakeHttp({}, status=500)).discover()
    with pytest.raises(Exception):
        CurrencySource(RATES, FakeHttp({"jismoniy": {"success": False, "data": []}})).discover()


def test_robots_exception_is_only_what_the_owner_allowed():
    assert robots_allow(CFG) == ["https://brb.uz/api/currency/compare"]
    http = HttpClient("test", 5, 0, 0, robots_allow=robots_allow(CFG))
    http._robots["https://brb.uz"] = None  # pretend robots.txt was read; the exception must not depend on it
    assert http.allowed("https://brb.uz/api/currency/compare")
    from urllib.robotparser import RobotFileParser
    closed = RobotFileParser()
    closed.parse(["User-agent: *", "Disallow: /api"])
    http._robots["https://brb.uz"] = closed
    assert http.allowed("https://brb.uz/api/currency/compare")
    assert not http.allowed("https://brb.uz/api/locations/x.json")
    http.close()


def test_the_javascript_rates_page_is_left_to_the_rates_site():
    brb = CFG.sites["brb"]
    assert is_excluded(page_path("https://brb.uz/valyutalar-kursi", brb), brb)


def ref(url, lastmod):
    return PageRef(url=url, site="brb", lang="uz", lastmod=lastmod)


def test_daily_run_loads_only_new_or_edited_pages():
    known = {"a": "2026-10-01", "b": "2026-10-01", "c": None, "d": "2026-11-23", "e": "2026-11-01"}
    refs = [ref("a", "2026-10-01"),   # same date: skip
            ref("b", "2026-11-20"),   # date moved: load
            ref("c", None),           # no date: weekly run's job
            ref("d", "2026-11-23"),   # same date but yesterday: may have changed again, load
            ref("e", None),           # had a date, now none: no signal, skip
            ref("new", None)]         # never seen: load
    got = [r.url for r in edited_since(refs, known, today=date(2026, 11, 24))]
    assert got == ["b", "d", "new"]


def test_job_names_keep_reports_apart():
    assert job_name(RunOptions()) == "all"
    assert job_name(RunOptions(changed_only=True)) == "all-changed"
    assert job_name(RunOptions(sites=["brb_rates"])) == "brb_rates"


def test_site_lock_waits_then_gives_up(tmp_path):
    lock = tmp_path / "locks" / "brb.lock"
    _take_lock(lock)
    with pytest.raises(SiteBusy):
        _take_lock(lock, wait_sec=0)
    lock.unlink()
    _take_lock(lock)  # free again
    old = time.time() - pipeline.LOCK_STALE_SEC - 10
    os.utime(lock, (old, old))
    _take_lock(lock)  # a crashed run's lock is taken over
