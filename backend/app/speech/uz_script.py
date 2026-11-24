"""
Uzbek text in one consistent spelling for display: Cyrillic letters written in Latin script
(the official 1995 alphabet), and every apostrophe variant (ʻ ʼ ‘ ’ ` ´) as a plain '.

Streaming STT changes its mind as it goes — the same word can come back first in Cyrillic, then in
Latin, or as O‘zbekiston, then O'zbekiston. Shown as is, the live words would jump back and forth;
written one way, they only grow.
"""

import regex as re

_LETTERS = {
    "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "g'", "д": "d", "ж": "j", "з": "z", "и": "i", "й": "y",
    "к": "k", "қ": "q", "л": "l", "м": "m", "н": "n", "о": "o", "ў": "o'", "п": "p", "р": "r", "с": "s",
    "т": "t", "у": "u", "ф": "f", "х": "x", "ҳ": "h", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "'", "ь": "",
    "ы": "i", "э": "e", "ё": "yo", "ю": "yu", "я": "ya", "ц": "ts",
}  # fmt: skip
_VOWELS = set("аеёиоуўэюяaeiou")
_APOSTROPHES = re.compile("[ʻʼ‘’`´]")
_CYRILLIC = re.compile("[Ѐ-ӿ]")


def _letter(ch: str, prev: str, nxt: str) -> str:
    low = ch.lower()
    if low == "е":
        # "ye" at the start of a word and after a vowel or ъ/ь (Европа → Yevropa, поезд → poyezd).
        out = "ye" if (not prev or not prev.isalpha() or prev.lower() in _VOWELS or prev.lower() in "ъь") else "e"
    elif low == "ц":
        # s at the start of a word, ts after a vowel (цирк → sirk, лицей → litsey).
        out = "s" if (not prev or not prev.isalpha()) else ("ts" if prev.lower() in _VOWELS else "s")
    else:
        out = _LETTERS.get(low, ch)
    if ch == low or not out:
        return out
    # A capital: "Ш" → "Sh", or "SH" when the word is written in capitals.
    return out.upper() if (nxt.isalpha() and nxt == nxt.upper() and nxt != nxt.lower()) else out[:1].upper() + out[1:]


def to_latin(text: str) -> str:
    """Uzbek Cyrillic → Latin; Latin text and other characters pass through unchanged."""
    if not _CYRILLIC.search(text):
        return text
    out = []
    for i, ch in enumerate(text):
        if _CYRILLIC.match(ch):
            out.append(_letter(ch, text[i - 1] if i else "", text[i + 1] if i + 1 < len(text) else ""))
        else:
            out.append(ch)
    return "".join(out)


def uz_display(text: str) -> str:
    """One spelling for live Uzbek words: Latin script, plain apostrophes."""
    return _APOSTROPHES.sub("'", to_latin(text))
