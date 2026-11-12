"""
Spelled-out Uzbek numbers → digits, for what the Uzbek STT hears.
Port of src/lib/speech/numbers.ts.

A year of birth arrives as "bir ming to'qqiz yuz to'qson ikkinchi yilda"; the
model compares "1992" reliably, words it does not. Only real numbers are
rewritten: a lone small number stays a word ("bir daqiqa" — just a moment).
"""

from dataclasses import dataclass

import regex as re

from app.jscompat import JS_S

VALUES = {
    "nol": 0, "bir": 1, "ikki": 2, "uch": 3, "to'rt": 4, "besh": 5, "olti": 6, "yetti": 7, "sakkiz": 8,
    "to'qqiz": 9, "o'n": 10, "yigirma": 20, "o'ttiz": 30, "qirq": 40, "ellik": 50, "oltmish": 60,
    "yetmish": 70, "sakson": 80, "to'qson": 90,
}  # fmt: skip
SCALES = {"yuz": 100, "ming": 1_000, "million": 1_000_000, "milliard": 1_000_000_000}

# Endings a number can carry: "beshta", "o'ndan", "ikkinchisi", "mingga".
ENDINGS = ["tadan", "gacha", "ning", "dan", "ga", "da", "ni", "ta", "si", ""]

_MONTH = re.compile(r"^(yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sent[ya]?abr|okt[ya]?abr|noyabr|dekabr)")
_SPLIT = re.compile(r"([^\p{L}'ʻʼ‘’`]+)")
_APOS = re.compile("[ʻʼ‘’`]")
_GAP_JOINS = re.compile(f"[{JS_S}-]+")
_GAP_SPACES = re.compile(f"[{JS_S}]+")


@dataclass
class NumberWord:
    value: int
    scale: bool
    ordinal: bool
    ending: str


def _lookup(stem: str) -> tuple[int, bool] | None:
    if stem in VALUES:
        return VALUES[stem], False
    if stem in SCALES:
        return SCALES[stem], True
    return None


def _read_word(word: str) -> NumberWord | None:
    """One word as a number, or None. Apostrophes are already normalised to '."""
    for ending in ENDINGS:
        if ending and not word.endswith(ending):
            continue
        base = word[: -len(ending)] if ending else word
        if not base:
            continue
        plain = _lookup(base)
        if plain:
            return NumberWord(plain[0], plain[1], False, ending)
        # Ordinals: bir+inchi, ikki+nchi, ellig+inchi (ellik softens).
        for suffix in ("inchi", "nchi"):
            if not base.endswith(suffix):
                continue
            stem = base[: -len(suffix)]
            found = _lookup("ellik" if stem == "ellig" else stem)
            if found:
                return NumberWord(found[0], found[1], True, ending)
    return None


def _read_run(words: list[NumberWord]) -> list[int]:
    """A run of number words → numbers (usually one; single digits in a row are several)."""
    numbers: list[int] = []
    total = group = 0
    last = "none"

    def flush() -> None:
        nonlocal total, group, last
        if last != "none":
            numbers.append(total + group)
        total = group = 0
        last = "none"

    for w in words:
        if w.scale:
            if w.value == 100:
                group = (group or 1) * 100
            else:
                total += (group or 1) * w.value
                group = 0
            last = "scale"
        elif w.value >= 10:
            # A tens word after a unit or another tens word starts a new number.
            if last in ("unit", "ten"):
                flush()
            group += w.value
            last = "ten"
        else:
            if last == "unit":
                flush()
            group += w.value
            last = "unit"
    flush()
    return numbers


def _digits(n: int) -> str:
    # Large amounts grouped as printed (7 800 000); years stay whole.
    return f"{n:,}".replace(",", " ") if n >= 10_000 else str(n)


def _read(token: str | None) -> NumberWord | None:
    return _read_word(_APOS.sub("'", token.lower())) if token else None


def uzbek_numbers_to_digits(text: str) -> str:
    tokens = _SPLIT.split(text)  # words, with their separators kept
    out: list[str] = []
    i = 0
    while i < len(tokens):
        first = _read(tokens[i])
        if not first:
            out.append(tokens[i])
            i += 1
            continue

        # Collect the run: number words joined by spaces (or a hyphen); an
        # ordinal or an ending is allowed only on its last word.
        run = [first]
        end = i
        while not run[-1].ordinal and not run[-1].ending:
            gap = tokens[end + 1] if end + 1 < len(tokens) else None
            nxt = _read(tokens[end + 2] if end + 2 < len(tokens) else None)
            if not nxt or not gap or not _GAP_JOINS.fullmatch(gap):
                break
            run.append(nxt)
            end += 2

        numbers = _read_run(run)
        tail = run[-1]
        following = (tokens[end + 2] if end + 2 < len(tokens) else "").lower()
        is_number = (
            (len(numbers) == 1 and (len(run) > 1 or numbers[0] >= 10))
            or (len(numbers) > 1 and any(n >= 10 for n in numbers))
            or (tail.ordinal and bool(_MONTH.search(following)))
        )
        if not is_number:
            out.append(tokens[i])
            i += 1
            continue

        written = " ".join(_digits(n) for n in numbers)
        if tail.ordinal:
            # "1992-yilda", "15-oktabrda": an ordinal joins the word it counts.
            gap = tokens[end + 1] if end + 1 < len(tokens) else None
            word_after = tokens[end + 2] if end + 2 < len(tokens) else None
            if not tail.ending and gap and _GAP_SPACES.fullmatch(gap) and word_after:
                out.append(f"{written}-{word_after}")
                i = end + 3
                continue
            written += f"-{tail.ending}" if tail.ending else "-chi"
        elif tail.ending:
            written += tail.ending
        out.append(written)
        i = end + 1
    return "".join(out)
