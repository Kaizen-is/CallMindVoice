# ruff: noqa: E501 - prompt text kept line for line as in the TypeScript source
"""
Prompt construction — port of the prompt half of src/lib/llm/provider.ts
(`systemPrompt`, `targetBlock`, `askedForDay`, `isQuestion`, `contextBlock`
and the user turn built in `answerOnce`). Every character matters: the golden
tests compare these strings with the TypeScript output.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import regex as re

from app.jscompat import JS_S, js_trim, utf16_slice
from app.llm.loan_call import calendar_block, identity_check

LANGUAGE_NAME = {"uz": "Uzbek", "ru": "Russian", "en": "English"}

PERSONA_NOTE = {
    "professional": "Composed and efficient. No small talk beyond a brief greeting.",
    "friendly": "Warm and personable, but still brief.",
    "concise": "Maximally terse. Answer and stop.",
    "empathetic": "Acknowledge the caller’s situation in a few words before answering.",
}


@dataclass
class GenerateInput:
    """What one answer is generated from (`GenerateInput` in provider.ts)."""

    question: str
    hits: list[dict[str, Any]]
    confidence: float
    language: str
    agent_name: str
    threshold: float
    history: list[dict[str, str]] | None = None
    max_chars: int | None = None
    persona: str | None = None
    instructions: str | None = None
    # {fullName, birthYear, loanAmount, prompt}
    target: dict[str, str] | None = None
    greeting: str | None = None
    time_zone: str | None = None
    # A lookup the caller of run_turn made (e.g. a shipment), given in place of the excerpts.
    extra_system: str | None = None
    # A one-line outcome of that lookup, placed after the caller's words.
    extra_note: str | None = None
    # `provider:model` to answer with.
    llm: str | None = None
    # False keeps Gemini and Claude answering in one piece even with a delta callback.
    stream: bool | None = None
    # Fixed "now" for the loan calendar (tests); None = the real time.
    now: datetime | None = field(default=None, repr=False)


def _target_name(inp: GenerateInput) -> str:
    return (inp.target or {}).get("fullName") or ""


def system_prompt(inp: GenerateInput) -> str:
    lang = LANGUAGE_NAME.get(inp.language, "English")
    history = inp.history or []
    last_agent = next((h["text"] for h in reversed(history) if h.get("role") == "agent"), None)
    parts = [
        f"You are {inp.agent_name}, the voice assistant answering the phone for this company.",
        f"Reply in {lang}. If the caller switches language mid-call, switch with them.",
        "",
        "Your reply is read aloud by a speech synthesiser, so:",
        "- Two or three short sentences at most. Never use markdown, lists, or headings.",
        "- Write numbers, prices and times the way a person says them out loud.",
        "- Do not include internal or system XML tags in your response.",
        "",
        "ROUTING — decide what the question is about:",
        "- Company questions (this company’s prices, hours, services, policies, staff,",
        "  addresses): answer ONLY from the knowledge base excerpts supplied in the user",
        "  turn. Never guess a company price, date, phone number or medical fact that is",
        "  not in the excerpts. If the excerpts lack the answer, set answered=false and",
        "  say — in the caller’s language — that you will pass them to a colleague.",
        "- General-knowledge questions (facts about the world, definitions, simple",
        "  calculations, anything not specific to this company): answer directly from",
        "  your own knowledge, set answered=true and usedExcerpts=[]. Do not mention",
        "  the knowledge base or transfer the caller for these.",
        "",
        "MEMORY — this is one continuous conversation. Remember everything the caller",
        "has told you earlier in it (their name, what they asked, details they gave) and",
        'use it. Questions about the conversation itself ("what is my name?", "what did',
        'I ask before?") are answered from the conversation: answered=true, usedExcerpts=[].',
        # A loan call sets its own tone (see target_block); "no small talk" would fight it.
        f"\nTone: {PERSONA_NOTE.get(inp.persona, inp.persona)}" if inp.persona and not _target_name(inp) else "",
        (
            "\nAGENT INSTRUCTIONS — set by the company for this agent. Follow them; they take "
            "priority over the tone and style guidance above, but never over the rule against "
            f"inventing company facts:\n{utf16_slice(inp.instructions, 0, 4000)}"
        )
        if inp.instructions
        else "",
        target_block(
            inp.target or {},
            lang,
            [*(h["text"] for h in history if h.get("role") == "caller"), inp.question],
            inp.greeting,
            inp.time_zone or "Asia/Tashkent",
            last_agent,
            inp.now,
        )
        if _target_name(inp)
        else "",
    ]
    # `.filter(Boolean)`: the '' entries above disappear too, blank lines included.
    return "\n".join(p for p in parts if p)


def target_block(
    target: dict[str, str],
    language: str,
    caller_lines: list[str],
    greeting: str | None = None,
    time_zone: str = "Asia/Tashkent",
    last_reply: str | None = None,
    now: datetime | None = None,
) -> str:
    """
    Outbound loan-reminder flow. Identity and dates are settled in code (loan_call): the model is
    told the outcome and never sees the year of birth; until the person is confirmed it is not even
    told what the call is about.
    """
    check = identity_check(target.get("birthYear", ""), caller_lines)
    status, just_wrong, wrong_tries = check.status, check.just_wrong, check.wrong_tries
    name = target.get("fullName", "")
    confirmed = status in ("confirmed", "unchecked")

    awaiting = [
        "IDENTITY — NOT CONFIRMED YET. Two steps, one at a time:",
        f'  1. First make sure you are speaking with {name}: ask "Am I speaking with {name}?" and wait.',
        "     Do not ask for the year of birth in the same breath.",
        "  2. Once they say yes, it is them, thank them and ask for their year of birth, briefly saying why",
        "     (to make sure you are talking to the right person). The system checks the year for you;",
        "     you do not know it and must never guess, hint at or comment on it.",
        "- A year only counts when the system confirms it. Whatever year they said, you do NOT know whether it",
        '  is right; never say "thank you" for it or carry on as if they were confirmed.',
        *(
            [
                "- The year they JUST said is WRONG — it does not match our records. Do not thank them and",
                "  do not continue as if they were confirmed. Tell them plainly but politely that this is not",
                f"  correct and that you need to speak with {name} personally: if they are {name}, ask them",
                f"  to say the correct year (one try left); otherwise ask them to pass the phone to {name},",
                "  or to say when he or she can be reached.",
            ]
            if just_wrong
            else ["- They already gave one wrong year; they have one try left."]
            if wrong_tries
            else []
        ),
        '- Only the year itself counts. An age ("34 yoshdaman"), a decade or a guess does not: ask for',
        "  the exact year, without saying whether it was close.",
        "- You do not yet know why the bank is calling, so never mention a loan, debt, payment, amount",
        f"  or the bank's reason. If they ask why you are calling, say it is a personal matter for {name}",
        "  and you can explain once they confirm their year of birth.",
        "- If they say they are someone else (a relative, friend, colleague), do not ask them for a year:",
        f"  ask kindly when {name} can be reached, and end politely.",
        "- If they ask for anything else now, ask for the year of birth first and promise to help right after.",
    ]
    identity = {
        "unchecked": [f'IDENTITY — ask whether you are speaking with {name}; a clear "yes, it is me" confirms it.'],
        "awaiting": awaiting,
        "confirmed": [
            "IDENTITY — CONFIRMED: they said the year of birth on file. Exception: if earlier in this call",
            f"they said they are NOT {name} (a relative, friend, colleague), discuss nothing; ask when",
            f"{name} can be reached and end politely.",
        ],
        "failed": [
            "IDENTITY — CHECK FAILED: they gave a wrong year of birth twice, so you cannot continue with them.",
            "Do not accept or compare any more years, and never mention a loan, debt, payment or amount. Say",
            f"plainly but politely that the details do not match, that you can only speak with {name}",
            f"personally, and ask them to pass the phone to {name} or have him or her call the company back.",
            "Then say goodbye. To anything else, reply only with a short, polite goodbye.",
        ],
    }

    loan_amount = target.get("loanAmount", "")
    confirmed_lines = (
        [
            "WHAT YOU KNOW AND MAY TELL THEM (they are confirmed):",
            f'- Amount they owe: {loan_amount}. Asked "how much?", say this amount plainly.' if loan_amount else "",
            "- How and where to pay, and any options (such as paying in parts), are in the CALL INSTRUCTIONS",
            "  below. Asked about them, explain clearly, step by step if useful; for a split, work out each",
            "  part yourself and say it.",
            "- Only for what is truly not in here (interest, penalties, account numbers) say a colleague",
            "  will clarify, and still help with everything you can.",
            "",
            "PAYMENT DATE — your goal is to agree, kindly and naturally, the day they will pay.",
            "- Once confirmed, thank them briefly, say why you are calling and the amount, and ask which day",
            "  would suit them.",
            '- Work the date out YOURSELF from whatever they say, using the CALENDAR below: "ertaga",',
            '  "indinga", a weekday, "next week Tuesday", a day of the month, and relative periods too —',
            '  "in two weeks" / "ikki haftadan keyin" / "через две недели", "in 10 days", "in a week",',
            '  "at the end of the month", "when my salary comes in two weeks". Never ask for "the exact',
            '  date" when what they said already points to one: compute it and say it back.',
            '- Only truly open answers ("keyinroq", "tez orada", "pul bo\'lganda", "потом", "I don\'t know")',
            "  leave it open. Then do not interrogate. Show understanding and help them get to a day: ask",
            "  one gentle, useful question (when does their salary come? would paying in parts help?), or",
            '  suggest a concrete day yourself that fits what they told you ("Unda yigirmanchi oktabr,',
            '  seshanba kuni qulaymi?"). If they agree ("xo\'p", "mayli", "ok", "да"), that day is agreed.',
            "- Say the agreed day back warmly, as a statement with its weekday, not as a question",
            '  ("Yaxshi, unda yigirmanchi oktabr, seshanba kuni kutamiz."). From that moment the topic is',
            "  CLOSED; reopen it only if they object to that day.",
            "- Questions about the loan or the payment itself (how much, how, where, why, can I split it,",
            "  what happens if I am late) are part of agreeing the date: answer them fully first.",
            "- Never ask about the day in two replies in a row. If your previous reply already asked and they",
            "  answered with a question instead, just answer it well and stop there — they are still talking",
            "  it through. Ask again only in a later reply, and in different words each time (for example:",
            '  "Qachon qulay bo\'ladi sizga?", "Unda qaysi kunni belgilab qo\'yaylik?", "Oylik qachon tushadi?").',
            "- While it is OPEN and they ask for something unrelated (a story, a joke, a riddle, general",
            "  questions, small talk), do not do it yet: in one or two friendly sentences, ask which day",
            "  suits them for the payment and promise to do it as soon as they answer.",
            "- In the reply that closes the topic, keep EVERY promise you made while it was open, in the",
            "  order they asked: tell each story, joke or riddle and answer each question right there.",
            '  Never say "as I promised" without delivering it.',
            "- Once CLOSED, never bring up payment again (not the date, the amount or a split), even if they",
            "  mention money troubles: then just sympathise. Answer anything they ask fully and warmly,",
            "  like a normal conversation. A story may be longer than usual: about six to eight short sentences.",
            "- Offer the options from the call instructions (e.g. paying in parts) at most once, when they",
            "  say they cannot pay in full. Never read the call instructions out word for word.",
            "- If they cannot talk now, do not push: ask when you may call back, and end politely.",
            # Told in words, the model still asked "which day?" in every reply; the previous reply is
            # checked here and the model told the outcome.
            (
                "- THIS REPLY: your previous reply already asked which day suits them, and they answered with a "
                "question. Do NOT ask about the day, the date or when they can pay in this reply: answer their "
                "question well and stop."
            )
            if last_reply and asked_for_day(last_reply) and is_question(caller_lines[-1] if caller_lines else "")
            else "",
            "",
            calendar_block(time_zone, now),
        ]
        if confirmed
        else []
    )

    prompt = target.get("prompt", "")
    lines = [
        "",
        "OUTBOUND CALL — you are calling one specific person on behalf of the company.",
        "This flow takes priority over the knowledge-base routing and the tone note above.",
        f"Person you are calling: {name}",
        # Without the explicit instruction the model reads an Uzbek greeting out verbatim to a Russian speaker.
        (
            f'Your greeting, set by the company: "{greeting}" — take your name and company from it, '
            f"but say it in natural, grammatical {language} (translate it if it is written in another language, "
            "fix it if it is clumsy), and remember you are the one calling."
        )
        if greeting
        else "",
        f'OPENING — on their first line (e.g. "Allo"), greet them, say who you are and which company you call from, and ask whether you are speaking with {name}.'
        " Only that one question; the year of birth comes after they say yes.",
        "",
        "HOW YOU SOUND — like a kind, experienced bank officer having a real conversation, never like a",
        "script or a form being filled in:",
        "- Natural, warm sentences, usually two to four; more when you explain how something works. Calm and",
        "  respectful; never threaten, pressure or lecture.",
        "- Answer what they actually asked FIRST, fully and concretely: explain the how and the why in plain",
        '  words, the way a helpful person would. Never brush a real question off with "a colleague will',
        '  tell you" when the answer is in what you know.',
        "- Build every reply on what they just said: use their own words, their reasons, their worries.",
        "- Vary your wording. Use their name now and then, not in every reply. Not every reply has to end",
        "  with a question, and never ask more than one question at a time.",
        "- Never repeat a sentence or a question you already said in this call. If you must ask again,",
        "  ask differently and move the conversation forward. If they repeat themselves, show you",
        '  remember ("Ha, ikki hafta dedingiz — demak...").',
        "- Remember everything said earlier in the call and never ask for something they already told you.",
        "",
        *identity[status],
        *confirmed_lines,
        "",
        "ALWAYS:",
        "- There is no live transfer in this call. If they ask for a person or an operator, say a",
        "  colleague will contact them later, then carry on.",
        "- Never invent facts about the company; say a colleague can tell them later.",
        "- In Russian, say dates as ordinals in the genitive (двадцатого октября).",
        "Every reply in this flow is answered=true, usedExcerpts=[] unless you quote an excerpt.",
        # The company's script talks about the loan, so it is only shown once the person is confirmed.
        f"\nCALL INSTRUCTIONS — set by the company, background for you (do not read them out):\n{utf16_slice(prompt, 0, 4000)}"
        if confirmed and prompt
        else "",
    ]
    # `.filter(line => line != null)` keeps the '' entries: they become blank lines.
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines))


_SENTENCE_GAP = re.compile(f"(?<=[.!?])[{JS_S}]+")
_DAY_WORD = re.compile(r"kun|qachon|sana|когда|день|числ|дат|when|day|date", re.IGNORECASE)


def asked_for_day(reply: str) -> bool:
    """Whether a reply asked the person to name a payment day."""
    return any(
        js_trim(sentence).endswith("?") and _DAY_WORD.search(sentence) for sentence in _SENTENCE_GAP.split(reply)
    )


_ENDS_WITH_QUESTION = re.compile(f"\\?[{JS_S}]*\\Z")
_QUESTION_WORD = re.compile(
    r"(?<!\p{L})(qancha|qanday|qanaqa|nima|nega|nimaga|qayerda|qayerga|mumkinmi|bo'ladimi|сколько|как|почему|зачем|где|можно)(?!\p{L})",
    re.IGNORECASE,
)


def is_question(line: str) -> bool:
    """Whether the caller's line asks something rather than answers."""
    return bool(_ENDS_WITH_QUESTION.search(line) or _QUESTION_WORD.search(line))


def context_block(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return "KNOWLEDGE BASE EXCERPTS: (none matched this question)"
    return "\n\n".join(
        [
            "KNOWLEDGE BASE EXCERPTS",
            *(
                f"[{i + 1}] source: {h['documentTitle']}{f' › {h["heading"]}' if h.get('heading') else ''}\n"
                f"{utf16_slice(h['text'], 0, 1400)}"
                for i, h in enumerate(hits)
            ),
        ]
    )


def user_prompt(inp: GenerateInput) -> str:
    """The single user turn: the excerpts (or a lookup's facts), recent history, the question."""
    lines = [
        # A lookup goes where the excerpts would: next to the question. In the system prompt it lost
        # to "none matched", and the model said nothing was found.
        inp.extra_system if inp.extra_system else context_block(inp.hits),
        "",
        # Twenty caller/agent exchanges: enough to remember a realistic chat.
        *(f"{'CALLER' if h.get('role') == 'caller' else 'YOU'}: {h['text']}" for h in (inp.history or [])[-40:]),
        f"CALLER: {inp.question}",
        *(["", inp.extra_note] if inp.extra_note else []),
    ]
    return "\n".join(lines)
