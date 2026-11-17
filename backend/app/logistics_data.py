"""
The logistics demo's "company system" — port of src/lib/logistics-data.ts:
made-up shipments from China to Uzbekistan, and the lookup an operator would
do in their software.

Dates are kept as offsets from today, so the demo always looks current. The
model never guesses where a parcel is: the caller's own words are searched for
a tracking or phone number here, and only a record found here is put in front
of the model.
"""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.jscompat import JS_B, JS_S, js_number_str
from app.speech.numbers import uzbek_numbers_to_digits

SHIPMENTS: list[dict[str, Any]] = [
    {
        "track": "482913",
        "phone": "901234567",
        "name": "Dilshod Rahimov",
        "goods": "phone cases and wireless headphones",
        "boxes": 2,
        "kg": 14,
        "method": "avto",
        "origin": "Guangzhou",
        "history": [
            (-9, "received at the Guangzhou warehouse"),
            (-7, "left Guangzhou by truck"),
            (-4, "arrived at the Urumqi sorting centre"),
            (-1, "arrived at the Khorgos border crossing (China–Kazakhstan)"),
        ],
        "now": "waiting at the Khorgos border crossing; there is a truck queue, about one day of delay",
        "eta": 6,
        "delivery": "pickup at the Tashkent terminal",
        "payment": "fully paid",
    },
    {
        "track": "615027",
        "phone": "932345678",
        "name": "Malika Yusupova",
        "goods": "children’s clothes",
        "boxes": 1,
        "kg": 6,
        "method": "avto",
        "origin": "Yiwu",
        "history": [
            (-15, "received at the Yiwu warehouse"),
            (-13, "left Yiwu by truck"),
            (-6, "crossed the Khorgos border"),
            (-2, "entered Uzbekistan"),
            (-1, "arrived at the Tashkent terminal"),
        ],
        "now": "at the Tashkent terminal, in customs clearance",
        "eta": 2,
        "delivery": "courier to the customer’s address in Tashkent",
        "payment": "185 000 so‘m still to pay, on delivery",
        "note": "customs needs a copy of the recipient’s passport; it can be sent to the company’s Telegram, and "
        "clearance then takes about a day",
    },
    {
        "track": "739184",
        "phone": "993456789",
        "name": "Jasur Karimov",
        "goods": "kitchen appliances (a blender and an air fryer)",
        "boxes": 3,
        "kg": 22,
        "method": "avto",
        "origin": "Guangzhou",
        "history": [
            (-17, "received at the Guangzhou warehouse"),
            (-14, "left Guangzhou by truck"),
            (-8, "crossed the Khorgos border"),
            (-3, "arrived at the Tashkent terminal"),
            (-1, "cleared customs"),
        ],
        "now": "out for delivery with a courier today, between 14:00 and 18:00; the courier calls 30 minutes before "
        "arriving",
        "eta": 0,
        "delivery": "courier to the customer’s address in Tashkent",
        "payment": "fully paid",
    },
    {
        "track": "827405",
        "phone": "971234567",
        "name": "Gulnora Saidova",
        "goods": "furniture parts (chairs and a table)",
        "boxes": 4,
        "kg": 35,
        "method": "avto",
        "origin": "Yiwu",
        "history": [
            (-16, "received at the Yiwu warehouse"),
            (-14, "left Yiwu by truck"),
            (-7, "crossed the Khorgos border"),
            (-2, "arrived at the Uzbek border (Yallama)"),
        ],
        "now": "held at the Uzbek border (Yallama) for a document check on the whole truck; not a problem with this "
        "customer’s parcel",
        "eta": 5,
        "delivery": "pickup at the Tashkent terminal",
        "payment": "fully paid",
        "note": "delayed by about three days against the original estimate; a manager will call the customer as soon "
        "as the truck is released",
    },
    {
        "track": "250468",
        "phone": "946789012",
        "name": "Nodira Aliyeva",
        "goods": "cosmetics",
        "boxes": 1,
        "kg": 2.4,
        "method": "avia",
        "origin": "Shenzhen",
        "history": [
            (-5, "received at the Shenzhen warehouse"),
            (-3, "flown to Urumqi"),
            (-1, "landed in Tashkent"),
        ],
        "now": "landed in Tashkent yesterday; customs clearance today",
        "eta": 1,
        "delivery": "pickup at the Tashkent terminal",
        "payment": "fully paid",
    },
    {
        "track": "908351",
        "phone": "905678901",
        "name": "Bekzod Tursunov",
        "goods": "car parts",
        "boxes": 5,
        "kg": 48,
        "method": "temir yo‘l",
        "origin": "Yiwu",
        "history": [
            (-12, "received at the Yiwu warehouse"),
            (-10, "loaded on a freight train"),
            (-3, "crossed into Kazakhstan"),
            (-1, "passed Almaty"),
        ],
        "now": "on the train in Kazakhstan, past Almaty",
        "eta": 4,
        "delivery": "courier to the customer’s address in Samarkand (one extra day after Tashkent)",
        "payment": "420 000 so‘m still to pay, on delivery",
    },
    {
        "track": "374620",
        "phone": "887654321",
        "name": "Sevara Qodirova",
        "goods": "shoes",
        "boxes": 1,
        "kg": 3,
        "method": "avto",
        "origin": "Guangzhou",
        "history": [(-2, "received at the Guangzhou warehouse")],
        "now": "at the Guangzhou warehouse, waiting to be loaded with other parcels; the truck leaves in two days",
        "eta": 16,
        "delivery": "pickup at the Tashkent terminal",
        "payment": "fully paid",
    },
    {
        "track": "561739",
        "phone": "951112233",
        "name": "Otabek Ergashev",
        "goods": "a laptop and accessories",
        "boxes": 2,
        "kg": 11,
        "method": "avia",
        "origin": "Shenzhen",
        "history": [
            (-9, "received at the Shenzhen warehouse"),
            (-7, "landed in Tashkent"),
            (-5, "cleared customs"),
            (-2, "delivered and signed for by the recipient"),
        ],
        "now": "delivered two days ago, signed for by Otabek Ergashev",
        "eta": None,
        "delivery": "courier to the customer’s address in Tashkent",
        "payment": "fully paid",
    },
]

# The numbers the demo page offers visitors to try.
TRY_TRACKS = ("482913", "615027", "739184", "827405")

# Terms GAPI should expect on these calls (at most 20).
LOGISTICS_VOCABULARY = (
    "Yiwu", "Guangzhou", "Shenzhen", "Urumchi", "Xorgos", "Olmaota", "Yallama", "Toshkent",
    "posilka", "track raqam", "trek raqam", "yuk", "bojxona", "kuryer", "terminal", "kargo", "avia",
)  # fmt: skip

# ── lookup ──────────────────────────────────────────────────────────

DIGIT_WORDS = {
    "nol": "0", "bir": "1", "ikki": "2", "uch": "3", "to'rt": "4", "tort": "4", "besh": "5",
    "olti": "6", "yetti": "7", "sakkiz": "8", "to'qqiz": "9", "toqqiz": "9",
}  # fmt: skip

# JavaScript's regexes here have no `u` flag: `i` folds ASCII letters only, `\b` is the ASCII word
# boundary and `\d` is 0-9 — so: the stdlib `re` with ASCII|IGNORECASE, and \s, \b, \d spelled out.
_APOSTROPHES = re.compile("[‘’ʻʼ`]")
_WORD = "(?:nol|bir|ikki|uch|to'rt|tort|besh|olti|yetti|sakkiz|to'qqiz|toqqiz)"
_SPELLED_RUN = re.compile(f"{JS_B}{_WORD}(?:[{JS_S},.\\-]+{_WORD}){{2,}}{JS_B}", re.ASCII | re.IGNORECASE)
_RUN_GAP = re.compile(f"[{JS_S},.\\-]+")
_DIGIT_GAP = re.compile(f"([0-9])[{JS_S}.,\\-]+(?=[0-9])")
_DIGITS = re.compile("[0-9]+")
_PUNCTUATION = re.compile("[,.;:!?]+")


def _spelled_digits(line: str) -> str:
    """A number said digit by digit ("olti bir besh nol ikki yetti") as digits."""
    text = _APOSTROPHES.sub("'", line)
    return _SPELLED_RUN.sub(
        lambda m: "".join(DIGIT_WORDS.get(w.lower(), "") for w in _RUN_GAP.split(m.group(0))),
        text,
    )


def _joined_digits(line: str) -> list[str]:
    """Digits as said: "48 29 13", "48, 29, 13" and "48-29-13" are one number."""
    text = _DIGIT_GAP.sub(r"\1", uzbek_numbers_to_digits(_spelled_digits(line)))
    return _DIGITS.findall(text)


def _numbers_in(line: str) -> list[str]:
    """
    Candidate numbers in a line, read twice: as written, and with punctuation dropped — GAPI may
    put a comma inside a number said in words, which splits it in two.
    """
    unpunctuated = _PUNCTUATION.sub(" ", line)
    found = [*_joined_digits(line), *_joined_digits(unpunctuated)]
    return [n for n in dict.fromkeys(found) if 6 <= len(n) <= 12]


@dataclass
class Lookup:
    found: list[dict[str, Any]] = field(default_factory=list)
    # How each found shipment was matched, by its track number.
    matched_by: dict[str, str] = field(default_factory=dict)
    # The caller gave a number that matched nothing (and nothing was found since).
    unknown_number: str | None = None
    # Digits in their latest line too short to be a number (part of one, or misheard).
    partial: str | None = None


def lookup_shipments(caller_lines: list[str]) -> Lookup:
    """Everything the caller has said, searched for track and phone numbers."""
    out = Lookup()
    for line in caller_lines:
        for n in _numbers_in(line):
            hits = [s for s in SHIPMENTS if s["track"] in n or (len(n) >= 9 and s["phone"] == n[-9:])]
            if hits:
                for h in hits:
                    if not any(f is h for f in out.found):
                        out.found.append(h)
                    out.matched_by[h["track"]] = (
                        "the track number they gave" if h["track"] in n else "the phone number they gave"
                    )
                out.unknown_number = None
            else:
                out.unknown_number = n
    last = caller_lines[-1] if caller_lines else ""
    short = [n for n in _joined_digits(last) if 2 <= len(n) < 6]
    out.partial = " ".join(short) if not out.found and not _numbers_in(last) and short else None
    return out


# ── what the model is told ──────────────────────────────────────────

DAY_UZ = ("yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba")
DAY_RU = ("воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота")
# Intl's en-GB names (`weekday: 'long'`, `month: 'long'`), Sunday first as getUTCDay() counts.
_DAY_EN = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
_MONTH_EN = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)  # fmt: skip


def _now() -> datetime:
    return datetime.now(UTC)


def day_label(offset: int, time_zone: str, now: datetime | None = None) -> str:
    """Today on the zone's calendar plus `offset` days: "today, Tuesday 17 November (seshanba / вторник)"."""
    today = (now or _now()).astimezone(ZoneInfo(time_zone)).date()
    d = today + timedelta(days=offset)
    weekday = (d.weekday() + 1) % 7  # getUTCDay(): Sunday = 0
    en = f"{_DAY_EN[weekday]} {d.day} {_MONTH_EN[d.month - 1]}"
    rel = "today, " if offset == 0 else "tomorrow, " if offset == 1 else "yesterday, " if offset == -1 else ""
    return f"{rel}{en} ({DAY_UZ[weekday]} / {DAY_RU[weekday]})"


def _describe(s: dict[str, Any], time_zone: str, matched_by: str | None = None) -> str:
    lines = [
        # No digits: the voice mispronounces long numbers, so the model is never given any to say.
        f"Shipment of {s['name']}" + (f" (found by {matched_by})" if matched_by else ""),
        f"  Goods: {s['goods']}; {s['boxes']} box(es), {js_number_str(s['kg'])} kg; sent by {s['method']} from "
        f"{s['origin']}.",
        "  Route so far:",
        *(f"    - {day_label(d, time_zone)}: {e}" for d, e in s["history"]),
        f"  Right now: {s['now']}.",
        "  Already delivered." if s["eta"] is None else f"  Expected handover: {day_label(s['eta'], time_zone)}.",
        f"  Delivery: {s['delivery']}. Payment: {s['payment']}.",
        f"  Note: {s['note']}." if s.get("note") else "",
    ]
    return "\n".join(line for line in lines if line)


def lookup_note(caller_lines: list[str]) -> str:
    """The lookup's outcome in one line, read by the model right after the caller's words."""
    found = lookup_shipments(caller_lines).found
    if found:
        names = ", ".join(s["name"] for s in found)
        return f"[Company system, this turn: shipment found for {names} — use only that record.]"
    return (
        "[Company system, this turn: NOTHING FOUND for what they said. Do not describe any parcel, recipient, "
        "goods, place or date.]"
    )


def logistics_context(caller_lines: list[str], agent_name: str, time_zone: str = "Asia/Tashkent") -> str:
    """
    The prompt part for one logistics turn: who the agent is, how a real operator call goes, the
    shipment(s) found so far, and the company's answers.
    """
    lookup = lookup_shipments(caller_lines)
    found = lookup.found
    if found:
        shipment = [
            "SHIPMENT FOUND in the company system — the only source of truth; never add to it:",
            *(_describe(s, time_zone, lookup.matched_by.get(s["track"])) for s in found),
            "- If you said earlier that you could not find it, say now that you have found it.",
            "- Several shipments match: briefly name each by its goods and ask which one they mean."
            if len(found) > 1
            else "",
        ]
    else:
        shipment = [
            "NO SHIPMENT IDENTIFIED YET — the system found nothing for what they said. You know nothing",
            "about any parcel: never describe a parcel, name a recipient, goods, place or date, and never",
            "say it is on the way. Inventing a parcel is the worst possible mistake here.",
            "- The number they gave matches nothing; speech recognition may have misheard it. Say you could not "
            "find that number, and ask them to say the track number again slowly, or to give the phone number the "
            "parcel was sent to."
            if lookup.unknown_number
            else "- You only caught part of a number. Ask kindly for all six digits of the track number, slowly."
            if lookup.partial
            else "- Ask for the 6-digit track number or the phone number the parcel was sent to.",
        ]

    return "\n".join(
        [
            "COMPANY SYSTEM — LOGISTICS SUPPORT. This takes priority over the knowledge-base routing.",
            f"You are {agent_name}, an operator of a cargo company that delivers goods from China to",
            "Uzbekistan. Customers call to ask where their cargo is and when it will arrive. Your name and",
            "the language of the call are already set; never invent a company name.",
            "",
            "HOW A GOOD CALL GOES — like a real phone call, not a report:",
            "- EVERY reply is one or two short sentences, at most about 25 words. A phone call is a",
            "  back-and-forth: say the one thing that matters most, then let them ask.",
            '- The lookup below is instant and already done: never say "I will check", "one moment" or',
            '  "please wait".',
            "- When you find a shipment, first say whose it is or what it is in a few words, where it is now,",
            '  and when it should arrive — nothing more. Example of the right size: "Topdim, Dilshod aka,',
            "  telefon g‘iloflari. Hozir Xorgos chegarasida, yigirma birinchi oktabr, chorshanba kuni",
            '  Toshkentda bo‘ladi." Then stop.',
            '- Answer exactly what they asked, first: "when" gets the date, "where" the place, "how" the way.',
            "- Give the other details one at a time, only when they ask or when it is their obvious next",
            "  question: why it is late, how it is delivered, what is left to pay. The one exception: if",
            "  they must do something to get it (e.g. send a passport copy), add it as a short second",
            "  sentence right away, in the reply where you first say where the parcel is.",
            "- Do not end every reply with a question or an offer. Add a short one (a few words) only now",
            "  and then, when it truly helps. Never close the call yourself; when they say goodbye, say a",
            "  short goodbye.",
            "- Answer follow-ups from the record, building on what you already said; never repeat a sentence.",
            "",
            "HOW YOU SOUND — like a friendly, experienced operator talking, never reading:",
            "- Plain spoken words in the caller’s language, the way people talk on the phone. Use their name",
            "  once you know it.",
            '- If they sound worried or angry, open with a few words of sympathy ("Kechirasiz, kutib',
            '  qoldingiz..."), then the fact — still within the two sentences.',
            '- In Uzbek, always call it "track raqam" (never "trek"); in Russian, "трек-номер".',
            "- Never say a track number or a phone number out loud, not even to repeat it back or confirm",
            '  it — the voice mispronounces long numbers. Refer to it as "track raqamingiz" / "this number".',
            "- Say dates, prices and weights the way people say them out loud.",
            "",
            *(line for line in shipment if line),
            "",
            "GENERAL ANSWERS (use only these; anything else: a manager will call them back today):",
            "- Delivery time from the China warehouse to Tashkent: by truck about 12–18 days, by rail",
            "  15–20 days, by air 5–7 days. Customs clearance in Tashkent usually takes 1–2 days.",
            "- The company sends an SMS when the parcel reaches the Tashkent terminal and when the courier",
            "  sets off. Switching between pickup and courier is possible until the parcel reaches Tashkent.",
            "- Prices depend on weight, volume and method; a manager sends the current price list on Telegram.",
            "- The company handles customs clearance; sometimes a copy of the recipient’s passport is needed.",
            "- Pickup at the Tashkent terminal: Monday to Saturday, 9:00–19:00, with a passport and the",
            "  track number. Courier delivery in Tashkent the day after clearance; regions 1–3 days more.",
            "- Not accepted: liquids, loose batteries, flammable goods, medicines, weapons, counterfeit goods.",
            "- Damage, a missing box or a complaint: apologise, take down what happened, and say a manager",
            "  will call them back today. There is no live transfer in this call.",
            "",
            "Every reply here is answered=true, usedExcerpts=[].",
        ]
    )
