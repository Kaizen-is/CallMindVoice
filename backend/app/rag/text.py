# ruff: noqa: E501, SIM905 - word lists stay as in the TypeScript source (one long string, one concept per line)
"""
Trilingual text normalisation for Uzbek (Latin + Cyrillic), Russian and English.
Port of src/lib/rag/text.ts — must give identical output, because the stored
term counts and vectors in `chunks` were computed by the TypeScript version.

Uzbek is written in two scripts and callers mix Uzbek and Russian, so all text
is projected into one normalised Latin space before indexing and querying:
«шифокор», "shifokor" and "shifokorga" collide.
"""

import unicodedata

import regex as re

from app.jscompat import JS_S, js_round, utf16_len

# ── script folding ──────────────────────────────────────────────────

CYRILLIC_TO_LATIN = {
    "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "g", "д": "d", "е": "e", "ё": "yo", "ж": "j",
    "з": "z", "и": "i", "й": "y", "к": "k", "қ": "q", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ў": "o", "ф": "f", "х": "x", "ҳ": "h",
    "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sh", "ъ": "", "ы": "i", "ь": "", "э": "e",
    "ю": "yu", "я": "ya", "ј": "j", "һ": "h", "ә": "a", "ө": "o", "ү": "u", "ң": "ng",
}  # fmt: skip

_APOSTROPHES = re.compile("[ʻʼʽ‘’`´']")
_COMBINING = re.compile("[̀-ͯ]")
_NOT_KEPT = re.compile(f"[^a-z0-9{JS_S}\\-+.@%/]")
_SPACES = re.compile(f"[{JS_S}]+")


def _js_trim(s: str) -> str:
    return re.sub(f"^[{JS_S}]+|[{JS_S}]+$", "", s)


def normalize(text: str) -> str:
    # NFKD then strip combining marks, so accented forms fold to their base letter.
    s = _COMBINING.sub("", unicodedata.normalize("NFKD", text.lower()))
    s = _APOSTROPHES.sub("", s)  # oʻ→o, gʻ→g
    s = "".join(CYRILLIC_TO_LATIN.get(ch, ch) for ch in s)
    s = _NOT_KEPT.sub(" ", s)
    return _js_trim(_SPACES.sub(" ", s))


# ── stopwords ───────────────────────────────────────────────────────

STOPWORDS = frozenset(
    (
        # English
        "a an and are as at be but by for from has have how i in is it its of on or that the this to was were "
        "what when where which who will with you your do does did can could would should not no yes if then "
        "than there here about into over under again more most some such only own same so too very "
        # Russian (transliterated by the same folding above)
        "i v vo ne chto on na ya s so kak a to vse ona tak ego no da ty k u zhe vi za bi po tolko ee mne bilo "
        "vot ot menya eshche net o iz emu teper kogda dazhe nu vdrug li esli uzhe ili ni bit bil nego do vas "
        "nibud opyat uzh vam skazal vedi tam potom sebya nichego ej mozhet oni tut gde est nado nej dlya mi "
        "tebya ih chem bila sam chtob bez budto chelovek chego raz tozhe sebe pod budet zh togda kto etot "
        "etogo kotoriy pri nas pro nih "
        # Uzbek
        "va bilan uchun bu shu ular biz siz men u bir har hech ham lekin ammo yoki agar chunki qanday qachon "
        "qayer nima kim necha juda faqat yana keyin oldin ustida ostida ichida tashqarida boshqa barcha "
        "hamma yaxshi kerak mumkin bor yoq edi ekan qilib deb dan ga da ni ning"
    ).split(" ")
)


def is_stopword(token: str) -> bool:
    return token in STOPWORDS


# ── stemming ────────────────────────────────────────────────────────

# Conservative suffix stripper; ordered as in the TypeScript list; never below 4 characters.
SUFFIXES = [
    # Uzbek case / possessive / plural (agglutinative — strip one layer)
    "lardan", "larga", "larda", "larni", "larim", "laring", "lari", "lar",
    "imizni", "ingizni", "ingiz", "imiz", "ning", "dagi", "gacha", "dan", "ga", "da", "ni", "im", "ing",
    "moqchi", "yapti", "gan", "yotgan", "adi", "ydi", "di", "sh", "ish",
    # Russian (transliterated)
    "ostyu", "ostey", "ostyah", "ovaniya", "eniya", "aniya", "ami", "yami", "ah", "yah",
    "ov", "ev", "iy", "yy", "aya", "oe", "ie", "ye", "ye", "om", "em", "ey", "oy",
    "ami", "imi", "yu", "ya", "u", "e", "a", "i", "y", "o",
    # English
    "ations", "ation", "ings", "ing", "edly", "ies", "ied", "es", "ed", "s",
]  # fmt: skip


def stem(token: str) -> str:
    # Tokens are ASCII after normalize(), so len() equals JavaScript's length here.
    if len(token) <= 4:
        return token
    for suffix in SUFFIXES:
        if len(token) - len(suffix) >= 4 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


# ── cross-lingual bridging ──────────────────────────────────────────

# High-frequency contact-centre concepts share a canonical token so a Russian
# question can find an Uzbek document. Written post-normalisation.
CONCEPTS: dict[str, list[str]] = {
    "price": [
        "narx", "qiymat", "cena", "stoimost", "price", "cost", "tarif", "tariff", "summa", "prays",
        "qancha", "skolko", "much", "stoit", "pochem", "fee", "pul", "dengi", "money",
    ],
    "hours": [
        "vaqt", "soat", "grafik", "raspisanie", "rezhim", "hour", "schedule", "open", "ochiq",
        "vremya", "chas", "qachon", "kogda", "when", "rabota", "ishlay", "close", "yopiq", "zakrit",
        "work", "opening", "shift", "smena",
    ],
    "address": [
        "manzil", "adres", "address", "joylash", "nahodit", "filial", "branch", "ofis", "office",
        "qayer", "gde", "where", "kocha", "street", "ulitsa", "metro", "orientir",
    ],
    "doc": [
        "hujjat", "dokument", "document", "spravka", "guvohnoma", "pasport", "passport", "polis",
        "policy", "nuzhno", "kerak", "need", "bring", "olib",
    ],
    "booking": [
        "navbat", "yozil", "zapis", "priem", "qabul", "booking", "appointment", "reserve", "bron",
        "konsultatsiya", "konsultaci", "consultation", "consult", "visit", "tashrif",
    ],
    "phone": ["telefon", "raqam", "nomer", "number", "phone", "aloqa", "svyaz", "contact", "kontakt",
              "whatsapp", "telegram"],
    "payment": [
        "tolov", "oplata", "payment", "pay", "karta", "card", "nalich", "naqd", "perevod", "transfer",
        "uzcard", "humo", "payme", "click", "rassrochk", "muddatli", "instalment", "installment",
    ],
    "insurance": ["sugurta", "strahov", "insurance", "polis", "insured"],
    "doctor": [
        "shifokor", "vrach", "doctor", "kardiolog", "terapevt", "pediatr", "nevropatolog", "ginekolog",
        "endokrinolog", "physician", "specialist", "mutaxassis",
    ],
    "child": ["bola", "rebenok", "detsk", "child", "children", "kid", "pediatr", "vakcin", "emlash", "privivk"],
    "result": ["natija", "rezultat", "result", "analiz", "tahlil", "test", "anali", "gotov", "tayyor", "ready"],
    "availability": ["bormi", "mavjud", "est", "imeet", "nalichie", "available", "svobodn", "bosh", "free",
                     "slot"],
    "delivery": ["yetkaz", "dostavka", "delivery", "kuryer", "courier", "ship", "dostav"],
    "refund": ["qaytar", "vozvrat", "refund", "return", "obmen", "almash", "exchange", "garantiya", "kafolat",
               "warranty"],
    "order": ["buyurtma", "zakaz", "order", "pokupk", "xarid", "track", "trek"],
    "operator": [
        "operator", "menejer", "manager", "xodim", "sotrudnik", "spetsialist", "human", "zhivoy",
        "soedinite", "ulang", "perevedite", "agent", "administrator",
    ],
    "weekend": ["dam", "vixodn", "weekend", "shanba", "yakshanba", "subbot", "voskresen", "saturday", "sunday"],
    "discount": ["chegirma", "skidk", "discount", "aksiya", "promo", "sale"],
    "complaint": ["shikoyat", "jalob", "complaint", "pretenz", "problema", "muammo", "problem"],
    "cancel": ["bekor", "otmen", "cancel", "perenes", "kochir", "reschedule"],
}  # fmt: skip

_CONCEPT_INDEX = [(form, f"~{concept}") for concept, forms in CONCEPTS.items() for form in forms]
_concept_cache: dict[str, str | None] = {}


def concept_of(term: str) -> str | None:
    """Canonical concept token for a term (`~price`), or None."""
    if term in _concept_cache:
        return _concept_cache[term]
    found = None
    for form, concept in _CONCEPT_INDEX:
        if term == form:
            found = concept
            break
        # Prefix match absorbs inflection the stemmer left behind; both sides need 4+ characters.
        if len(form) >= 4 and len(term) >= 4 and (term.startswith(form) or form.startswith(term)):
            found = concept
            break
    _concept_cache[term] = found
    return found


def expand_terms(terms: list[str]) -> list[str]:
    """Terms plus their concept tokens (each concept once), in the TypeScript order."""
    out = list(terms)
    seen: set[str] = set()
    for t in terms:
        c = concept_of(t)
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


# ── tokenisation ────────────────────────────────────────────────────

_SPLIT = re.compile(f"[{JS_S}\\-/]+")
_EDGE_PUNCT = re.compile(r"^[.@%+]+|[.@%+]+$")


def tokenize(text: str, keep_stopwords: bool = False) -> list[str]:
    out = []
    for raw in _SPLIT.split(normalize(text)):
        t = _EDGE_PUNCT.sub("", raw)
        if len(t) < 2:
            continue
        if not keep_stopwords and t in STOPWORDS:
            continue
        out.append(t)
    return out


def stems(text: str) -> list[str]:
    """Stemmed tokens plus concept tokens — what both the indexer and the retriever use."""
    return expand_terms([stem(t) for t in tokenize(text)])


def char_ngrams(token: str, low: int = 3, high: int = 4) -> list[str]:
    padded = f"«{token}»"
    return [padded[i : i + n] for n in range(low, high + 1) for i in range(len(padded) - n + 1)]


# ── language detection ──────────────────────────────────────────────

# JavaScript regexes without the `u` flag: \b and \w are ASCII-only, hence re.ASCII.
_UZ_MARKERS = re.compile(
    r"\b(va|bilan|uchun|kerak|qanday|salom|rahmat|shifokor|qabul|narx|ish|xizmat|mumkin|bormi|qilish|yoki)\b",
    re.ASCII,
)
_RU_MARKERS = re.compile(
    r"\b(и|в|не|что|как|вы|мне|здравствуйте|спасибо|врач|прием|цена|услуга|можно|или|где|когда)\b",
    re.ASCII | re.IGNORECASE,
)
_EN_MARKERS = re.compile(
    r"\b(the|and|you|for|are|with|hello|thanks|doctor|price|service|can|how|when|where)\b",
    re.ASCII | re.IGNORECASE,
)
_UZ_GRAPHEMES = re.compile(r"қ|ғ|ҳ|ў|o['ʻʼ’]|g['ʻʼ’]|\bq[aeiou]|sh\w|ch\w", re.ASCII)
_CYRILLIC = re.compile("[а-яёқғҳўј]")
_LATIN = re.compile("[a-z]")
_UZ_CYRILLIC_ONLY = re.compile("[қғҳў]")


def detect_language(text: str) -> str:
    lower = text.lower()
    cyr = len(_CYRILLIC.findall(lower))
    lat = len(_LATIN.findall(lower))
    letters = cyr + lat
    if not letters:
        return "uz"

    normalized = normalize(lower)
    uz_marker = bool(_UZ_MARKERS.search(normalized))
    ru_marker = bool(_RU_MARKERS.search(lower))
    en_marker = bool(_EN_MARKERS.search(lower))

    # Scale the grapheme signal by length so one incidental "sha" can't outvote English function words.
    graphemes = len(_UZ_GRAPHEMES.findall(lower))
    grapheme_rate = graphemes / max(6, letters / 4)

    uz = (3.5 if uz_marker else 0) + min(3, grapheme_rate * 2.5)
    ru = 3.5 if ru_marker else 0
    en = 3.5 if en_marker else 0

    if cyr > lat:
        # Cyrillic is Russian unless something specifically Uzbek says otherwise.
        ru += 2.5
        if uz_marker or _UZ_CYRILLIC_ONLY.search(lower):
            uz += 2
        en -= 2
    elif lat > 0:
        en += 0.5
        uz += 0.5

    if uz > ru and uz > en:
        return "uz"
    if ru > en:
        return "ru"
    if en > uz:
        return "en"
    return "uz" if lat >= cyr else "ru"


# ── misc ────────────────────────────────────────────────────────────


def estimate_tokens(text: str) -> int:
    """Cheap token estimate — good enough for cost display and chunk sizing."""
    return max(1, js_round(utf16_len(text) / 3.6))


_SENTENCE_SPLIT = re.compile(f"(?<=[.!?…])[{JS_S}]+(?=[A-ZА-ЯЎҚҒҲ«\"(0-9])|\\n{{2,}}")


def sentences(text: str) -> list[str]:
    return [s for s in (_js_trim(p) for p in _SENTENCE_SPLIT.split(text)) if s]


_WORD_RUNS = re.compile(r"([\p{L}\p{N}']+)|([^\p{L}\p{N}']+)")


def highlight(snippet: str, query: str) -> list[tuple[str, bool]]:
    """Split a snippet into [text, is_match] runs for the query's terms."""
    wanted = set(stems(query))
    if not wanted:
        return [(snippet, False)]
    parts: list[tuple[str, bool]] = []
    for m in _WORD_RUNS.finditer(snippet):
        word = m.group(1)
        parts.append((word, stem(normalize(word)) in wanted) if word else (m.group(2), False))
    merged: list[list] = []
    for t, hit in parts:
        if merged and merged[-1][1] == hit:
            merged[-1][0] += t
        else:
            merged.append([t, hit])
    return [(t, hit) for t, hit in merged]
