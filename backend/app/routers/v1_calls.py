"""
The public REST API's call list and grounded answers — ports of src/app/api/v1/calls/route.ts and
src/app/api/v1/answer/route.ts. Authenticated by bearer API key (`check_api_key`), not the session
cookie; the site forwards /api/v1/calls and /api/v1/answer here.
"""

import json
import math
import time
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app import db
from app.auth import check_api_key
from app.engine.calls import live_agent
from app.jscompat import js_fixed_number, js_number, js_round, js_trim
from app.llm.choice import agent_llm, tenant_default_llm
from app.llm.prompts import GenerateInput
from app.llm.provider import generate_answer
from app.rag.retrieve import retrieve_async
from app.rag.text import detect_language
from app.views_common import js_response

router = APIRouter()

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
LANGUAGES = ("uz", "ru", "en")


def _authorization(request: Request) -> str | None:
    """`req.headers.get('authorization')`: repeated headers come back joined with ', '."""
    values = request.headers.getlist("authorization")
    return ", ".join(values) if values else None


def _search_param(request: Request, key: str) -> str | None:
    """`URLSearchParams.get`: the first value (Starlette's `.get` would give the last)."""
    values = request.query_params.getlist(key)
    return values[0] if values else None


@router.get("/v1/calls")
async def list_calls(request: Request) -> Response:
    """
    GET /v1/calls (scope: read): the tenant's calls with outcome and latency, newest first.
    `?limit=` (default 50, at most 200), `?outcome=` (exact match), `?from=` (lower bound on the
    start time); `hasMore` says whether another page exists.
    """
    auth = check_api_key(_authorization(request), "read")

    raw = _search_param(request, "limit")
    raw_limit = 0.0 if raw is None else js_number(raw)  # Number(null) is 0
    limit = min(MAX_LIMIT, math.floor(raw_limit)) if math.isfinite(raw_limit) and raw_limit > 0 else DEFAULT_LIMIT

    where = ["tenant_id = :t"]
    args: dict[str, Any] = {"t": auth.tenant_id}
    outcome = _search_param(request, "outcome")
    if outcome:
        where.append("outcome = :outcome")
        args["outcome"] = outcome
    since = _search_param(request, "from")
    if since:
        where.append("started_at >= :since")
        args["since"] = since

    # One extra row decides `hasMore` without a second COUNT query.
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            f"""SELECT id, from_e164, outcome, language, turns, duration_ms, avg_latency_ms, csat
                  FROM calls
                 WHERE {" AND ".join(where)}
                 ORDER BY started_at DESC
                 LIMIT :limit""",  # noqa: S608 - fixed clauses, values are bound
            **args,
            limit=limit + 1,
        )
    data = [
        {
            "id": r["id"],
            "from": r["from_e164"],
            "outcome": r["outcome"],
            "language": r["language"],
            "turns": r["turns"],
            "durationMs": r["duration_ms"],
            "avgLatencyMs": r["avg_latency_ms"],
            "csat": r["csat"],
        }
        for r in rows[:limit]
    ]
    return js_response({"data": data, "hasMore": len(rows) > limit})


def _invalid(message: str) -> Response:
    return js_response({"error": {"type": "invalid_request", "message": message}}, status=400)


def _parse_json(raw: bytes) -> Any:
    """`await req.json()`: UTF-8 (a BOM dropped, bad bytes replaced) and JSON.parse's grammar (no NaN)."""

    def no_constant(name: str) -> Any:
        raise ValueError(name)

    return json.loads(raw.decode("utf-8", errors="replace").removeprefix("﻿"), parse_constant=no_constant)


def _ms_since(started: float) -> int:
    return js_round((time.perf_counter() - started) * 1000)


@router.post("/v1/answer")
async def answer(request: Request) -> Response:
    """
    POST /v1/answer (scope: read): stateless grounded question-answering — the knowledge-base search
    and answer the voice engine uses, without a call being stored.
    """
    auth = check_api_key(_authorization(request), "read")

    try:
        body = _parse_json(await request.body())
    except ValueError:
        return _invalid("Request body must be valid JSON.")
    if body is None:
        # `null.question` throws in the TypeScript: an unhandled error, so a 500.
        raise TypeError("Cannot read properties of null (reading 'question')")
    fields = body if isinstance(body, dict) else {}

    question = js_trim(fields["question"]) if isinstance(fields.get("question"), str) else ""
    if not question:
        return _invalid("`question` is required.")

    language = fields.get("language")
    if not (isinstance(language, str) and language in LANGUAGES):
        language = detect_language(question)

    # The tenant's live agent supplies name, persona, instructions and threshold; without one,
    # neutral defaults rather than an error.
    agent = live_agent(auth.tenant_id)
    threshold = agent["confidence_threshold"] if agent and agent.get("confidence_threshold") is not None else 0.45

    t0 = time.perf_counter()

    t_retrieve = time.perf_counter()
    retrieval = await retrieve_async(auth.tenant_id, question, top_k=5)
    retrieval_ms = _ms_since(t_retrieve)

    t_gen = time.perf_counter()
    generated = await generate_answer(
        GenerateInput(
            question=question,
            hits=retrieval.hits,
            confidence=retrieval.confidence,
            language=language,
            agent_name=agent["name"] if agent and agent.get("name") is not None else "CallMind AI",
            threshold=threshold,
            history=[],
            persona=agent.get("persona") if agent else None,
            instructions=agent.get("instructions") if agent else None,
            llm=agent_llm(agent) if agent else tenant_default_llm(auth.tenant_id),
        )
    )
    llm_ms = _ms_since(t_gen)
    total_ms = _ms_since(t0)

    # Stateless escalation signal: an explicit "human please" or an ungrounded answer — the live
    # engine's two hardest triggers, without call state.
    escalate = (
        "explicit_request"
        if generated["intent"] == "human"
        else "low_confidence"
        if not generated["answered"]
        else None
    )

    source_hits = generated["usedHits"] if generated["usedHits"] else retrieval.hits[:2]
    citations = [
        {"documentTitle": h["documentTitle"], "heading": h["heading"], "score": js_fixed_number(h["score"], 3)}
        for h in source_hits
    ]
    return js_response(
        {
            "answer": generated["answer"],
            "confidence": js_fixed_number(retrieval.confidence, 2),
            "answered": generated["answered"],
            "escalate": escalate,
            "citations": citations,
            "timings": {"retrievalMs": retrieval_ms, "llmMs": llm_ms, "totalMs": total_ms},
        }
    )
