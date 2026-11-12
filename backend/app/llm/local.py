# ruff: noqa: E501 - regex word lists and phrasebook kept as in the TypeScript source
"""
The local answer engine — port of src/lib/llm/local.ts.

Rule-based intent and sentiment, plus an extractive answer built from the
retrieved chunks in the caller's language. It is the fallback whenever every
hosted model fails, and its intent decides fillers, escalation and the
"give me a human" shortcut — so it must behave exactly like the TypeScript.
"""

from typing import Any

import regex as re

from app.jscompat import JS_B, JS_S, utf16_len, utf16_slice, utf16_units
from app.rag.text import detect_language, normalize, sentences, stem, tokenize

S = f"[{JS_S}]"

# ── intent taxonomy ─────────────────────────────────────────────────

INTENT_PATTERNS: list[tuple[str, re.Pattern]] = [
    (intent, re.compile(pattern, re.ASCII))
    for intent, pattern in [
        (
            "human",
            r"\b(operator|operatorga|human|zhivoy|manager|menejer|specialist|spetsialist|sotrudnik|xodim|perevedite|ulang|ulab|soedinite|agent)\b",
        ),
        (
            "greeting",
            r"\b(salom|assalom|assalomu|zdravstvuyte|privet|dobriy|hello|hi|hey|good morning|good afternoon)\b",
        ),
        ("goodbye", r"\b(xayr|rahmat|spasibo|do svidaniya|poka|bye|goodbye|thanks|thank you)\b"),
        # Tested against " <text> " (leading space), so in practice this never matches — kept identical.
        ("affirm", r"^(ha|xa|yes|da|ok|okay|xorosho|yaxshi|tugri|verno|konechno|albatta)\b"),
        (
            "price",
            r"\b(narx|narxi|qancha|pul|tolov|to lov|summa|price|cost|how much|fee|tariff|tarif|cena|stoit|stoimost|skolko|oplata|prays)\b",
        ),
        (
            "hours",
            r"\b(vaqt|soat|ish vaqti|qachon|ochiq|yopiq|hours|open|close|when|schedule|raspisanie|grafik|rezhim|rabotaete|vremya|dam olish)\b",
        ),
        (
            "location",
            r"\b(manzil|qayer|joylash|address|where|location|adres|gde|nahodit|filial|branch|kurish|karta|orientir)\b",
        ),
        ("contact", r"\b(telefon|raqam|aloqa|contact|phone|number|email|pochta|nomer|svyaz|whatsapp|telegram)\b"),
        (
            "booking",
            r"\b(navbat|yozil|band qil|qabul|book|appointment|reserve|schedule|zapis|zapisatsya|priem|zabronirovat|rezerv)\b",
        ),
        ("availability", r"\b(bormi|bor mi|mavjud|available|est li|imeetsya|nalichie|svobodn|bosh joy|in stock)\b"),
        (
            "documents",
            r"\b(hujjat|pasport|documents|document|spravka|passport|dokument|nuzhno vzyat|olib kelish|kerakli)\b",
        ),
        ("status", r"\b(holat|status|qayerda|track|order|zakaz|buyurtma|dostavka|yetkaz|where is my|gotov|tayyor)\b"),
        (
            "complaint",
            r"\b(shikoyat|complaint|problem|muammo|jaloba|ne rabotaet|ishlamayapti|ploho|yomon|obman|refund|vozvrat|qaytar)\b",
        ),
        (
            "policy",
            r"\b(qoida|shart|policy|rules|usloviya|pravila|garantiya|kafolat|strahov|sugurta|dogovor|shartnoma|licenz)\b",
        ),
        ("howto", r"\b(qanday|kak|how|qilaman|sdelat|oformit|rasmiylash|poluchit|olish|instrukciya)\b"),
    ]
]


def classify_intent(text: str) -> str:
    n = f" {normalize(text)} "
    for intent, pattern in INTENT_PATTERNS:
        if pattern.search(n):
            return intent
    return "general"


INTENT_LABEL = {
    "price": "Pricing", "hours": "Opening hours", "location": "Location", "contact": "Contact details",
    "booking": "Appointment booking", "availability": "Availability", "documents": "Required documents",
    "policy": "Policy & terms", "howto": "How-to", "status": "Order / request status", "complaint": "Complaint",
    "human": "Operator request", "greeting": "Greeting", "goodbye": "Closing", "affirm": "Confirmation",
    "general": "General enquiry",
}  # fmt: skip

# ── sentiment ───────────────────────────────────────────────────────

_NEGATIVE = re.compile(
    r"\b(yomon|yoqmadi|shikoyat|jahl|xafa|kutdim|uzoq|sekin|ishlamayapti|muammo|noto|aldadi|ploho|uzhasno|dolgo|zhdu|ne rabotaet|problema|obman|zlyus|nedovolen|bad|awful|terrible|angry|wait|waiting|useless|broken|refund|complain|slow)\b",
    re.ASCII,
)
_POSITIVE = re.compile(
    r"\b(rahmat|zor|ajoyib|yaxshi|tez|minnatdor|spasibo|otlichno|horosho|bistro|udobno|great|thanks|perfect|excellent|helpful|fast)\b",
    re.ASCII,
)
_UPPER = re.compile("[^A-ZА-Я]")
_NOT_LETTER = re.compile(r"[^\p{L}]")


def sentiment_of(text: str) -> float:
    n = f" {normalize(text)} "
    score = 0.0
    if _NEGATIVE.search(n):
        score -= 0.55
    if _POSITIVE.search(n):
        score += 0.5
    if re.search(r"[!]{2,}", text):
        score -= 0.15
    caps = utf16_len(_UPPER.sub("", text)) / max(1, utf16_len(_NOT_LETTER.sub("", text)))
    if caps > 0.6 and utf16_len(text) > 12:
        score -= 0.2
    return max(-1, min(1, score))


# ── phrasebook ──────────────────────────────────────────────────────

PHRASES: dict[str, dict[str, Any]] = {
    "uz": {
        "lead": {
            "price": ["Narxlar quyidagicha:", "Bu xizmat narxi:"],
            "hours": ["Ish vaqtimiz:", "Qabul vaqti:"],
            "location": ["Manzilimiz:", "Bizni bu yerdan topasiz:"],
            "contact": ["Aloqa maʼlumotlari:"],
            "booking": ["Navbatga yozilish tartibi:"],
            "availability": ["Maʼlumot bo‘yicha:"],
            "documents": ["Kerakli hujjatlar:"],
            "policy": ["Shartlarimiz bo‘yicha:"],
            "howto": ["Tartib quyidagicha:"],
            "status": ["Holat bo‘yicha:"],
        },
        "generic": ["Maʼlumotlarimizga ko‘ra:", "Mana javob:"],
        "unknown": [
            "Kechirasiz, bu savolga aniq javob topa olmadim. Mutaxassisimizga ulab qo‘yaymi?",
            "Afsuski, menda bu boʻyicha aniq maʼlumot yo‘q. Operatorga ulayman.",
        ],
        "transfer": ["Albatta, hozir operatorga ulayman. Bir daqiqa kutib turing."],
        "greeting": ["Assalomu alaykum! Men {agent}man. Sizga qanday yordam bera olaman?"],
        "goodbye": ["Sizga rahmat! Yana savollaringiz bo‘lsa, qo‘ng‘iroq qiling. Xayr!"],
        "followUp": ["Yana biror savolingiz bormi?", "Boshqa yordam kerakmi?"],
        "ack": ["Tushunarli.", "Yaxshi."],
    },
    "ru": {
        "lead": {
            "price": ["Стоимость следующая:", "По ценам:"],
            "hours": ["Мы работаем так:", "График приёма:"],
            "location": ["Наш адрес:", "Мы находимся здесь:"],
            "contact": ["Контактные данные:"],
            "booking": ["Записаться можно так:"],
            "availability": ["По наличию:"],
            "documents": ["Необходимые документы:"],
            "policy": ["По условиям:"],
            "howto": ["Порядок такой:"],
            "status": ["По статусу:"],
        },
        "generic": ["По нашим данным:", "Отвечаю:"],
        "unknown": [
            "К сожалению, точного ответа на этот вопрос у меня нет. Соединить вас со специалистом?",
            "Не могу это подтвердить по базе знаний. Давайте я переключу вас на оператора.",
        ],
        "transfer": ["Конечно, сейчас соединю вас с оператором. Одну минуту."],
        "greeting": ["Здравствуйте! Меня зовут {agent}. Чем могу помочь?"],
        "goodbye": ["Спасибо за обращение! Всего доброго."],
        "followUp": ["Могу ещё чем-то помочь?", "Есть ещё вопросы?"],
        "ack": ["Понял вас.", "Хорошо."],
    },
    "en": {
        "lead": {
            "price": ["Here are the prices:", "The cost is:"],
            "hours": ["Our opening hours:", "We are open:"],
            "location": ["Our address:", "You can find us here:"],
            "contact": ["Contact details:"],
            "booking": ["Here is how booking works:"],
            "availability": ["On availability:"],
            "documents": ["Documents you will need:"],
            "policy": ["On our terms:"],
            "howto": ["Here is the process:"],
            "status": ["On the status:"],
        },
        "generic": ["Here is what I have:", "According to our records:"],
        "unknown": [
            "I couldn't find a confident answer to that. Shall I connect you to a specialist?",
            "I don't have that in my knowledge base. Let me pass you to a colleague.",
        ],
        "transfer": ["Of course — connecting you to an operator now. One moment."],
        "greeting": ["Hello! I'm {agent}. How can I help you today?"],
        "goodbye": ["Thanks for calling. Have a great day!"],
        "followUp": ["Anything else I can help with?", "Is there anything else?"],
        "ack": ["Got it.", "Understood."],
    },
}


def _pick(options: list[str], seed: int) -> str:
    return options[abs(seed) % len(options)]


def seed_of(s: str) -> int:
    """`(h * 31 + charCode) | 0` over UTF-16 units — JavaScript's int32 wraparound."""
    h = 0
    for unit in utf16_units(s):
        h = ((h * 31 + unit + 0x80000000) & 0xFFFFFFFF) - 0x80000000
    return h


# ── evidence selection ──────────────────────────────────────────────

_NUMERIC = re.compile("[0-9]")
_MONEY = re.compile(f"([0-9][0-9{JS_S}.,]*){S}*(so'm|som|sum|uzs|usd|\\$|€|rub|руб|ming|mln|million)", re.IGNORECASE)
_TIME = re.compile(
    f"{JS_B}([0-9]{{1,2}}[:.][0-9]{{2}}|[0-9]{{1,2}}{S}*(am|pm)|dushanba|seshanba|chorshanba|payshanba|juma|shanba|yakshanba|ponedelnik|vtornik|sreda|chetverg|pyatnitsa|subbota|voskresene|monday|tuesday|wednesday|thursday|friday|saturday|sunday){JS_B}",
    re.IGNORECASE,
)
_ADDRESS = re.compile(
    f"{JS_B}(kocha|ko'cha|street|str\\.|ul\\.|dom|uy|shahar|city|tuman|district|mfy|orientir|metro|prospekt){JS_B}",
    re.IGNORECASE,
)
_PHONE = re.compile(f"(\\+?[0-9][0-9{JS_S}()\\-]{{7,}})")
INTENT_BONUS = {"price": _MONEY, "hours": _TIME, "location": _ADDRESS, "contact": _PHONE}
_BULLET_START = re.compile(r"^[•\-*]")
_TRIM = re.compile(f"^{S}+|{S}+$")
_WS = re.compile(f"{S}+")


def _trim(s: str) -> str:
    return _TRIM.sub("", s)


def _score_sentences(question: str, hits: list[dict[str, Any]], intent: str) -> list[dict[str, Any]]:
    q_terms = {stem(t) for t in tokenize(question)}
    bonus = INTENT_BONUS.get(intent)
    out: list[dict[str, Any]] = []
    for hit_idx, hit in enumerate(hits):
        lines: list[str] = []
        for line in hit["text"].split("\n"):
            lines.extend(sentences(line) if utf16_len(line) > 220 else [line])
        lines = [t for t in (_trim(s) for s in lines) if utf16_len(_WS.sub("", t)) > 12]

        for line_idx, line in enumerate(lines):
            terms = {stem(t) for t in tokenize(line)}
            overlap = sum(1 for t in q_terms if t in terms)
            coverage = overlap / len(q_terms) if q_terms else 0
            score = coverage * 2.6
            score += hit["score"] * 1.5
            score -= hit_idx * 0.22
            score -= line_idx * 0.035
            if bonus is not None and bonus.search(line):
                score += 1.5
            if intent == "price" and _NUMERIC.search(line):
                score += 0.35
            # An FAQ chunk's heading restates the question: findable, never the reply itself.
            if hit.get("heading") and _trim(line) == _trim(hit["heading"]):
                score -= 1.1
            if _BULLET_START.search(line):
                score += 0.2
            if utf16_len(line) < 26:
                score -= 0.4
            if utf16_len(line) > 320:
                score -= 0.3
            out.append({"text": line, "score": score, "hit": hit})
    out.sort(key=lambda s: -s["score"])  # stable, like Array.prototype.sort
    return out


def _tidy(line: str) -> str:
    line = re.sub(f"^[•\\-*]{S}*", "", line, count=1)
    line = re.sub(f"^[0-9]+[.)]{S}*", "", line, count=1)
    return _trim(_WS.sub(" ", line))


def _assemble(picked: list[dict[str, Any]], intent: str, limit: int) -> str:
    """Keep replies short — this text is going to be spoken aloud."""
    seen: set[str] = set()
    kept: list[str] = []
    budget = limit
    for s in picked:
        clean = _tidy(s["text"])
        key = normalize(clean)[:60]
        if not clean or key in seen:
            continue
        if utf16_len(clean) > budget and kept:
            break
        seen.add(key)
        kept.append(clean)
        budget -= utf16_len(clean)
        cap = 3 if intent in ("price", "documents", "howto") else 2
        if len(kept) >= cap or budget <= 40:
            break
    if len(kept) <= 1:
        return kept[0] if kept else ""
    return " ".join(k if re.search(r"[.!?:;]$", k) else f"{k}." for k in kept)


def synthesize_local(
    question: str,
    hits: list[dict[str, Any]],
    confidence: float,
    language: str | None,
    agent_name: str,
    threshold: float,
    history: list[dict[str, str]] | None = None,
    max_chars: int = 340,
) -> dict[str, Any]:
    """`{answer, intent, answered, usedHits, engine: 'local'}` — the SynthesisOutput shape."""
    language = language or detect_language(question)
    phrases = PHRASES.get(language, PHRASES["en"])
    intent = classify_intent(question)
    seed = seed_of(question)

    def result(answer: str, answered: bool, used: list[dict[str, Any]]) -> dict[str, Any]:
        return {"answer": answer, "intent": intent, "answered": answered, "usedHits": used, "engine": "local"}

    if intent == "human":
        return result(_pick(phrases["transfer"], seed), False, [])
    if intent == "greeting" and not history:
        return result(_pick(phrases["greeting"], seed).replace("{agent}", agent_name, 1), True, [])
    if intent == "goodbye":
        return result(_pick(phrases["goodbye"], seed), True, [])
    if not hits or confidence < threshold:
        return result(_pick(phrases["unknown"], seed), False, hits[:2])

    scored = _score_sentences(question, hits, intent)
    body = _assemble(scored, intent, max_chars)
    if not body:
        return result(_pick(phrases["unknown"], seed), False, hits[:2])

    lead_options = phrases["lead"].get(intent, phrases["generic"])
    lead = _pick(lead_options, seed) if confidence > 0.72 else _pick(phrases["generic"], seed)
    follow_up = _pick(phrases["followUp"], seed + 7)
    used_ids = {s["hit"]["chunkId"] for s in scored[:4]}
    used = [h for h in hits if h["chunkId"] in used_ids][:3]
    answer = _trim(_WS.sub(" ", f"{lead} {body}{'' if re.search(r'[.!?]$', body) else '.'} {follow_up}"))
    return result(answer, True, used)


# ── call summary for operator hand-off ──────────────────────────────

_REASON_TEXT = {
    "low_confidence": {
        "uz": "AI bazadan ishonchli javob topa olmadi",
        "ru": "AI не нашёл уверенного ответа в базе",
        "en": "the assistant could not find a confident answer",
    },
    "explicit_request": {
        "uz": "mijoz operatorni so‘radi",
        "ru": "клиент попросил оператора",
        "en": "the caller asked for a human",
    },
    "negative_sentiment": {"uz": "mijoz norozi", "ru": "клиент недоволен", "en": "the caller sounds unhappy"},
    "repeated_failure": {
        "uz": "ketma-ket bir necha savolga javob topilmadi",
        "ru": "несколько вопросов подряд остались без ответа",
        "en": "several questions in a row went unanswered",
    },
    "after_hours": {
        "uz": "ish vaqtidan tashqari murojaat",
        "ru": "обращение вне рабочего времени",
        "en": "the call arrived outside business hours",
    },
}


def summarize_local(turns: list[dict[str, str]], language: str, reason: str) -> str:
    caller = [t for t in (_trim(x["text"]) for x in turns if x["role"] == "caller") if t]
    if not caller:
        return {
            "uz": "Qo‘ng‘iroq boshlandi, mijoz hali savol bermadi.",
            "ru": "Звонок начат, клиент ещё не задал вопрос.",
            "en": "Call started; the caller has not asked anything yet.",
        }[language]
    topic = INTENT_LABEL[classify_intent(" ".join(caller))]
    first = utf16_slice(_WS.sub(" ", caller[0]), 0, 150)
    last = utf16_slice(_WS.sub(" ", caller[-1]), 0, 150)
    mood = sentiment_of(" ".join(caller))
    why = _REASON_TEXT.get(reason, {}).get(language, reason)
    templates = {
        "uz": f"Mavzu: {topic}. Mijozning birinchi savoli: “{first}”. Oxirgi gap: “{last}”. Eskalatsiya sababi: {why}.{' Diqqat: mijoz kayfiyati salbiy.' if mood < -0.2 else ''}",
        "ru": f"Тема: {topic}. Первый вопрос клиента: «{first}». Последняя реплика: «{last}». Причина эскалации: {why}.{' Внимание: клиент раздражён.' if mood < -0.2 else ''}",
        "en": f"Topic: {topic}. Caller opened with: “{first}”. Last message: “{last}”. Escalated because {why}.{' Heads up: the caller sounds frustrated.' if mood < -0.2 else ''}",
    }
    return templates[language]
