"""
Answer generation — port of src/lib/llm/provider.ts.

Engines behind one interface: the local extractive synthesiser (always
there), Claude (ANTHROPIC_API_KEY), Gemini (GEMINI_API_KEY), OpenAI
(OPENAI_API_KEY) and Ollama (OLLAMA_BASE_URL). Any failure falls back — first
to the fallback model (Claude Haiku) when the chosen model failed before
saying a word, then to the local engine — so a call never goes silent.

Which model answers: the agent's own choice, else the account default, else
the first engine with a key set (`provider()`); a choice whose key is missing
on this server falls back the same way.
"""

import asyncio
import json
import logging
import time
from collections.abc import Callable
from typing import Any

import regex as re

from app.env import env, env_raw
from app.jscompat import JS_S, js_trim, js_truthy, utf16_len
from app.llm import claude, gemini, ollama, openai
from app.llm.call import LlmCall
from app.llm.local import INTENT_LABEL, classify_intent, sentiment_of, summarize_local, synthesize_local
from app.llm.prompts import LANGUAGE_NAME, GenerateInput, system_prompt, user_prompt
from app.registry import LlmProvider, llm_cost
from app.usage_log import UsageEntry, record_usage

__all__ = [
    "INTENT_LABEL",
    "FALLBACK_TAG",
    "GenerateInput",
    "classify_intent",
    "engine_is_hosted",
    "engine_label",
    "engine_name",
    "generate_answer",
    "is_fallback_answer",
    "llm_provider_ready",
    "resolve_llm",
    "sentiment_of",
    "stream_answer",
    "summarize_call",
]

log = logging.getLogger("callmind.llm")

PROVIDERS: tuple[LlmProvider, ...] = ("openai", "anthropic", "gemini", "ollama")

# ── provider selection ──────────────────────────────────────────────


def llm_provider_ready(p: str) -> bool:
    """Whether this server has the key (or URL) the provider needs."""
    if p == "openai":
        return openai.has_openai()
    if p == "anthropic":
        return claude.client() is not None
    if p == "gemini":
        return gemini.has_gemini()
    return ollama.has_ollama()


def _env_model(p: str) -> str:
    if p == "ollama":
        return ollama.ollama_model()
    if p == "gemini":
        return gemini.gemini_model()
    if p == "anthropic":
        return claude.default_model()
    if p == "openai":
        return openai.openai_model()
    return "ovoz-local-synthesis"


def _provider() -> str:
    """LLM_PROVIDER forces one; otherwise the first configured wins (Claude, Ollama, Gemini, OpenAI), local last."""
    pref = env("LLM_PROVIDER").lower() or None
    if pref == "ollama":
        return "ollama" if ollama.has_ollama() else "local"
    if pref == "gemini":
        return "gemini" if gemini.has_gemini() else "local"
    if pref in ("anthropic", "claude"):
        return "anthropic" if claude.client() is not None else "local"
    if pref == "openai":
        return "openai" if openai.has_openai() else "local"
    if pref == "local":
        return "local"
    if claude.client() is not None:
        return "anthropic"
    if ollama.has_ollama():
        return "ollama"
    if gemini.has_gemini():
        return "gemini"
    if openai.has_openai():
        return "openai"
    return "local"


def resolve_llm(choice: str | None = None) -> tuple[str, str]:
    """(provider, model) for a `provider:model` choice; honoured only when that provider is set up here."""
    if choice:
        at = choice.find(":")
        p = choice[:at] if at >= 0 else choice[:-1]  # JS slice(0, -1) when ':' is missing
        model = js_trim(choice[at + 1 :])
        if at > 0 and model and p in PROVIDERS and llm_provider_ready(p):
            return p, model
    p = _provider()
    return p, _env_model(p)


def _selection_id(sel: tuple[str, str]) -> str:
    return f"{sel[0]}:{sel[1]}"


def _name_of(sel: tuple[str, str]) -> str:
    """The engine string replies carry (`openai:gpt-5.5`, `claude:…`)."""
    if sel[0] == "local":
        return "ovoz-local-synthesis"
    return f"{'claude' if sel[0] == 'anthropic' else sel[0]}:{sel[1]}"


def engine_name(choice: str | None = None) -> str:
    return _name_of(resolve_llm(choice))


def engine_is_hosted(choice: str | None = None) -> bool:
    return resolve_llm(choice)[0] != "local"


def engine_label(choice: str | None = None) -> str:
    """Human-friendly label for the engine that answers (Overview, Settings, Playground)."""
    p, model = resolve_llm(choice)
    if p == "ollama":
        return f"Ollama {model}"
    if p == "gemini":
        return f"Gemini {model}"
    if p == "anthropic":
        return f"Claude {model}"
    if p == "openai":
        return f"OpenAI {model}"
    return "Local synthesiser"


# ── generation ──────────────────────────────────────────────────────

FALLBACK_TAG = " (fallback)"


def is_fallback_answer(out: dict[str, Any]) -> bool:
    """True when the chosen model failed and the fallback model wrote this answer."""
    return out["engine"].endswith(FALLBACK_TAG)


def fallback_model() -> str | None:
    """Claude Haiku by default; LLM_FALLBACK_MODEL picks another Claude model, `off` turns it off."""
    setting = env_raw("LLM_FALLBACK_MODEL")
    model = js_trim("claude-haiku-5-5" if setting is None else setting)
    return model if model and model != "off" else None


def _local(inp: GenerateInput) -> dict[str, Any]:
    return synthesize_local(
        inp.question,
        inp.hits,
        inp.confidence,
        inp.language,
        inp.agent_name,
        inp.threshold,
        inp.history,
        inp.max_chars if inp.max_chars is not None else 340,
    )


def _ms_since(started: float) -> float:
    return (time.perf_counter() - started) * 1000


class _Voice:
    """One model's streamed answer, held back until it is the model that speaks (`go_live`)."""

    def __init__(self, on_delta: Callable[[str], None] | None) -> None:
        self.on_delta = on_delta
        self.text = ""
        self.held: list[str] = []
        self.live = False
        self.spoke = asyncio.Event()
        self.started = time.perf_counter()
        self.first_ms: list[float] = []

    def relay(self, delta: str) -> None:
        self.text += delta
        if not self.first_ms:
            self.first_ms.append(_ms_since(self.started))
        self.spoke.set()
        if self.live:
            if self.on_delta:
                self.on_delta(delta)
        else:
            self.held.append(delta)

    def go_live(self) -> None:
        self.live = True
        if self.on_delta:
            for delta in self.held:
                self.on_delta(delta)
        self.held.clear()


def _ms_setting(name: str, default: int) -> float | None:
    """A time setting in ms from the environment, in seconds; 0 or `off` turns it off (None)."""
    raw = js_trim(env(name) or "")
    if raw.lower() == "off":
        return None
    try:
        ms = float(raw) if raw else float(default)
    except ValueError:
        ms = float(default)
    return ms / 1000 if ms > 0 else None


def _backup_joins_after_s() -> float | None:
    """How long the chosen model may stay silent before the backup model starts too (LLM_BACKUP_AFTER_MS)."""
    return _ms_setting("LLM_BACKUP_AFTER_MS", 1500)


def _give_up_after_s() -> float:
    """When neither model has said a word, the local engine answers (LLM_GIVE_UP_MS, from the start)."""
    return _ms_setting("LLM_GIVE_UP_MS", 3000) or 3.0


async def _first_of(signals: list, tasks: list, timeout: float) -> None:
    """Wait until one signal fires or one task ends, or `timeout` passes; the tasks keep running."""
    waiters = [asyncio.ensure_future(s) for s in signals]
    try:
        await asyncio.wait([*waiters, *tasks], timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in waiters:
            w.cancel()


async def generate_answer(inp: GenerateInput, on_delta: Callable[[str], None] | None = None) -> dict[str, Any]:
    """
    `{answer, intent, answered, usedHits, engine}`. `on_delta`, when given, receives the spoken
    answer piece by piece as the model writes it; the returned `answer` always starts with
    everything that was streamed, so a voice that already spoke part of it is never contradicted.
    """
    sel = resolve_llm(inp.llm)
    started = time.perf_counter()
    first_ms: list[float] = []
    call = LlmCall(model=sel[1])

    def relay(delta: str) -> None:
        if not first_ms:
            first_ms.append(_ms_since(started))
        on_delta(delta)  # type: ignore[misc]

    out = await _answer_once(inp, sel, call, relay if on_delta else None)
    # One usage row per hosted answer. The "give me a human" shortcut never reaches a model.
    shortcut = out["intent"] == "human" and not (inp.target or {}).get("fullName")
    if sel[0] != "local" and not shortcut:
        rescued = out["engine"].endswith(FALLBACK_TAG)
        fell_back = out["engine"] == "local" or rescued
        record_usage(
            UsageEntry(
                kind="llm",
                engine=sel[0],
                model=_selection_id(sel),
                ms=_ms_since(started),
                first_ms=first_ms[0] if first_ms else None,
                chars=utf16_len(out["answer"]),
                tokens_in=call.tokens_in,
                tokens_out=call.tokens_out,
                cost_usd=llm_cost(_selection_id(sel), call.tokens_in, call.tokens_out),
                ok=not fell_back,
                error="fell_back_to_fallback_model" if rescued else "fell_back_to_local" if fell_back else None,
            )
        )
    return out


class _Unreadable(Exception):
    """The model's reply was not the JSON answer we asked for."""


def _parse_answer(raw: str | None) -> dict[str, Any] | None:
    """`JSON.parse(raw)` with a non-empty string `answer`; None for no reply; raises _Unreadable otherwise."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError as err:
        raise _Unreadable from err
    if not isinstance(parsed, dict):
        # JSON.parse('"x"') then `.answer` is undefined: treated as no answer, like a missing field.
        return {}
    answer = parsed.get("answer")
    if answer is not None and not isinstance(answer, str):
        raise _Unreadable  # `.trim` of a number throws in TypeScript
    return parsed


def _has_answer(parsed: dict[str, Any] | None) -> bool:
    return bool(parsed) and isinstance(parsed.get("answer"), str) and bool(js_trim(parsed["answer"]))


async def _answer_once(
    inp: GenerateInput,
    sel: tuple[str, str],
    call: LlmCall,
    on_delta: Callable[[str], None] | None,
) -> dict[str, Any]:
    intent = classify_intent(inp.question)
    target_name = (inp.target or {}).get("fullName")

    # Explicit "give me a human" never needs a model round-trip — except on a loan call,
    # which has no live transfer and must keep pursuing the date.
    if intent == "human" and not target_name:
        return _local(inp)

    active = sel[0]
    if active == "local":
        return _local(inp)
    engine = _name_of(sel)

    system = system_prompt(inp)
    user = user_prompt(inp)

    def finalize(parsed: dict[str, Any], engine_tag: str) -> dict[str, Any]:
        used_raw = parsed.get("usedExcerpts")
        if used_raw is not None and not isinstance(used_raw, (list, str)):
            raise _Unreadable  # `new Set(5)` throws in TypeScript
        # Only numbers can match an excerpt number (JSON `true` is not 1 there, unlike in Python).
        used = {x for x in used_raw or [] if isinstance(x, (int, float)) and not isinstance(x, bool)}
        return {
            "answer": js_trim(parsed["answer"]),
            "intent": intent,
            "answered": js_truthy(parsed.get("answered")),
            "usedHits": [h for i, h in enumerate(inp.hits) if i + 1 in used][:3],
            "engine": engine_tag,
        }

    def finish_backup(
        raw: str | None, streamed: str, backup: LlmCall, started: float, first_ms: list[float], model: str
    ) -> dict[str, Any]:
        """The backup model's answer (or the local engine's, when it gave none), with its usage row."""
        tag = f"claude:{model}{FALLBACK_TAG}"
        out: dict[str, Any] | None = None
        try:
            parsed = _parse_answer(raw)
            if _has_answer(parsed):
                out = finalize(parsed, tag)  # type: ignore[arg-type]
        except _Unreadable:
            pass
        if out is None and js_trim(streamed):
            out = {"answer": js_trim(streamed), "intent": intent, "answered": True, "usedHits": [], "engine": tag}
        record_usage(
            UsageEntry(
                kind="llm",
                engine="anthropic",
                model=f"anthropic:{model}",
                ms=_ms_since(started),
                first_ms=first_ms[0] if first_ms else None,
                chars=utf16_len(out["answer"]) if out else 0,
                tokens_in=backup.tokens_in,
                tokens_out=backup.tokens_out,
                cost_usd=llm_cost(f"anthropic:{model}", backup.tokens_in, backup.tokens_out),
                ok=out is not None,
                error=None if out else "fallback_failed",
            )
        )
        return out if out is not None else _local(inp)

    def backup_model_for_this_turn() -> str | None:
        model = fallback_model()
        if not model or claude.client() is None or (active == "anthropic" and sel[1] == model):
            return None
        return model

    async def rescue(reason: str) -> dict[str, Any]:
        """
        The chosen model failed before any of its answer went out: answer with the fallback model,
        streamed the same way, and only if that fails too with the local engine.
        """
        model = backup_model_for_this_turn()
        if not model:
            return _local(inp)
        log.warning("[llm] %s failed before answering (%s); answering with %s", engine, reason, model)
        backup = LlmCall(model=model)
        voice = _Voice(on_delta)
        voice.go_live()
        raw: str | None = None
        try:
            if on_delta and inp.stream is not False:
                raw = await claude.json_stream(model, system, user, voice.relay, backup)
            else:
                raw, _ = await claude.answer_once(model, system, user, backup)
        except Exception as err:  # noqa: BLE001
            log.warning("[llm] fallback failed: %s", err)
        return finish_backup(raw, voice.text, backup, voice.started, voice.first_ms, model)

    # Gemini and Claude stream only for a caller that voices the answer as it comes.
    stream_others = bool(on_delta) and inp.stream is not False
    claude_client = claude.client() if active == "anthropic" else None

    if (
        active == "openai"
        or (active == "ollama" and on_delta)
        or (active == "gemini" and stream_others)
        or (active == "anthropic" and stream_others and claude_client is not None)
    ):

        async def main_stream(relay: Callable[[str], None]) -> str | None:
            if active == "anthropic":
                return await claude.json_stream(sel[1], system, user, relay, call)
            if active == "openai":
                return await openai.openai_json_stream(system, user, relay, call)
            if active == "gemini":
                return await gemini.gemini_json_stream(system, user, relay, call)
            return await ollama.ollama_json_stream(system, user, relay, call)

        main = _Voice(on_delta)
        join_s = _backup_joins_after_s()
        model = backup_model_for_this_turn() if stream_others and join_s is not None else None
        if model is None:
            main.go_live()
            raw = await main_stream(main.relay)
        else:
            # A caller is waiting for the first word: if the chosen model has not said one by `join_s`,
            # the backup model starts too and whichever speaks first answers; if neither has by the
            # give-up time, the local engine does. A model that spoke is never interrupted.
            loop = asyncio.get_running_loop()
            begun = loop.time()
            main_task = asyncio.ensure_future(main_stream(main.relay))
            backup_task: asyncio.Future | None = None
            try:
                await _first_of([main.spoke.wait()], [main_task], join_s)
                if not main.spoke.is_set() and not main_task.done():
                    log.warning("[llm] %s silent for %.1f s; %s starts too", engine, join_s, model)
                    backup = LlmCall(model=model)
                    voice = _Voice(on_delta)
                    backup_task = asyncio.ensure_future(claude.json_stream(model, system, user, voice.relay, backup))
                    give_up_at = begun + _give_up_after_s()
                    while not main.spoke.is_set() and not voice.spoke.is_set():
                        running = [x for x in (main_task, backup_task) if not x.done()]
                        left = give_up_at - loop.time()
                        if not running or left <= 0:
                            break
                        await _first_of([main.spoke.wait(), voice.spoke.wait()], running, left)
                    if not main.spoke.is_set():
                        main_task.cancel()
                        if voice.spoke.is_set():
                            voice.go_live()
                            try:
                                raw_backup = await backup_task
                            except Exception as err:  # noqa: BLE001
                                log.warning("[llm] backup stream broke: %s", err)
                                raw_backup = None
                            return finish_backup(raw_backup, voice.text, backup, voice.started, voice.first_ms, model)
                        log.warning("[llm] neither %s nor %s spoke in time; the local engine answers", engine, model)
                        backup_task.cancel()
                        return finish_backup(None, "", backup, voice.started, voice.first_ms, model)
                    backup_task.cancel()
                main.go_live()
                raw = await main_task
            finally:
                for task in (main_task, backup_task):
                    if task is not None and not task.done():
                        task.cancel()
        try:
            parsed = _parse_answer(raw)
            if _has_answer(parsed):
                return finalize(parsed, engine)  # type: ignore[arg-type]
        except _Unreadable:
            pass
        # The stream broke after part of the answer went out: keep what was said.
        if js_trim(main.text):
            return {
                "answer": js_trim(main.text),
                "intent": intent,
                "answered": True,
                "usedHits": [],
                "engine": engine,
            }
        return await rescue("unreadable answer" if raw else "no answer")

    if active in ("gemini", "ollama"):
        raw = await (
            ollama.ollama_json(system, user, call) if active == "ollama" else gemini.gemini_json(system, user, call)
        )
        if not raw:
            return await rescue("no answer")
        try:
            parsed = _parse_answer(raw)
        except _Unreadable:
            return await rescue("unreadable answer")
        if not _has_answer(parsed):
            return await rescue("empty answer")
        try:
            return finalize(parsed, engine)  # type: ignore[arg-type]
        except _Unreadable:
            return await rescue("unreadable answer")

    if claude_client is None:
        return _local(inp)
    try:
        raw, answered_by = await claude.answer_once(sel[1], system, user, call)
        if raw is None:
            return _local(inp)
        parsed = _parse_answer(raw)
        if not _has_answer(parsed):
            return _local(inp)
        return finalize(parsed, f"claude:{answered_by}")  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        return _local(inp)


_WORDS = re.compile(f"([{JS_S}]+)")


async def stream_answer(inp: GenerateInput):  # noqa: ANN201 - async generator of {delta} / {done}
    """Streaming shape for the web playground's token-by-token display."""
    result = _local(inp) if resolve_llm(inp.llm)[0] == "local" else await generate_answer(inp)
    pause = 0.014 if resolve_llm(inp.llm)[0] == "local" else 0.010
    for word in _WORDS.split(result["answer"]):
        yield {"delta": word}
        await asyncio.sleep(pause)
    yield {"done": result}


# ── summarisation for operator hand-off ─────────────────────────────


async def summarize_call(turns: list[dict[str, str]], language: str, reason: str, llm: str | None = None) -> str:
    fallback = summarize_local(turns, language, reason)
    if len(turns) < 2:
        return fallback
    sel = resolve_llm(llm)
    active = sel[0]
    if active == "local":
        return fallback
    call = LlmCall(model=sel[1])
    system = (
        "You brief a human contact-centre operator who is about to pick up a live call "
        "mid-conversation. Write 2–3 sentences: what the caller wants, what has already "
        "been said, and what the operator must do next. No preamble, no markdown. "
        "Do not include internal or system XML tags in your response. "
        f"Write in {LANGUAGE_NAME.get(language, 'English')}."
    )
    transcript = "\n".join(f"{'CALLER' if t['role'] == 'caller' else 'AI'}: {t['text']}" for t in turns)
    user = f"Escalation reason: {reason}\n\nTranscript:\n{transcript}"

    async def written() -> str | None:
        if active == "ollama":
            return await ollama.ollama_text(system, user, 300, call)
        if active == "openai":
            return await openai.openai_text(system, user, 300, call)
        if active == "gemini":
            return await gemini.gemini_text(system, user, 300, call)
        if claude.client() is None:
            return None
        return await claude.text(sel[1], system, user, 300)

    # The hand-off is written while the caller waits for the reply: a slow model gets the local summary.
    from app.engine.live_turn import in_playground

    deadline = _ms_setting("SUMMARY_DEADLINE_MS", 2000) if in_playground() else None
    try:
        if deadline is None:
            text = await written()
        else:
            async with asyncio.timeout(deadline):
                text = await written()
    except TimeoutError:
        log.warning("[llm] hand-off summary took over %.1f s; the local summary is used", deadline)
        return fallback
    except Exception:  # noqa: BLE001
        return fallback
    return js_trim(text) if text and js_trim(text) else fallback
