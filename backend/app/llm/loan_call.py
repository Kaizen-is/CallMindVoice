"""
The two facts of an outbound loan call decided in code, not by the model —
port of src/lib/llm/loan-call.ts.

- Identity: the caller's own words are checked against the year of birth; the
  prompt only learns the outcome (the model never sees the year).
- Dates: the next three weeks are written out, so a spoken day is looked up,
  never worked out.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import regex as re

from app.jscompat import JS_S
from app.speech.numbers import uzbek_numbers_to_digits

MAX_WRONG_YEARS = 2


@dataclass
class IdentityCheck:
    status: str  # unchecked | awaiting | confirmed | failed
    just_wrong: bool
    wrong_tries: int


_FOUR_DIGITS = re.compile(r"(?<![0-9])([0-9]{4})(?![0-9])")
_TWO_DIGIT_YEAR = re.compile(
    f"(?<![0-9])([0-9]{{2}})(?:[{JS_S}]*-?[{JS_S}]*(?:го|й))?[{JS_S}]*-?[{JS_S}]*(?:yil|йил|год)",
    re.IGNORECASE,
)
_YEAR_NOISE = re.compile(f"[{JS_S}.,!?;:'\"«»()-]")


def _spoken_years(line: str) -> list[str]:
    """Years said in one line: "1992", "92-yil", "92-го года", or a bare "92"."""
    text = uzbek_numbers_to_digits(line)
    # Any four-digit number is an attempt — an absurd one is a wrong answer, not silence.
    years = [m.group(1) for m in _FOUR_DIGITS.finditer(text)]
    years += [m.group(1) for m in _TWO_DIGIT_YEAR.finditer(text)]
    bare = _YEAR_NOISE.sub("", text)
    if re.fullmatch(r"[0-9]{2}", bare):
        years.append(bare)
    return years


def identity_check(birth_year: str, caller_lines: list[str]) -> IdentityCheck:
    year = birth_year.strip()
    if not re.fullmatch(r"[0-9]{4}", year):
        return IdentityCheck("unchecked", False, 0)
    wrong = 0
    just_wrong = False
    for line in caller_lines:
        said = _spoken_years(line)
        just_wrong = False
        if not said:
            continue
        # Every year in the line must be right: "1990, 1991, 1992" is a guess, not an answer.
        if all(y == year or y == year[2:] for y in said):
            return IdentityCheck("confirmed", False, wrong)
        wrong += 1
        just_wrong = True
        if wrong >= MAX_WRONG_YEARS:
            return IdentityCheck("failed", True, wrong)
    return IdentityCheck("awaiting", just_wrong, wrong)


# ── calendar ────────────────────────────────────────────────────────

DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
DAY_UZ = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"]
DAY_RU = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"]
MONTH_EN = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"]  # fmt: skip


def _js_weekday(d: date) -> int:
    """`getUTCDay()`: Sunday = 0."""
    return (d.weekday() + 1) % 7


def _label(d: date) -> str:
    w = _js_weekday(d)
    return f"{DAY_EN[w]} ({DAY_UZ[w]} / {DAY_RU[w]}) {d.day} {MONTH_EN[d.month - 1]}"


def _month_shift(year: int, month0: int, n: int) -> tuple[int, int]:
    """(year, 0-based month) after adding n months — Date.UTC's month overflow."""
    total = year * 12 + month0 + n
    return total // 12, total % 12


def _last_day(year: int, month0: int) -> int:
    ny, nm = _month_shift(year, month0, 1)
    return (date(ny, nm + 1, 1) - timedelta(days=1)).day


def calendar_block(time_zone: str = "Asia/Tashkent", now: datetime | None = None) -> str:
    """The next three weeks in the tenant's time zone, named the way callers name them."""
    moment = now or datetime.now(UTC)
    today = moment.astimezone(ZoneInfo(time_zone)).date()

    def day(n: int) -> date:
        return today + timedelta(days=n)

    until_sunday = (7 - _js_weekday(today)) % 7

    def span(start: int, end: int) -> str:
        return "; ".join(_label(day(n)) for n in range(start, end + 1))

    def in_months(n: int) -> date:
        y, m0 = _month_shift(today.year, today.month - 1, n)
        return date(y, m0 + 1, min(today.day, _last_day(y, m0)))

    month_end = date(today.year, today.month, _last_day(today.year, today.month - 1))
    ny, nm0 = _month_shift(today.year, today.month - 1, 1)
    next_month_start = date(ny, nm0 + 1, 1)

    lines = [
        "CALENDAR — look every date up here; never work out a weekday or a date yourself:",
        f"- today: {_label(today)} {today.year}",
        f"- tomorrow (ertaga / завтра): {_label(day(1))}",
        f"- the day after tomorrow (indinga / послезавтра): {_label(day(2))}",
        f"- rest of this week: {span(3, until_sunday)}" if until_sunday >= 3 else "",
        f"- next week (kelasi hafta / на следующей неделе): {span(until_sunday + 1, until_sunday + 7)}",
        f"- the week after: {span(until_sunday + 8, until_sunday + 14)}",
        f"- in 3 days (3 kundan keyin / через три дня): {_label(day(3))}",
        f"- in a week (bir haftadan keyin / через неделю): {_label(day(7))}",
        f"- in 10 days (10 kundan keyin / через десять дней): {_label(day(10))}",
        f"- in two weeks (ikki haftadan keyin / через две недели): {_label(day(14))}",
        f"- in three weeks (uch haftadan keyin / через три недели): {_label(day(21))}",
        f"- in a month (bir oydan keyin / через месяц): {_label(in_months(1))}",
        f"- end of this month (oy oxirida / в конце месяца): {_label(month_end)}",
        f"- start of next month (keyingi oy boshida / в начале следующего месяца): {_label(next_month_start)}",
        'A weekday on its own ("juma kuni", "kelasi juma", "в пятницу") means its nearest date',
        'after today in this list. "Next week" plus a weekday means that weekday under "next',
        'week". A day of the month on its own ("25-chi", "третьего числа") means this month if',
        'it is still ahead, otherwise next month. Any other period ("in 5 days", "in two months")',
        "is counted from today the same way. Never agree to a date that has passed.",
    ]
    return "\n".join(line for line in lines if line)
