from datetime import date

from brb_scraper.config import load_config
from brb_scraper.diff import plan_changes
from brb_scraper.groups import group_by_breadcrumb, group_by_url, is_excluded, lang_of, news_too_old, page_path
from brb_scraper.models import Page

CFG = load_config()
BRB = CFG.sites["brb"]


def group_of(url: str) -> str:
    return group_by_url(page_path(url, BRB), BRB)


def test_language_prefix_is_stripped():
    assert page_path("https://brb.uz/ru/fizicheskim-litsam/kredity/avto", BRB) == "fizicheskim-litsam/kredity/avto"
    assert lang_of("https://brb.uz/ru/fizicheskim-litsam/kredity", BRB) == "ru"
    assert lang_of("https://brb.uz/en/o-bankeen", BRB) == "en"
    assert lang_of("https://brb.uz/jismoniy-shaxslarga/kreditlar", BRB) == "uz"


def test_groups_follow_the_site_menu():
    assert group_of("https://brb.uz/jismoniy-shaxslarga/kreditlar/jac-smart-drive") == "personal_loans"
    assert group_of("https://brb.uz/ru/fizicheskim-litsam/ipoteka") == "personal_loans"
    assert group_of("https://brb.uz/jismoniy-shaxslarga/kartalar/humo") == "personal_cards"
    assert group_of("https://brb.uz/ru/fizicheskim-litsam/vklady") == "personal_deposits"
    assert group_of("https://brb.uz/valyutalar-kursi") == "personal_transfers"
    assert group_of("https://brb.uz/jismoniy-shaxslarga/jismoniy-shaxslar-bank-tariflari") == "personal_general"
    assert group_of("https://brb.uz/kreditlar/lizing") == "business"
    assert group_of("https://brb.uz") == "business"


def test_specific_rules_win_over_general_ones():
    # Investor pages live under bank-haqida/ but must not land in `about`.
    assert group_of("https://brb.uz/bank-haqida/moliyaviy-korsatkichlar") == "investors"
    assert group_of("https://brb.uz/bank-haqida/rahbariyat") == "about"


def test_news_and_exclusions():
    assert group_of("https://brb.uz/axborot-markazi/yangiliklar/abc") == "news"
    assert is_excluded(page_path("https://brb.uz/mulklar/uy-123", BRB), BRB)
    assert is_excluded(page_path("https://brb.uz/axborot-markazi/tenderlar", BRB), BRB)
    # "tenderga-kafolat" is a bank-guarantee product, not a tender notice.
    assert not is_excluded(page_path("https://brb.uz/ru/tenderga-kafolat", BRB), BRB)


def test_news_age_limit():
    today = date(2026, 11, 23)
    assert news_too_old("2025-01-01", BRB, today)
    assert not news_too_old("2026-10-01", BRB, today)
    assert not news_too_old(None, BRB, today)


def test_breadcrumb_fallback():
    assert group_by_breadcrumb(["Физическим лицам", "Кредиты"], BRB) == "personal_loans"
    assert group_by_breadcrumb([], BRB) is None


def _page(url: str, text: str) -> Page:
    return Page(url=url, site="brb", lang="uz", group="g", kind="page", title="t",
                breadcrumb=[], text=text, source_lastmod=None)


def test_diff_new_changed_unchanged_removed():
    a, b, c = _page("u/a", "same"), _page("u/b", "new text"), _page("u/c", "fresh")
    known = {"u/a": a.fingerprint, "u/b": "sha256:old", "u/old": "sha256:x"}
    ch = plan_changes(known, {"u/a": a, "u/b": b, "u/c": c}, in_scope={"u/a", "u/b", "u/c"},
                      gone=set(), max_removed_share=0.9)
    assert [p.url for p in ch.new] == ["u/c"]
    assert [p.url for p in ch.changed] == ["u/b"]
    assert [p.url for p in ch.unchanged] == ["u/a"]
    assert ch.removed == ["u/old"]


def test_failed_page_is_kept():
    # u/b is still in scope but failed to load: it is not loaded, not gone → kept.
    known = {"u/a": "x", "u/b": "y"}
    ch = plan_changes(known, {}, in_scope={"u/a", "u/b"}, gone=set(), max_removed_share=0.2)
    assert ch.removed == []


def test_gone_page_is_removed():
    ch = plan_changes({"u/a": "x"}, {}, in_scope={"u/a"}, gone={"u/a"}, max_removed_share=1.0)
    assert ch.removed == ["u/a"]


def test_safety_brake_blocks_mass_removal():
    known = {f"u/{i}": "x" for i in range(20)}
    ch = plan_changes(known, {}, in_scope={"u/0"}, gone=set(), max_removed_share=0.2)
    assert ch.removed == [] and ch.removal_blocked
    ch = plan_changes(known, {}, in_scope={"u/0"}, gone=set(), max_removed_share=0.2, allow_mass_removal=True)
    assert len(ch.removed) == 19


def test_fingerprint_ignores_fetch_time():
    p1, p2 = _page("u", "text"), _page("u", "text")
    p2.fetched_at = "2030-01-01T00:00:00+00:00"
    assert p1.fingerprint == p2.fingerprint


def test_only_kept_languages():
    assert BRB.keep_langs == ["uz"]
    assert CFG.sites["brbtech"].languages == {"uz": "uz"}
