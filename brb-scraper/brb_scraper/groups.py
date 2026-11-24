"""Scope and grouping: which pages we keep, and which shelf each one goes on.

Pure functions over URLs and config, with no network and no database, so the
rules are easy to test and easy to reason about.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from fnmatch import fnmatchcase
from urllib.parse import urlsplit

from .config import SiteConfig


def page_path(url: str, site: SiteConfig) -> str:
    """URL → the path the rules see: no leading slash, no language prefix."""
    path = urlsplit(url).path.strip("/")
    first, _, rest = path.partition("/")
    if first in site.lang_prefixes.values():
        return rest
    return path


def lang_of(url: str, site: SiteConfig) -> str:
    first = urlsplit(url).path.strip("/").partition("/")[0]
    for lang, prefix in site.lang_prefixes.items():
        if first == prefix:
            return lang
    return site.default_lang


def _matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatchcase(path, p) for p in patterns)


def is_excluded(path: str, site: SiteConfig) -> bool:
    return _matches(path, site.exclude)


def is_news(path: str, site: SiteConfig) -> bool:
    return _matches(path, site.news_patterns)


def news_too_old(lastmod: str | None, site: SiteConfig, today: date | None = None) -> bool:
    if not site.news_max_age_days or not lastmod:
        return False
    try:
        changed = datetime.fromisoformat(lastmod.replace("Z", "+00:00")).date()
    except ValueError:
        return False
    today = today or datetime.now(timezone.utc).date()
    return changed < today - timedelta(days=site.news_max_age_days)


def group_by_url(path: str, site: SiteConfig) -> str:
    if is_news(path, site):
        return "news"
    for group, patterns in site.group_rules:
        if _matches(path, patterns):
            return group
    return site.default_group


def group_by_breadcrumb(breadcrumb: list[str], site: SiteConfig) -> str | None:
    """Second chance for pages no URL rule matched: read the breadcrumb."""
    text = " > ".join(breadcrumb).lower()
    if not text:
        return None
    for group, keywords in site.breadcrumb_groups:
        if any(k in text for k in keywords):
            return group
    return None
