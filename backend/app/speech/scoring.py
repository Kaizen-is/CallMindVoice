"""
Scoring a transcript against the words that were said — port of src/lib/speech/scoring.ts: word
and character error rates (WER / CER) for the deploy benchmark (`app/benchmark.py`).

It ignores differences that are not real mistakes: Latin vs Cyrillic spelling, the many
apostrophes of oʻ and gʻ, a left-out glottal-stop mark (taʼzim = tazim), case, punctuation, numbers
written as words vs digits, how digits are grouped, and a suffix glued to a number ("30da" = "30 da").

JavaScript regex details kept: `\\d` is ASCII only, `\\s` is JavaScript's set, `$` is the very end.
"""

import regex as re

from app.jscompat import JS_S, js_round, js_trim, utf16_len
from app.speech.numbers import uzbek_numbers_to_digits

CYRILLIC = {
    "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "g'", "д": "d", "е": "e", "ё": "yo", "ж": "j", "з": "z", "и": "i",
    "й": "y", "к": "k", "қ": "q", "л": "l", "м": "m", "н": "n", "о": "o", "ў": "o'", "п": "p", "р": "r", "с": "s",
    "т": "t", "у": "u", "ф": "f", "х": "x", "ҳ": "h", "ц": "s", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "'", "ь": "",
    "ы": "i", "э": "e", "ю": "yu", "я": "ya",
}  # fmt: skip

DIGIT_WORDS = {
    "nol": "0", "bir": "1", "ikki": "2", "uch": "3", "to'rt": "4",
    "besh": "5", "olti": "6", "yetti": "7", "sakkiz": "8", "to'qqiz": "9",
}  # fmt: skip
_DIGIT_WORD = "(?:nol|bir|ikki|uch|to'rt|besh|olti|yetti|sakkiz|to'qqiz)"
_S = f"[{JS_S}]"

_CYRILLIC_LETTER = re.compile("[Ѐ-ӿ]")
_APOSTROPHES = re.compile("[ʻʼ‘’`´']")
_NOT_WORD = re.compile(r"[^\p{L}\p{N}' ]+")
_DIGIT_RUN = re.compile(f"(?<![\\p{{L}}']){_DIGIT_WORD}(?:{_S}+{_DIGIT_WORD})+(?![\\p{{L}}'])")
_SPACES = re.compile(f"{_S}+")
_DIGIT_THEN_LETTER = re.compile(r"([0-9])(?=\p{L})")
_LETTER_THEN_DIGIT = re.compile(r"(\p{L})(?=[0-9])")
_NUMBER_RUN = re.compile(f"[0-9]+(?:{_S}+[0-9]+)+")
_LOOSE_APOSTROPHE = re.compile(f"(^|{_S})'+|'+(?={_S}|\\Z)")
_GLOTTAL = re.compile(r"(?<![og])'")


def normalize_for_scoring(text: str) -> str:
    """The text as the scorer compares it."""
    s = text.lower()
    s = _CYRILLIC_LETTER.sub(lambda m: CYRILLIC.get(m.group(0), m.group(0)), s)
    s = _APOSTROPHES.sub("'", s)
    s = uzbek_numbers_to_digits(s)
    s = _NOT_WORD.sub(" ", s)
    # Digits read one by one ("bir ikki uch") are a number. A lone "bir" stays a word.
    s = _DIGIT_RUN.sub(lambda m: " ".join(DIGIT_WORDS[w] for w in _SPACES.split(m.group(0))), s)
    # A suffix glued to a number ("30da", "25-noyabr") is its own word.
    s = _DIGIT_THEN_LETTER.sub(r"\1 ", s)
    s = _LETTER_THEN_DIGIT.sub(r"\1 ", s)
    # A run of numbers is one token: "7 800 000" = "7800000", "14 30" = "14:30" (grouping is formatting).
    s = _NUMBER_RUN.sub(lambda m: _SPACES.sub("", m.group(0)), s)
    # An apostrophe that is not part of a word (o', g', ma'no) is noise.
    s = _LOOSE_APOSTROPHE.sub(lambda m: m.group(1) or "", s)
    # The glottal-stop mark (ma'no, ta'zim) is often left out in writing: not a recognition error.
    # Only o' and g' keep theirs — there it changes the letter.
    s = _GLOTTAL.sub("", s)
    return js_trim(_SPACES.sub(" ", s))


def _edit_distance(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)))
        prev = cur
    return prev[len(b)]


def score(reference: str, heard: str) -> dict[str, float | None]:
    """Word and character error rates (0 = perfect), or None for both without a reference."""
    ref = normalize_for_scoring(reference)
    if not ref:
        return {"wer": None, "cer": None}
    hyp = normalize_for_scoring(heard)
    words = ref.split(" ")

    def rounded(n: float) -> float:
        return js_round(n * 10000) / 10000

    return {
        "wer": rounded(_edit_distance(words, hyp.split(" ") if hyp else []) / len(words)),
        # `[...ref]` walks code points; `ref.length` counts UTF-16 units.
        "cer": rounded(_edit_distance(list(ref), list(hyp)) / utf16_len(ref)),
    }
