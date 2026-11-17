"""
The phone-bridge routes (`app/routers/bridge.py`) against the ORIGINAL TypeScript
(src/app/api/telephony/bridge/*), recorded in fixtures/golden_bridge.json by
tools/golden/make-golden-bridge.cjs: the requests in tools/golden/scenarios-bridge.json, in order,
on one database, with the real call and turn engines and the same scripted TTS/STT. Every status,
header and body must match, and so must the calls and turns each request touched, the daily
usage, the wallet and the escalations.
"""

import base64
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.jscompat import js_json, js_json_parse
from app.routers import bridge
from app.speech import fillers
from app.speech.stt import SttError
from app.speech.tts import TtsError

ROOT = Path(__file__).parents[1]
SPEC = json.loads((ROOT / "tools" / "golden" / "scenarios-bridge.json").read_text(encoding="utf-8"))
GOLDEN = json.loads((ROOT / "tests" / "fixtures" / "golden_bridge.json").read_text(encoding="utf-8"))
HEADERS = (
    "content-type", "cache-control", "x-ovoz-callid", "x-ovoz-escalate", "x-ovoz-text", "x-ovoz-engine", "x-ovoz-count",
)  # fmt: skip
SEEDED = {c["id"] for c in SPEC["seed"]["calls"]}


# ── the scripted speech of make-golden-bridge.cjs ───────────────────


def _flag(value: object) -> str:
    return "true" if value else "false"


async def _synthesize_pcm(text: object, opts) -> bytes:  # noqa: ANN001
    if not isinstance(text, str):
        raise TypeError("Cannot read properties of undefined (reading 'replace')")
    if opts.voice_id == "boom":
        raise TtsError("tts_unavailable", 503)
    return f"pcm|{opts.tenant_id}|{opts.tag}|{opts.language}|{opts.voice_id}|{_flag(opts.cache)}|{text}".encode()


async def _synthesize_stream(text: str, opts):  # noqa: ANN001, ANN202
    yield f"stream|{opts.tenant_id}|{opts.tag}|{opts.language}|{opts.voice_id}|{_flag(opts.cache)}|".encode()
    for i, word in enumerate(text.split(" ")):
        if opts.voice_id == "crack":
            raise TtsError("tts_cut", 502)
        yield f"{i}:{word}|".encode()


async def _transcribe(audio: bytes, *, language: str | None = None, **_: Any) -> dict:
    said = audio.decode("utf-8")
    if said == "":
        raise SttError("empty_audio", 400)
    if said == "FAIL":
        raise SttError("stt_unreachable", 503)
    if said == "CRASH":
        raise Exception("socket hang up")  # noqa: TRY002 - a plain Error, as in the script
    if said == "SILENCE":
        return {"text": "", "engine": "kotib", "language": None}
    return {"text": said, "engine": f"kotib-{language}", "language": language}


# ── replay ──────────────────────────────────────────────────────────


def _seed(db_path: Path) -> None:
    con = sqlite3.connect(db_path)
    for table, rows in SPEC["seed"].items():
        for row in rows:
            con.execute(
                f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})", list(row.values())
            )
    con.commit()
    con.close()


def _rows(db_path: Path, sql: str, *params: object) -> list[dict]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def _typeof(value: object) -> str:
    if value is None:
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return "string"


def _call_view(db_path: Path, call_id: str, unstable: bool) -> dict | None:
    rows = _rows(
        db_path,
        """SELECT tenant_id, agent_id, number_id, direction, channel, from_e164, to_e164, status, outcome, language,
             intent, turns, duration_ms, cost_usd, escalated, escalation_reason, answered_at IS NOT NULL AS answered,
             ended_at FROM calls WHERE id=?""",
        call_id,
    )
    if not rows:
        return None
    call = rows[0]
    if unstable or call_id not in SEEDED:
        call["ended_at"] = "x" if call["ended_at"] else None
    if unstable:
        call["duration_ms"] = _typeof(call["duration_ms"])
        call["cost_usd"] = _typeof(call["cost_usd"])
    turns = _rows(
        db_path,
        "SELECT ordinal, role, text, language, confidence, latency_ms IS NOT NULL AS has_latency "
        "FROM turns WHERE call_id=? ORDER BY ordinal",
        call_id,
    )
    return {"call": call, "turns": turns}


def _finals(db_path: Path) -> dict:
    return {
        "usageDaily": _rows(
            db_path,
            "SELECT day, calls, ai_resolved, escalated, abandoned, minutes, cost_usd, csat_sum, csat_count "
            "FROM usage_daily WHERE day='2026-11-12' ORDER BY day",
        ),
        "wallet": {
            "balance": _rows(db_path, "SELECT balance_uzs FROM tenants WHERE id='t1'")[0]["balance_uzs"],
            "ledger": _rows(
                db_path,
                "SELECT kind, amount_uzs, balance_after, note FROM wallet_ledger WHERE tenant_id='t1' "
                "ORDER BY created_at, rowid",
            ),
        },
        "escalations": _rows(db_path, "SELECT call_id, reason, priority, status FROM escalations ORDER BY call_id"),
        "callCount": _rows(db_path, "SELECT COUNT(*) AS n FROM calls")[0]["n"],
    }


def _send(client: TestClient, sc: dict):  # noqa: ANN202
    url = f"/api/telephony/bridge/{sc['route']}"
    if "qs" in sc:
        url += f"?{sc['qs']}"
    headers: dict[str, str] = {}
    auth = sc.get("auth", "ok")
    secret = SPEC["secret"]
    if auth == "ok":
        headers["x-bridge-secret"] = secret
    elif auth == "wrong":
        headers["x-bridge-secret"] = secret[:-1] + "X"
    elif auth == "short":
        headers["x-bridge-secret"] = secret[:-1]
    if sc["route"] == "filler":
        return client.get(url, headers=headers)
    if "form" in sc:
        parts = [
            (name, (None, value) if isinstance(value, str) else ("utterance.wav", value["file"].encode(), "audio/wav"))
            for name, value in sc["form"]
        ]
        return client.post(url, headers=headers, files=parts)
    content_type = sc.get("contentType", "application/json")
    if content_type:
        headers["content-type"] = content_type
    return client.post(url, headers=headers, content=sc["raw"].encode())


def _touched(sc: dict, minted: str | None) -> str | None:
    if minted:
        return minted
    if "form" in sc:
        return next((v for n, v in sc["form"] if n == "callId"), None) or None
    if sc["route"] == "end":
        try:
            parsed = js_json_parse(sc["raw"].encode())
            value = parsed.get("callId") if isinstance(parsed, dict) else None
        except ValueError:
            return None
        if value is None:
            return None
        text = value if isinstance(value, str) else str(value)
        return text.strip() or None
    return None


@pytest.fixture
def replay(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    """Every scenario run against the Python routes: {'results': [...], 'finals': {...}}."""
    from app.main import create_app

    monkeypatch.setattr(bridge, "synthesize_pcm", _synthesize_pcm)
    monkeypatch.setattr(bridge, "synthesize_stream", _synthesize_stream)
    monkeypatch.setattr(bridge, "transcribe", _transcribe)
    monkeypatch.setattr(fillers, "synthesize_pcm", _synthesize_pcm)
    db_path = data_dir / "ovoz.db"
    _seed(db_path)

    out: dict[str, Any] = {"results": []}
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        for sc in SPEC["scenarios"]:
            if sc.get("unstable") and "finals" not in out:
                out["finals"] = _finals(db_path)
            env = sc.get("env", "set")
            if env == "unset":
                monkeypatch.delenv("BRIDGE_SHARED_SECRET", raising=False)
            else:
                monkeypatch.setenv("BRIDGE_SHARED_SECRET", SPEC["secret"] if env == "set" else "")
            res = _send(client, sc)
            if res.status_code == 500:
                out["results"].append({"name": sc["name"], "status": 500})
                continue
            headers = {h: res.headers[h] for h in HEADERS if h in res.headers}
            body = res.content.decode("utf-8")
            call_id = headers.get("x-ovoz-callid")
            minted = call_id if call_id and call_id not in SEEDED else None
            if minted:
                headers["x-ovoz-callid"] = f"minted:{minted.split('_')[0]}"
            if sc["route"] == "end" and headers.get("content-type") == "application/json":
                # avg/p95 are measured turn latencies; an unstable scenario's end time is "now".
                parsed = json.loads(body)
                for key in ("durationMs", "cost", "avg", "p95") if sc.get("unstable") else ("avg", "p95"):
                    if key in parsed:
                        parsed[key] = _typeof(parsed[key])
                body = js_json(parsed)
            touched = _touched(sc, minted)
            out["results"].append(
                {
                    "name": sc["name"],
                    "status": res.status_code,
                    "headers": headers,
                    "body": body,
                    "touched": touched and _call_view(db_path, touched, bool(sc.get("unstable"))),
                }
            )
    out.setdefault("finals", _finals(db_path))
    return out


def test_scenarios_and_fixture_line_up() -> None:
    assert [s["name"] for s in SPEC["scenarios"]] == [r["name"] for r in GOLDEN["results"]]


@pytest.mark.parametrize("index", range(len(GOLDEN["results"])), ids=[r["name"] for r in GOLDEN["results"]])
def test_response_matches_typescript(replay: dict, index: int) -> None:
    want = dict(GOLDEN["results"][index])
    if "threw" in want:  # an unhandled throw: Next.js answers 500
        want = {"name": want["name"], "status": 500}
    assert replay["results"][index] == want


def test_usage_wallet_and_escalations_match_typescript(replay: dict) -> None:
    assert replay["finals"] == GOLDEN["finals"]


def test_reply_text_header_is_utf8_base64() -> None:
    headers = bridge._headers("c1", "", "To‘lov 😀 \ud83d", "kotib")
    assert base64.b64decode(headers["x-ovoz-text"]).decode("utf-8") == "To‘lov 😀 �"
