"""
Words the recognisers should expect on an agent's calls: the agent's name, the company's name,
and the names and abbreviations its knowledge base keeps using (products, branches, places).
Recognisers misspell words they have never seen; GAPI takes them as `vocabulary`, Whisper as
its `prompt`.

Built automatically, nothing to fill in. Names are found the plain way: a capitalised word that
appears at least twice mid-sentence and never in lower case ("Mastercard", "Chilonzor"), or an
abbreviation in capitals ("BRB", "SMS"). The knowledge-base part is cached until a document is
added, changed or removed.
"""

import logging
from typing import Any

import regex as re

from app import db
from app.jscompat import js_trim

log = logging.getLogger("callmind.vocabulary")

MAX_WORDS = 20  # GAPI's limit; also keeps Whisper's prompt short
MAX_CHUNKS = 5000  # enough text to find the names without reading a huge library on a call
MIN_COUNT = 2

_WORD = re.compile(r"[\p{L}\p{N}][\p{L}\p{N}'ʻʼ‘’`-]*")
_TRAILING = "'ʻʼ‘’`-"
_SENTENCE_END = '.!?…:;"«»()[]*#|•–—-'

# tenant id -> ((document count, last change), words)
_cache: dict[str, tuple[tuple[Any, Any], list[str]]] = {}


def _at_sentence_start(text: str, start: int) -> bool:
    prev = text[max(0, start - 40) : start].rstrip(" \t")
    return not prev or prev[-1] in _SENTENCE_END or prev[-1] in "\r\n"


def _is_abbreviation(word: str) -> bool:
    letters = [c for c in word if c.isalpha()]
    return 2 <= len(word) <= 8 and len(letters) >= 2 and all(c.isupper() for c in letters)


def _is_title(word: str) -> bool:
    return len(word) >= 3 and word[0].isupper() and any(c.islower() for c in word[1:])


def knowledge_names(texts: list[str]) -> list[str]:
    """The names and abbreviations a body of text keeps using, most frequent first."""
    counts: dict[str, int] = {}
    first_seen: dict[str, int] = {}
    lower: set[str] = set()
    order = 0
    for text in texts:
        for match in _WORD.finditer(text):
            word = match.group().rstrip(_TRAILING)
            if not word:
                continue
            if word.islower():
                lower.add(word)
                continue
            if _is_abbreviation(word):
                pass  # an abbreviation counts wherever it stands
            elif not _is_title(word) or _at_sentence_start(text, match.start()):
                continue
            counts[word] = counts.get(word, 0) + 1
            if word not in first_seen:
                first_seen[word] = order
                order += 1
    names = [w for w, n in counts.items() if n >= MIN_COUNT and w.lower() not in lower]
    names.sort(key=lambda w: (-counts[w], first_seen[w]))
    return names


def _knowledge_words(conn: Any, tenant_id: str) -> list[str]:
    stamp_row = db.fetch_one(
        conn, "SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM documents WHERE tenant_id = :t", t=tenant_id
    )
    stamp = (stamp_row["n"], stamp_row["at"]) if stamp_row else (0, None)
    cached = _cache.get(tenant_id)
    if cached and cached[0] == stamp:
        return cached[1]
    rows = db.fetch_all(
        conn,
        """SELECT c.text FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.tenant_id = :t AND d.status = 'ready'
           ORDER BY d.created_at, c.ordinal LIMIT :n""",
        t=tenant_id,
        n=MAX_CHUNKS,
    )
    words = knowledge_names([r["text"] for r in rows if r["text"]])[:MAX_WORDS]
    _cache[tenant_id] = (stamp, words)
    if len(_cache) > 500:
        _cache.clear()
    return words


def recognition_words(tenant_id: str, agent: dict[str, Any] | None = None) -> list[str]:
    """
    Up to 20 words for this agent's calls: its name, the company's, then the knowledge base's names.
    Never raises: a missing hint must not cost the caller their turn.
    """
    try:
        with db.connect() as conn:
            tenant = db.fetch_one(conn, "SELECT name FROM tenants WHERE id = :t", t=tenant_id)
            found = _knowledge_words(conn, tenant_id)
    except Exception as err:  # noqa: BLE001
        log.warning("[vocabulary] %s", err)
        return []
    out: list[str] = []
    seen: set[str] = set()
    for word in (agent or {}).get("name"), (tenant or {}).get("name"), *found:
        text = js_trim(word) if isinstance(word, str) else ""
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append(text)
    return out[:MAX_WORDS]


def whisper_prompt(words: list[str] | None) -> str:
    """Whisper's `prompt`: the words as a short list, the way earlier transcript text would read."""
    return f"{', '.join(words)}." if words else ""


_PUNCT = re.compile(r"[^\p{L}\p{N}]+")


def echoes_prompt(text: str, prompt: str) -> bool:
    """
    Whisper sometimes repeats its prompt when it hears nothing it can make out. Three or more words
    that run exactly as in the prompt are taken for that echo, not for speech.
    """
    said = _PUNCT.sub(" ", text.lower()).split()
    if len(said) < 3 or not prompt:
        return False
    return f" {' '.join(said)} " in f" {' '.join(_PUNCT.sub(' ', prompt.lower()).split())} "


# Words of a loan or bank call that Uzbek recognisers mishear (Q9; "qarzim" heard as "qarsim").
CALL_TERMS = (
    "qarz", "qarzim", "qarzingiz", "qarzdorlik", "to'lov", "to'lovni", "so'm", "muddat", "muddati",
    "kredit", "foiz", "penya", "karta", "Humo", "Uzcard", "filial", "oylik", "ertaga",
)  # fmt: skip
MAX_LIVE_WORDS = 40


def live_words(tenant_id: str, agent: dict[str, Any] | None = None) -> list[str]:
    """
    The words a live recogniser is biased towards (Gemini live `customVocabulary`): the call terms
    above, the agent's and company's names and its knowledge base's names (`recognition_words`), and
    the name of the person the agent calls. Never raises.
    """
    words: list[str] = list(CALL_TERMS)
    words += recognition_words(tenant_id, agent)
    target = (agent or {}).get("target_json") or ""
    try:
        import json

        full_name = js_trim(str((json.loads(target) if target else {}).get("fullName") or ""))
    except (TypeError, ValueError):
        full_name = ""
    words += [w for w in full_name.split() if len(w) > 1]
    seen: set[str] = set()
    out: list[str] = []
    for word in words:
        key = word.lower()
        if word and key not in seen:
            seen.add(key)
            out.append(word)
    return out[:MAX_LIVE_WORDS]
