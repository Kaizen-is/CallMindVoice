"""
Spoken-form normalisation — the last step before text reaches the TTS.
Port of src/lib/speech/normalize.ts (the disk-cache key of every rendered
sentence is computed from this output, so it must match exactly).

Fixes what a synthesiser can't see: markdown and stray symbols, long digit
runs (phone/card numbers spoken in groups), clock times, currency and unit
abbreviations per language, thousands separators. `split_for_speech` cuts a
reply into chunks that are rendered and played one after another.
"""

from collections.abc import Callable
from dataclasses import dataclass

import regex as re

from app.jscompat import JS_B, JS_LINE_START, JS_S, utf16_len

S = f"[{JS_S}]"  # JavaScript \s
NOT_S = f"[^{JS_S}]"  # JavaScript \S


def _pad(n: int) -> str:
    return str(n).zfill(2)


@dataclass
class Vocab:
    time: Callable[[int, int], str]
    currency: dict[str, str]
    units: dict[str, str]
    plus: str
    range: str


VOCAB: dict[str, Vocab] = {
    "uz": Vocab(
        time=lambda h, m: f"soat {h}" if m == 0 else f"soat {h} {_pad(m)}",
        currency={
            "so'm": "so'm", "soʻm": "so'm", "UZS": "so'm", "$": "dollar", "USD": "dollar",
            "€": "yevro", "EUR": "yevro", "₽": "rubl", "RUB": "rubl",
        },
        units={"km": "kilometr", "kg": "kilogramm", "m2": "kvadrat metr", "gb": "gigabayt", "mb": "megabayt"},
        plus="plyus",
        range="dan",
    ),
    "ru": Vocab(
        time=lambda h, m: f"{h} часов" if m == 0 else f"{h} часов {m} минут",
        currency={
            "so'm": "сум", "сум": "сум", "UZS": "сум", "$": "долларов", "USD": "долларов",
            "€": "евро", "EUR": "евро", "₽": "рублей", "RUB": "рублей",
        },
        units={"km": "километров", "kg": "килограмм", "m2": "квадратных метров", "gb": "гигабайт",
               "mb": "мегабайт"},
        plus="плюс",
        range="до",
    ),
    "en": Vocab(
        time=lambda h, m: f"{h} o'clock" if m == 0 else f"{h} {_pad(m)}",
        currency={
            "so'm": "som", "UZS": "som", "$": "dollars", "USD": "dollars", "€": "euros", "EUR": "euros",
            "₽": "roubles", "RUB": "roubles",
        },
        units={"km": "kilometres", "kg": "kilograms", "m2": "square metres", "gb": "gigabytes",
               "mb": "megabytes"},
        plus="plus",
        range="to",
    ),
}  # fmt: skip


# ── passes ──────────────────────────────────────────────────────────

_FENCE = re.compile(r"```[\s\S]*?```")  # [\s\S] = any character, in both languages
_INLINE_CODE = re.compile(r"`([^`]+)`")
_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_MD_HEADING = re.compile(f"{JS_LINE_START}{S}{{0,3}}#{{1,6}}{S}+")
_MD_BULLET = re.compile(f"{JS_LINE_START}{S}*[-*+]{S}+")
_MD_NUMBERED = re.compile(f"{JS_LINE_START}{S}*[0-9]+[.)]{S}+")
_EMPHASIS = re.compile(r"(\*\*|__|\*|_|~~)")


def _strip_markdown(text: str) -> str:
    text = _FENCE.sub(" ", text)
    text = _INLINE_CODE.sub(r"\1", text)
    text = _LINK.sub(r"\1", text)  # links & images → their label
    text = _MD_HEADING.sub("", text)
    text = _MD_BULLET.sub("", text)
    text = _MD_NUMBERED.sub("", text)
    return _EMPHASIS.sub("", text)


_PHONE = re.compile(f"(\\+?)([0-9][0-9{JS_S}()\\-]{{8,}}[0-9])")


def _group_phone(d: str) -> list[str]:
    """Uzbek/CIS shape: country(3) area(2) 3-2-2; falls back to even 3s."""
    if len(d) == 12 and d.startswith("998"):
        return [d[0:3], d[3:5], d[5:8], d[8:10], d[10:12]]
    if len(d) == 9:
        return [d[0:2], d[2:5], d[5:7], d[7:9]]
    return [d[i : i + 3] for i in range(0, len(d), 3)]


def _spell_phones(text: str, v: Vocab) -> str:
    """`+998901234567` → `plyus 998, 90, 123, 45, 67` (runs of 9–15 digits only)."""

    def repl(m: re.Match) -> str:
        plus, body = m.group(1), m.group(2)
        digits = re.sub(r"[^0-9]", "", body)
        if len(digits) < 9 or len(digits) > 15:
            return m.group(0)
        return f"{v.plus + ' ' if plus else ''}{', '.join(_group_phone(digits))}"

    return _PHONE.sub(repl, text)


_RANGE = re.compile(f"{JS_B}([0-9]{{1,2}}:[0-5][0-9]){S}?[-–—]{S}?([0-9]{{1,2}}:[0-5][0-9]){JS_B}")
_TIME = re.compile(f"{JS_B}([01]?[0-9]|2[0-3]):([0-5][0-9]){JS_B}")


def _spell_ranges(text: str, v: Vocab) -> str:
    return _RANGE.sub(lambda m: f"{m.group(1)} {v.range} {m.group(2)}", text)


def _spell_times(text: str, v: Vocab) -> str:
    return _TIME.sub(lambda m: v.time(int(m.group(1)), int(m.group(2))), text)


_THOUSANDS = [
    re.compile(f"(?<=[0-9])[ ](?=[0-9]{{3}}{JS_B})"),
    re.compile(f"(?<=[0-9]),(?=[0-9]{{3}}{JS_B})"),
    re.compile(f"(?<=[0-9])\\.(?=[0-9]{{3}}{JS_B})"),
]


def _join_thousands(text: str) -> str:
    """`250 000` / `250,000` / `250.000` → `250000`, read as one number."""
    for pattern in _THOUSANDS:
        text = pattern.sub("", text)
    return text


def _spell_currency(text: str, v: Vocab) -> str:
    out = text
    for sym, word in v.currency.items():
        if sym in ("$", "€", "₽"):
            # The symbol precedes the amount in English usage; move it after and expand.
            out = re.sub(f"{re.escape(sym)}{S}?([0-9][0-9.]*)", lambda m, w=word: f"{m.group(1)} {w}", out)
            out = re.sub(re.escape(sym), lambda _m, w=word: f" {w}", out)
        else:
            out = re.sub(f"{JS_B}{re.escape(sym)}{JS_B}", lambda _m, w=word: w, out, flags=re.IGNORECASE)
    return out


def _spell_units(text: str, v: Vocab) -> str:
    out = text
    for abbr, word in v.units.items():
        out = re.sub(
            f"([0-9]){S}?{re.escape(abbr)}{JS_B}", lambda m, w=word: f"{m.group(1)} {w}", out, flags=re.IGNORECASE
        )
    return out


_URL = re.compile(f"https?://(www\\.)?([^{JS_S}/]+){NOT_S}*", re.IGNORECASE)
_EMAIL = re.compile(f"{JS_B}([A-Za-z0-9_.+-]+)@([A-Za-z0-9_.-]+){JS_B}")


def _tame_urls(text: str) -> str:
    """URLs and emails read aloud are useless — reduce them to host / handle."""
    text = _URL.sub(lambda m: m.group(2), text)
    return _EMAIL.sub(lambda m: f"{m.group(1)} at {m.group(2)}", text)


_QUOTES = re.compile('[«»"„]')
_PIPE = re.compile(f"{S}*\\|{S}*")
_SPACES_TABS = re.compile(r"[ \t]{2,}")
_SPACE_BEFORE_PUNCT = re.compile(f"{S}+([,.;:!?])")
_BLANK_LINES = re.compile(r"\n{2,}")
_TRIM = re.compile(f"^{S}+|{S}+$")


def _tidy(text: str) -> str:
    text = _QUOTES.sub("", text)
    text = _PIPE.sub(", ", text)
    text = _SPACES_TABS.sub(" ", text)
    text = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
    text = _BLANK_LINES.sub(". ", text)
    text = text.replace("\n", " ")
    return _TRIM.sub("", text)


# ── public ──────────────────────────────────────────────────────────


def normalize_for_speech(text: str, language: str = "uz") -> str:
    """The form the TTS should receive. Order matters (see the TypeScript notes)."""
    v = VOCAB.get(language, VOCAB["uz"])
    out = _strip_markdown(text)
    out = _tame_urls(out)
    out = _join_thousands(out)
    out = _spell_phones(out, v)
    out = _spell_ranges(out, v)
    out = _spell_times(out, v)
    out = _spell_currency(out, v)
    out = _spell_units(out, v)
    return _tidy(out)


_SENTENCE_GAP = re.compile(f"(?<=[.!?…]){S}+")
_COMMA_GAP = re.compile(f"(?<=,){S}+")


def split_for_speech(text: str, min_chars: int = 30, max_chars: int = 120) -> list[str]:
    """Cut a reply into synthesis chunks at sentence boundaries (30–120 characters)."""
    clean = _TRIM.sub("", text)
    if utf16_len(clean) <= min_chars * 2:
        return [clean] if clean else []
    out: list[str] = []
    for piece in _SENTENCE_GAP.split(clean):
        if out and utf16_len(out[-1]) < min_chars:
            out[-1] = f"{out[-1]} {piece}"
        elif utf16_len(piece) > max_chars:
            out.extend(_hard_wrap(piece, max_chars))
        else:
            out.append(piece)
    return [p for p in out if p]


def _hard_wrap(sentence: str, max_chars: int) -> list[str]:
    out: list[str] = []
    buf = ""
    for part in _COMMA_GAP.split(sentence):
        if buf and utf16_len(buf) + utf16_len(part) > max_chars:
            out.append(buf)
            buf = part
        else:
            buf = f"{buf} {part}" if buf else part
    if buf:
        out.append(buf)
    return out
