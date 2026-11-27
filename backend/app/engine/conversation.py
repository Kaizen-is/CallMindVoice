"""
The turn engine — port of src/lib/engine/conversation.ts.

One caller utterance in → one spoken reply out, plus every side effect on the
way: retrieval, generation, escalation decisioning, transcript persistence,
latency instrumentation and knowledge-gap capture. The phone path and the
Playground both call this, so the Playground is a true rehearsal of a call.
"""

import asyncio
import contextlib
import dataclasses
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from app import db
from app.engine.bus import publish
from app.engine.live_turn import in_playground, is_small_talk, last_facts, remember_facts, smart_search_on
from app.ids import new_id, now_iso
from app.jscompat import js_fixed_number, js_json, js_round, js_trim, utf16_len, utf16_slice
from app.llm.choice import agent_llm, safe_json
from app.llm.goal_call import agent_goal
from app.llm.loan_plan import promise_from_turn
from app.llm.local import classify_intent
from app.llm.prompts import GenerateInput
from app.llm.provider import engine_name, generate_answer, sentiment_of, summarize_call
from app.rag.library import knowledge_tenant
from app.rag.retrieve import RetrievalResult, retrieve_async
from app.rag.routing import has_grouped_knowledge, retrieve_routed
from app.rag.text import detect_language, stems
from app.webhooks import dispatch_webhook

if TYPE_CHECKING:
    from app.engine.early import EarlyAnswer

DEFAULT_ESCALATION = {
    "onLowConfidence": True,
    "onExplicitRequest": True,
    "onNegativeSentiment": True,
    "onRepeatedFailure": True,
    "maxFailedTurns": 2,
    "afterHoursAction": "answer_anyway",
    "ringTimeoutSec": 30,
    "fallbackNumber": "",
}

DEFAULT_HOURS = {
    "enabled": False,
    "timezone": "Asia/Tashkent",
    "days": {
        "1": {"open": "09:00", "close": "18:00", "closed": False},
        "2": {"open": "09:00", "close": "18:00", "closed": False},
        "3": {"open": "09:00", "close": "18:00", "closed": False},
        "4": {"open": "09:00", "close": "18:00", "closed": False},
        "5": {"open": "09:00", "close": "18:00", "closed": False},
        "6": {"open": "10:00", "close": "15:00", "closed": False},
        "0": {"open": "00:00", "close": "00:00", "closed": True},
    },
}

EMPTY_TARGET = {"fullName": "", "birthYear": "", "loanAmount": "", "prompt": ""}


def _obj(raw: str | None) -> dict[str, Any]:
    value = safe_json(raw, {})
    return value if isinstance(value, dict) else {}


def agent_escalation(agent: dict[str, Any]) -> dict[str, Any]:
    return {**DEFAULT_ESCALATION, **_obj(agent.get("escalation_json"))}


def agent_target(agent: dict[str, Any]) -> dict[str, Any]:
    return {**EMPTY_TARGET, **_obj(agent.get("target_json"))}


def agent_hours(agent: dict[str, Any]) -> dict[str, Any]:
    parsed = _obj(agent.get("hours_json"))
    days = parsed.get("days") if isinstance(parsed.get("days"), dict) else {}
    return {**DEFAULT_HOURS, **parsed, "days": {**DEFAULT_HOURS["days"], **days}}


def is_within_hours(hours: dict[str, Any], at: datetime | None = None) -> bool:
    """On the tenant's wall clock, not the server's."""
    if not hours.get("enabled"):
        return True
    local = (at or datetime.now(UTC)).astimezone(ZoneInfo(hours.get("timezone") or "Asia/Tashkent"))
    day_index = (local.weekday() + 1) % 7  # Sunday = 0, as in JavaScript
    spec = hours["days"].get(str(day_index))
    if not spec or spec.get("closed"):
        return False
    minutes = local.hour * 60 + local.minute
    oh, om = (int(x) for x in spec["open"].split(":"))
    ch, cm = (int(x) for x in spec["close"].split(":"))
    return oh * 60 + om <= minutes < ch * 60 + cm


def _to_citations(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "chunkId": h["chunkId"],
            "documentId": h["documentId"],
            "documentTitle": h["documentTitle"],
            "heading": h["heading"],
            "snippet": h["snippet"],
            "score": js_fixed_number(h["score"], 3),
        }
        for h in hits
    ]


def _record_gap(tx, tenant_id: str, question: str, score: float) -> None:  # noqa: ANN001
    normalized = utf16_slice(js_trim(question), 0, 300)
    if utf16_len(normalized) < 6:
        return
    existing = db.fetch_one(
        tx,
        "SELECT id, hits FROM knowledge_gaps WHERE tenant_id = :t AND lower(question) = lower(:q)",
        t=tenant_id,
        q=normalized,
    )
    if existing:
        db.execute(
            tx,
            """UPDATE knowledge_gaps SET hits = :hits, best_score = MAX(best_score, :score), last_seen = :now
               WHERE id = :id""",
            hits=existing["hits"] + 1,
            score=score,
            now=now_iso(),
            id=existing["id"],
        )
    else:
        stamp = now_iso()
        db.execute(
            tx,
            """INSERT INTO knowledge_gaps (id, tenant_id, question, hits, best_score, status, last_seen, created_at)
               VALUES (:id, :t, :q, 1, :score, 'open', :now, :now2)""",
            id=new_id("gap"),
            t=tenant_id,
            q=normalized,
            score=score,
            now=stamp,
            now2=now_iso(),
        )


Context = Callable[[list[str]], "str | dict[str, str] | None"]


def _lookup_for(context: Context | None, caller_lines: list[str]) -> dict[str, str | None]:
    out = context(caller_lines) if context else None
    if not out:
        return {}
    if isinstance(out, str):
        return {"extra_system": out}
    return {"extra_system": out.get("facts"), "extra_note": out.get("note")}


def _names_its_subject(question: str, hit: dict[str, Any]) -> bool:
    """Whether the question shares a word with the found page's title or place on the site (its subject)."""

    def words(text: str) -> set[str]:
        # Real words only: concept tags ("~payment") join "muddat" and "karta" and would name every page.
        return {s for s in stems(text) if not s.startswith("~")}

    return bool(words(question) & words(f"{hit.get('documentTitle') or ''} {hit.get('heading') or ''}"))


def _ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000


def read_call(tenant_id: str, call_id: str) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """The call's row and its transcript so far (every role, in order)."""
    with db.connect() as conn:
        call = db.fetch_one(conn, "SELECT * FROM calls WHERE id = :id AND tenant_id = :t", id=call_id, t=tenant_id)
        history = [
            {"role": t["role"], "text": t["text"]}
            for t in db.fetch_all(
                conn, "SELECT role, text FROM turns WHERE call_id = :id ORDER BY ordinal ASC", id=call_id
            )
        ]
    return call, history


def dialogue(history: list[dict[str, str]]) -> list[dict[str, str]]:
    """System bookkeeping turns (e.g. __unanswered__) are not dialogue: never shown to the model."""
    return [t for t in history if t["role"] in ("caller", "agent")]


@dataclass
class ReplyPlan:
    """What one reply is generated from: the knowledge-base lookup and the model's whole input."""

    retrieval: RetrievalResult
    retrieval_ms: float
    generate: GenerateInput


def _recent_caller_lines(model_history: list[dict[str, str]]) -> list[str]:
    return [js_trim(t["text"]) for t in model_history if t["role"] == "caller"][-2:]


async def plan_reply(
    *,
    tenant_id: str,
    agent: dict[str, Any],
    utterance: str,
    model_history: list[dict[str, str]],
    target: dict[str, Any],
    context: Context | None = None,
    stream_llm: bool | None = None,
    call_id: str | None = None,
) -> ReplyPlan:
    """
    Everything the model's answer depends on, read before it is written. A function of these
    arguments, the knowledge base and the call's remembered topic (grouped knowledge: app.rag.routing,
    keyed by `call_id`): the early start (app/engine/early.py) runs it ahead of the turn. An early start
    that is then discarded may have updated that topic from the same caller's phrase.
    """
    language = detect_language(utterance)
    threshold = agent["confidence_threshold"] if agent.get("confidence_threshold") is not None else 0.55

    # retrieval — in the agent's knowledge base (its own company's, or a shared library: app.rag.library);
    # grouped (app.rag.routing) where the pages came from a website import, else the plain search
    with db.connect() as conn:
        kb_tenant = knowledge_tenant(conn, agent, tenant_id)
        routed = has_grouped_knowledge(conn, kb_tenant)

    async def search(query: str) -> Any:
        if routed:
            return await retrieve_routed(
                kb_tenant, query, language=language, threshold=threshold, call_id=call_id, top_k=5
            )
        return await retrieve_async(kb_tenant, query, top_k=5)

    t_retrieve = time.perf_counter()
    # Q3 (Playground turns, app.engine.live_turn): a phrase with no question in it skips the search, and
    # a follow-up's two searches run side by side instead of one after the other.
    smart = smart_search_on()
    if smart and is_small_talk(utterance):
        # "ha", "rahmat", "xo'p"…: nothing to look up. The facts of the call's last search stay in front of
        # the model, since an "ha" often accepts what those facts offered ("kurslarni aytaymi?" → "ha").
        previous = last_facts(call_id)
        retrieval = (
            dataclasses.replace(previous, took_ms=0.0, strategy=f"reused:{previous.strategy}")
            if previous is not None
            else RetrievalResult(hits=[], confidence=0.0, took_ms=0.0, strategy="skipped:small_talk", total_chunks=0)
        )
    elif routed and model_history:
        # Grouped search (Python only): a follow-up ("Uning foizi qancha?", "o'rtada yechib olsam bo'ladimi?")
        # rarely names its subject, and a generic page can match the bare words confidently — the retry below
        # then never runs and the answer comes from the wrong page. So the bare question and the question in
        # context (the caller's last lines and the agent's last answer, which names the product) are searched
        # side by side. If the bare question names the page it found ("Humo kartasini…" → "Humo"), it stands
        # on its own (a change of topic); otherwise it is a follow-up and the search in context is used.
        # (Comparing confidences does not work: a longer query lowers every page's coverage.)
        recent = [js_trim(t["text"]) for t in model_history if t["role"] == "caller"][-2:]
        last_reply = next((t["text"] for t in reversed(model_history) if t["role"] == "agent"), "")
        context_query = "\n".join([*(t for t in recent if t), utf16_slice(last_reply, 0, 300), utterance])
        bare, in_context = await asyncio.gather(search(utterance), search(context_query))
        if bare.hits and _names_its_subject(utterance, bare.hits[0]):
            retrieval = bare
        else:
            retrieval = in_context if in_context.hits else bare
    elif smart and model_history and (recent := [t for t in _recent_caller_lines(model_history) if t]):
        # The follow-up below, searched at the same time as the bare question rather than after it.
        bare, contextual = await asyncio.gather(search(utterance), search("\n".join([*recent, utterance])))
        retrieval = contextual if bare.confidence < threshold and contextual.confidence > bare.confidence else bare
    else:
        retrieval = await search(utterance)
    if smart:
        remember_facts(call_id, retrieval)
    # Short follow-ups ("dam olish kunlari-chi?") may not repeat the subject: if the lookup is weak,
    # retry once with the two most recent caller turns and keep the more confident one.
    if not smart and not routed and model_history and retrieval.confidence < threshold:
        recent = [js_trim(t["text"]) for t in model_history if t["role"] == "caller"][-2:]
        recent = [t for t in recent if t]
        if recent:
            contextual = await search("\n".join([*recent, utterance]))
            if contextual.confidence > retrieval.confidence:
                retrieval = contextual
    retrieval_ms = _ms(t_retrieve)

    # generation
    goal = agent_goal(agent)
    caller_lines = [*(t["text"] for t in model_history if t["role"] == "caller"), utterance]
    return ReplyPlan(
        retrieval=retrieval,
        retrieval_ms=retrieval_ms,
        generate=GenerateInput(
            question=utterance,
            hits=retrieval.hits,
            confidence=retrieval.confidence,
            language=language,
            agent_name=agent["name"],
            threshold=threshold,
            history=model_history,
            persona=agent.get("persona"),
            instructions=agent.get("instructions"),
            target=target,
            greeting=agent.get("greeting"),
            time_zone=agent_hours(agent)["timezone"],
            llm=agent_llm(agent),
            stream=stream_llm,
            goal=goal,
            **_lookup_for(context, caller_lines),
        ),
    )


async def _until_stopped(work: Any, stop: asyncio.Event | None) -> Any:
    """`work`'s result, or None when `stop` is set first (the work is then cancelled)."""
    if stop is None:
        return await work
    task = asyncio.ensure_future(work)
    waiter = asyncio.ensure_future(stop.wait())
    try:
        done, _ = await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        waiter.cancel()
    if task in done:
        return task.result()
    task.cancel()
    with contextlib.suppress(BaseException):
        await task
    return None


async def run_turn(
    *,
    tenant_id: str,
    call_id: str,
    agent: dict[str, Any],
    utterance: str,
    stt_ms: float | None = None,
    persist: bool = True,
    target: dict[str, Any] | None = None,
    context: Context | None = None,
    on_delta: Callable[[str], None] | None = None,
    stream_llm: bool | None = None,
    early: "EarlyAnswer | None" = None,
    stop: asyncio.Event | None = None,
) -> dict[str, Any]:
    """
    One turn. Returns the TurnResult shape of conversation.ts (camelCase keys).

    `stop` (Playground, Q7): set when the caller talks over the reply. The model stops writing at once
    and the turn is written down with what it had written; the Playground then cuts it to what was heard.

    `early`: an answer the Playground started while the caller paused (app/engine/early.py). It is
    used only when it was started from exactly this turn's input — the same words, transcript so
    far, agent and target — so the reply is the one this turn would have written; otherwise it is
    cancelled and the reply is written here as usual.
    """
    t0 = time.perf_counter()
    call, history = read_call(tenant_id, call_id)
    model_history = dialogue(history)

    language = detect_language(utterance)
    policy = agent_escalation(agent)
    target = target if target is not None else agent_target(agent)
    goal = agent_goal(agent)

    # retrieval and generation
    written = [""]  # what the model wrote so far (a turn stopped mid-answer keeps it)

    def relay(delta: str) -> None:
        written[0] += delta
        on_delta(delta)  # type: ignore[misc]

    t_gen = time.perf_counter()
    stopped = False
    adopting = (
        early is not None and context is None and early.matches(utterance, model_history, agent, target, stream_llm)
    )
    if adopting:
        adopted = await _until_stopped(early.adopt(relay if on_delta else None), stop)  # type: ignore[union-attr]
        if adopted is None:
            stopped = True
            plan = early.plan  # type: ignore[union-attr]
        else:
            plan, generated, llm_ms = adopted
    else:
        if early is not None:
            early.cancel()
        plan = None
    if plan is None:
        plan = await plan_reply(
            tenant_id=tenant_id,
            agent=agent,
            utterance=utterance,
            model_history=model_history,
            target=target,
            context=context,
            stream_llm=stream_llm,
            call_id=call_id,
        )
    if not adopting:
        t_gen = time.perf_counter()
        answer = await _until_stopped(generate_answer(plan.generate, relay if on_delta else None), stop)
        if answer is None:
            stopped = True
        else:
            generated = answer
            llm_ms = _ms(t_gen)
    if stopped:
        # Talked over: the answer is what had been written when the caller cut in, without a last word
        # the model may have been in the middle of ("…besh mil").
        llm_ms = _ms(t_gen)
        so_far = written[0]
        if so_far and not so_far[-1].isspace() and so_far[-1] not in ".!?,;:…»)\"'":
            so_far = so_far.rsplit(None, 1)[0] if len(so_far.split()) > 1 else ""
        generated = {
            "answer": js_trim(so_far),
            "intent": classify_intent(utterance),
            "answered": True,
            "usedHits": [],
            "engine": engine_name(agent_llm(agent)),
        }
    retrieval, retrieval_ms = plan.retrieval, plan.retrieval_ms

    # escalation decisioning
    sentiment = sentiment_of(utterance)
    failed_before = sum(1 for h in history if h["role"] == "system" and h["text"] == "__unanswered__")
    is_loan_call = bool(target.get("fullName"))
    # A goal-led call (Python only) is the agent's own outbound call, like the loan call: no live transfer,
    # and a question the knowledge base cannot answer is promised to a specialist, not handed to the inbox.
    is_goal_call = goal is not None and not is_loan_call
    no_transfer = is_loan_call or is_goal_call

    escalate: str | None = None
    # A loan call has no live transfer: the agent says a colleague will call back and keeps going.
    if policy["onExplicitRequest"] and generated["intent"] == "human" and not no_transfer:
        escalate = "explicit_request"
    elif policy["onLowConfidence"] and not generated["answered"] and not is_goal_call:
        escalate = "low_confidence"
    # On a loan call, "I have money problems" is the expected answer, not a reason to pull the person away.
    elif policy["onNegativeSentiment"] and sentiment <= -0.5 and not no_transfer:
        escalate = "negative_sentiment"
    elif (
        policy["onRepeatedFailure"]
        and not generated["answered"]
        and failed_before + 1 >= policy["maxFailedTurns"]
        and not is_goal_call
    ):
        escalate = "repeated_failure"
    elif (
        policy["afterHoursAction"] != "answer_anyway"
        and not is_within_hours(agent_hours(agent))
        and generated["intent"] != "goodbye"
    ):
        escalate = "after_hours"
    # The turn cap protects phone lines; a typed web chat may run as long as the user likes.
    elif call and call["channel"] != "web" and call["turns"] >= agent["max_turns"]:
        escalate = "max_turns"

    # TTS time is measured on the client for browser calls; modelled from the length for telephony.
    tts_ms = js_round(40 + utf16_len(generated["answer"]) * 1.15)
    timings = {
        "sttMs": js_round(stt_ms or 0),
        "retrievalMs": js_round(retrieval_ms),
        "llmMs": js_round(llm_ms),
        "ttsMs": tts_ms,
        "totalMs": js_round(_ms(t0) + (stt_ms or 0) + tts_ms),
    }

    citations = _to_citations(generated["usedHits"] if generated["usedHits"] else retrieval.hits[:2])
    ordinal = len(history)

    if persist:
        stamp = now_iso()

        def save() -> None:
            with db.transaction() as tx:
                db.execute(
                    tx,
                    """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, confidence,
                         citations_json, timings_json, latency_ms, created_at)
                       VALUES (:id, :t, :call, :ord, 'caller', :text, :lang, NULL, '[]', '{}', NULL, :at)""",
                    id=new_id("trn"),
                    t=tenant_id,
                    call=call_id,
                    ord=ordinal,
                    text=utterance,
                    lang=language,
                    at=stamp,
                )
                db.execute(
                    tx,
                    """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, language, confidence,
                         citations_json, timings_json, latency_ms, created_at)
                       VALUES (:id, :t, :call, :ord, 'agent', :text, :lang, :conf, :cit, :tim, :lat, :at)""",
                    id=new_id("trn"),
                    t=tenant_id,
                    call=call_id,
                    ord=ordinal + 1,
                    text=generated["answer"],
                    lang=language,
                    conf=retrieval.confidence,
                    cit=js_json(citations),
                    tim=js_json(timings),
                    lat=timings["totalMs"],
                    at=stamp,
                )
                if not generated["answered"]:
                    db.execute(
                        tx,
                        """INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, created_at)
                           VALUES (:id, :t, :call, :ord, 'system', '__unanswered__', :at)""",
                        id=new_id("trn"),
                        t=tenant_id,
                        call=call_id,
                        ord=ordinal + 2,
                        at=stamp,
                    )
                    _record_gap(tx, tenant_id, utterance, retrieval.confidence)
                # The call's headline intent is the first substantive one (not greeting / goodbye / affirm).
                substantive = generated["intent"] not in ("greeting", "goodbye", "affirm")
                db.execute(
                    tx,
                    """UPDATE calls SET turns = turns + 1, language = :lang,
                         intent = CASE WHEN :subst = 1 AND (intent IS NULL OR intent IN ('greeting','goodbye','affirm'))
                                       THEN :intent ELSE COALESCE(intent, :intent2) END,
                         confidence = :conf, sentiment = :sent, first_response_ms = COALESCE(first_response_ms, :frm),
                         status = CASE WHEN status = 'ringing' THEN 'active' ELSE status END,
                         answered_at = COALESCE(answered_at, :at)
                       WHERE id = :id""",
                    lang=language,
                    subst=1 if substantive else 0,
                    intent=generated["intent"],
                    intent2=generated["intent"],
                    conf=retrieval.confidence,
                    sent=sentiment,
                    frm=timings["totalMs"],
                    at=stamp,
                    id=call_id,
                )

        # L7, in the Playground: the SQLite commit runs off the event loop; on it, every other call on the
        # server waited. Elsewhere it stays in line, as the TypeScript ran it (the event order is pinned).
        if in_playground():
            await asyncio.to_thread(save)
        else:
            save()

    summary: str | None = None
    if escalate and persist:
        transcript = [*history, {"role": "caller", "text": utterance}]
        summary = await summarize_call(transcript, language, escalate, agent_llm(agent))
        escalate_call(tenant_id, call_id, escalate, summary, sentiment)
        dispatch_webhook(tenant_id, "call.escalated", {"callId": call_id, "reason": escalate, "summary": summary})

    publish(
        tenant_id,
        {
            "type": "turn",
            "callId": call_id,
            "reply": generated["answer"],
            "utterance": utterance,
            "confidence": retrieval.confidence,
            "escalated": bool(escalate),
            "latencyMs": timings["totalMs"],
        },
    )

    result: dict[str, Any] = {
        "callId": call_id,
        "reply": generated["answer"],
        "language": language,
        "intent": generated["intent"],
        "confidence": retrieval.confidence,
        "answered": generated["answered"],
        "citations": citations,
        "timings": timings,
        "escalate": escalate,
    }
    if summary is not None:
        result["summary"] = summary
    result.update(
        {
            "turnOrdinal": ordinal,
            "engine": generated["engine"] or engine_name(agent_llm(agent)),
            "retrievalDebug": {
                "strategy": retrieval.strategy,
                "totalChunks": retrieval.total_chunks,
                "hits": [
                    {
                        "title": h["documentTitle"],
                        "heading": h["heading"],
                        "score": js_fixed_number(h["score"], 3),
                        "lexical": js_fixed_number(h["lexicalScore"], 3),
                        "dense": js_fixed_number(h["denseScore"], 3),
                    }
                    for h in retrieval.hits
                ],
            },
        }
    )
    if retrieval.extra.get("routing"):  # grouped search only: which shelf was searched, and why
        result["retrievalDebug"]["routing"] = retrieval.extra["routing"]
    if is_loan_call and in_playground():
        # L6: a day the caller named and the reply said back is a promise to pay, written down as data.
        caller_said = [*(h["text"] for h in history if h["role"] == "caller"), utterance]
        promise = promise_from_turn(target, caller_said, generated["answer"])
        if promise is not None:
            result["promise"] = promise
    return result


# ── escalation ──────────────────────────────────────────────────────


def escalate_call(tenant_id: str, call_id: str, reason: str, summary: str, sentiment: float = 0) -> str:
    with db.connect() as conn:
        existing = db.fetch_one(
            conn, "SELECT id FROM escalations WHERE call_id = :c AND status IN ('waiting','assigned')", c=call_id
        )
    if existing:
        return existing["id"]
    priority = (
        "urgent"
        if reason == "negative_sentiment" or sentiment <= -0.5
        else "high"
        if reason == "explicit_request"
        else "normal"
    )
    esc_id = new_id("esc")
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO escalations (id, tenant_id, call_id, reason, priority, status, summary, created_at)
               VALUES (:id, :t, :c, :reason, :priority, 'waiting', :summary, :now)""",
            id=esc_id,
            t=tenant_id,
            c=call_id,
            reason=reason,
            priority=priority,
            summary=summary,
            now=now_iso(),
        )
        db.execute(
            tx,
            "UPDATE calls SET status='escalating', escalated=1, escalation_reason=:r, summary=:s WHERE id=:id",
            r=reason,
            s=summary,
            id=call_id,
        )
    publish(
        tenant_id,
        {"type": "escalation", "callId": call_id, "escalationId": esc_id, "reason": reason, "priority": priority},
    )
    return esc_id


def _ms_since_iso(iso: str) -> int:
    from app.ids import parse_iso

    return int((datetime.now(UTC) - parse_iso(iso)).total_seconds() * 1000)


def assign_escalation(tenant_id: str, escalation_id: str, operator_id: str) -> str | None:
    with db.connect() as conn:
        esc = db.fetch_one(
            conn,
            "SELECT id, call_id, created_at, status FROM escalations WHERE id = :id AND tenant_id = :t",
            id=escalation_id,
            t=tenant_id,
        )
    if not esc or esc["status"] != "waiting":
        return None
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE escalations SET status='assigned', operator_id=:op, assigned_at=:now, waited_ms=:w WHERE id=:id",
            op=operator_id,
            now=now_iso(),
            w=_ms_since_iso(esc["created_at"]),
            id=escalation_id,
        )
        db.execute(
            tx,
            "UPDATE calls SET status='with_operator', operator_id=:op WHERE id=:id",
            op=operator_id,
            id=esc["call_id"],
        )
    publish(
        tenant_id,
        {
            "type": "escalation_assigned",
            "escalationId": escalation_id,
            "callId": esc["call_id"],
            "operatorId": operator_id,
        },
    )
    return esc["call_id"]


def resolve_escalation(tenant_id: str, escalation_id: str, resolution: str, notes: str = "") -> str | None:
    with db.connect() as conn:
        esc = db.fetch_one(
            conn,
            "SELECT call_id, assigned_at, created_at FROM escalations WHERE id = :id AND tenant_id = :t",
            id=escalation_id,
            t=tenant_id,
        )
    if not esc:
        return None
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE escalations SET status='resolved', resolution=:r, notes=:n, resolved_at=:now, handled_ms=:h
               WHERE id=:id""",
            r=resolution,
            n=notes,
            now=now_iso(),
            h=_ms_since_iso(esc["assigned_at"] or esc["created_at"]),
            id=escalation_id,
        )
    publish(tenant_id, {"type": "escalation_resolved", "escalationId": escalation_id, "callId": esc["call_id"]})
    return esc["call_id"]
