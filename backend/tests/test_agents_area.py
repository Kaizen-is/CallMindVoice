"""
Agents, onboarding, models and voices: what the golden replay (test_agents_parity.py) does not
reach — login and role refusals, the clone upload limit, the deploy benchmark's once-per-build
scheduling, and the small JavaScript behaviours the port relies on (Node's path.extname, String(),
JSON.stringify of integer-like keys and of half an emoji).
"""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import benchmark, custom_voices
from app.auth import COOKIE, encode_session
from app.console_text import js_slice_stored, js_str, node_extname
from app.jscompat import js_json, utf16_slice
from tests.conftest import SECRET
from tests.test_system import _seed_user

# Node's path.posix.extname for the same inputs.
EXTNAMES = [
    ["a.wav", ".wav"], ["Sample.WAV", ".WAV"], [".bashrc", ""], ["a.", "."], ["a.b.c", ".c"], ["", ""],
    ["noext", ""], ["..", ""], ["...", "."], [".a.b", ".b"], ["dir.x/file", ""], ["dir/.hidden", ""],
    ["a/b.c/", ".c"], ["x..y", ".y"], [".", ""], ["a/", ""], ["my.voice.Mp3", ".Mp3"], ["/abs/x.ogg", ".ogg"],
]  # fmt: skip


@pytest.mark.parametrize(("path", "ext"), EXTNAMES)
def test_node_extname(path: str, ext: str) -> None:
    assert node_extname(path) == ext


def test_js_str_and_slices() -> None:
    assert [js_str(v) for v in (None, True, 1.5, 1e21, [1, None, [2, "a"]], {})] == [
        "null", "true", "1.5", "1e+21", "1,,2,a", "[object Object]",
    ]  # fmt: skip
    cut = "ab😀"
    assert js_slice_stored(cut, 3) == "ab�"  # a column gets U+FFFD for half an emoji
    assert js_json({"name": utf16_slice(cut, 0, 3)}) == '{"name":"ab\\ud83d"}'  # JSON.stringify keeps the half
    assert js_json({"name": cut}) == '{"name":"ab😀"}'


def test_js_json_orders_integer_keys_like_javascript() -> None:
    days = {"1": "mon", "6": "sat", "0": "sun", "x": 1, "10": "?", "01": "not an index"}
    assert js_json(days) == '{"0":"sun","1":"mon","6":"sat","10":"?","x":1,"01":"not an index"}'
    assert list(json.loads(js_json(days))) == ["0", "1", "6", "10", "x", "01"]


def test_gemini_3_8_flash_is_not_offered_and_a_stored_choice_falls_back(data_dir, sql) -> None:  # noqa: ANN001
    """Taken out 2026-11-25 (Google kept answering it with 503): no picker, lab or benchmark offers it,
    and an agent or account still set to it answers with the next choice down."""
    from app.llm.choice import agent_llm, llm_options, set_tenant_default_llm, tenant_default_llm
    from app.registry import LLM_MODELS

    gone = "gemini:gemini-3.8-flash"
    assert gone not in [o["id"] for o in llm_options()]
    assert gone not in [m.id for m in LLM_MODELS]
    assert "gemini:gemini-3.5-flash-lite" in [m.id for m in LLM_MODELS]

    _seed_user(sql)
    tenant = "ten_test000000000001"
    sql("UPDATE tenants SET settings_json = ? WHERE id = ?", json.dumps({"llmModel": gone}), tenant)
    assert tenant_default_llm(tenant) is None
    assert not set_tenant_default_llm(tenant, gone)
    assert agent_llm({"llm_model": gone, "tenant_id": tenant}) is None

    assert set_tenant_default_llm(tenant, "gemini:gemini-3.5-flash-lite")
    assert agent_llm({"llm_model": gone, "tenant_id": tenant}) == "gemini:gemini-3.5-flash-lite"


# ── refusals ────────────────────────────────────────────────────────


@pytest.fixture
def api(data_dir, sql):  # noqa: ANN001, ANN201
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


def test_pages_and_actions_need_a_login(client: TestClient) -> None:
    for path in ("/views/agent", "/views/playground", "/views/onboarding", "/views/models/lab", "/views/dev/tts"):
        assert client.get(path).status_code == 401, path
    for name in ("saveAgentAction", "playgroundTurnAction", "skipOnboardingAction", "setDefaultLlmAction"):
        res = client.post(f"/actions/{name}", json={})
        assert (res.status_code, res.json()) == (401, {"error": "unauthorized"}), name


def test_admin_actions_refuse_an_operator(api: TestClient, sql) -> None:  # noqa: ANN001
    sql("UPDATE users SET role = 'operator'")
    for name, args in (
        ("saveAgentAction", {"agentId": "x", "draft": {}}),
        ("setAgentStatusAction", {"agentId": "x", "status": "live"}),
        ("createAgentAction", {"name": "x"}),
        ("completeOnboardingAction", {"payload": {}}),
        ("setDefaultLlmAction", {"choice": None}),
    ):
        res = api.post(f"/actions/{name}", json=args)
        assert (res.status_code, res.json()) == (403, {"error": "forbidden"}), name
    # Not admin-only, as before: skipping onboarding and the voice actions.
    assert api.post("/actions/skipOnboardingAction").json() == {"ok": True}
    assert api.post("/actions/deleteCustomVoiceAction", json={"voiceId": "cv_x"}).json() == {"ok": False}


def test_clone_sample_over_the_limit(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(custom_voices, "MAX_REF_BYTES", 10)
    res = api.post(
        "/actions/createCloneVoiceAction", data={"name": "Ovoz"}, files={"refAudio": ("a.wav", b"x" * 11, "audio/wav")}
    )
    assert res.json() == {"ok": False, "message": "audio_too_large"}


def test_clone_without_the_own_stt(api: TestClient) -> None:
    res = api.post("/actions/createCloneVoiceAction", data={"name": "Ovoz"}, files={"refAudio": ("a.wav", b"RIFF", "")})
    assert res.json() == {"ok": False, "message": "transcribe_failed"}


# ── the deploy benchmark: when it runs ──────────────────────────────


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(benchmark, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(benchmark, "START_DELAY_S", 0)
    for key in ("BENCHMARK_ON_START", "NODE_ENV"):
        monkeypatch.delenv(key, raising=False)
    return tmp_path


def _scheduled(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Builds the benchmark is started for, when the API starts."""
    started: list[str] = []

    async def run(build: str) -> bool:
        started.append(build)
        return True

    monkeypatch.setattr(benchmark, "run_benchmark", run)
    app = FastAPI()
    app.include_router(benchmark.startup_router)
    with TestClient(app):
        task = benchmark._task
        if task is not None:
            asyncio.run_coroutine_threadsafe(asyncio.sleep(0), task.get_loop()).result()
            for _ in range(50):
                if task.done():
                    break
                asyncio.run_coroutine_threadsafe(asyncio.sleep(0.01), task.get_loop()).result()
    return started


def test_benchmark_runs_once_a_build_starts_in_production(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (repo / ".next").mkdir()
    (repo / ".next" / "BUILD_ID").write_text(" abc123\n", encoding="utf-8")
    monkeypatch.setattr(benchmark, "_task", None)
    monkeypatch.setenv("NODE_ENV", "production")
    assert _scheduled(monkeypatch) == ["abc123"]


def test_benchmark_skipped_in_development_and_when_turned_off(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (repo / ".next").mkdir()
    (repo / ".next" / "BUILD_ID").write_text("abc123", encoding="utf-8")
    monkeypatch.setattr(benchmark, "_task", None)
    assert _scheduled(monkeypatch) == []  # not production
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("BENCHMARK_ON_START", "0")
    assert _scheduled(monkeypatch) == []  # turned off everywhere


def test_benchmark_forced_in_development_uses_build_dev(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(benchmark, "_task", None)
    monkeypatch.setenv("BENCHMARK_ON_START", "1")
    assert _scheduled(monkeypatch) == ["dev"]  # no .next/BUILD_ID


def test_benchmark_without_a_build_id_does_nothing(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(benchmark, "_task", None)
    monkeypatch.setenv("NODE_ENV", "production")
    assert _scheduled(monkeypatch) == []


def test_benchmark_claims_the_build_and_records_a_failed_step(data_dir: Path, sql, monkeypatch) -> None:  # noqa: ANN001
    async def ok(_build: str) -> None:
        return None

    async def broken(_build: str) -> None:
        raise RuntimeError("no set")

    monkeypatch.setattr(benchmark, "benchmark_stt", broken)
    monkeypatch.setattr(benchmark, "benchmark_tts", ok)
    monkeypatch.setattr(benchmark, "benchmark_llm", ok)
    assert asyncio.run(benchmark.run_benchmark("b9")) is True
    assert asyncio.run(benchmark.run_benchmark("b9")) is False  # a restart of the same build
    ((status, finished),) = sql("SELECT status, finished_at IS NOT NULL FROM benchmark_runs WHERE build = 'b9'")
    assert (status, finished) == ("partial", 1)
