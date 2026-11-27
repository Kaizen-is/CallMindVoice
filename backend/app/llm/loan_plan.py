"""
L6: the loan call's figures and its promise to pay, worked out and checked in code (Playground first).

Like the person's identity and the day they name (app/llm/loan_call.py), two more facts of a loan call
are no longer left to the model:

- The figures. Asked to split the debt, the model used to divide it itself; an odd amount (7 850 000 in
  three) invites a wrong sum. `plan_lines` gives it the parts, worked out here, to say as they are.
- The promise to pay. A turn whose caller named a day and whose reply said that same day back is a
  promise; `promise_from_turn` writes it down as data — the date, the sum (their own figure, a part of
  the split, or the whole debt) — and checks it: a day within 90 days, a sum no larger than the debt.
  The Playground shows it with the turn; a reply that never says the day back records nothing.
"""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import regex as re

from app.llm.loan_call import identity_check, named_day
from app.speech.numbers import uzbek_numbers_to_digits

MIN_SUM = 10_000  # smaller numbers are days, years, counts — not money
ROUND_TO = 1_000
MAX_DAYS_AHEAD = 90
_SPLIT = re.compile(
    r"(?i)\b(bo['‘ʻ’]?lib|bo['‘ʻ’]?laklab|qism|oyga|oyma-oy|har\s+oy|частями|по\s+частям|рассрочк|каждый\s+месяц)"
)
_COUNT_WORDS = {
    "ikki": 2,
    "uch": 3,
    "to'rt": 4,
    "tort": 4,
    "besh": 5,
    "olti": 6,
    "два": 2,
    "две": 2,
    "три": 3,
    "четыре": 4,
    "пять": 5,
    "шесть": 6,
}
_PARTS = re.compile(
    r"(?i)\b([2-6]|ikki|uch|to['‘ʻ’]?rt|besh|olti|два|две|три|четыре|пять|шесть)\s*-?\s*"
    r"(?:oyga|oy|qism|qismga|месяц|месяца|части|частей)"
)


def _part_counts(text: str) -> list[int]:
    """The numbers of parts a text names ("uch oyga", "3 qism", "на три месяца")."""
    counts = []
    for word in _PARTS.findall(text):
        key = re.sub("[‘ʻ’]", "'", word.lower())
        counts.append(int(key) if key.isdigit() else _COUNT_WORDS.get(key, _COUNT_WORDS.get(key.replace("'", ""), 0)))
    return [c for c in counts if 2 <= c <= 6]


_SCALE = re.compile(r"(?i)(\d+(?:[.,]\d+)?)\s*(ming|минг|тысяч\w*|тыс\.?|million|mln|миллион\w*|млн|mlrd|milliard)")
# A number with thousands groups ("2 600 000", "500.000") or a plain run of digits.
_NUMBER = re.compile(r"\d{1,3}(?:[  .,]\d{3})+(?!\d)|\d+")


def _scaled(m: re.Match) -> str:
    """ "500 ming" → "500000", "1,5 mln" → "1500000"."""
    word = m.group(2).lower()
    if word.startswith(("mlrd", "milliard")):
        scale = 1_000_000_000
    elif word.startswith(("million", "mln", "миллион", "млн")):
        scale = 1_000_000
    else:
        scale = 1_000
    return str(round(float(m.group(1).replace(",", ".")) * scale))


def sums_in(text: str) -> list[int]:
    """Sums of money in a line: digits ("2 600 000", "500.000", "500 ming", "1,5 mln") or Uzbek words."""
    digits = _SCALE.sub(_scaled, uzbek_numbers_to_digits(_SCALE.sub(_scaled, text)))
    found = []
    for m in _NUMBER.finditer(digits):
        raw = re.sub(r"[  .,]", "", m.group())
        if int(raw) >= MIN_SUM:
            found.append(int(raw))
    return found


def parse_sum(text: str) -> int | None:
    sums = sums_in(text)
    return sums[0] if sums else None


def split_plan(total: int, parts: int) -> list[int]:
    """`parts` payments that add up to `total`: equal, rounded to 1 000, the rest on the last."""
    if parts < 2 or total <= 0:
        return [total]
    each = (total // parts) // ROUND_TO * ROUND_TO
    return [each] * (parts - 1) + [total - each * (parts - 1)]


def say_sum(n: int, currency: str = "so'm") -> str:
    return f"{n:,}".replace(",", " ") + f" {currency}"


def _currency(loan_text: str) -> str:
    m = re.search(r"(?i)(so['‘ʻ’]?m|сум|сўм|usd|\$|доллар)", loan_text)
    return m.group(1) if m else "so'm"


def plan_lines(target: dict) -> list[str]:
    """For the prompt, once the person is confirmed: the split worked out, to say exactly."""
    loan_text = str(target.get("loanAmount") or "")
    total = parse_sum(loan_text)
    if not total:
        return []
    currency = _currency(loan_text)
    named = _part_counts(str(target.get("prompt") or ""))
    counts = sorted({*named, 3}) if named else [2, 3]
    lines = ["- If they pay in parts, these are the figures, worked out for you: say them exactly as written."]
    for parts in counts:
        plan = split_plan(total, parts)
        same = len(set(plan)) == 1
        each = say_sum(plan[0], currency)
        last = "" if same else f", last one {say_sum(plan[-1], currency)}"
        lines.append(f"  {parts} parts: {each} each{last}")
    return lines


def promise_from_turn(
    target: dict,
    caller_lines: list[str],
    reply: str,
    time_zone: str = "Asia/Tashkent",
    now: datetime | None = None,
) -> dict | None:
    """
    The promise this turn settled, or None: the caller (confirmed) named a day in their last two lines and
    the agent's reply says that very day back. The sum is their own figure if they named one, a part of
    the split if a split was agreed, else the whole debt.
    """
    if not reply or not caller_lines:
        return None
    if identity_check(str(target.get("birthYear") or ""), caller_lines).status not in ("confirmed", "unchecked"):
        return None
    said_back = named_day(reply, time_zone, now)
    if said_back is None:
        return None
    day = next((d for line in reversed(caller_lines[-2:]) if (d := named_day(line, time_zone, now)) is not None), None)
    if day is None or day["date"] != said_back["date"]:
        return None
    today = (now or datetime.now(UTC)).astimezone(ZoneInfo(time_zone)).date()
    due = datetime.fromisoformat(day["date"]).date()
    if not today <= due <= today + timedelta(days=MAX_DAYS_AHEAD):
        return None

    loan_text = str(target.get("loanAmount") or "")
    total = parse_sum(loan_text)
    currency = _currency(loan_text)
    recent = " ".join(caller_lines[-3:])
    own = [n for n in sums_in(recent) if total is None or n <= total]
    split_said = bool(_SPLIT.search(recent) or _SPLIT.search(reply))
    named = _part_counts(recent) or _part_counts(reply) or _part_counts(str(target.get("prompt") or ""))
    parts = 1
    if own:
        amount = own[-1]
        # Their figure is a part of a split: say which split.
        if total and split_said:
            parts = next((k for k in (named or range(2, 7)) if split_plan(total, k)[0] == amount), 1)
    elif total and split_said:
        parts = named[0] if named else 3
        amount = split_plan(total, parts)[0]
    else:
        amount = total
    return {
        "date": day["date"],
        "label": day["label"],
        "amount": amount,
        "amountText": say_sum(amount, currency) if amount else None,
        "parts": parts,
        "ofTotal": total,
    }
