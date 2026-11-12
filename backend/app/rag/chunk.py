"""
Structure-aware chunking — port of src/lib/rag/chunk.ts.

Contact-centre documents are line-oriented (one fact per line under a short
heading), so: detect headings from their surroundings, keep each line its own
unit unless it is a wrapped continuation, pack units up to a target size with
the heading carried into every chunk, and overlap consecutive chunks.
"""

from dataclasses import dataclass

import regex as re

from app.jscompat import JS_S, utf16_len
from app.rag.text import estimate_tokens, sentences

TARGET_TOKENS = 170
MAX_TOKENS = 280
OVERLAP_TOKENS = 30

_TERMINAL = re.compile(r"[.!?:;,]$")
_BULLET = re.compile(f"^([-*•·]|[0-9]+[.)])[{JS_S}]+")
_PRICE = re.compile(f"[0-9][0-9{JS_S}.,]*[{JS_S}]*(so'm|som|sum|uzs|usd|\\$|€|rub|руб|%)", re.IGNORECASE)
_MD_HEADING = re.compile(f"^#{{1,6}}[{JS_S}]+[^{JS_S}]")
_NUMBERED = re.compile(f"^([0-9]+(\\.[0-9]+)*)[.)][{JS_S}]+[^{JS_S}]")
_CAPS_LINE = re.compile("^[A-ZА-ЯЎҚҒҲ][^a-zа-я]*$")
_NOT_LETTER = re.compile(r"[^\p{L}]")
_STARTS_UPPER_OR_DIGIT = re.compile(r"^[\p{Lu}\p{N}]")
_STARTS_LOWER = re.compile(r"^[\p{Ll}]")
_WS_RUN = re.compile(f"[{JS_S}]+")
_HASHES = re.compile(f"^#{{1,6}}[{JS_S}]+")


@dataclass
class RawChunk:
    heading: str | None
    text: str
    token_count: int


def _trim(s: str) -> str:
    return re.sub(f"^[{JS_S}]+|[{JS_S}]+$", "", s)


def _is_blank(line: str) -> bool:
    return not _trim(line)


def _js_split_ws(s: str) -> list[str]:
    """`s.split(/\\s+/)` — keeps the empty strings JavaScript keeps."""
    return _WS_RUN.split(s)


def _is_heading(lines: list[str], i: int) -> bool:
    t = _trim(lines[i])
    if not t:
        return False
    if _MD_HEADING.search(t):
        return True
    if _NUMBERED.search(t) and utf16_len(t) <= 90:
        return True
    if _CAPS_LINE.search(t) and utf16_len(_NOT_LETTER.sub("", t)) >= 4 and utf16_len(t) <= 80:
        return True

    # Contextual heading: a short, unpunctuated line that opens a block.
    if utf16_len(t) > 70:
        return False
    if _TERMINAL.search(t) or _BULLET.search(t) or _PRICE.search(t):
        return False
    if len(_js_split_ws(t)) > 8:
        return False
    if not _STARTS_UPPER_OR_DIGIT.search(t):
        return False
    prev_blank = i == 0 or _is_blank(lines[i - 1])
    next_filled = i + 1 < len(lines) and not _is_blank(lines[i + 1])
    return prev_blank and next_filled


def _is_continuation(prev: str, cur: str) -> bool:
    if not prev:
        return False
    if _BULLET.search(cur):
        return False
    if _TERMINAL.search(_trim(prev)):
        return False
    return bool(_STARTS_LOWER.search(_trim(cur)))


def _to_blocks(text: str) -> list[tuple[str | None, list[str]]]:
    lines = re.sub(r"\r\n?", "\n", text).split("\n")
    blocks: list[tuple[str | None, list[str]]] = []
    heading: str | None = None
    units: list[str] = []

    for i, line in enumerate(lines):
        if _is_blank(line):
            continue
        if _is_heading(lines, i):
            if units:
                blocks.append((heading, units))
            units = []
            heading = _HASHES.sub("", _trim(line), count=1)
            continue
        clean = _WS_RUN.sub(" ", _trim(line))
        if units and _is_continuation(units[-1], clean):
            units[-1] = f"{units[-1]} {clean}"
        else:
            units.append(clean)
    if units:
        blocks.append((heading, units))
    return blocks


def _split_oversized(unit: str) -> list[str]:
    if estimate_tokens(unit) <= MAX_TOKENS:
        return [unit]
    out: list[str] = []
    current = ""
    for s in sentences(unit):
        if current and estimate_tokens(f"{current} {s}") > TARGET_TOKENS:
            out.append(current)
            current = s
        else:
            current = f"{current} {s}" if current else s
    if current:
        out.append(current)
    return out or [unit]


def chunk_document(text: str, title: str) -> list[RawChunk]:
    chunks: list[RawChunk] = []

    for heading, block_units in _to_blocks(text):
        units = [piece for u in block_units for piece in _split_oversized(u)]
        prefix = f"{heading}\n" if heading else ""
        current: list[str] = []
        current_tokens = 0

        def emit(with_overlap: bool, heading=heading, prefix=prefix) -> None:
            nonlocal current, current_tokens
            if not current:
                return
            body = "\n".join(current)
            chunks.append(RawChunk(heading, _trim(f"{prefix}{body}"), estimate_tokens(prefix + body)))
            if not with_overlap:
                current, current_tokens = [], 0
                return
            # Carry the tail forward so a fact split across a boundary is still found.
            tail: list[str] = []
            tail_tokens = 0
            i = len(current) - 1
            while i >= 0 and tail_tokens < OVERLAP_TOKENS:
                tail.insert(0, current[i])
                tail_tokens += estimate_tokens(current[i])
                i -= 1
            overlapping = len(tail) < len(current)
            current = tail if overlapping else []
            current_tokens = tail_tokens if overlapping else 0

        for unit in units:
            t = estimate_tokens(unit)
            if current_tokens + t > TARGET_TOKENS and current:
                emit(True)
            current.append(unit)
            current_tokens += t
        emit(False)

    # Degenerate input (a single unstructured blob) — fall back to windows.
    if not chunks and _trim(text):
        for part in _split_oversized(_trim(_WS_RUN.sub(" ", text))):
            chunks.append(RawChunk(title, part, estimate_tokens(part)))

    out = []
    for c in chunks:
        trimmed = _trim(c.text)
        if utf16_len(_WS_RUN.sub("", trimmed)) > 20:
            out.append(RawChunk(c.heading, trimmed, c.token_count))
    return out


def chunk_faq(pairs: list[dict[str, str]]) -> list[RawChunk]:
    """FAQ pairs become one chunk each — the highest-precision shape for voice."""
    out = []
    for p in pairs:
        q, a = _trim(p["q"]), _trim(p["a"])
        if q and a:
            out.append(RawChunk(q, f"{q}\n{a}", estimate_tokens(p["q"] + p["a"])))
    return out
