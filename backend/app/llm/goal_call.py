# ruff: noqa: E501 - prompt text reads better unwrapped
"""
Goal-led calls: the agent calls a person with a purpose and needs something from them.

The loan reminder ("Who to call", `target_json`) hard-codes one purpose: agree a
payment date. A goal (`agents.goal_json`) describes any such call as data:

    {
      "purpose":  "why we call",
      "person":   {"fullName": "...", "birthYear": "1988"},        # identity check, as the loan call
      "facts":    ["what we already know about them", ...],
      "collect":  [{"key": "amount", "label": "Loan amount", "ask": "How much would you like?"}, ...],
      "closing":  "the next step we promise at the end",
      "personas": [{"situation": "...", "questions": ["..."]}]    # Playground scenario cards
    }

The prompt block below turns that into the same kind of guided conversation the
loan call has, while the caller can ask anything about the company (answered
from the knowledge base). What the person told the agent is extracted after the
call (`extract_collected`) and stored in `call_results`.

An agent with an empty goal behaves exactly as before: none of this runs.
"""

import json
import logging
import random
from typing import Any

from app.jscompat import js_trim, utf16_slice
from app.llm.loan_call import identity_check

log = logging.getLogger(__name__)

LANGUAGE_NAME = {"uz": "Uzbek", "ru": "Russian", "en": "English"}


def agent_goal(agent: dict[str, Any]) -> dict[str, Any] | None:
    """The agent's goal, or None (no column yet, '{}', or no purpose)."""
    raw = agent.get("goal_json")
    if not raw:
        return None
    try:
        goal = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(goal, dict) or not str(goal.get("purpose") or "").strip():
        return None
    person = goal.get("person") if isinstance(goal.get("person"), dict) else {}
    collect = [c for c in goal.get("collect") or [] if isinstance(c, dict) and c.get("key") and c.get("label")]
    return {
        "purpose": str(goal["purpose"]).strip(),
        "person": {
            "fullName": str(person.get("fullName") or "").strip(),
            "birthYear": str(person.get("birthYear") or "").strip(),
        },
        "facts": [str(f) for f in goal.get("facts") or [] if str(f).strip()],
        "collect": collect,
        "closing": str(goal.get("closing") or "").strip(),
        "personas": [p for p in goal.get("personas") or [] if isinstance(p, dict)],
    }


# ── the prompt block ─────────────────────────────────────────────────


def goal_block(goal: dict[str, Any], language: str, caller_lines: list[str], greeting: str | None = None) -> str:
    name = goal["person"]["fullName"] or "the person"
    check = identity_check(goal["person"]["birthYear"], caller_lines)
    status = check.status if goal["person"]["fullName"] else "confirmed"
    confirmed = status in ("confirmed", "unchecked")

    identity = {
        "unchecked": [f'IDENTITY — ask whether you are speaking with {name}; a clear "yes, it is me" confirms it.'],
        "awaiting": [
            "IDENTITY — NOT CONFIRMED YET. One step at a time:",
            f'  1. Ask "Am I speaking with {name}?" and wait.',
            "  2. Once they say yes, ask for their year of birth and briefly say why (to make sure you speak with",
            "     the right person). The system checks the year; you do not know it and must never guess or hint.",
            "- Until the system confirms them, never say why you are calling beyond a personal matter for "
            f"{name}, and ask for nothing else.",
            *(
                [
                    "- The year they JUST said is WRONG. Say politely it does not match and that you need to speak with "
                    f"{name} personally; if they are {name}, they have one more try."
                ]
                if check.just_wrong
                else []
            ),
            "- An age or a guess is not a year: ask for the exact year.",
            f"- If they say they are someone else, ask when {name} can be reached and end politely.",
        ],
        "confirmed": [f"IDENTITY — CONFIRMED: you are speaking with {name}."],
        "failed": [
            "IDENTITY — CHECK FAILED: two wrong years of birth. Do not continue or mention why you called. Say the",
            f"details do not match, that you can only speak with {name} personally, and say goodbye.",
        ],
    }[status]

    steps = [
        f"  {i}. {c['label']}" + (f' — for example: "{c["ask"]}"' if c.get("ask") else "")
        for i, c in enumerate(goal["collect"], 1)
    ]
    lines = [
        "",
        "OUTBOUND CALL WITH A GOAL — you are calling one specific person on behalf of the company.",
        "This flow takes priority over the tone note above. Company facts still come ONLY from the knowledge",
        "base excerpts: never invent a rate, amount, fee, address or document.",
        f"Person you are calling: {name}",
        f"WHY YOU CALL: {goal['purpose']}",
        (
            f'Your greeting, set by the company: "{greeting}" — take your name and company from it and say it in '
            f"natural, grammatical {language}; remember you are the one calling."
        )
        if greeting
        else "",
        f'OPENING — on their first line (e.g. "Allo"), greet them, say who you are and which company you call from, and ask whether you are speaking with {name}. Only that one question.',
        "",
        *identity,
    ]
    if confirmed:
        lines += [
            "",
            "Once they are confirmed, thank them briefly and say why you are calling.",
            *(["WHAT YOU ALREADY KNOW ABOUT THEM:", *[f"- {f}" for f in goal["facts"]]] if goal["facts"] else []),
            "WHAT YOU NEED FROM THEM — ask in this order, ONE item per reply, and skip anything they already told",
            "you (even in passing). Never ask again for something they answered; confirm unclear answers once:",
            *steps,
            "THEIR QUESTIONS — they will ask about products, rates, terms, documents or branches. Answer FIRST, fully",
            "and concretely, from the knowledge base excerpts (figures exactly as written there). If the excerpts do",
            "not cover it, say a specialist will clarify (answered=false) and carry on. Then come back to the next",
            "missing item — but never ask two questions in one reply.",
            "WHEN YOU HAVE EVERYTHING — repeat back what they told you in one or two sentences and ask if it is right."
            + (f" Then tell them the next step: {goal['closing']}" if goal["closing"] else "")
            + " Then thank them and say goodbye.",
            "If they cannot talk now, ask when you may call back and end politely. If they are not interested, thank",
            "them and end politely; do not push.",
        ]
    lines += [
        "",
        "ALWAYS:",
        "- Sound like a friendly, experienced bank employee in a real conversation, not a form: vary your wording,",
        "  use what they said, never repeat a sentence you already said.",
        "- NEVER ask for card numbers, CVV, PIN, SMS codes, passwords or online-banking logins. If they start",
        "  giving them, stop them: the bank never needs these on a call.",
        "- There is no live transfer in this call. If they ask for a person, say a specialist will contact them.",
        "Replies in this flow are answered=true unless a company question was not covered by the excerpts.",
    ]
    return "\n".join(line for line in lines if line is not None).replace("\n\n\n", "\n\n")


# ── Playground scenario card ─────────────────────────────────────────


def scenario(goal: dict[str, Any], seed: int | None = None) -> dict[str, Any]:
    """Who the tester plays, so they know what to say when the agent calls."""
    rng = random.Random(seed)
    persona = rng.choice(goal["personas"]) if goal["personas"] else {}
    return {
        "you": goal["person"]["fullName"],
        "birthYear": goal["person"]["birthYear"],
        "purpose": goal["purpose"],
        "situation": str(persona.get("situation") or ""),
        "questions": [str(q) for q in persona.get("questions") or []][:4],
        "agentNeeds": [c["label"] for c in goal["collect"]],
    }


# ── after the call: what did the person tell us? ─────────────────────


async def llm_text(system: str, user: str, max_tokens: int, llm: str | None) -> str | None:
    """One plain-text answer from the agent's model (None: local engine or a failure)."""
    from app.llm import claude, gemini, ollama, openai
    from app.llm.call import LlmCall
    from app.llm.provider import resolve_llm

    provider, model = resolve_llm(llm)
    call = LlmCall(model=model)
    try:
        if provider == "ollama":
            return await ollama.ollama_text(system, user, max_tokens, call)
        if provider == "openai":
            return await openai.openai_text(system, user, max_tokens, call)
        if provider == "gemini":
            return await gemini.gemini_text(system, user, max_tokens, call)
        if provider == "anthropic" and claude.client() is not None:
            return await claude.text(model, system, user, max_tokens)
    except Exception as err:  # noqa: BLE001 - extraction is best-effort
        log.warning("llm_text failed: %s", err)
    return None


def _first_json_object(text: str) -> dict[str, Any] | None:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


async def extract_collected(goal: dict[str, Any], turns: list[dict[str, str]], llm: str | None) -> dict[str, Any]:
    """The goal's fields as the person answered them (null = not given), plus a short outcome."""
    keys = [c["key"] for c in goal["collect"]]
    empty = {"fields": dict.fromkeys(keys), "identityConfirmed": None, "outcome": "", "complete": False}
    dialogue = [t for t in turns if t.get("role") in ("caller", "agent")]
    if not dialogue:
        return empty
    system = (
        "You read the transcript of a bank's outbound call and fill in a form. Use ONLY what the PERSON said "
        "(not suggestions the agent made that the person did not accept). Return one JSON object and nothing else:\n"
        '{"fields": {<key>: <short value in the person\'s words, or null>}, "identityConfirmed": true|false|null, '
        '"outcome": "<one sentence: how the call ended and the agreed next step>"}\n'
        "Fields:\n" + "\n".join(f"- {c['key']}: {c['label']}" for c in goal["collect"])
    )
    transcript = "\n".join(f"{'PERSON' if t['role'] == 'caller' else 'AGENT'}: {t['text']}" for t in dialogue)
    raw = await llm_text(system, utf16_slice(transcript, 0, 12000), 500, llm)
    parsed = _first_json_object(raw or "")
    if not parsed:
        return {**empty, "outcome": "extraction unavailable (no hosted model answered)"}
    got = parsed.get("fields") if isinstance(parsed.get("fields"), dict) else {}
    fields = {k: (js_trim(str(got[k])) if got.get(k) not in (None, "", "null") else None) for k in keys}
    return {
        "fields": fields,
        "identityConfirmed": parsed.get("identityConfirmed")
        if isinstance(parsed.get("identityConfirmed"), bool)
        else None,
        "outcome": js_trim(str(parsed.get("outcome") or "")),
        "complete": all(v for v in fields.values()),
    }
