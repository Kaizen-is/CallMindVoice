"""
Traffic simulator — port of src/lib/engine/simulator.ts.

Real telephony needs the Asterisk bridge and a connected number; the simulator drives the *same*
engine the phone lines drive (`run_turn`), so the live wallboard shows genuine retrieval,
generation and escalation decisions against the tenant's own documents. Only the audio
transport is modelled.

Behaviour kept from the TypeScript on purpose:
  • every wait of a running call is tracked (not every call), so `simulator_load` counts pending
    and past waits of the calls still running, and `stop_simulation` returns that count;
  • stopping cancels the pending waits: a call waiting on one stops for good (its `finally` never
    mattered), while a call that is inside a turn at that moment carries on;
  • a call that escalates leaves the simulator (the operator inbox owns it).
"""

import asyncio
import contextlib
import json
import math
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app import db
from app.background import spawn
from app.engine.bus import publish
from app.engine.calls import end_call, live_agent, start_call
from app.engine.conversation import run_turn
from app.engine.rng import seeded_random
from app.jscompat import js_number_str, utf16_len, utf16_units

# ── caller personas ────────────────────────────────────────────────

UZ_NAMES = [
    "Aziz Karimov", "Dilnoza Yusupova", "Sardor Rahimov", "Malika Tosheva",
    "Jasur Ergashev", "Nilufar Saidova", "Bekzod Aliyev", "Kamola Nazarova",
    "Otabek Xolmatov", "Shahnoza Qodirova", "Rustam Ibragimov", "Zilola Umarova",
    "Farrux Sultonov", "Gulnora Abdullayeva", "Timur Yoqubov", "Sevara Mirzayeva",
]  # fmt: skip

PREFIXES = ["+99890", "+99893", "+99894", "+99897", "+99899", "+99888"]

# Caller utterances only — every answer comes from the tenant's indexed documents at run time.
SCRIPTS: dict[str, dict[str, list[str]]] = {
    "uz": {
        "open": ["Assalomu alaykum", "Salom, eshityapsizmi?", "Assalomu alaykum, savolim bor edi"],
        "body": [
            "Ish vaqtingiz qanday?",
            "Qabul narxi qancha?",
            "Manzilingiz qayerda joylashgan?",
            "Navbatga qanday yozilsam bo‘ladi?",
            "Bugun bo‘sh joy bormi?",
            "Qanday hujjatlar kerak?",
            "Dam olish kunlari ishlaysizmi?",
            "To‘lovni qanday amalga oshiraman?",
            "Sug‘urta polisi qabul qilinadimi?",
            "Telefon raqamingizni ayta olasizmi?",
            "Bolalar uchun ham xizmat bormi?",
            "Natijani qachon olaman?",
        ],
        "hard": [
            "Menda kecha bo‘lgan operatsiya bo‘yicha shikoyat bor, kim javob beradi?",
            "O‘tgan yilgi shartnomamdagi 14-bandni tushuntira olasizmi?",
            "Xodimingiz menga noto‘g‘ri ma’lumot berdi, buni kim hal qiladi?",
        ],
        "close": ["Rahmat, tushunarli", "Katta rahmat, xayr", "Yaxshi, rahmat sizga"],
    },
    "ru": {
        "open": ["Здравствуйте", "Алло, добрый день", "Здравствуйте, у меня вопрос"],
        "body": [
            "Какой у вас график работы?",
            "Сколько стоит приём?",
            "Где вы находитесь?",
            "Как записаться на приём?",
            "Есть свободное время сегодня?",
            "Какие документы нужны?",
            "Вы работаете в выходные?",
            "Как можно оплатить?",
            "Вы принимаете страховку?",
            "Подскажите ваш номер телефона",
            "А для детей услуги есть?",
            "Когда будут готовы результаты?",
        ],
        "hard": [
            "Я хочу подать жалобу на вчерашний приём, с кем можно поговорить?",
            "Объясните пункт 14 моего прошлогоднего договора",
            "Мне дали неверную информацию, кто это будет решать?",
        ],
        "close": ["Спасибо, всё понятно", "Большое спасибо, до свидания", "Хорошо, спасибо вам"],
    },
    "en": {
        "open": ["Hello, good afternoon", "Hi, I have a question", "Hello, can you hear me?"],
        "body": [
            "What are your opening hours?",
            "How much does an appointment cost?",
            "Where are you located?",
            "How do I book an appointment?",
            "Do you have anything available today?",
            "What documents do I need to bring?",
            "Are you open at the weekend?",
            "What payment methods do you accept?",
            "Do you accept insurance?",
            "Could you give me your phone number?",
            "Do you offer services for children?",
            "When will the results be ready?",
        ],
        "hard": [
            "I want to make a complaint about yesterday — who can I speak to?",
            "Can you explain clause 14 of my contract from last year?",
            "Your staff gave me the wrong information, who resolves that?",
        ],
        "close": ["Thanks, that is clear", "Thank you very much, goodbye", "Great, thanks for your help"],
    },
}

HUMAN_REQUEST = {
    "uz": "Operator bilan gaplashsam bo‘ladimi?",
    "ru": "Можно соединить меня с оператором?",
    "en": "Could you put me through to a human agent, please?",
}

# Tests shrink every wait (0 = next loop turn); the waits keep their order either way.
TIME_SCALE = 1.0

# ── small JavaScript-isms ──────────────────────────────────────────


def pick(items: Any, r: float) -> Any:
    """`items[Math.floor(r * items.length)]` — None where JavaScript gives undefined."""
    if items is None:
        raise TypeError("Cannot read properties of null (reading 'length')")
    if isinstance(items, str):
        items = [chr(u) for u in utf16_units(items)]
    if not isinstance(items, list):
        return None  # `.length` of a number or an object is undefined
    i = math.floor(r * len(items))
    return items[i] if 0 <= i < len(items) else None


def agent_languages(agent: dict[str, Any]) -> Any:
    """`JSON.parse(agent.languages_json || '["uz","ru","en"]')` (bad JSON raises, as it throws there)."""
    return json.loads(agent.get("languages_json") or '["uz","ru","en"]')


def phone_number(rng: Callable[[], float]) -> str:
    """`${PREFIXES[…]}${String(Math.floor(rng() * 9e6) + 1e6)}` — two draws, prefix first."""
    prefix = pick(PREFIXES, rng())
    return f"{prefix}{math.floor(rng() * 9e6) + 1000000}"


def primary_number(tenant_id: str) -> dict[str, Any] | None:
    """`primaryNumber` from calls.ts: the tenant's oldest active number."""
    with db.connect() as conn:
        return db.fetch_one(
            conn,
            "SELECT * FROM phone_numbers WHERE tenant_id = :t AND status = 'active' ORDER BY created_at ASC LIMIT 1",
            t=tenant_id,
        )


# ── scheduling ─────────────────────────────────────────────────────


@dataclass
class _Wait:
    call_id: str
    handle: asyncio.TimerHandle
    future: asyncio.Future


class _Stopped(BaseException):
    """A wait whose timer was cleared by `stop_simulation`: in JavaScript it never resolves."""


_running: dict[str, list[_Wait]] = {}


def _track(tenant_id: str, entry: _Wait) -> None:
    _running.setdefault(tenant_id, []).append(entry)


def _untrack(tenant_id: str, call_id: str) -> None:
    waits = _running.get(tenant_id)
    if waits is None:
        return
    _running[tenant_id] = [w for w in waits if w.call_id != call_id]


def simulator_load(tenant_id: str) -> int:
    return len(_running.get(tenant_id, ()))


def stop_simulation(tenant_id: str) -> int:
    waits = _running.pop(tenant_id, [])
    for w in waits:
        w.handle.cancel()
        if not w.future.done():
            w.future.cancel()
    return len(waits)


def _settle(future: asyncio.Future) -> None:
    if not future.done():
        future.set_result(None)


def _start_wait(tenant_id: str, call_id: str, ms: float, speed: float) -> asyncio.Future:
    """`setTimeout(resolve, Math.max(20, ms / speed))`, tracked at once (synchronously, as in JavaScript)."""
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    delay_s = max(20, ms / speed) / 1000 * TIME_SCALE
    _track(tenant_id, _Wait(call_id, loop.call_later(delay_s, _settle, future), future))
    return future


async def _until(future: asyncio.Future) -> None:
    try:
        await future
    except asyncio.CancelledError:
        if future.cancelled():
            raise _Stopped from None
        raise


async def _wait(tenant_id: str, call_id: str, ms: float, speed: float) -> None:
    await _until(_start_wait(tenant_id, call_id, ms, speed))


# ── one simulated call ─────────────────────────────────────────────


def simulate_call(
    tenant_id: str,
    *,
    language: str | None = None,
    difficulty: float | None = None,
    speed: float | None = None,
    seed: str | None = None,
) -> str | None:
    """Start one simulated call (needs a running event loop); its turns play out in the background."""
    agent = live_agent(tenant_id)
    if agent is None:
        return None

    rng = seeded_random(seed if seed is not None else f"{tenant_id}:{js_number_str(random.random())}")
    languages = agent_languages(agent)
    if language is None:
        language = pick(languages, rng())
        if language is None:
            language = "uz"
    difficulty = 0.25 if difficulty is None else difficulty
    speed = max(1, 6 if speed is None else speed)

    number = primary_number(tenant_id)
    name = pick(UZ_NAMES, rng())
    from_ = phone_number(rng)

    call_id = start_call(
        tenant_id=tenant_id,
        agent_id=agent["id"],
        number_id=number["id"] if number else None,
        from_=from_,
        to=number["e164"] if number else "+998712000000",
        caller_name=name,
        language=language,
        channel="voice",
    )

    script = SCRIPTS.get(language) if isinstance(language, str) else None
    script = script or SCRIPTS["en"]
    utterances: list[Any] = [pick(script["open"], rng())]

    body_turns = 1 + math.floor(rng() * 3)
    pool = list(script["body"])
    for _ in range(body_turns):
        if rng() < difficulty and script["hard"]:
            utterances.append(pick(script["hard"], rng()))
        elif pool:
            utterances.append(pool.pop(math.floor(rng() * len(pool))))
    if rng() < 0.12:
        utterances.append(HUMAN_REQUEST.get(language) if isinstance(language, str) else None)
    utterances.append(pick(script["close"], rng()))

    publish(tenant_id, {"type": "call_ringing", "callId": call_id, "from": from_})

    # `void driveCall(…)` runs up to its first wait before simulateCall returns: the ring time is
    # drawn and its timer tracked now, so the simulator load counts this call straight away.
    ring = _start_wait(tenant_id, call_id, 1200 + rng() * 1800, speed)
    spawn(_drive_call(tenant_id, call_id, agent, utterances, rng, speed, ring))
    return call_id


async def _drive_call(
    tenant_id: str,
    call_id: str,
    agent: dict[str, Any],
    utterances: list[Any],
    rng: Callable[[], float],
    speed: float,
    ring: asyncio.Future,
) -> None:
    # Stopped while waiting: in JavaScript the call simply never resumes.
    with contextlib.suppress(_Stopped):
        await _drive(tenant_id, call_id, agent, utterances, rng, speed, ring)


async def _drive(
    tenant_id: str,
    call_id: str,
    agent: dict[str, Any],
    utterances: list[Any],
    rng: Callable[[], float],
    speed: float,
    ring: asyncio.Future,
) -> None:
    try:
        await _until(ring)  # ring time

        escalated = False
        for utterance in utterances:
            with db.connect() as conn:
                still_live = db.fetch_one(conn, "SELECT status FROM calls WHERE id = :id", id=call_id)
            if still_live is None or still_live["status"] in ("completed", "abandoned"):
                return

            # Speaking time, then recognition latency.
            await _wait(tenant_id, call_id, 900 + utf16_len(utterance) * 42 + rng() * 700, speed)
            result = await run_turn(
                tenant_id=tenant_id,
                call_id=call_id,
                agent=agent,
                utterance=utterance,
                stt_ms=180 + rng() * 220,
            )
            if result["escalate"]:
                escalated = True
                break
            await _wait(tenant_id, call_id, 400 + rng() * 900, speed)  # caller absorbs the answer

        if escalated:
            # The operator inbox now owns this call; it leaves the simulator here.
            _untrack(tenant_id, call_id)
            return

        if rng() < 0.05:
            end_call(tenant_id=tenant_id, call_id=call_id, outcome="abandoned")
        else:
            csat = (5 if rng() < 0.72 else 4) if rng() < 0.82 else (3 if rng() < 0.6 else 2)
            end_call(tenant_id=tenant_id, call_id=call_id, outcome="resolved_by_ai", csat=csat)
    except Exception:  # noqa: BLE001 - any failure ends the call as abandoned, as in the TypeScript
        end_call(tenant_id=tenant_id, call_id=call_id, outcome="abandoned")
    finally:
        _untrack(tenant_id, call_id)


# ── burst mode ─────────────────────────────────────────────────────


async def simulate_burst(
    tenant_id: str,
    *,
    count: float,
    speed: float | None = None,
    difficulty: float | None = None,
    seed: str | None = None,
    spread_ms: float | None = None,
) -> list[str]:
    spread = 2500 if spread_ms is None else spread_ms
    started: list[str] = []
    i = 0
    while i < count:
        call_id = simulate_call(
            tenant_id,
            difficulty=difficulty,
            speed=speed,
            seed=f"{seed if seed is not None else 'burst'}:{i}:{int(time.time() * 1000)}",
        )
        if call_id:
            started.append(call_id)
        if i < count - 1:
            await asyncio.sleep(spread / count / 1000 * TIME_SCALE)
        i += 1
    return started
