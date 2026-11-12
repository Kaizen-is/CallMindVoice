"""
The Python answer layer against the ORIGINAL TypeScript (`generateAnswer`, `summarizeCall`,
`resolveLlm`), recorded in fixtures/golden_llm.json by scratchpad/golden/make-golden-llm.cjs.

Each scenario replays the same scripted provider responses and checks the exact request bodies
(prompts included), Claude request params, streamed pieces, the answer and the usage rows.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import http
from app.llm import claude, provider
from app.llm.prompts import GenerateInput
from tests.fakes import FakeAnthropic, ScriptedTransport, same_request

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_llm.json").read_text(encoding="utf-8"))
FIXED_NOW = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)

ENV_KEYS = (
    "GEMINI_API_KEY", "GEMINI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL",
    "OPENAI_BASE_URL", "OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_API_KEY", "LLM_PROVIDER", "LLM_FALLBACK_MODEL",
)  # fmt: skip


def _setup(monkeypatch: pytest.MonkeyPatch, env: dict, fetch: list, claude_script: list) -> ScriptedTransport:
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    transport = ScriptedTransport(json.loads(json.dumps(fetch)))
    http.set_transport(transport)
    monkeypatch.setattr(claude.anthropic, "AsyncAnthropic", FakeAnthropic)
    claude._client = None
    FakeAnthropic.script = json.loads(json.dumps(claude_script))
    FakeAnthropic.calls = []
    return transport


def _input(raw: dict) -> GenerateInput:
    names = {
        "agentName": "agent_name",
        "timeZone": "time_zone",
        "extraSystem": "extra_system",
        "extraNote": "extra_note",
    }
    return GenerateInput(**{names.get(k, k): v for k, v in raw.items()}, now=FIXED_NOW)


def _usage_view(entry) -> dict:
    return {
        "kind": entry.kind,
        "engine": entry.engine,
        "model": entry.model,
        "chars": entry.chars,
        "tokensIn": entry.tokens_in,
        "tokensOut": entry.tokens_out,
        "costUsd": entry.cost_usd,
        "ok": entry.ok,
        "error": entry.error,
        "firstMs": None if entry.first_ms is None else "set",
    }


@pytest.mark.parametrize("scenario", GOLDEN["scenarios"], ids=lambda s: s["name"])
def test_generate_answer_matches_typescript(scenario: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    transport = _setup(monkeypatch, scenario["env"], scenario["fetch"], scenario["claude"])
    usage: list = []
    monkeypatch.setattr(provider, "record_usage", usage.append)
    deltas: list[str] = []

    result = asyncio.run(
        provider.generate_answer(_input(scenario["input"]), deltas.append if scenario["delta"] else None)
    )

    assert len(transport.requests) == len(scenario["requests"])
    for ts, py in zip(scenario["requests"], transport.requests, strict=True):
        same_request(ts, py)
    assert FakeAnthropic.calls == scenario["claudeCalls"]
    assert deltas == scenario["deltas"]
    assert result == scenario["result"]
    expected_usage = [{k: u.get(k) for k in _usage_view(e)} for u, e in zip(scenario["usage"], usage, strict=False)]
    assert [_usage_view(e) for e in usage] == expected_usage
    assert len(usage) == len(scenario["usage"])
    assert transport.script == [] and FakeAnthropic.script == []


@pytest.mark.parametrize("scenario", GOLDEN["summaries"], ids=lambda s: s["name"])
def test_summarize_call_matches_typescript(scenario: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    transport = _setup(monkeypatch, scenario["env"], scenario["fetch"], scenario["claude"])
    result = asyncio.run(provider.summarize_call(*scenario["args"]))
    assert result == scenario["result"]
    assert len(transport.requests) == len(scenario["requests"])
    for ts, py in zip(scenario["requests"], transport.requests, strict=True):
        same_request(ts, py)
    assert FakeAnthropic.calls == scenario["claudeCalls"]


def test_model_resolution_matches_typescript(monkeypatch: pytest.MonkeyPatch) -> None:
    for case in GOLDEN["resolve"]:
        _setup(monkeypatch, case["env"], [], [])
        choice = case["choice"]
        p, model = provider.resolve_llm(choice)
        assert {"provider": p, "model": model} == case["resolved"], case
        assert provider.engine_name(choice) == case["name"], case
        assert provider.engine_label(choice) == case["label"], case
        assert provider.engine_is_hosted(choice) == case["hosted"], case
