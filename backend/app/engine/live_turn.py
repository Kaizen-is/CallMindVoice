"""
What only a Playground voice turn does (for now): the latency work of the real-time roadmap is tried in
the Playground first and reaches the phone line later, by decision (2026-11-26). The Playground router
marks its turns (`playground_turn`); shared code checks `in_playground()` before using a Playground-only
behaviour, so phone calls, demos and the API keep working exactly as before.

Also here: the short phrases that need no knowledge-base search (Q3) and the per-call memory of the last
facts found, which such a phrase reuses.
"""

import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import regex as re

from app.env import env

_playground: ContextVar[bool] = ContextVar("playground_turn", default=False)


@contextmanager
def playground_turn() -> Iterator[None]:
    """Mark the work done inside (and the tasks it starts) as a Playground voice turn."""
    token = _playground.set(True)
    try:
        yield
    finally:
        _playground.reset(token)


def in_playground() -> bool:
    return _playground.get()


def smart_search_on() -> bool:
    """Q3 in a Playground turn, unless KB_SMART_SEARCH=off (or 0/false/no)."""
    raw = (env("KB_SMART_SEARCH") or "").strip().lower()
    return in_playground() and raw not in ("off", "0", "false", "no")


# ── short phrases that need no search ───────────────────────────────

# Agreement, refusal, thanks and goodbyes, greetings and sounds of listening: the caller's whole phrase
# made of these (at most 3 words) carries no question for the knowledge base. Compared without
# apostrophes, so "xo'p", "xo‘p" and "xop" are the same word.
SMALL_TALK = (
    # yes / agree
    "ha", "xo'p", "mayli", "albatta", "to'g'ri", "bo'pti", "tushunarli", "xo'sh",
    # no
    "yo'q", "yo'g'e", "kerak emas",
    # thanks / bye
    "rahmat", "katta rahmat", "sog' bo'ling", "xayr", "salomat bo'ling",
    # greetings
    "salom", "assalomu alaykum", "alo", "allo",
    # sounds of listening
    "hmm", "aha", "ana", "mm",
)  # fmt: skip
MAX_WORDS = 3

_APOSTROPHES = re.compile(r"[‘’ʻʼ`´']")
_NOT_WORD = re.compile(r"[^\p{L}\p{N}\s]")


def _words(text: str) -> list[str]:
    text = _APOSTROPHES.sub("", text.lower()).replace("-", " ")
    return _NOT_WORD.sub(" ", text).split()


_PHRASES = sorted({tuple(_words(p)) for p in SMALL_TALK}, key=len, reverse=True)


def is_small_talk(utterance: str) -> bool:
    """True when the whole phrase is made only of SMALL_TALK items and has at most MAX_WORDS words."""
    words = _words(utterance)
    if not words or len(words) > MAX_WORDS:
        return False
    i = 0
    while i < len(words):
        for phrase in _PHRASES:
            if tuple(words[i : i + len(phrase)]) == phrase:
                i += len(phrase)
                break
        else:
            return False
    return True


# ── the last facts found in each call ───────────────────────────────

FACTS_TTL_S = 600.0
_last_facts: dict[str, tuple[float, Any]] = {}


def remember_facts(call_id: str | None, retrieval: Any) -> None:
    """Keep a call's latest search result that found something (a following "ha" answers from it)."""
    if not call_id or not getattr(retrieval, "hits", None):
        return
    _last_facts[call_id] = (time.monotonic(), retrieval)
    if len(_last_facts) > 2000:
        stale = time.monotonic() - FACTS_TTL_S
        for cid in [c for c, (at, _r) in _last_facts.items() if at < stale]:
            del _last_facts[cid]


def last_facts(call_id: str | None) -> Any | None:
    entry = _last_facts.get(call_id) if call_id else None
    if entry is None or time.monotonic() - entry[0] > FACTS_TTL_S:
        return None
    return entry[1]
