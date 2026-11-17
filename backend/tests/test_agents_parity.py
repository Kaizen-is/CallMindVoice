"""
Agents, onboarding, models and voices served by Python, replayed against the ORIGINAL TypeScript
(fixtures/golden_agents.json, recorded by tools/golden/make-golden-agents.cjs from the pages and
server actions as they were before the port):

  • every page's data equals the props the TypeScript page passed to its client component;
  • every server action returns the same value (or the same 403), triggers the same
    revalidatePath / redirect through its TypeScript proxy, and adds, changes or removes exactly the
    same rows — with the same ids, which both sides draw from the same fixed byte stream;
  • the transcript scorer gives the same numbers; the deploy benchmark, with the same scripted
    engines and clock, writes the same rows; the Model lab then shows the same statistics.
"""

import asyncio
import hashlib
import io
import json
import re
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app import benchmark, http, ids, model_lab
from app.auth import COOKIE
from app.ids import now_iso
from app.speech import zipformer
from app.speech.scoring import normalize_for_scoring, score
from app.speech.tts import pcm_to_wav
from tests.conftest import _reset_provider_state

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_agents.json").read_text(encoding="utf-8"))

TABLES = [
    "tenants", "agents", "custom_voices", "audit_log", "calls", "turns", "usage_daily", "wallet_ledger",
    "knowledge_gaps", "escalations", "model_usage", "benchmark_runs", "benchmark_results",
]  # fmt: skip
VOLATILE = {
    "calls": ["duration_ms", "first_response_ms", "avg_latency_ms", "p95_latency_ms", "cost_usd"],
    "turns": ["latency_ms", "timings_json"],
    "usage_daily": ["minutes", "cost_usd", "avg_latency_ms"],
}
ENV_KEYS = [
    "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_BASE_URL", "LLM_PROVIDER", "LLM_FALLBACK_MODEL",
    "TTS_BASE_URL", "TTS_CLIENT_SECRET", "TTS_JWT_TOKEN", "SPEKO_API_KEY", "STT_TRANSCRIBE_URL",
    "WHISPER_TRANSCRIBE_URL", "GAPIAPI", "GAPI_API_KEY", "BRB_SPEECH_URL", "BRB_SPEECH_LOGIN", "BRB_SPEECH_PASSWORD",
    "BRB_STT_URL", "ZIPFORMER_MODEL_DIR", "DENOISE_URL",
]  # fmt: skip

# What each TypeScript proxy does with the Python answer (src/app/actions/*.ts).
VOICE_PAGES = [["/app/dev/voice-clone"], ["/app/dev/voice-design"], ["/app/dev/tts"], ["/app/agent"]]
AGENT_PAGES = [["/app/agent"], ["/app"]]

ISO_ANY = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


class Masker:
    """The generator's `mask`: run-time stamps and days hidden, measured timings reduced."""

    def __init__(self) -> None:
        self.run_start = now_iso()
        self.run_day = (datetime.now(UTC) - timedelta(hours=36)).strftime("%Y-%m-%d")

    def __call__(self, value: Any) -> Any:  # noqa: ANN401
        if isinstance(value, str):
            if DAY.fullmatch(value) and value >= self.run_day:
                return "<today>"
            return ISO_ANY.sub(lambda m: "<now>" if m.group(0) >= self.run_start else m.group(0), value)
        if isinstance(value, list):
            return [self(v) for v in value]
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                if k == "timings" and isinstance(v, dict):
                    out[k] = {"keys": ",".join(v), "sttMs": v.get("sttMs"), "ttsMs": v.get("ttsMs")}
                else:
                    out[k] = self(v)
            return out
        return value

    def row(self, table: str, row: dict[str, Any]) -> dict[str, Any]:
        r = self(row)
        if "<now>" in r.values() or "<today>" in r.values():
            for col in VOLATILE.get(table, []):
                if col in r:
                    r[col] = "<v>"
        return r


class Rows:
    """Rows added, changed and removed since the last look — the generator's `changes()`."""

    def __init__(self, db_path: Path, mask: Masker) -> None:
        self.db_path = db_path
        self.mask = mask
        self.last = self._snapshot()

    def _snapshot(self) -> dict[str, dict[int, dict[str, Any]]]:
        con = sqlite3.connect(self.db_path)
        con.row_factory = sqlite3.Row
        try:
            return {
                t: {
                    r["_rowid"]: self.mask.row(t, dict(r))
                    for r in con.execute(f"SELECT rowid AS _rowid, * FROM {t}")  # noqa: S608 - fixed names
                }
                for t in TABLES
            }
        finally:
            con.close()

    def changes(self) -> dict[str, Any]:
        now = self._snapshot()
        out = {}
        for t in TABLES:
            added = [r for rowid, r in now[t].items() if rowid not in self.last[t]]
            changed = [r for rowid, r in now[t].items() if rowid in self.last[t] and self.last[t][rowid] != r]
            removed = [rowid for rowid in self.last[t] if rowid not in now[t]]
            if added or changed or removed:
                out[t] = {"added": added, "changed": changed, "removed": removed}
        self.last = now
        return out


@pytest.fixture
def fixed_ids(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """New ids from sha256(counter), as the generator made them."""
    counter = [0]

    class Bytes:
        @staticmethod
        def token_bytes(n: int) -> bytes:
            out = hashlib.sha256(str(counter[0]).encode()).digest()[:n]
            counter[0] += 1
            return out

    monkeypatch.setattr(ids, "secrets", Bytes)
    return counter


def _seed(data_dir: Path) -> None:
    con = sqlite3.connect(data_dir / "ovoz.db")
    try:
        for table, rows in GOLDEN["seed"].items():
            for row in rows:
                cols = list(row)
                con.execute(
                    f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",  # noqa: S608
                    [row[c] for c in cols],
                )
        con.commit()
    finally:
        con.close()
    uploads = data_dir / "uploads"
    uploads.mkdir(exist_ok=True)
    import base64

    (uploads / "voice_cv_clone.wav").write_bytes(base64.b64decode(GOLDEN["cloneSample"]))


def _token(user: str) -> str:
    import base64
    import hmac

    sid = f"ses_{user[4:]}"
    mac = hmac.new(GOLDEN["secret"].encode(), sid.encode(), hashlib.sha256).digest()
    return f"{sid}.{base64.urlsafe_b64encode(mac).rstrip(b'=').decode()}"


@pytest.fixture
def stt_log() -> Iterator[list[dict[str, Any]]]:
    """The own STT (STT_TRANSCRIBE_URL), answering as the generator's fetch stand-in did."""
    log: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) != GOLDEN["sttUrl"]:
            raise httpx.ConnectError("offline")
        body = request.read()
        name = re.search(rb'filename="([^"]*)"', body).group(1).decode()
        part = body.split(b"\r\n\r\n", 1)[1]
        ctype = re.search(rb"Content-Type: ([^\r\n]+)", body).group(1).decode()
        boundary = request.headers["content-type"].split("boundary=")[1].encode()
        size = len(part.split(b"\r\n--" + boundary)[0])
        log.append({"name": name, "type": ctype, "size": size})
        if name == "broken.wav":
            return httpx.Response(500, text="upstream exploded")
        if name == "silent.wav":
            return httpx.Response(200, json={"text": "   "})
        if name == "null.wav":
            return httpx.Response(200, content=b"null", headers={"content-type": "application/json"})
        return httpx.Response(200, json={"text": "  Salom, bu mening ovozim.  ", "language": "uz"})

    STT_TRANSPORT[0] = httpx.MockTransport(handler)
    yield log
    STT_TRANSPORT[0] = None
    http.set_transport(None)


STT_TRANSPORT: list[httpx.MockTransport | None] = [None]


def _use_profile(monkeypatch: pytest.MonkeyPatch, name: str, tmp: Path) -> None:
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    for key, value in GOLDEN["profiles"][name].items():
        monkeypatch.setenv(key, str(tmp / "no-zipformer") if key == "ZIPFORMER_MODEL_DIR" else value)
    monkeypatch.setenv("LLM_FALLBACK_MODEL", "off")
    _reset_provider_state()  # (also drops the HTTP transport: put the scripted STT back)
    http.set_transport(STT_TRANSPORT[0])


def _diff(got: Any, want: Any, path: str = "") -> dict[str, Any]:  # noqa: ANN401
    """Where two JSON values differ (empty when equal), for readable failures."""
    if isinstance(got, dict) and isinstance(want, dict):
        out: dict[str, Any] = {}
        for k in {*got, *want}:
            out.update(_diff(got.get(k, "<missing>"), want.get(k, "<missing>"), f"{path}.{k}"))
        return out
    if isinstance(got, list) and isinstance(want, list) and len(got) == len(want):
        out = {}
        for i, (g, w) in enumerate(zip(got, want, strict=True)):
            out.update(_diff(g, w, f"{path}[{i}]"))
        return out
    return {} if got == want else {path: (got, want)}


def _view_path(step: dict[str, Any]) -> str:
    query = step["args"] or {}
    return f"/views/{step['name']}" + ("?" + "&".join(f"{k}={v}" for k, v in query.items()) if query else "")


def _proxy(name: str, status: int, body: Any) -> tuple[Any, str | None, list, str | None]:  # noqa: ANN401
    """(return value, error, revalidatePath calls, redirect) of the TypeScript proxy for this Python answer."""
    if status == 403:
        assert body == {"error": "forbidden"}
        return None, "forbidden", [], None
    assert status == 200, body
    ok = isinstance(body, dict) and body.get("ok")
    if name == "saveAgentAction":
        return body, None, AGENT_PAGES if ok else [], None
    if name in ("setAgentStatusAction", "createAgentAction"):
        return body, None, AGENT_PAGES, None
    if name == "setDefaultLlmAction":
        return body, None, [["/app", "layout"]] if ok else [], None
    if name in ("createDesignVoiceAction", "createCloneVoiceAction", "deleteCustomVoiceAction"):
        return body, None, VOICE_PAGES if ok else [], None
    if name == "endPlaygroundCallAction":
        return {"ok": body["ok"]}, None, [["/app"]] if body["closed"] else [], None
    if name in ("completeOnboardingAction", "skipOnboardingAction"):
        return (None, None, [["/app", "layout"]], "/app") if ok else (body, None, [], None)
    return body, None, [], None


def test_pages_and_actions_match_the_typescript(
    data_dir: Path, fixed_ids: list[int], stt_log: list, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from app.main import create_app

    _seed(data_dir)
    mask = Masker()
    rows = Rows(data_dir / "ovoz.db", mask)
    locales = {u["id"]: u["locale"] for u in GOLDEN["seed"]["users"]}
    with TestClient(create_app()) as client:
        for i, step in enumerate(GOLDEN["steps"]):
            where = f"step {i}: {step['user']} {step['kind']} {step['name']} {json.dumps(step['args'])[:80]}"
            _use_profile(monkeypatch, step["profile"], tmp_path)
            client.cookies.set(COOKIE, _token(step["user"]))
            if step["kind"] == "sql":
                con = sqlite3.connect(data_dir / "ovoz.db")
                for statement in step["args"]:
                    con.execute(statement.replace("$RUN_START", mask.run_start))
                con.commit()
                con.close()
            elif step["kind"] == "view":
                if "redirect" in step:  # the TypeScript page redirects before it asks for data
                    continue
                res = client.get(_view_path(step))
                assert res.status_code == 200, where
                data = mask(res.json())
                if "element" in step:  # the agent page's "No agent yet"
                    assert data == {"agent": None}, where
                else:
                    if step["name"] == "playground" and data["engine"] is None:
                        data["engine"] = GOLDEN["localSynth"][locales[step["user"]]]
                    expected = dict(step["props"])
                    if step["name"] == "agent":
                        assert data["agent"]["id"] == step["key"], where
                    if step["name"] == "onboarding":
                        # The page still takes these three from its own session (as before).
                        user = next(u for u in GOLDEN["seed"]["users"] if u["id"] == step["user"])
                        tenant = next(t for t in GOLDEN["seed"]["tenants"] if t["id"] == user["tenant_id"])
                        session_fields = {
                            "company": tenant["name"],
                            "userName": user["name"],
                            "industry": tenant["industry"],
                        }
                        assert {k: expected.pop(k) for k in session_fields} == session_fields, where
                    assert data == expected, where
            elif step["kind"] == "form":
                fields = [(k, v) for k, v in step["args"] if not isinstance(v, dict)]
                files = [
                    (k, (v["name"], io.BytesIO(__import__("base64").b64decode(v["b64"])), v["type"]))
                    for k, v in step["args"]
                    if isinstance(v, dict)
                ]
                res = client.post(f"/actions/{step['name']}", data=dict(fields), files=files or None)
                result, error, revalidate, redirect = _proxy(step["name"], res.status_code, mask(res.json()))
                assert (result, error, revalidate, redirect) == (
                    step["result"],
                    step["error"],
                    step["revalidate"],
                    step["redirect"],
                ), where
                listing = sorted((f.name, f.stat().st_size) for f in (data_dir / "uploads").iterdir())
                assert [{"name": n, "size": s} for n, s in listing] == step["uploads"], where
            else:
                res = client.post(f"/actions/{step['name']}", json=step["args"])
                result, error, revalidate, redirect = _proxy(step["name"], res.status_code, mask(res.json()))
                assert (result, error, revalidate, redirect) == (
                    step["result"],
                    step["error"],
                    step["revalidate"],
                    step["redirect"],
                ), where
            assert _diff(rows.changes(), step["rows"]) == {}, where
    assert stt_log == GOLDEN["sttRequests"]
    assert fixed_ids[0] == GOLDEN["idsUsed"]


@pytest.mark.parametrize("case", GOLDEN["scoring"], ids=lambda c: c["ref"][:24])
def test_scoring_matches_the_typescript(case: dict[str, Any]) -> None:
    assert normalize_for_scoring(case["ref"]) == case["normRef"]
    assert normalize_for_scoring(case["heard"]) == case["normHeard"]
    assert score(case["ref"], case["heard"]) == case["score"]


def test_benchmark_and_lab_match_the_typescript(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bench = GOLDEN["benchmark"]
    _seed(data_dir)
    mask = Masker()
    rows = Rows(data_dir / "ovoz.db", mask)

    steps = bench["clockSteps"]
    clock = {"at": 1000.0, "i": 0}

    def clock_ms() -> float:
        clock["at"] += steps[clock["i"] % len(steps)]
        clock["i"] += 1
        return clock["at"]

    async def transcribe_one(engine: str, audio: bytes, language: str | None = None) -> dict:
        heard = bench["stt"][engine][bench["clipSha1"].index(hashlib.sha1(audio).hexdigest())]  # noqa: S324
        if heard is None:
            raise RuntimeError(f"{engine} failed")
        return {"text": heard, "engine": engine, "language": "uz"}

    async def render_timed(sentence: str, opts) -> dict:  # noqa: ANN001
        out = bench["tts"][opts.engine][benchmark.TTS_SENTENCES.index(sentence)]
        if not out or opts.tenant_id != "bench" or opts.language != "uz":
            raise RuntimeError("render failed")
        pcm = bytes([len(opts.voice_id)]) * out["pcmBytes"]
        return {"pcm": pcm, "firstMs": out["firstMs"], "totalMs": out["totalMs"], "spoken": out["spoken"]}

    def transcribe_wav(wav: bytes) -> str:
        heard = bench["heard"].get(str(len(wav)))
        if heard is None:
            raise RuntimeError("zipformer failed")
        return heard

    async def generate_answer(inp, on_delta=None) -> dict:  # noqa: ANN001
        script = bench["llm"].get(inp.llm) or [{"deltas": 1, "answer": "Javob", "engine": "x"}] * 3
        out = script[benchmark.LLM_QUESTIONS.index(inp.question)]
        if not out:
            raise RuntimeError("model failed")
        for _ in range(out["deltas"]):
            on_delta("piece")
        return {"answer": out["answer"], "engine": out["engine"], "intent": "faq", "answered": True, "usedHits": []}

    def ready(p: str) -> bool:
        return p in bench["llmReady"]

    monkeypatch.setattr(benchmark, "clock_ms", clock_ms)
    monkeypatch.setattr(benchmark, "stt_engine_ids", lambda: dict(bench["sttReady"]))
    monkeypatch.setattr(benchmark, "transcribe_one", transcribe_one)
    monkeypatch.setattr(benchmark, "tts_engines", lambda: dict(bench["ttsReady"]))
    monkeypatch.setattr(benchmark, "render_timed", render_timed)
    monkeypatch.setattr(zipformer, "zipformer_available", lambda: bench["zipformer"])
    monkeypatch.setattr(zipformer, "transcribe_wav", transcribe_wav)
    monkeypatch.setattr(benchmark, "llm_provider_ready", ready)
    monkeypatch.setattr(benchmark, "generate_answer", generate_answer)
    monkeypatch.setattr(model_lab, "stt_engine_ids", lambda: dict(bench["sttReady"]))
    monkeypatch.setattr(model_lab, "tts_engines", lambda: dict(bench["ttsReady"]))
    monkeypatch.setattr(model_lab, "llm_provider_ready", ready)
    assert len(pcm_to_wav(b"\0" * 1000)) == 1044  # the WAV sizes the scripted Zipformer keys on

    assert asyncio.run(benchmark.run_benchmark("build-42")) is bench["first"]
    assert rows.changes() == bench["rows"]
    assert asyncio.run(benchmark.run_benchmark("build-42")) is bench["again"]
    assert mask(benchmark.latest_benchmarks()) == bench["latest"]
    assert mask(model_lab.model_stats()) == bench["stats"]
