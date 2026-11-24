"""Loads config/sites.yaml into typed objects and fails early on mistakes.

A typo in the config should stop the run at start-up with a clear message,
not surface as a half-finished crawl at 3 a.m.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "sites.yaml"


class ConfigError(ValueError):
    pass


@dataclass
class RunConfig:
    user_agent: str
    concurrency: int
    min_delay_sec: float
    timeout_sec: float
    retries: int
    max_removed_share: float
    data_dir: Path


@dataclass
class GroupInfo:
    id: str
    title: str
    description: str
    keywords: list[str]


@dataclass
class HtmlRules:
    main_selector: str
    breadcrumb_selector: str | None = None
    breadcrumb_home: list[str] = field(default_factory=list)
    drop_selectors: list[str] = field(default_factory=list)
    drop_lines: list[str] = field(default_factory=list)
    title_suffixes: list[str] = field(default_factory=list)


@dataclass
class SiteConfig:
    id: str
    name: str
    source: str
    base_url: str
    html: HtmlRules
    exclude: list[str]
    news_patterns: list[str]
    news_max_age_days: int
    # Ordered: the first group whose pattern matches wins.
    group_rules: list[tuple[str, list[str]]]
    breadcrumb_groups: list[tuple[str, list[str]]]
    default_group: str = "other"
    # sitemap sources
    sitemap: str | None = None
    default_lang: str = "uz"
    lang_prefixes: dict[str, str] = field(default_factory=dict)
    keep_langs: list[str] = field(default_factory=list)  # empty = every language
    # brbtech_api source
    api_base: str | None = None
    languages: dict[str, str] = field(default_factory=dict)
    html_pages: dict[str, str] = field(default_factory=dict)
    # currency_api source: a JSON endpoint per rate type, published as one page per type
    api_path: str | None = None
    page_url: str | None = None
    rate_types: dict[str, str] = field(default_factory=dict)
    # URL prefixes the site's owner allowed us to read although robots.txt closes them.
    robots_allow: list[str] = field(default_factory=list)


@dataclass
class Config:
    run: RunConfig
    groups: dict[str, GroupInfo]
    sites: dict[str, SiteConfig]


SOURCES = {"sitemap", "brbtech_api", "currency_api"}


def load_config(path: Path = DEFAULT_CONFIG) -> Config:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    r = raw["run"]
    data_dir = Path(r.get("data_dir", "data"))
    run = RunConfig(
        user_agent=r["user_agent"],
        concurrency=int(r.get("concurrency", 4)),
        min_delay_sec=float(r.get("min_delay_sec", 0.25)),
        timeout_sec=float(r.get("timeout_sec", 25)),
        retries=int(r.get("retries", 3)),
        max_removed_share=float(r.get("max_removed_share", 0.2)),
        data_dir=data_dir if data_dir.is_absolute() else ROOT / data_dir,
    )
    groups = {
        gid: GroupInfo(gid, g["title"], g.get("description", ""), [str(k) for k in g.get("keywords", [])])
        for gid, g in raw["groups"].items()
    }
    sites = {sid: _site(sid, s, groups) for sid, s in raw["sites"].items()}
    return Config(run=run, groups=groups, sites=sites)


def robots_allow(cfg: Config) -> list[str]:
    return [u for s in cfg.sites.values() for u in s.robots_allow]


def _site(sid: str, s: dict, groups: dict[str, GroupInfo]) -> SiteConfig:
    if s.get("source") not in SOURCES:
        raise ConfigError(f"site {sid}: source must be one of {sorted(SOURCES)}")
    rules = [(gid, [str(p) for p in pats]) for gid, pats in (s.get("groups") or {}).items()]
    crumbs = [(gid, [str(k).lower() for k in kws]) for gid, kws in (s.get("breadcrumb_groups") or {}).items()]
    default_group = s.get("default_group", "other")
    for gid in [g for g, _ in rules] + [g for g, _ in crumbs] + [default_group, "news"]:
        if gid not in groups:
            raise ConfigError(f"site {sid}: group '{gid}' is not defined under `groups:`")
    h = s.get("html") or {"main_selector": "main"}  # API sources read no HTML
    news = s.get("news") or {}
    return SiteConfig(
        id=sid,
        name=s["name"],
        source=s["source"],
        base_url=s["base_url"].rstrip("/"),
        html=HtmlRules(
            main_selector=h["main_selector"],
            breadcrumb_selector=h.get("breadcrumb_selector"),
            breadcrumb_home=[x.lower() for x in h.get("breadcrumb_home", [])],
            drop_selectors=h.get("drop_selectors", []),
            drop_lines=h.get("drop_lines", []),
            title_suffixes=h.get("title_suffixes", []),
        ),
        exclude=[str(p) for p in s.get("exclude") or []],
        news_patterns=[str(p) for p in news.get("patterns") or []],
        news_max_age_days=int(news.get("max_age_days", 0)),
        group_rules=rules,
        breadcrumb_groups=crumbs,
        default_group=default_group,
        sitemap=s.get("sitemap"),
        default_lang=s.get("default_lang", "uz"),
        lang_prefixes=s.get("lang_prefixes") or {},
        keep_langs=[str(x) for x in s.get("keep_langs") or []],
        api_base=(s.get("api_base") or "").rstrip("/") or None,
        languages=s.get("languages") or {},
        html_pages=s.get("html_pages") or {},
        api_path=s.get("api_path"),
        page_url=s.get("page_url"),
        rate_types=s.get("rate_types") or {},
        robots_allow=[str(x) for x in s.get("robots_allow") or []],
    )
