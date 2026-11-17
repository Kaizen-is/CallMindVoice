"""
Demo history generator — port of src/lib/engine/demo-data.ts.

Explicitly user-triggered and labelled in the UI: an analytics page with three calls in it says
nothing about whether the analytics are any good. Two kinds of record:
  • the most recent calls run through the real engine (`run_turn`) — genuine retrieval, answers,
    citations and latencies;
  • older days are backfilled as metadata-only call records with realistic distributions.

The random stream is seeded per tenant (`<tenant>:demo`) and drawn in exactly the order the
TypeScript draws it, so the same tenant on the same day gets the same history from either app.
Days, hours and months are worked out in the server's local time, like JavaScript's `Date`.
"""

import math
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app import db
from app.engine.calls import COST_PER_MINUTE, end_call, live_agent, start_call
from app.engine.conversation import run_turn
from app.engine.rng import seeded_random
from app.engine.simulator import agent_languages, pick, primary_number
from app.ids import new_id
from app.jscompat import js_fixed_number, js_round, utf16_units
from app.rag.retrieve import invalidate_corpus

NAMES = [
    "Aziz Karimov", "Dilnoza Yusupova", "Sardor Rahimov", "Malika Tosheva", "Jasur Ergashev",
    "Nilufar Saidova", "Bekzod Aliyev", "Kamola Nazarova", "Otabek Xolmatov", "Shahnoza Qodirova",
    "Rustam Ibragimov", "Zilola Umarova", "Farrux Sultonov", "Gulnora Abdullayeva", "Timur Yoqubov",
    "Sevara Mirzayeva", "Doniyor Tursunov", "Feruza Xolikova", "Alisher Nurmatov", "Mohira Bekova",
]  # fmt: skip

PREFIXES = ["+99890", "+99893", "+99894", "+99897", "+99899", "+99888", "+99891"]

INTENTS: list[dict[str, Any]] = [
    {"intent": "hours", "weight": 18, "solvable": 0.96},
    {"intent": "price", "weight": 22, "solvable": 0.92},
    {"intent": "booking", "weight": 16, "solvable": 0.78},
    {"intent": "location", "weight": 10, "solvable": 0.97},
    {"intent": "documents", "weight": 8, "solvable": 0.88},
    {"intent": "availability", "weight": 7, "solvable": 0.55},
    {"intent": "policy", "weight": 6, "solvable": 0.7},
    {"intent": "status", "weight": 5, "solvable": 0.42},
    {"intent": "complaint", "weight": 4, "solvable": 0.15},
    {"intent": "general", "weight": 4, "solvable": 0.6},
]

ESCALATION_REASONS = ["low_confidence", "explicit_request", "negative_sentiment", "repeated_failure"]

REPLAY_SCRIPTS: dict[str, list[list[str]]] = {
    "uz": [
        ["Assalomu alaykum", "Ish vaqtingiz qanday?", "Rahmat!"],
        ["Salom, kardiolog qabuli qancha turadi?", "Qanday hujjatlar kerak?"],
        ["Manzilingiz qayerda?", "Dam olish kunlari ishlaysizmi?"],
        ["Navbatga qanday yozilsam bo‘ladi?", "Katta rahmat"],
    ],
    "ru": [
        ["Здравствуйте, вы принимаете страховой полис?", "А какие документы нужны?"],
        ["Сколько стоит приём терапевта?", "Спасибо, всё понятно"],
        ["Когда будут готовы анализы?", "Хорошо, спасибо"],
        ["Я хочу подать жалобу на вчерашний приём", "С кем можно поговорить?"],
    ],
    "en": [
        ["Hello, what are your opening hours?", "Thanks very much"],
        ["How much is a consultation?", "Do you accept insurance?"],
        ["When will my results be ready?", "Great, thank you"],
    ],
}

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


# ── JavaScript's Date, in local time ───────────────────────────────


def now_ms() -> int:
    """`Date.now()` (tests replace it to pin the clock)."""
    return int(time.time() * 1000)


# The server's zone, both ways (the C library's, which reads TZ / the system zone as Node does).
# Tests swap these two for a fixed zone.
def to_local(seconds: int) -> time.struct_time:
    return time.localtime(seconds)


def from_local(wall: tuple[int, int, int, int, int, int]) -> int:
    return int(time.mktime((*wall, 0, 0, -1)))


def _local(ms: int) -> time.struct_time:
    return to_local(math.floor(ms / 1000))


def js_day(ms: int) -> int:
    """`getDay()`: 0 = Sunday."""
    return (_local(ms).tm_wday + 1) % 7


def _local_ms(year: int, month: int, day: int, hours: int, minutes: int, seconds: int, millis: int) -> int:
    """Local wall time → epoch ms, with JavaScript's overflow rules (month 12 is next January, day 31 of a
    30-day month is the 1st of the next)."""
    year += month // 12
    month %= 12
    d = date(year, month + 1, 1) + timedelta(days=day - 1)
    return from_local((d.year, d.month, d.day, hours, minutes, seconds)) * 1000 + millis


def set_hours(ms: int, hours: int, minutes: int, seconds: int, millis: int) -> int:
    """`new Date(ms).setHours(h, m, s, ms)`."""
    t = _local(ms)
    return _local_ms(t.tm_year, t.tm_mon - 1, t.tm_mday, hours, minutes, seconds, millis)


def add_months(ms: int, months: int) -> int:
    """`d.setMonth(d.getMonth() + months)` on `d = new Date(ms)`."""
    t = _local(ms)
    return _local_ms(t.tm_year, t.tm_mon - 1 + months, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec, ms % 1000)


def iso(ms: float) -> str:
    """`new Date(ms).toISOString()` (the time value truncated to whole ms, as TimeClip does)."""
    moment = _EPOCH + timedelta(milliseconds=int(ms))
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def parse_ms(iso_string: str) -> int:
    """`new Date(iso).getTime()` for an ISO string written by `iso`."""
    moment = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
    return (moment - _EPOCH) // timedelta(milliseconds=1)


# ── distributions ──────────────────────────────────────────────────


def hour_weight(hour: int, weekday: int) -> float:
    """Calls cluster in office hours; weekends are quieter."""
    if weekday == 0:
        return 0.25 if 10 <= hour <= 15 else 0.03
    if weekday == 6:
        return 0.5 if 10 <= hour <= 16 else 0.05
    if hour < 8 or hour > 20:
        return 0.04
    if 9 <= hour <= 12:
        return 1
    if 13 <= hour <= 17:
        return 0.85
    return 0.4


def pick_intent(rng: Callable[[], float]) -> dict[str, Any]:
    total = 0
    for i in INTENTS:
        total += i["weight"]
    r = rng() * total
    for i in INTENTS:
        r -= i["weight"]
        if r <= 0:
            return i
    return INTENTS[0]


def _new_totals() -> dict[str, Any]:
    return {
        "calls": 0,
        "ai": 0,
        "esc": 0,
        "aband": 0,
        "minutes": 0,
        "cost": 0,
        "latency": [],
        "csatSum": 0,
        "csatCount": 0,
    }


# ── seeding ────────────────────────────────────────────────────────


async def seed_demo_history(
    tenant_id: str, *, days: int = 30, per_day: int = 55, live_calls: int = 12
) -> dict[str, Any]:
    agent = live_agent(tenant_id)
    if agent is None:
        return {"ok": False, "created": 0, "message": "Create an agent first."}

    number = primary_number(tenant_id)
    rng = seeded_random(f"{tenant_id}:demo")
    languages = agent_languages(agent)

    created = 0
    day_totals: dict[str, dict[str, Any]] = {}

    with db.transaction() as tx:
        for d in range(days, 0, -1):
            day_ms = now_ms() - d * 86400000
            weekday = js_day(day_ms)
            # A gentle upward trend so the charts show the agent bedding in.
            growth = 0.62 + (1 - d / days) * 0.5
            day_factor = 0.2 if weekday == 0 else 0.5 if weekday == 6 else 1
            day_calls = js_round(per_day * growth * day_factor * (0.8 + rng() * 0.45))

            for _ in range(day_calls):
                hour = math.floor(rng() * 24)
                # Rejection-sample against the hour-of-day profile.
                attempt = 0
                while attempt < 6 and rng() > hour_weight(hour, weekday):
                    hour = math.floor(rng() * 24)
                    attempt += 1
                minute = math.floor(rng() * 60)
                second = math.floor(rng() * 60)
                started = set_hours(day_ms, hour, minute, second, 0)

                spec = pick_intent(rng)
                language = pick(languages, rng())
                if language is None:
                    language = "uz"
                answered = rng() < spec["solvable"]
                abandoned = not answered and rng() < 0.12
                escalated = not answered and not abandoned

                turns = 2 + math.floor(rng() * 4) if answered else 2 + math.floor(rng() * 3)
                duration_ms = js_round((28 + turns * 14 + rng() * 45) * 1000)
                # Latency improves slightly over the period as the index warms.
                base = 700 - (1 - d / days) * 180
                avg_latency = js_round(base + rng() * 260 + (90 if escalated else 0))
                minutes = duration_ms / 60000
                cost = js_fixed_number(minutes * COST_PER_MINUTE, 4)
                if answered:
                    csat = 5 if rng() < 0.78 else 4 if rng() < 0.7 else 3
                elif escalated:
                    csat = 4 if rng() < 0.5 else 3
                else:
                    csat = None

                call_id = new_id("call")
                ended = started + duration_ms

                # Argument order is draw order: number, name, sentiment, confidence, first response, p95, reason.
                from_ = phone_number_from(PREFIXES, rng)
                caller_name = pick(NAMES, rng())
                sentiment = 0.1 + rng() * 0.4 if answered else -0.6 + rng() * 0.5
                confidence = 0.6 + rng() * 0.37 if answered else 0.12 + rng() * 0.35
                first_response = js_round(avg_latency * (0.85 + rng() * 0.3))
                p95 = js_round(avg_latency * (1.25 + rng() * 0.35))
                reason = pick(ESCALATION_REASONS, rng()) if escalated else None
                db.execute(
                    tx,
                    """INSERT INTO calls (id, tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164,
                         caller_name, status, outcome, language, intent, sentiment, confidence, csat, turns,
                         duration_ms, first_response_ms, avg_latency_ms, p95_latency_ms, cost_usd, escalated,
                         escalation_reason, summary, started_at, answered_at, ended_at)
                       VALUES (:id, :t, :agent, :number, 'inbound', 'voice', :from_, :to, :name, 'completed',
                         :outcome, :language, :intent, :sentiment, :confidence, :csat, :turns, :duration,
                         :first, :avg, :p95, :cost, :escalated, :reason, NULL, :started, :started, :ended)""",
                    id=call_id,
                    t=tenant_id,
                    agent=agent["id"],
                    number=number["id"] if number else None,
                    from_=from_,
                    to=number["e164"] if number else "+998712000000",
                    name=caller_name,
                    outcome="abandoned" if abandoned else "resolved_by_operator" if escalated else "resolved_by_ai",
                    language=language,
                    intent=spec["intent"],
                    sentiment=sentiment,
                    confidence=confidence,
                    csat=csat,
                    turns=turns,
                    duration=duration_ms,
                    first=first_response,
                    avg=avg_latency,
                    p95=p95,
                    cost=cost,
                    escalated=1 if escalated else 0,
                    reason=reason,
                    started=iso(started),
                    ended=iso(ended),
                )

                if escalated:
                    waited = js_round(4000 + rng() * 26000)
                    esc_reason = pick(ESCALATION_REASONS, rng())
                    priority = "urgent" if rng() < 0.15 else "high" if rng() < 0.4 else "normal"
                    handled = js_round(60000 + rng() * 180000)
                    db.execute(
                        tx,
                        """INSERT INTO escalations (id, tenant_id, call_id, reason, priority, status, summary,
                             operator_id, waited_ms, handled_ms, resolution, created_at, assigned_at, resolved_at)
                           VALUES (:id, :t, :call, :reason, :priority, 'resolved', NULL, NULL, :waited, :handled,
                             'answered', :created, :assigned, :resolved)""",
                        id=new_id("esc"),
                        t=tenant_id,
                        call=call_id,
                        reason=esc_reason,
                        priority=priority,
                        waited=waited,
                        handled=handled,
                        created=iso(started),
                        assigned=iso(started + waited),
                        resolved=iso(ended),
                    )

                key = iso(started)[:10]
                t = day_totals.setdefault(key, _new_totals())
                t["calls"] += 1
                if answered:
                    t["ai"] += 1
                if escalated:
                    t["esc"] += 1
                if abandoned:
                    t["aband"] += 1
                t["minutes"] += minutes
                t["cost"] += cost
                t["latency"].append(avg_latency)
                if csat:
                    t["csatSum"] += csat
                    t["csatCount"] += 1
                created += 1

        for day, t in day_totals.items():
            latency_sum = 0
            for v in t["latency"]:
                latency_sum += v
            avg = js_round(latency_sum / max(1, len(t["latency"])))
            db.execute(
                tx,
                """INSERT INTO usage_daily (id, tenant_id, day, calls, ai_resolved, escalated, abandoned,
                     minutes, cost_usd, avg_latency_ms, csat_sum, csat_count)
                   VALUES (:id, :t, :day, :calls, :ai, :esc, :aband, :minutes, :cost, :avg, :csat_sum, :csat_count)
                   ON CONFLICT(tenant_id, day) DO UPDATE SET
                     calls = calls + excluded.calls,
                     ai_resolved = ai_resolved + excluded.ai_resolved,
                     escalated = escalated + excluded.escalated,
                     abandoned = abandoned + excluded.abandoned,
                     minutes = minutes + excluded.minutes,
                     cost_usd = cost_usd + excluded.cost_usd,
                     avg_latency_ms = excluded.avg_latency_ms,
                     csat_sum = csat_sum + excluded.csat_sum,
                     csat_count = csat_count + excluded.csat_count""",
                id=new_id("usg"),
                t=tenant_id,
                day=day,
                calls=t["calls"],
                ai=t["ai"],
                esc=t["esc"],
                aband=t["aband"],
                minutes=t["minutes"],
                cost=t["cost"],
                avg=avg,
                csat_sum=t["csatSum"],
                csat_count=t["csatCount"],
            )

        # A year of invoices so the billing page has history.
        for m in range(3, 0, -1):
            issued = add_months(now_ms(), -m)
            period = iso(issued)[:7]
            exists = db.fetch_one(
                tx, "SELECT id FROM invoices WHERE tenant_id = :t AND period = :p", t=tenant_id, p=period
            )
            if exists:
                continue
            calls = js_round(900 + rng() * 700)
            minutes = calls * (2.2 + rng() * 1.4)
            db.execute(
                tx,
                """INSERT INTO invoices (id, tenant_id, period, plan, base_usd, usage_usd, total_usd, minutes, calls,
                     status, issued_at)
                   VALUES (:id, :t, :period, 'pro', 1890, :usage, :total, :minutes, :calls, 'paid', :issued)""",
                id=new_id("inv"),
                t=tenant_id,
                period=period,
                usage=js_fixed_number(minutes * 0.065, 2),
                total=js_fixed_number(1890 + minutes * 0.065, 2),
                minutes=js_fixed_number(minutes, 0),
                calls=calls,
                issued=iso(issued),
            )

    # The most recent calls are replayed through the real engine so the transcripts, citations
    # and latencies on those records are genuine.
    real_ids: list[str] = []
    for i in range(live_calls):
        language = _cycle(languages, i)
        call_id = await _replay_real_call(tenant_id, agent, language if language is not None else "uz", rng)
        if call_id:
            real_ids.append(call_id)

    invalidate_corpus(tenant_id)
    return {
        "ok": True,
        "created": created + len(real_ids),
        "realCalls": len(real_ids),
        "message": f"Generated {created} historical records and {len(real_ids)} fully-replayed calls.",
    }


def _cycle(items: Any, i: int) -> Any:
    """`items[i % items.length]` — None where JavaScript gives undefined (an empty list: i % 0 is NaN)."""
    if items is None:
        raise TypeError("Cannot read properties of null (reading 'length')")
    if isinstance(items, str):
        items = [chr(u) for u in utf16_units(items)]
    if not isinstance(items, list) or not items:
        return None
    return items[i % len(items)]


def phone_number_from(prefixes: list[str], rng: Callable[[], float]) -> str:
    prefix = pick(prefixes, rng())
    return f"{prefix}{math.floor(rng() * 9e6) + 1000000}"


async def _replay_real_call(
    tenant_id: str, agent: dict[str, Any], language: str, rng: Callable[[], float]
) -> str | None:
    scripts = REPLAY_SCRIPTS.get(language) if isinstance(language, str) else None
    script = pick(scripts or REPLAY_SCRIPTS["en"], rng())
    number = primary_number(tenant_id)
    started_at = iso(now_ms() - math.floor(rng() * 8 * 3600_000))

    from_ = phone_number_from(PREFIXES, rng)
    caller_name = pick(NAMES, rng())
    call_id = start_call(
        tenant_id=tenant_id,
        agent_id=agent["id"],
        number_id=number["id"] if number else None,
        from_=from_,
        to=number["e164"] if number else "+998712000000",
        caller_name=caller_name,
        language=language,
        started_at=started_at,
    )

    escalated = False
    for utterance in script:
        result = await run_turn(
            tenant_id=tenant_id, call_id=call_id, agent=agent, utterance=utterance, stt_ms=150 + rng() * 200
        )
        if result["escalate"]:
            escalated = True
            break

    csat = 5 if rng() < 0.8 else 4
    end_call(
        tenant_id=tenant_id,
        call_id=call_id,
        outcome="resolved_by_operator" if escalated else "resolved_by_ai",
        csat=csat,
        ended_at=iso(parse_ms(started_at) + 40_000 + rng() * 90_000),
    )
    return call_id


def clear_demo_history(tenant_id: str) -> int:
    with db.connect() as conn:
        row = db.fetch_one(conn, "SELECT COUNT(*) AS c FROM calls WHERE tenant_id = :t", t=tenant_id)
    before = row["c"] if row and row["c"] is not None else 0
    with db.transaction() as tx:
        for table in ("escalations", "turns", "calls", "usage_daily", "knowledge_gaps", "invoices"):
            db.execute(tx, f"DELETE FROM {table} WHERE tenant_id = :t", t=tenant_id)  # noqa: S608 - fixed names
    return before
