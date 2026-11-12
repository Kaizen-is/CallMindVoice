"""
The two facts of an outbound loan call decided in code, not by the model —
port of src/lib/llm/loan-call.ts.

- Identity: the caller's own words are checked against the year of birth; the
  prompt only learns the outcome (the model never sees the year).
- Dates: the next three weeks are written out, and a day the person names
  ("1 haftadan keyin", "juma kuni", "через неделю") is worked out here, with the
  words to say it back with (`named_day`).
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


# ── the day they just named ─────────────────────────────────────────
# Even with the calendar written out, a small model picked the wrong line for "1 haftadan keyin"
# four times in five. So a day the person names is worked out here, as identity is, and the model
# is handed the date and the exact words to say it back with.

MONTH_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun",
            "iyul", "avgust", "sentyabr", "oktabr", "noyabr", "dekabr"]  # fmt: skip
MONTH_RU_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня",
                "июля", "августа", "сентября", "октября", "ноября", "декабря"]  # fmt: skip
UNIT_UZ = ["bir", "ikki", "uch", "to'rt", "besh", "olti", "yetti", "sakkiz", "to'qqiz"]
ORD_UZ = ["birinchi", "ikkinchi", "uchinchi", "to'rtinchi", "beshinchi",
          "oltinchi", "yettinchi", "sakkizinchi", "to'qqizinchi"]  # fmt: skip
TENS_UZ = {"o'n": 10, "yigirma": 20, "o'ttiz": 30}
ORD_TENS_UZ = {"o'ninchi": 10, "yigirmanchi": 20, "o'ttizinchi": 30}
NUM_RU = {"один": 1, "одну": 1, "одна": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5,
          "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "пятнадцать": 15}  # fmt: skip
ORD_RU_GEN = ["первого", "второго", "третьего", "четвёртого", "пятого", "шестого", "седьмого", "восьмого", "девятого",
              "десятого", "одиннадцатого", "двенадцатого", "тринадцатого", "четырнадцатого", "пятнадцатого",
              "шестнадцатого", "семнадцатого", "восемнадцатого", "девятнадцатого"]  # fmt: skip
WEEKDAY_UZ = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"]
# Whole words: "сред" alone would also catch "средства" (funds) and "среди".
WEEKDAY_RU = ["воскресенье|воскресенья", "понедельник|понедельника", "вторник|вторника", "среда|среду|среды",
              "четверг|четверга", "пятница|пятницу|пятницы", "суббота|субботу|субботы"]  # fmt: skip

_S = f"[{JS_S}]"
# A word starts or ends here (letters and the Uzbek apostrophe belong to words).
_B = r"(?<![\p{L}'])"
_E = r"(?![\p{L}'])"
_ORD_RU_MATCH = [w.replace("ё", "е") for w in ORD_RU_GEN]


def _alt(words) -> str:  # noqa: ANN001
    return "|".join(words)


def _digits_for(text: str) -> str:
    """Number words as digits: "ikki", "o'n besh", "две"; ordinals as "5-chi" / "25-го"."""
    t = re.sub(
        f"{_B}(?:({_alt(TENS_UZ)}){_S}+)?({_alt(ORD_UZ)}){_E}",
        lambda m: f"{(TENS_UZ[m[1]] if m[1] else 0) + ORD_UZ.index(m[2]) + 1}-chi",
        text,
    )
    t = re.sub(f"{_B}({_alt(ORD_TENS_UZ)}){_E}", lambda m: f"{ORD_TENS_UZ[m[1]]}-chi", t)
    t = re.sub(
        f"{_B}({_alt(TENS_UZ)})(?:{_S}+({_alt(UNIT_UZ)}))?{_E}",
        lambda m: str(TENS_UZ[m[1]] + (UNIT_UZ.index(m[2]) + 1 if m[2] else 0)),
        t,
    )
    t = re.sub(f"{_B}({_alt(UNIT_UZ)}){_E}", lambda m: str(UNIT_UZ.index(m[1]) + 1), t)
    t = re.sub(
        f"{_B}(?:(двадцать|тридцать){_S}+)?({_alt(_ORD_RU_MATCH)}){_E}",
        lambda m: f"{(20 if m[1] == 'двадцать' else 30 if m[1] else 0) + _ORD_RU_MATCH.index(m[2]) + 1}-го",
        t,
    )
    t = re.sub(f"{_B}(двадцатого|тридцатого){_E}", lambda m: "20-го" if m[1] == "двадцатого" else "30-го", t)
    t = re.sub(
        f"{_B}(?:(двадцать|тридцать){_S}+)?({_alt(NUM_RU)}){_E}",
        lambda m: str((20 if m[1] == "двадцать" else 30 if m[1] else 0) + NUM_RU[m[2]]),
        t,
    )
    return re.sub(f"{_B}(двадцать|тридцать){_E}", lambda m: "20" if m[1] == "двадцать" else "30", t)


def _ordinal_uz(n: int) -> str:
    tens, unit = n // 10 * 10, n % 10
    if not unit:
        return next(w for w, v in ORD_TENS_UZ.items() if v == tens)
    tens_word = next((w for w, v in TENS_UZ.items() if v == tens), None)
    return f"{tens_word} {ORD_UZ[unit - 1]}" if tens_word else ORD_UZ[unit - 1]


def _ordinal_ru(n: int) -> str:
    if n < 20:
        return ORD_RU_GEN[n - 1]
    if n == 20:
        return "двадцатого"
    if n == 30:
        return "тридцатого"
    return f"{'двадцать' if n < 30 else 'тридцать'} {ORD_RU_GEN[n % 10 - 1]}"


def _named(d: date) -> dict:
    w = _js_weekday(d)
    return {
        "date": d.isoformat(),
        "label": f"{_label(d)} {d.year}",
        "say": {
            "uz": f"{_ordinal_uz(d.day)} {MONTH_UZ[d.month - 1]}, {DAY_UZ[w]}".replace("'", "‘"),
            "ru": f"{_ordinal_ru(d.day)} {MONTH_RU_GEN[d.month - 1]}, {DAY_RU[w]}",
            "en": f"{DAY_EN[w]}, {d.day} {MONTH_EN[d.month - 1]}",
        },
    }


def _day_of(year: int, month0: int, day: int) -> date | None:
    """That day of a 0-based month (which may run past December), or None when it has no such day."""
    y, m0 = _month_shift(year, month0, 0)
    return date(y, m0 + 1, day) if 1 <= day <= _last_day(y, m0) else None


def named_day(line: str, time_zone: str = "Asia/Tashkent", now: datetime | None = None) -> dict | None:
    """
    The day one line names ("ertaga", "1 haftadan keyin", "juma kuni", "kelasi hafta seshanba",
    "25-noyabr", "oy oxirida", "через неделю", "в пятницу") as {date, label, say: {uz, ru, en}},
    worked out from today in the tenant's time zone; None when it names none or unclearly
    (a negation such as "ertaga emas" is left to the model).
    """
    t = _digits_for(re.sub("[‘ʻʼ’`]", "'", uzbek_numbers_to_digits(line).lower()).replace("ё", "е"))
    if re.search(f"{_B}(?:emas|не){_E}", t):
        return None
    today = (now or datetime.now(UTC)).astimezone(ZoneInfo(time_zone)).date()

    def at(n: int) -> dict:
        return _named(today + timedelta(days=n))

    def months_later(n: int) -> dict:
        y, m0 = _month_shift(today.year, today.month - 1, n)
        return _named(date(y, m0 + 1, min(today.day, _last_day(y, m0))))

    m = re.search(
        f"(?<![0-9])([0-9]{{1,2}}){_S}*-?{_S}*(kun|hafta|oy)(?:lar)?(?:dan)?{_S}+(?:keyin|so'ng|o'tib|o'tgach){_E}", t
    )
    if m:
        n = int(m[1])
        return months_later(n) if m[2] == "oy" else at(n if m[2] == "kun" else n * 7)
    m = re.search(
        f"{_B}через{_S}+(?:([0-9]{{1,2}}){_S}+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев){_E}", t
    )
    if m:
        n = int(m[1]) if m[1] else 1
        return months_later(n) if m[2].startswith("месяц") else at(n * 7 if m[2].startswith("нед") else n)
    if re.search(f"{_B}(?:indinga|послезавтра){_E}", t):
        return at(2)
    if re.search(f"{_B}(?:ertaga|завтра){_E}", t):
        return at(1)
    if re.search(f"{_B}(?:bugun|сегодня){_E}", t):
        return at(0)
    if re.search(f"oy{_S}+oxir|конц[еау]{_S}+месяца", t):
        return _named(date(today.year, today.month, _last_day(today.year, today.month - 1)))
    if re.search(f"(?:keyingi|kelasi){_S}+oy{_S}+bosh|начал[еоа]{_S}+следующего{_S}+месяца", t):
        y, m0 = _month_shift(today.year, today.month - 1, 1)
        return _named(date(y, m0 + 1, 1))
    # A whole month word: "1 marta" (once) is not March.
    m = re.search(
        f"(?<![0-9])([0-9]{{1,2}}){_S}*-?{_S}*(?:chi{_S}+|го{_S}+|е{_S}+)?"
        f"(?:({_alt(MONTH_UZ)})(?:da|ga|dan|gacha|ning|si)?|({_alt(MONTH_RU_GEN)})){_E}",
        t,
    )
    if m:
        month0 = MONTH_UZ.index(m[2]) if m[2] else MONTH_RU_GEN.index(m[3])
        d = _day_of(today.year, month0, int(m[1]))
        if d and d < today:
            d = _day_of(today.year + 1, month0, int(m[1]))
        return _named(d) if d else None
    # An ordinal counts only at the end of the line or before kun/sana: "birinchi to'lov" is not a day.
    m = re.search(
        f"(?<![0-9])([0-9]{{1,2}}){_S}*-?{_S}*(?:(?:chi|inchi|nchi)(?:si)?"
        rf"(?={_S}*[.,!?]*{_S}*(?![\s\S])|{_S}+(?:kun|sana))|sana|го{_S}+числа|числа)",
        t,
    )
    if m:
        n = int(m[1])
        d = _day_of(today.year, today.month - 1, n) if n >= today.day else None
        d = d or _day_of(today.year, today.month, n)
        return _named(d) if d else None
    weekday = next((i for i, w in enumerate(WEEKDAY_UZ) if re.search(f"{_B}{w}", t)), -1)
    if weekday < 0:
        weekday = next((i for i, w in enumerate(WEEKDAY_RU) if re.search(f"{_B}(?:{w}){_E}", t)), -1)
    if weekday >= 0:
        today_w = _js_weekday(today)
        if re.search(f"(?:kelasi|keyingi){_S}+hafta|следующ", t):
            return at((7 - today_w) % 7 + 1 + (weekday + 6) % 7)
        return at((weekday - today_w + 7) % 7 or 7)
    return None
