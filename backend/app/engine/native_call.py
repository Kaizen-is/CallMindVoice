"""
L8 pilot: the Playground call with Gemini Live as the voice itself (native audio), behind text guardrails.

The cascade hears (STT), thinks (LLM) and speaks (TTS) in three steps. Gemini Live does all three in one
model on one connection: it hears the caller's audio, decides when they have finished, notices when they
talk over it, and answers in its own voice. What it must never decide alone are the facts of a loan
call, so those are tools answered by our code, exactly as in the cascade:

  check_identity(birth_year)    the year is compared in code (app/llm/loan_call); the model never sees it
  get_balance()                 the debt and its split (app/llm/loan_plan), only once identity is confirmed
  record_promise(day, amount)   the day worked out and checked in code; written down as data (≤ 90 days,
                                no more than the debt)

Text guardrails: both sides are transcribed (input and output transcription). Every agent line is checked
the way the whole-call evaluation checks it (app/llm/loan_plan.sums_in): a sum it was not given, or any
sum before identity was confirmed, is flagged on that turn. Every line goes into the call's turns, so the
Playground's records hold the pilot's calls like any other.

Off unless the page asks for it (`?native=1`); GEMINI_NATIVE_MODEL (default gemini-3.8-live).
"""

import asyncio
import base64
import contextlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import websockets

from app import db
from app.engine.conversation import agent_target
from app.env import env
from app.ids import new_id, now_iso
from app.jscompat import js_json, js_trim, utf16_slice
from app.llm.loan_call import identity_check, named_day
from app.llm.loan_plan import parse_sum, plan_lines, say_sum, split_plan, sums_in
from app.speech.gemini_live import url as live_url

log = logging.getLogger("callmind.native")

CONNECT_TIMEOUT_S = 15.0
LANGUAGE_NAMES = {"uz": "Uzbek (Latin script)", "ru": "Russian", "en": "English"}
VOICE = "Charon"


def native_model() -> str:
    return env("GEMINI_NATIVE_MODEL", "gemini-3.8-live")


TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "check_identity",
                "description": "Check the year of birth the person just said against the record. Call it as soon as "
                "they say a year. You never see the right year; you only learn whether it matched.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {"birth_year": {"type": "STRING", "description": "The year exactly as they said it"}},
                    "required": ["birth_year"],
                },
            },
            {
                "name": "get_balance",
                "description": "The amount the person owes and how it splits into parts. Works only after "
                "check_identity confirmed them. Say the figures exactly as returned.",
                "parameters": {"type": "OBJECT", "properties": {}},
            },
            {
                "name": "record_promise",
                "description": "Write down the day the person promised to pay and the sum. Call it once they have "
                "agreed a day; then say the day back to them as the tool returns it.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "day": {"type": "STRING", "description": "The day as they said it, or YYYY-MM-DD"},
                        "amount": {
                            "type": "NUMBER",
                            "description": "The sum in so'm they will pay that day: their own figure, or the "
                            "first part from get_balance if they chose to pay in parts",
                        },
                    },
                    "required": ["day"],
                },
            },
        ]
    }
]


def instruction(agent: dict[str, Any], lang: str) -> str:
    target = agent_target(agent)
    name = target.get("fullName") or "the customer"
    persona = js_trim(str(agent.get("persona") or ""))
    greeting = js_trim(str(agent.get("greeting") or ""))
    instructions = js_trim(str(agent.get("instructions") or ""))
    notes = js_trim(str(target.get("prompt") or ""))
    speak = LANGUAGE_NAMES.get(lang, "Uzbek (Latin script)")
    lines = [
        f"You are {agent.get('name') or 'the agent'}, a voice assistant on a live phone call. Speak {speak} only,",
        "unless the person clearly speaks another language: then answer in theirs.",
        "Talk like a person on the phone: one or two short sentences per turn, warm and calm, numbers in words.",
        persona,
        "",
        f"THIS CALL: you are calling {name}.",
        # As the cascade's prompt (app/llm/prompts.py): the company's greeting gives the name and the company.
        (
            f'Your greeting, set by the company: "{greeting}" — take your name and company from it, but say it in '
            f"natural {speak}, and remember you are the one calling."
        )
        if greeting
        else "",
        # The cascade's AGENT INSTRUCTIONS and CALL INSTRUCTIONS blocks (app/llm/prompts.py), same limits.
        f"AGENT INSTRUCTIONS — set by the company, follow them:\n{utf16_slice(instructions, 0, 4000)}"
        if instructions
        else "",
        (
            "CALL INSTRUCTIONS — set by the company, background for you (do not read them out):\n"
            + utf16_slice(notes, 0, 4000)
        )
        if notes
        else "",
        "",
        "RULES — they come before anything else:",
        "1. Your first line: greet them, say your name and which company you call from, and ask",
        f'   "Am I speaking with {name}?" — that one question only. If they say no, apologise,',
        "   say nothing about why you called, and end politely.",
        "2. If they say yes, ask for their year of birth and call check_identity with it. Until it says confirmed,",
        "   do not say what the call is about, and never say any sum.",
        "3. After confirmation, call get_balance and use ONLY its figures. Never work out or invent a sum.",
        "4. When they agree a day to pay, call record_promise, then say back the day it returns, and tell them",
        "   how and where they can pay, as the call instructions say. Asked how or where to pay, answer that first.",
        '   Give it the day as they said it ("30-sanasigacha", "oy oxiri", "kelasi juma"): it works the date out.',
        "   Never ask which month or for an exact date; only if it answers day_not_understood, ask once.",
        "   If they chose to pay in parts, the amount is the first part from get_balance, not the whole debt.",
        "5. Never threaten, never pressure. If they are upset or ask you to stop calling: apologise and do not",
        "   push. Only if check_identity has confirmed them, say in one sentence why you called and how they can",
        "   pay. If it has not (they would not say the year, or it did not match), say nothing about the loan,",
        "   a debt or a payment — only that a colleague will call back — and close politely. Rule 2 comes first.",
        "6. You cannot grant delays, write-offs or reviews. If they ask, show understanding, offer the options in",
        "   the call instructions once (such as paying in parts), and never promise anything they do not offer.",
    ]
    return "\n".join(line for line in lines if line is not None)


@dataclass
class CallFacts:
    """What our code knows and has settled during the call (the model only learns results)."""

    target: dict[str, Any]
    lang: str
    years_said: list[str] = field(default_factory=list)
    confirmed: bool = False
    promise: dict[str, Any] | None = None
    caller_sums: list[int] = field(default_factory=list)

    @property
    def total(self) -> int | None:
        return parse_sum(str(self.target.get("loanAmount") or ""))

    def allowed_sums(self) -> set[int]:
        total = self.total
        allowed = set(self.caller_sums)
        if total:
            allowed |= {total, *(p for k in range(2, 7) for p in split_plan(total, k))}
            allowed |= {total - n for n in self.caller_sums if n < total}
        return allowed


def run_tool(facts: CallFacts, name: str, args: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """One tool call, answered by our code."""
    if name == "check_identity":
        year = str(args.get("birth_year") or "")
        facts.years_said.append(year)
        check = identity_check(str(facts.target.get("birthYear") or ""), facts.years_said)
        facts.confirmed = check.status in ("confirmed", "unchecked")
        if facts.confirmed:
            return {"confirmed": True}
        return {"confirmed": False, "triesLeft": max(0, 2 - check.wrong_tries), "status": check.status}
    if name == "get_balance":
        if not facts.confirmed:
            return {"error": "identity_not_confirmed"}
        total = facts.total
        loan = str(facts.target.get("loanAmount") or "")
        return {"owes": loan, "split": [line.strip() for line in plan_lines(facts.target)[1:]], "total": total}
    if name == "record_promise":
        if not facts.confirmed:
            return {"saved": False, "reason": "identity_not_confirmed"}
        said = str(args.get("day") or "")
        day = named_day(said, now=now)
        if day is None:
            try:
                d = datetime.fromisoformat(said).date()
                day = {"date": d.isoformat(), "label": d.isoformat(), "say": {facts.lang: d.isoformat()}}
            except ValueError:
                return {"saved": False, "reason": "day_not_understood"}
        today = (now or datetime.now(UTC)).astimezone(ZoneInfo("Asia/Tashkent")).date()
        due = datetime.fromisoformat(day["date"]).date()
        if not today <= due <= today + timedelta(days=90):
            return {"saved": False, "reason": "day_out_of_range"}
        total = facts.total
        amount = args.get("amount")
        amount = int(amount) if isinstance(amount, int | float) and amount > 0 else total
        if total and amount and amount > total:
            amount = total
        facts.promise = {
            "date": day["date"],
            "label": day["label"],
            "amount": amount,
            "amountText": say_sum(amount) if amount else None,
        }
        return {"saved": True, "sayDay": day["say"].get(facts.lang) or day["label"], "amount": amount}
    return {"error": "unknown_tool"}


# The loan, a debt or a payment, in Uzbek (Latin, with any apostrophe) and Russian: words the agent may not say
# before the identity check (the greeting may name the bank).
LOAN_TOPIC = re.compile(
    r"(?i)\b(kredit|qarz|to[‘’ʻ'`]?lov|muddat[i]? o[‘’ʻ'`]?tgan|кредит|долг|задолженн|плат[её]ж|оплат|просроч)"
)


def guard(facts: CallFacts, agent_line: str) -> list[str]:
    """The text guardrail on one agent line: what it said that it should not have."""
    flags = []
    sums = sums_in(agent_line)
    if sums and not facts.confirmed:
        flags.append("sum_before_identity")
    elif not facts.confirmed and LOAN_TOPIC.search(agent_line):
        flags.append("topic_before_identity")  # why we call is private until the person is confirmed
    bad = [n for n in sums if n not in facts.allowed_sums()]
    if bad:
        flags.append("sum_not_given:" + ",".join(str(n) for n in bad))
    return flags


def whole_sentences(line: str) -> str:
    """The line up to its last finished sentence (an interrupted turn's tail may stop mid-word)."""
    ends = [line.rfind(mark) for mark in ".!?…"]
    return line[: max(ends) + 1] if max(ends) >= 0 else ""


Send = Callable[[dict[str, Any] | bytes], Awaitable[None]]


class NativeSession:
    """One call: the Gemini Live connection, the facts, the turns written to the call."""

    def __init__(self, tenant_id: str, call_id: str, agent: dict[str, Any], lang: str, *, audio: bool = True) -> None:
        self.tenant_id, self.call_id, self.agent, self.lang, self.audio = tenant_id, call_id, agent, lang, audio
        self.facts = CallFacts(agent_target(agent), lang)
        self.ws: Any = None
        self.reader: asyncio.Task | None = None
        self.ordinal = 0
        self.caller_text = ""
        self.agent_text = ""
        self.turn_started: float | None = None
        self.first_out: float | None = None
        # This model turn called a tool: its answer went back, so the model speaks again ("more" to come).
        self.tool_called = False
        # The caller talked over this turn: its last sentence may be cut off mid-word.
        self.cut = False

    async def open(self, send: Send) -> None:
        key = js_trim(env("GEMINI_API_KEY"))
        if not key:
            raise RuntimeError("gemini_not_configured")
        target = live_url()
        self.ws = await websockets.connect(
            target,
            additional_headers={"x-goog-api-key": key},
            ssl=httpx.create_ssl_context() if target.startswith("wss:") else None,
            max_size=None,
            open_timeout=CONNECT_TIMEOUT_S,
        )
        config: dict[str, Any] = {"responseModalities": ["AUDIO" if self.audio else "TEXT"]}
        if self.audio:
            config["speechConfig"] = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}}
        setup: dict[str, Any] = {
            "model": f"models/{native_model()}",
            "generationConfig": config,
            "systemInstruction": {"parts": [{"text": instruction(self.agent, self.lang)}]},
            "tools": TOOLS,
        }
        if self.audio:
            setup["inputAudioTranscription"] = {}
            setup["outputAudioTranscription"] = {}
        await self.ws.send(json.dumps({"setup": setup}))
        first = json.loads(await asyncio.wait_for(self.ws.recv(), CONNECT_TIMEOUT_S))
        if "setupComplete" not in first:
            raise RuntimeError(f"native_setup: {str(first)[:200]}")
        self.reader = asyncio.create_task(self._read(send))
        # The agent places the call: it speaks first.
        await self.say_text("[The call has just connected. Greet the person and start, following the rules.]")

    async def feed_audio(self, pcm16k: bytes) -> None:
        if self.ws is None:
            return
        if self.turn_started is None:
            self.turn_started = time.perf_counter()
        b64 = base64.b64encode(pcm16k).decode()
        await self.ws.send(json.dumps({"realtimeInput": {"audio": {"data": b64, "mimeType": "audio/pcm;rate=16000"}}}))

    async def say_text(self, text: str, *, caller: bool = False) -> None:
        """A typed line (tests, the pilot's text box): as if the caller said it."""
        if caller:
            self.caller_text = text
            self.facts.caller_sums += sums_in(text)
        self.turn_started = time.perf_counter()
        self.first_out = None
        await self.ws.send(
            json.dumps(
                {"clientContent": {"turns": [{"role": "user", "parts": [{"text": text}]}], "turnComplete": True}}
            )
        )

    async def close(self) -> None:
        if self.reader is not None:
            self.reader.cancel()
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()

    async def _read(self, send: Send) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "toolCall" in msg:
                    await self._tools(msg["toolCall"], send)
                content = msg.get("serverContent") or {}
                if content.get("inputTranscription", {}).get("text"):
                    piece = content["inputTranscription"]["text"]
                    self.caller_text += piece
                    await send({"t": "caller", "text": self.caller_text})
                for part in (content.get("modelTurn") or {}).get("parts", []):
                    if self.first_out is None and self.turn_started is not None:
                        self.first_out = time.perf_counter()
                    data = (part.get("inlineData") or {}).get("data")
                    if data:
                        await send(base64.b64decode(data))
                    # Spoken replies: the agent's words are the transcript of what was said (below); a text
                    # part next to the voice can repeat or reword it. Thoughts are never the agent's words.
                    if part.get("text") and not part.get("thought") and not self.audio:
                        self.agent_text += part["text"]
                        await send({"t": "agent", "text": self.agent_text})
                if content.get("outputTranscription", {}).get("text"):
                    self.agent_text += content["outputTranscription"]["text"]
                    await send({"t": "agent", "text": self.agent_text})
                if content.get("interrupted"):
                    self.cut = True
                    await send({"t": "interrupted"})
                if content.get("turnComplete"):
                    await self._turn_done(send)
        except websockets.ConnectionClosed as err:
            await send({"t": "closed", "reason": (err.rcvd.reason if err.rcvd else "")[:200]})
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log.warning("[native] read failed: %s", err, exc_info=True)
            await send({"t": "error", "code": "native"})

    async def _tools(self, call: dict[str, Any], send: Send) -> None:
        self.tool_called = True
        responses = []
        for fc in call.get("functionCalls", []):
            result = run_tool(self.facts, fc.get("name", ""), fc.get("args") or {})
            responses.append({"id": fc.get("id"), "name": fc.get("name"), "response": result})
            await send({"t": "tool", "name": fc.get("name"), "args": fc.get("args") or {}, "result": result})
            if fc.get("name") == "record_promise" and result.get("saved"):
                await send({"t": "promise", "promise": self.facts.promise})
        await self.ws.send(json.dumps({"toolResponse": {"functionResponses": responses}}))

    async def _turn_done(self, send: Send) -> None:
        # Take the turn and start the next one before anything awaits: the caller may already be talking.
        caller, agent_line = js_trim(self.caller_text), js_trim(self.agent_text)
        started, first = self.turn_started, self.first_out
        more, cut = self.tool_called, self.cut
        self.caller_text = self.agent_text = ""
        self.turn_started = self.first_out = None
        self.tool_called = self.cut = False
        self.facts.caller_sums += [n for n in sums_in(caller) if n not in self.facts.caller_sums]
        # A line cut off mid-number ("yetti million sakkiz…") is not a wrong sum: only whole sentences are checked.
        checked = whole_sentences(agent_line) if cut else agent_line
        flags = guard(self.facts, checked) if checked else []
        first_ms = round((first - started) * 1000) if first and started else None
        event = {"t": "turn", "caller": caller, "agent": agent_line, "flags": flags, "firstMs": first_ms}
        await send({**event, "more": more, "cut": cut})
        await asyncio.to_thread(self._save, caller, agent_line, flags, first_ms, cut)

    def _save(self, caller: str, agent_line: str, flags: list[str], first_ms: int | None, cut: bool = False) -> None:
        stamp = now_iso()
        timings: dict[str, Any] = {"native": 1, "firstMs": first_ms, "flags": flags}
        if cut:
            timings["cut"] = 1
        if self.facts.promise:
            timings["promise"] = self.facts.promise
        with db.transaction() as tx:
            for role, text in (("caller", caller), ("agent", agent_line)):
                if not text:
                    continue
                db.execute(
                    tx,
                    """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, confidence,
                         citations_json, timings_json, latency_ms, created_at)
                       VALUES (:id, :t, :call, :ord, :role, :text, :lang, NULL, '[]', :tim, :lat, :at)""",
                    id=new_id("trn"),
                    t=self.tenant_id,
                    call=self.call_id,
                    ord=self.ordinal,
                    role=role,
                    text=text,
                    lang=self.lang,
                    tim=js_json(timings) if role == "agent" else "{}",
                    lat=first_ms if role == "agent" else None,
                    at=stamp,
                )
                self.ordinal += 1
            db.execute(tx, "UPDATE calls SET turns = turns + 1 WHERE id = :id", id=self.call_id)
