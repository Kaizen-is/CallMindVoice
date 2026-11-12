"""
The Python turn engine against the ORIGINAL TypeScript on a real database, recorded in
fixtures/golden_turn.json by scratchpad/golden/make-golden-turn.cjs: the same agents, knowledge
base and caller lines, with the local answer engine. Every turn's result, every row written
(turns, calls, knowledge gaps, escalations, daily usage, wallet) and every bus event must match.
"""

import asyncio
import base64
import json
import sqlite3
from pathlib import Path

from app import background
from app.engine import bus, calls, conversation

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_turn.json").read_text(encoding="utf-8"))
STAMP = "2026-11-12T05:00:00.000Z"


def _seed(db_path: Path) -> None:
    con = sqlite3.connect(db_path)
    for table, rows in GOLDEN["seed"].items():
        for row in rows:
            values = [base64.b64decode(v["b64"]) if isinstance(v, dict) else v for v in row.values()]
            con.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})", values)
    con.commit()
    con.close()


def _rows(db_path: Path, sql: str, *params) -> list[dict]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def _timings_view(raw: str | None) -> str | None:
    if not raw or raw == "{}":
        return raw
    t = json.loads(raw)
    return f"{','.join(t)}|tts={t['ttsMs']}|stt={t['sttMs']}"


def _mask_event(e: dict) -> dict:
    out = dict(e)
    for key in ("callId", "escalationId", "latencyMs"):
        if key in out:
            out[key] = "x"
    return out


def test_turns_match_typescript(data_dir: Path) -> None:
    db_path = data_dir / "ovoz.db"
    _seed(db_path)
    events: list[dict] = []
    unsubscribe = bus.subscribe("t1", events.append)

    async def run() -> list[dict]:
        out = []
        for sc in GOLDEN["scripts"]:
            agent = _rows(db_path, "SELECT * FROM agents WHERE id = ?", sc["agent"])[0]
            call_id = calls.start_call(
                tenant_id="t1",
                agent_id=agent["id"],
                from_="+998901112233",
                to="+998712000000",
                channel=sc["channel"],
                language=agent["primary_lang"],
                started_at=STAMP,
            )
            results = []
            for i, line in enumerate(sc["lines"]):
                r = await conversation.run_turn(
                    tenant_id="t1", call_id=call_id, agent=agent, utterance=line, stt_ms=100 + i
                )
                r["timings"] = {"sttMs": r["timings"]["sttMs"], "ttsMs": r["timings"]["ttsMs"]}
                results.append(r)
            ended = None
            if sc.get("end"):
                e = sc["end"]
                res = calls.end_call(
                    tenant_id="t1", call_id=call_id, outcome=e["outcome"], csat=e["csat"], ended_at=e["endedAt"]
                )
                ended = {"durationMs": res["durationMs"], "cost": res["cost"]}
            out.append({"call_id": call_id, "results": results, "ended": ended})
        await background.drain()
        return out

    produced = asyncio.run(run())
    unsubscribe()

    for sc, got in zip(GOLDEN["scripts"], produced, strict=True):
        for ts, py in zip(sc["results"], got["results"], strict=True):
            ts = {**ts, "callId": got["call_id"]}
            assert py == ts, sc["name"]
        assert got["ended"] == sc.get("ended"), sc["name"]
        turns = _rows(
            db_path,
            "SELECT ordinal, role, text, language, confidence, citations_json, timings_json,"
            " latency_ms IS NOT NULL AS has_latency FROM turns WHERE call_id = ? ORDER BY ordinal",
            got["call_id"],
        )
        for t in turns:
            t["timings_json"] = _timings_view(t["timings_json"])
        assert turns == sc["turns"], sc["name"]
        call = _rows(
            db_path,
            "SELECT direction, channel, status, outcome, language, intent, sentiment, confidence, csat, turns,"
            " duration_ms, first_response_ms IS NOT NULL AS has_frm, avg_latency_ms IS NOT NULL AS has_avg, cost_usd,"
            " escalated, escalation_reason, summary, answered_at IS NOT NULL AS answered, ended_at"
            " FROM calls WHERE id = ?",
            got["call_id"],
        )[0]
        assert call == sc["call"], sc["name"]
        escalations = _rows(
            db_path, "SELECT reason, priority, status, summary FROM escalations WHERE call_id = ?", got["call_id"]
        )
        assert escalations == sc["escalations"], sc["name"]

    assert (
        _rows(db_path, "SELECT question, hits, best_score, status FROM knowledge_gaps ORDER BY question")
        == GOLDEN["gaps"]
    )
    assert (
        _rows(
            db_path,
            "SELECT day, calls, ai_resolved, escalated, abandoned, minutes, cost_usd, csat_sum, csat_count"
            " FROM usage_daily ORDER BY day",
        )
        == GOLDEN["usageDaily"]
    )
    wallet = {
        "balance": _rows(db_path, "SELECT balance_uzs FROM tenants WHERE id = 't1'")[0]["balance_uzs"],
        "ledger": _rows(
            db_path, "SELECT kind, amount_uzs, balance_after, note FROM wallet_ledger ORDER BY created_at, rowid"
        ),
    }
    assert wallet == GOLDEN["wallet"]
    assert [_mask_event(e) for e in events] == GOLDEN["events"]
