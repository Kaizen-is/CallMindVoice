"""HTML → clean Markdown: only the page's own content, in reading order.

On a bank website most of every page is the same menu, footer and pop-ups.
Left in, that text appears in all pages, so search finds "kredit" everywhere
and cannot tell pages apart. This module keeps the main content only and
writes it as plain Markdown that a person (and a chunker) can read:

    # Heading
    A paragraph on one line.
    - a list item
    Foiz stavkasi: 0%-19,5%          ← a product card's label and value, joined
    Tarif: Humo; Narx: 25 000 so'm   ← a table row, with its column names
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterator

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

from .config import HtmlRules

ALWAYS_DROP = ["script", "style", "noscript", "svg", "iframe", "template", "button", "input", "select", "textarea", "img", "video", "picture"]
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 4, "h6": 4}
BLOCKS = {
    "p", "div", "section", "article", "main", "aside", "header", "footer", "nav", "ul", "ol",
    "dl", "dt", "dd", "blockquote", "figure", "figcaption", "details", "summary", "form", "fieldset",
    "address", "pre", "hr",
}
BREAK = object()


@dataclass
class Extracted:
    title: str
    breadcrumb: list[str]
    text: str
    html_lang: str | None


def extract_html(html: str, rules: HtmlRules) -> Extracted:
    soup = BeautifulSoup(html, "lxml")
    html_lang = soup.html.get("lang") if soup.html else None
    page_title = _clean_title(soup.title.get_text(" ", strip=True) if soup.title else "", rules)

    breadcrumb: list[str] = []
    if rules.breadcrumb_selector:
        node = soup.select_one(rules.breadcrumb_selector)
        if node:
            breadcrumb = _breadcrumb(node, rules.breadcrumb_home)
            node.decompose()  # so it does not repeat inside the text

    root = soup.select_one(rules.main_selector) or soup.body or soup
    for selector in ALWAYS_DROP + rules.drop_selectors:
        for el in root.select(selector):
            el.decompose()

    h1 = root.find("h1")
    title = (h1.get_text(" ", strip=True) if h1 else "") or (breadcrumb[-1] if breadcrumb else "") or page_title

    lines = _assemble(_walk(root))
    lines = _clean_lines(lines, rules.drop_lines)
    lines = _join_labels(lines)
    return Extracted(title=title, breadcrumb=breadcrumb, text="\n".join(lines), html_lang=html_lang)


def text_from_fragment(html_or_text: str) -> str:
    """For API fields that may hold a little HTML (descriptions, news bodies)."""
    if "<" not in html_or_text:
        return "\n".join(_norm(x) for x in html_or_text.splitlines() if _norm(x))
    soup = BeautifulSoup(html_or_text, "lxml")
    root = soup.body or soup
    return "\n".join(_clean_lines(_assemble(_walk(root)), []))


# ── DOM walk ─────────────────────────────────────────────────────────


def _walk(node: Tag) -> Iterator[object]:
    """Yield inline text pieces and BREAK markers in reading order.

    Inline elements (a, span, strong…) stay on the line they are in; block
    elements start a new line. That keeps "Kredit miqdori <b>75%</b> gacha"
    as one line instead of three.
    """
    for child in node.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            text = _norm(str(child))
            if text:
                yield text
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name in HEADINGS:
            text = child.get_text(" ", strip=True)
            if text:
                yield BREAK
                yield "#" * HEADINGS[name] + " " + _norm(text)
                yield BREAK
        elif name == "table":
            yield BREAK
            for row in _table_rows(child):
                yield row
                yield BREAK
        elif name == "dl":
            # <dt>Turi:</dt><dd>Miniven</dd> → "Turi: Miniven"
            yield BREAK
            term = ""
            for item in child.find_all(["dt", "dd"]):
                text = _norm(item.get_text(" ", strip=True))
                if item.name == "dt":
                    term = text.rstrip(":")
                elif text:
                    yield f"{term}: {text}" if term else text
                    yield BREAK
                    term = ""
            if term:
                yield term
                yield BREAK
        elif name == "li":
            text = child.get_text(" ", strip=True)
            if text:
                yield BREAK
                yield "- " + _norm(text)
                yield BREAK
        elif name == "br":
            yield BREAK
        elif name in BLOCKS:
            yield BREAK
            yield from _walk(child)
            yield BREAK
        else:
            yield from _walk(child)


def _assemble(pieces: Iterator[object]) -> list[str]:
    lines: list[str] = []
    current: list[str] = []
    for piece in pieces:
        if piece is BREAK:
            if current:
                lines.append(_norm(" ".join(current)))
                current = []
        else:
            current.append(piece)  # type: ignore[arg-type]
    if current:
        lines.append(_norm(" ".join(current)))
    return [line for line in lines if line]


def _table_rows(table: Tag) -> list[str]:
    rows = [
        [_norm(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"])]
        for tr in table.find_all("tr")
    ]
    rows = [r for r in rows if any(r)]
    if not rows:
        return []
    has_th = table.find("th") is not None
    if not has_th and all(len(r) == 2 for r in rows):
        # A two-column table without header cells is a list of "name | value"
        # pairs (or "1 | requirement"): keep each pair on its own line.
        return [f"- {v}" if k.isdigit() else (f"{k}: {v}" if k and v else k or v) for k, v in rows]
    header = rows[0] if has_th or len(rows) > 2 else None
    out = []
    for row in rows[1:] if header else rows:
        if header and len(header) == len(row):
            # Each value keeps its column name, so a row still makes sense on its own.
            out.append("; ".join(f"{h}: {v}" if h else v for h, v in zip(header, row) if v))
        else:
            out.append(" | ".join(v for v in row if v))
    return out


def _breadcrumb(node: Tag, home: list[str]) -> list[str]:
    items = [a.get_text(" ", strip=True) for a in node.find_all(["a", "span", "li"]) if not a.find(["a", "span", "li"])]
    items = [_norm(x) for x in items if _norm(x) and _norm(x) not in {">", "/", "›", "»"}]
    out: list[str] = []
    for item in items:
        if item.lower() in home or (out and out[-1] == item):
            continue
        out.append(item)
    return out


# ── line clean-up ────────────────────────────────────────────────────

SPACES = re.compile(r"\s+")
LABEL = re.compile(r"^[^\d#\-|:;.!?]{2,40}$")  # short, no digits, no ending punctuation
VALUE = re.compile(r"\d")
SMALL_HEADING = re.compile(r"^#{3,4} ([^\d|:;.!?]{2,40})$")  # "### Foiz stavkasi" on a product card
STEP_NUMBER = re.compile(r"^\d{1,2}$")  # "1", "2" — numbers of form steps or slides


def _norm(text: str) -> str:
    return SPACES.sub(" ", text.replace("\xa0", " ")).strip()


def _clean_title(title: str, rules: HtmlRules) -> str:
    for suffix in rules.title_suffixes:
        if title.endswith(suffix):
            title = title[: -len(suffix)]
    return title.strip()


def _clean_lines(lines: list[str], drop_lines: list[str]) -> list[str]:
    drop = {d.lower() for d in drop_lines}
    out: list[str] = []
    for line in lines:
        if line.lower() in drop or not re.search(r"\w", line) or STEP_NUMBER.match(line):
            continue
        if out and out[-1] == line:  # the same line twice in a row
            continue
        out.append(line)
    # A heading with nothing under it (the next line is another heading of the
    # same or higher level, or the end) carries no fact; drop it.
    result: list[str] = []
    for i, line in enumerate(out):
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            nxt = out[i + 1] if i + 1 < len(out) else None
            if nxt is None or (nxt.startswith("#") and len(nxt) - len(nxt.lstrip("#")) <= level):
                continue
        result.append(line)
    return result


def _join_labels(lines: list[str]) -> list[str]:
    """Product cards show "FOIZ STAVKASI" and "0%-19,5%" on two lines.

    Apart they are useless to search ("0%-19,5%" of what?), so a short label
    line followed by a short value line with a number becomes one line.
    """
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        short_value = bool(nxt) and len(nxt) <= 60 and not nxt.startswith(("#", "- "))
        heading = SMALL_HEADING.match(line)
        label = None
        if short_value and VALUE.search(nxt) and LABEL.match(line):
            label = line
        elif short_value and VALUE.search(nxt) and heading and len(nxt) <= 30:
            # Only a real value ("0%-12%", "60 oygacha"), not a product's tagline.
            label = heading.group(1)
        elif short_value and line.endswith(":") and len(line) <= 41 and not line.startswith("#"):
            label = line[:-1]  # "Turi:" + "Miniven"
        if label:
            out.append(f"{label.capitalize() if label.isupper() else label}: {nxt}")
            i += 2
            continue
        out.append(line)
        i += 1
    return out
