"""
The early start: the agent begins its answer while the caller is still in their pause.

The Playground waits for 0.8 s of quiet before it takes a phrase as finished. At 0.35 s it already
offers the phrase (`/playground/turn?prefetch=1`): the words, settled by the live STT, or the
recording, transcribed then. An EarlyAnswer runs exactly what the turn would run — the knowledge-base
lookup and the LLM (`plan_reply` + `generate_answer`) — with the same agent, the same transcript so
far and the same words, and keeps what the model writes.

When the turn arrives, `run_turn` takes the early answer only if it was started from exactly the
turn's input (`matches`): then the answer is the one the turn would have written, only sooner. If the
caller went on speaking, the words changed, a turn landed in between, or the agent was edited, the
early answer is cancelled and the turn writes its own. The model never sees half a phrase as the
question it answers: every answer that is spoken was generated from the turn's final input.
"""

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

import regex as re

from app.engine.conversation import ReplyPlan, plan_reply
from app.llm.provider import generate_answer

_APOSTROPHES = re.compile(r"[‘’ʻʼ`´]")
_NOT_WORD = re.compile(r"[^\w\s']")


def same_words(text: str) -> str:
    """
    The caller's words as the model reads them: case, punctuation, apostrophe shapes and spacing left
    out, so the words on screen at the pause ("qancha qarzim qoldi") match the settled ones ("Qancha
    qarzim qoldi?") and the early answer begun from them is used (Q5). Different words never match.
    """
    plain = _NOT_WORD.sub(" ", _APOSTROPHES.sub("'", text.lower()))
    return " ".join(plain.split())


def fingerprint(
    utterance: str,
    model_history: list[dict[str, str]],
    agent: dict[str, Any],
    target: dict[str, Any],
    stream_llm: bool | None,
) -> str:
    """Everything the reply is generated from, as one comparable string (the words by `same_words`)."""
    return json.dumps(
        [same_words(utterance), model_history, agent, target, stream_llm],
        sort_keys=True,
        default=str,
        ensure_ascii=False,
    )


class EarlyAnswer:
    """One answer begun ahead of its turn (see the module docstring)."""

    def __init__(
        self,
        *,
        tenant_id: str,
        agent: dict[str, Any],
        utterance: str,
        model_history: list[dict[str, str]],
        target: dict[str, Any],
        stream_llm: bool | None,
        call_id: str | None = None,
    ) -> None:
        self.key = fingerprint(utterance, model_history, agent, target, stream_llm)
        self.started = time.monotonic()
        self.deltas: list[str] = []
        self.listener: Callable[[str], None] | None = None
        self.plan: ReplyPlan | None = None
        self.llm_ms = 0.0
        self.adopted = False
        self.task = asyncio.get_running_loop().create_task(
            self._run(tenant_id, agent, utterance, model_history, target, stream_llm, call_id)
        )
        self.task.add_done_callback(_quiet)

    async def _run(
        self,
        tenant_id: str,
        agent: dict[str, Any],
        utterance: str,
        model_history: list[dict[str, str]],
        target: dict[str, Any],
        stream_llm: bool | None,
        call_id: str | None,
    ) -> dict[str, Any]:
        self.plan = await plan_reply(
            tenant_id=tenant_id,
            agent=agent,
            utterance=utterance,
            model_history=model_history,
            target=target,
            stream_llm=stream_llm,
            call_id=call_id,
        )
        t_gen = time.perf_counter()
        generated = await generate_answer(self.plan.generate, self._delta)
        self.llm_ms = (time.perf_counter() - t_gen) * 1000
        return generated

    def _delta(self, delta: str) -> None:
        self.deltas.append(delta)
        if self.listener is not None:
            self.listener(delta)

    def matches(
        self,
        utterance: str,
        model_history: list[dict[str, str]],
        agent: dict[str, Any],
        target: dict[str, Any],
        stream_llm: bool | None,
    ) -> bool:
        """Whether this answer was started from exactly this input (and has not failed)."""
        if self.task.cancelled() or (self.task.done() and self.task.exception() is not None):
            return False
        return self.key == fingerprint(utterance, model_history, agent, target, stream_llm)

    async def adopt(self, on_delta: Callable[[str], None] | None) -> tuple[ReplyPlan, dict[str, Any], float]:
        """
        The turn takes this answer: what the model wrote so far goes to `on_delta` at once, the rest as
        it comes. Returns the plan, the answer and the model's own time, as the turn would have them.
        """
        self.adopted = True
        if on_delta is not None:
            for delta in self.deltas:  # no await in between: nothing can slip past the hand-over
                on_delta(delta)
            self.listener = on_delta
        generated = await self.task
        assert self.plan is not None
        return self.plan, generated, self.llm_ms

    def cancel(self) -> None:
        if not self.task.done():
            self.task.cancel()


def _quiet(task: asyncio.Task) -> None:
    """A cancelled or failed early answer is simply not used (the turn writes its own)."""
    if not task.cancelled():
        task.exception()
