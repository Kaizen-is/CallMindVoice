"""
Per-turn lap times of the Playground's voice call, saved with the turn, and their summary.

One voice turn is timed at seven moments, counted from when the caller stopped talking:

  browser  silenceWaitMs   the silence wait ended (the page decided the phrase was over)
  browser  endpointMs      the words were final and the turn left for the server
  server   srv_stt         the server had the words (0 with live words: the page sent them)
  server   srv_retrieval   knowledge-base search time (after srv_stt)
  server   srv_llmFirst    the model's first word
  server   srv_firstSegment the first phrase was ready to voice
  server   srv_firstAudio  the first voice audio was ready
  browser  mouthToEarMs    the caller heard the first sound

Server marks count from when the server started the turn; browser marks from when the caller stopped.
The server saves its own marks when the turn's voice is done (`save_laps`); the page sends its marks
once the reply has started playing. Both land in the agent turn's `timings_json` under "laps", with the
names the page's waterfall uses, so a reopened chat shows the same breakdown.
"""

import json
import math
from typing import Any

from app import db
from app.jscompat import js_json, js_round
from app.llm.choice import safe_json

# The marks the page may send (numbers, ms) and those the server writes; nothing else is stored.
BROWSER_LAPS = (
    "tmEnd",  # L3, ×1000: the model at the pause that ended the phrase
    "tmMid",  # ×1000: its highest score at pauses the caller went on after (would it have cut them off?)
    "tmMids",  # how many such pauses
    "tmUsed",  # 1: the model ended this phrase early
    "silenceWaitMs",
    "endpointMs",
    "mouthToEarMs",
    "replyRecvMs",
    "fillerAtMs",
    "gapCount",
    "gapMs",
)
SERVER_LAPS = (
    "srv_stt",
    "srv_retrieval",
    "srv_llm",
    "srv_llmFirst",
    "srv_firstSegment",
    "srv_firstAudio",
    "srv_fast",
    "srv_early",
    "srv_filler",
)
MAX_MS = 120_000  # a lap longer than two minutes is a broken clock, not a turn
SUMMARY_TURNS = 50  # the summary covers this many recent timed turns
TURN_MODEL_SURE = 900  # L3: the model's score (×1000) at which the Playground may end a phrase on it

# The steps of the summary, in order: each ends at a mark on the caller's clock (see `_stages`).
STEPS = ("silence", "words", "stt", "search", "llm", "segment", "voice", "play")


def latest_agent_turn(call_id: str) -> str | None:
    """The id of the call's newest agent turn (read while the call is still locked by its turn)."""
    with db.connect() as conn:
        row = db.fetch_one(
            conn,
            "SELECT id FROM turns WHERE call_id = :c AND role = 'agent' ORDER BY ordinal DESC LIMIT 1",
            c=call_id,
        )
    return row["id"] if row else None


def _clean(laps: object, allowed: tuple[str, ...]) -> dict[str, float]:
    if not isinstance(laps, dict):
        return {}
    out: dict[str, float] = {}
    for key in allowed:
        value = laps.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            continue
        if 0 <= value <= MAX_MS:
            out[key] = js_round(value)
    return out


def save_laps(
    tenant_id: str,
    call_id: str,
    turn_id: object,
    laps: object,
    *,
    source: str,
    engines: dict[str, str | None] | None = None,
) -> bool:
    """
    Add lap times to a Playground agent turn. `source` is "server" or "browser": each may only write its
    own marks. False when the turn is not this tenant's Playground turn.
    """
    if not isinstance(turn_id, str) or not turn_id:
        return False
    clean = _clean(laps, SERVER_LAPS if source == "server" else BROWSER_LAPS)
    if not clean and not engines:
        return False
    with db.transaction() as tx:
        row = db.fetch_one(
            tx,
            """SELECT t.timings_json FROM turns t JOIN calls c ON c.id = t.call_id
               WHERE t.id = :id AND t.call_id = :call AND t.tenant_id = :t AND t.role = 'agent'
                 AND c.channel = 'web' AND c.from_e164 = 'playground'""",
            id=turn_id,
            call=call_id,
            t=tenant_id,
        )
        if row is None:
            return False
        timings = safe_json(row["timings_json"], {})
        if not isinstance(timings, dict):
            timings = {}
        saved = timings.get("laps") if isinstance(timings.get("laps"), dict) else {}
        saved = {**saved, **clean}
        if engines:
            saved["engines"] = {**(saved.get("engines") or {}), **{k: v for k, v in engines.items() if v}}
        timings["laps"] = saved
        db.execute(tx, "UPDATE turns SET timings_json = :j WHERE id = :id", j=js_json(timings), id=turn_id)
    return True


def save_promise(tenant_id: str, call_id: str, turn_id: str, promise: dict[str, Any]) -> None:
    """Keep the promise to pay a Playground turn settled (L6) with that turn."""
    with db.transaction() as tx:
        row = db.fetch_one(
            tx,
            "SELECT timings_json FROM turns WHERE id = :id AND call_id = :call AND tenant_id = :t",
            id=turn_id,
            call=call_id,
            t=tenant_id,
        )
        if row is None:
            return
        timings = safe_json(row["timings_json"], {})
        timings = timings if isinstance(timings, dict) else {}
        timings["promise"] = promise
        db.execute(tx, "UPDATE turns SET timings_json = :j WHERE id = :id", j=js_json(timings), id=turn_id)


def flat_timings(raw: str | None) -> dict[str, Any]:
    """A saved turn's timings as the page reads them: the laps beside the original numbers."""
    timings = safe_json(raw, {})
    if not isinstance(timings, dict):
        return {}
    laps = timings.pop("laps", None)
    if isinstance(laps, dict):
        timings.update({k: v for k, v in laps.items() if k != "engines"})
    return timings


def _stages(laps: dict[str, Any]) -> dict[str, float] | None:
    """
    One turn's time per step, on the caller's clock. Server marks are placed after `endpointMs` (when the
    turn left); a step whose mark is missing or earlier than the one before folds into the next, as the
    page's waterfall does. None for a turn without the two browser ends.
    """
    endpoint, heard = laps.get("endpointMs"), laps.get("mouthToEarMs")
    if endpoint is None or heard is None:
        return None
    silence = laps.get("silenceWaitMs")
    stt = laps.get("srv_stt")
    search = stt + laps["srv_retrieval"] if stt is not None and laps.get("srv_retrieval") is not None else None

    def at(offset: float | None) -> float | None:
        return None if offset is None else endpoint + offset

    marks = [
        ("silence", silence),
        ("words", endpoint),
        ("stt", at(stt)),
        ("search", at(search)),
        ("llm", at(laps.get("srv_llmFirst"))),
        ("segment", at(laps.get("srv_firstSegment"))),
        ("voice", at(laps.get("srv_firstAudio"))),
        ("play", heard),
    ]
    out: dict[str, float] = {}
    prev = 0.0
    for key, mark in marks:
        if mark is None or mark < prev:
            continue
        out[key] = mark - prev
        prev = mark
    return out


def _percentile(values: list[float], share: float) -> int | None:
    """Nearest-rank percentile: the value `share` of the turns are at or below."""
    if not values:
        return None
    ordered = sorted(values)
    return js_round(ordered[max(0, math.ceil(share * len(ordered)) - 1)])


def summary(tenant_id: str, *, llm: str | None = None, tts: str | None = None, limit: int = SUMMARY_TURNS) -> dict:
    """Typical (p50) and worst (p95) time per step over this tenant's recent timed Playground turns."""
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            """SELECT t.timings_json FROM turns t JOIN calls c ON c.id = t.call_id
               WHERE t.tenant_id = :t AND t.role = 'agent' AND c.channel = 'web' AND c.from_e164 = 'playground'
                 AND t.timings_json LIKE '%"mouthToEarMs"%'
               ORDER BY t.created_at DESC LIMIT 1000""",
            t=tenant_id,
        )
    llms: set[str] = set()
    ttss: set[str] = set()
    picked: list[dict[str, Any]] = []
    for row in rows:
        laps = (safe_json(row["timings_json"], {}) or {}).get("laps")
        if not isinstance(laps, dict):
            continue
        engines = laps.get("engines") or {}
        if engines.get("llm"):
            llms.add(engines["llm"])
        if engines.get("tts"):
            ttss.add(engines["tts"])
        if (llm and engines.get("llm") != llm) or (tts and engines.get("tts") != tts):
            continue
        if len(picked) < limit and _stages(laps) is not None:
            picked.append(laps)
    per_step: dict[str, list[float]] = {s: [] for s in STEPS}
    totals: list[float] = []
    for laps in picked:
        stages = _stages(laps) or {}
        for step in STEPS:
            per_step[step].append(stages.get(step, 0.0))
        totals.append(laps["mouthToEarMs"])
    n = len(picked)
    return {
        "turnModel": _turn_model_view(picked),
        "turns": n,
        "steps": [
            {"key": s, "p50": _percentile(per_step[s], 0.5), "p95": _percentile(per_step[s], 0.95)} for s in STEPS
        ],
        "total": {"p50": _percentile(totals, 0.5), "p95": _percentile(totals, 0.95)},
        "earlyShare": round(sum(1 for laps in picked if laps.get("srv_early")) / n, 2) if n else None,
        "fillerShare": round(sum(1 for laps in picked if laps.get("fillerAtMs") is not None) / n, 2) if n else None,
        "llms": sorted(llms),
        "ttsEngines": sorted(ttss),
    }


def _turn_model_view(picked: list[dict[str, Any]]) -> dict[str, Any] | None:
    """
    What the end-of-turn model said on these turns (L3), whether or not it was in charge: how often it was
    sure at the pause that really ended the phrase (it would have answered sooner), and how often it was
    sure at a pause the caller went on after (it would have cut them off).
    """
    scored = [laps for laps in picked if isinstance(laps.get("tmEnd"), int | float)]
    if not scored:
        return None
    paused = [laps for laps in scored if (laps.get("tmMids") or 0) > 0]
    return {
        "turns": len(scored),
        "sure": TURN_MODEL_SURE,
        "endsSure": round(sum(1 for laps in scored if laps["tmEnd"] >= TURN_MODEL_SURE) / len(scored), 2),
        "pausedTurns": len(paused),
        "cutOffs": round(sum(1 for laps in paused if (laps.get("tmMid") or 0) >= TURN_MODEL_SURE) / len(paused), 2)
        if paused
        else None,
        "used": round(sum(1 for laps in scored if laps.get("tmUsed")) / len(scored), 2),
    }


def parse_body(raw: bytes) -> dict[str, Any]:
    try:
        body = json.loads(raw)
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}
