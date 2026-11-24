"""Source adapters: one per website, all with the same two methods.

    discover() → list[PageRef]   what pages exist right now
    load(ref)  → Page            the page's clean content

The pipeline only talks to this interface, so it does not care whether a site
is read from a sitemap + HTML (brb.uz) or from a JSON API (brb-tech.uz).
Adding a third site means writing one more adapter, nothing else.
"""
from __future__ import annotations

import logging
import xml.etree.ElementTree as ET
from typing import Protocol
from urllib.parse import urlsplit

from .config import SiteConfig
from .extract import extract_html, text_from_fragment
from .groups import lang_of
from .http import FetchError, HttpClient
from .models import Page, PageRef

log = logging.getLogger(__name__)

SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


class PageGone(Exception):
    """The page answered 404/410: it no longer exists."""


class Source(Protocol):
    site: SiteConfig
    notes: list[str]

    def discover(self) -> list[PageRef]: ...

    def load(self, ref: PageRef) -> Page: ...


def make_source(site: SiteConfig, http: HttpClient) -> Source:
    if site.source == "sitemap":
        return SitemapSource(site, http)
    if site.source == "brbtech_api":
        return BrbTechSource(site, http)
    if site.source == "currency_api":
        return CurrencySource(site, http)
    raise ValueError(f"unknown source {site.source}")


def _load_html_page(http: HttpClient, site: SiteConfig, ref: PageRef) -> Page:
    res = http.get(ref.url)
    if res.status_code in (404, 410):
        raise PageGone(f"HTTP {res.status_code}")
    if res.status_code != 200:
        raise FetchError(f"HTTP {res.status_code}")
    if "html" not in res.headers.get("content-type", "html"):
        raise FetchError(f"not HTML: {res.headers.get('content-type')}")
    ex = extract_html(res.text, site.html)
    return Page(
        url=ref.url,
        site=site.id,
        lang=ref.lang,
        group=ref.group or site.default_group,
        kind=ref.kind,
        title=ex.title,
        breadcrumb=ex.breadcrumb,
        text=ex.text,
        source_lastmod=ref.lastmod,
    )


# ── brb.uz: sitemap + HTML ───────────────────────────────────────────


class SitemapSource:
    def __init__(self, site: SiteConfig, http: HttpClient):
        self.site = site
        self.http = http
        self.notes: list[str] = []

    def discover(self) -> list[PageRef]:
        entries: dict[str, str | None] = {}
        empty = offsite = 0
        for sitemap_url in self._sitemaps():
            for loc, lastmod in self._urls(sitemap_url):
                if not loc:
                    empty += 1
                    continue
                url = self._normalise(loc)
                if url is None:
                    offsite += 1
                    continue
                entries.setdefault(url, lastmod)
        if empty:
            self.notes.append(f"{empty} sitemap entries have an empty <loc> (a bug on the site's side; skipped)")
        if offsite:
            self.notes.append(f"{offsite} sitemap entries point to another host (skipped)")
        return [PageRef(url=u, site=self.site.id, lang=lang_of(u, self.site), lastmod=m) for u, m in entries.items()]

    def load(self, ref: PageRef) -> Page:
        return _load_html_page(self.http, self.site, ref)

    def _sitemaps(self) -> list[str]:
        root = self._xml(self.site.sitemap or f"{self.site.base_url}/sitemap.xml")
        if root.tag == f"{SITEMAP_NS}sitemapindex":
            return [(el.text or "").strip() for el in root.iter(f"{SITEMAP_NS}loc") if (el.text or "").strip()]
        return [self.site.sitemap or ""]

    def _urls(self, sitemap_url: str) -> list[tuple[str, str | None]]:
        root = self._xml(sitemap_url)
        out = []
        for node in root.iter(f"{SITEMAP_NS}url"):
            loc = "".join((node.findtext(f"{SITEMAP_NS}loc") or "").split())
            lastmod = (node.findtext(f"{SITEMAP_NS}lastmod") or "").strip() or None
            out.append((loc, lastmod))
        return out

    def _xml(self, url: str) -> ET.Element:
        res = self.http.get(url)
        if res.status_code != 200:
            raise FetchError(f"sitemap {url}: HTTP {res.status_code}")
        return ET.fromstring(res.content)

    def _normalise(self, loc: str) -> str | None:
        base = urlsplit(self.site.base_url)
        parts = urlsplit(loc)
        if parts.netloc and parts.netloc != base.netloc:
            return None
        path = parts.path.rstrip("/")
        return f"{base.scheme}://{base.netloc}{path}"


# ── brb-tech.uz: JSON API + the home page ────────────────────────────

DATE_LABEL = {"uz": "Sana", "ru": "Дата", "en": "Date"}
LINK_LABEL = {"uz": "Havola", "ru": "Ссылка", "en": "Link"}
TEAM_TITLE = {"uz": "BRB-TECH jamoasi", "ru": "Команда BRB-TECH", "en": "BRB-TECH team"}
PARTNERS_TITLE = {"uz": "BRB-TECH hamkorlari", "ru": "Партнёры BRB-TECH", "en": "BRB-TECH partners"}
PROJECTS_TITLE = {"uz": "BRB-TECH loyihalari", "ru": "Проекты BRB-TECH", "en": "BRB-TECH projects"}
# The section a record belongs to, as its breadcrumb. A project page alone never says "project": with
# "BRB-TECH › Loyihalar" in its heading, "BRB-TECH qanday loyihalar qilgan?" finds it.
SECTION = {
    "news": {"uz": "Yangiliklar", "ru": "Новости", "en": "News"},
    "project": {"uz": "Loyihalar", "ru": "Проекты", "en": "Projects"},
    "projects": {"uz": "Loyihalar", "ru": "Проекты", "en": "Projects"},
    "team": {"uz": "Jamoa", "ru": "Команда", "en": "Team"},
    "partners": {"uz": "Hamkorlar", "ru": "Партнёры", "en": "Partners"},
}
WORK_TIME = {"uz": "Ish vaqti", "ru": "Время работы", "en": "Working hours"}


class BrbTechSource:
    """The site is a Nuxt app whose news, projects, team and partners come from
    its own JSON API. Reading the API gives clean, already-separated fields in
    every language, with an `updatedAt` date — far better than parsing HTML."""

    def __init__(self, site: SiteConfig, http: HttpClient):
        self.site = site
        self.http = http
        self.notes: list[str] = []

    def discover(self) -> list[PageRef]:
        refs: list[PageRef] = []
        for lang, path in self.site.html_pages.items():
            refs.append(PageRef(url=self._url(path), site=self.site.id, lang=lang, kind="page"))

        news = self._items("News")
        projects = self._items("Portfolio")
        staff = self._items("Staff")
        partners = self._items("Partner")

        for lang, code in self.site.languages.items():
            prefix = self._prefix(lang)
            for item in news:
                refs.append(PageRef(
                    url=self._url(f"{prefix}/news/{item['id']}"), site=self.site.id, lang=lang,
                    kind="news", lastmod=item.get("updatedAt"), data={"item": item, "code": code},
                ))
            for item in projects:
                refs.append(PageRef(
                    url=self._url(f"{prefix}/projects#{item['id']}"), site=self.site.id, lang=lang,
                    kind="project", lastmod=item.get("updatedAt"), data={"item": item, "code": code},
                ))
            if staff:
                refs.append(PageRef(
                    url=self._url(f"{prefix}/#team"), site=self.site.id, lang=lang, kind="team",
                    lastmod=max((s.get("updatedAt") or "") for s in staff) or None, data={"items": staff, "code": code},
                ))
            if projects:
                # One overview page: "what has BRB-TECH built?" is answered by a list, not by one project.
                refs.append(PageRef(
                    url=self._url(f"{prefix}/projects"), site=self.site.id, lang=lang, kind="projects",
                    lastmod=max((p.get("updatedAt") or "") for p in projects) or None,
                    data={"items": projects, "code": code},
                ))
            if partners:
                refs.append(PageRef(
                    url=self._url(f"{prefix}/#partners"), site=self.site.id, lang=lang, kind="partners",
                    lastmod=max((p.get("updatedAt") or "") for p in partners) or None, data={"items": partners, "code": code},
                ))
        return refs

    def load(self, ref: PageRef) -> Page:
        if ref.data is None:
            return _load_html_page(self.http, self.site, ref)
        code = ref.data["code"]
        if ref.kind == "news":
            title, text = self._news(ref.data["item"], code, ref.lang)
        elif ref.kind == "project":
            title, text = self._project(ref.data["item"], code, ref.lang)
        elif ref.kind == "team":
            title, text = self._team(ref.data["items"], code, ref.lang)
        elif ref.kind == "projects":
            title, text = self._projects(ref.data["items"], code, ref.lang)
        else:
            title, text = self._partners(ref.data["items"], code, ref.lang)
        return Page(
            url=ref.url, site=self.site.id, lang=ref.lang, group=ref.group or self.site.default_group,
            kind=ref.kind, title=title, breadcrumb=["BRB-TECH", SECTION[ref.kind][ref.lang]], text=text,
            source_lastmod=ref.lastmod,
        )

    # ── API ───────────────────────────────────────────────────────
    def _items(self, entity: str) -> list[dict]:
        res = self.http.get(f"{self.site.api_base}/{entity}/GetAll", params={"take": 1000})
        if res.status_code != 200:
            raise FetchError(f"{entity}: HTTP {res.status_code}")
        body = res.json()
        items = body.get("content") or []
        total = body.get("total")
        if isinstance(total, int) and total > len(items):
            self.notes.append(f"{entity}: API returned {len(items)} of {total} items")
        # state 1 = published on this API; anything else is a draft or hidden.
        published = [i for i in items if i.get("state", 1) == 1]
        if len(published) < len(items):
            self.notes.append(f"{entity}: skipped {len(items) - len(published)} unpublished items")
        return published

    def _prefix(self, lang: str) -> str:
        path = self.site.html_pages.get(lang, "/")
        return "" if path == "/" else path.rstrip("/")

    def _url(self, path: str) -> str:
        return f"{self.site.base_url}{path if path.startswith('/') else '/' + path}"

    @staticmethod
    def _t(value, code: str) -> str:
        """A field in the asked language, falling back to Uzbek."""
        if isinstance(value, dict):
            return (value.get(code) or value.get("uz") or "").strip()
        return (value or "").strip() if isinstance(value, str) else ""

    def _news(self, item: dict, code: str, lang: str) -> tuple[str, str]:
        title = self._t(item.get("title"), code)
        body = text_from_fragment(self._t(item.get("description"), code))
        date = (item.get("publishedAt") or "")[:10]
        lines = [f"# {title}"] + ([f"{DATE_LABEL[lang]}: {date}"] if date else []) + [body]
        return title, "\n".join(x for x in lines if x)

    def _project(self, item: dict, code: str, lang: str) -> tuple[str, str]:
        title = self._t(item.get("title"), code)
        lines = [f"# {title}", self._t(item.get("definition"), code).lstrip("—– ").strip(),
                 text_from_fragment(self._t(item.get("description"), code))]
        if item.get("webUrl"):
            lines.append(f"{LINK_LABEL[lang]}: {item['webUrl']}")
        return title, "\n".join(x for x in lines if x)

    def _team(self, items: list[dict], code: str, lang: str) -> tuple[str, str]:
        lines = [f"# {TEAM_TITLE[lang]}"]
        for s in sorted(items, key=lambda x: x.get("orderCode") or 0):
            name = " ".join(x for x in (self._t(s.get("surname"), code), self._t(s.get("name"), code),
                                        self._t(s.get("middleName"), code)) if x)
            position = self._t((s.get("position") or {}).get("name"), code)
            department = self._t((s.get("department") or {}).get("name"), code)
            role = ", ".join(x for x in (position, department) if x)
            line = f"- {name}" + (f" — {role}" if role else "")
            if s.get("workTime"):
                line += f" ({WORK_TIME[lang]}: {s['workTime']})"
            lines.append(line)
        return TEAM_TITLE[lang], "\n".join(lines)

    def _projects(self, items: list[dict], code: str, lang: str) -> tuple[str, str]:
        lines = [f"# {PROJECTS_TITLE[lang]}"]
        for p in sorted(items, key=lambda x: x.get("orderCode") or 0):
            what = self._t(p.get("definition"), code).lstrip("—– ").strip()
            lines.append(f"- {self._t(p.get('title'), code)}" + (f" — {what}" if what else ""))
        return PROJECTS_TITLE[lang], "\n".join(lines)

    def _partners(self, items: list[dict], code: str, lang: str) -> tuple[str, str]:
        lines = [f"# {PARTNERS_TITLE[lang]}"]
        for p in sorted(items, key=lambda x: x.get("orderCode") or 0):
            name = self._t(p.get("title"), code)
            lines.append(f"- {name}" + (f" ({p['url']})" if p.get("url") else ""))
        return PARTNERS_TITLE[lang], "\n".join(lines)


# ── brb.uz exchange rates: the JSON the "Valyutalar kursi" page itself reads ──

CURRENCY_NAMES = {
    "USD": "AQSH dollari", "EUR": "Yevro", "RUB": "Rossiya rubli", "GBP": "Angliya funt sterlingi",
    "CHF": "Shveytsariya franki", "JPY": "Yaponiya iyenasi", "TJS": "Tojikiston somoniysi",
    "KZT": "Qozog'iston tengesi", "CNY": "Xitoy yuani", "KRW": "Janubiy Koreya voni", "TRY": "Turkiya lirasi",
    "MOBIL USD": "AQSH dollari, BRB mobil ilovasida",
}
MONTHS_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentyabr", "oktyabr",
             "noyabr", "dekabr"]


def som(tiyin) -> str:
    """The API gives tiyin (the page divides by 100): 1197000 → "11 970", 1289328 → "12 893,28"."""
    v = int(tiyin)
    whole, frac = divmod(abs(v), 100)
    out = f"{whole:,}".replace(",", " ") + (f",{frac:02d}" if frac else "")
    return ("-" if v < 0 else "") + out


def uz_datetime(stamp: str) -> str:
    """"2026-11-24 12:48:02" → "2026-yil 24-noyabr, soat 12:48"."""
    date, _, time_ = stamp.partition(" ")
    y, m, d = (int(x) for x in date.split("-"))
    return f"{y}-yil {d}-{MONTHS_UZ[m - 1]}" + (f", soat {time_[:5]}" if time_ else "")


class CurrencySource:
    """brb.uz loads its rate table with JavaScript from /api/currency/compare?type=…, so the HTML page
    has no figures. We read the same JSON and publish one small page per rate type (individuals,
    businesses). It runs every 15 minutes on its own (`run --site brb_rates`): the rest of the site
    changes weekly, rates change during the day."""

    def __init__(self, site: SiteConfig, http: HttpClient):
        self.site = site
        self.http = http
        self.notes: list[str] = []

    def discover(self) -> list[PageRef]:
        refs = []
        for rtype in self.site.rate_types:
            res = self.http.get(f"{self.site.base_url}{self.site.api_path}", params={"type": rtype})
            if res.status_code != 200:
                raise FetchError(f"rates {rtype}: HTTP {res.status_code}")
            body = res.json()
            if not body.get("success") or not body.get("data"):
                raise FetchError(f"rates {rtype}: empty answer")
            refs.append(PageRef(url=f"{self.site.page_url}#{rtype}", site=self.site.id, lang=self.site.default_lang,
                                kind="rates", lastmod=body.get("updated_at"), data={"type": rtype, "body": body}))
        return refs

    def load(self, ref: PageRef) -> Page:
        rtype, body = ref.data["type"], ref.data["body"]
        who = self.site.rate_types[rtype]
        title = f"BRB valyuta kurslari — {who} uchun"
        lines = [f"# {title}"]
        if body.get("updated_at"):
            lines.append(f"Yangilangan: {uz_datetime(body['updated_at'])} (Toshkent vaqti)")
        lines.append("Sotib olish — bank valyutani sizdan sotib oladigan kurs; sotish — bank valyutani sizga "
                     "sotadigan kurs. Narxlar 1 birlik valyuta uchun, so'mda.")
        for row in body["data"]:
            code = str(row.get("code", "")).strip()
            name = CURRENCY_NAMES.get(code, code)
            line = f"- {name} ({code}): sotib olish {som(row['buy'])} so'm, sotish {som(row['sell'])} so'm"
            moves = [f"{label} {'+' if int(v) > 0 else ''}{som(v)} so'm"
                     for label, v in (("sotib olish", row.get("buy_change") or 0),
                                      ("sotish", row.get("sell_change") or 0)) if int(v)]
            if moves:
                line += f" (oldingi kursga nisbatan o'zgarish: {', '.join(moves)})"
            lines.append(line)
        lines.append('Manba: brb.uz, "Valyutalar kursi" sahifasi.')
        return Page(url=ref.url, site=self.site.id, lang=ref.lang, group=ref.group or self.site.default_group,
                    kind="rates", title=title, breadcrumb=["Valyutalar kursi", who.capitalize()],
                    text="\n".join(lines), source_lastmod=ref.lastmod)
