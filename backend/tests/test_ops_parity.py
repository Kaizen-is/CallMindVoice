"""
The traffic simulator and the demo-history generator against the ORIGINAL TypeScript, recorded in
fixtures/golden_ops.json by tools/golden/make-golden-ops.cjs: the same seeds, agent, phone number
and knowledge base, the local answer engine, the clock pinned and the zone Asia/Tashkent. The
random streams, every row written (calls, turns, escalations, daily usage, invoices) and every bus
event must match; only measured latencies are left out (the fixture masks them too).
"""

import asyncio
import base64
import calendar
import json
import sqlite3
import sys
import time
from pathlib import Path

import pytest

from app import background
from app.engine import bus, demo_data, simulator
from app.engine.rng import seeded_random

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = json.loads((FIXTURES / "golden_ops.json").read_text(encoding="utf-8"))
RAG = json.loads((FIXTURES / "golden_rag.json").read_text(encoding="utf-8"))
NOW = GOLDEN["now"]
TASHKENT = 5 * 3600  # UTC+5 all year
LATENCY = ("latency_ms", "first_response_ms", "avg_latency_ms", "p95_latency_ms")


def _seed(db_path: Path) -> None:
    con = sqlite3.connect(db_path)
    for table in ("tenants", "agents", "phone_numbers", "documents"):
        for row in GOLDEN["seed"][table]:
            placeholders = ",".join("?" * len(row))
            con.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({placeholders})", list(row.values()))
    for i, c in enumerate(RAG["corpus"]):
        con.execute(
            "INSERT INTO chunks (id, tenant_id, document_id, ordinal, heading, text, token_count, embedding, "
            "terms_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (c["id"], "t1", c["document_id"], i, c["heading"], c["text"], c["token_count"],
             base64.b64decode(c["embedding"]), c["terms_json"], "2026-11-01T05:00:00.000Z"),
        )  # fmt: skip
    con.commit()
    con.close()


def _rows(db_path: Path, sql: str, *params) -> list[dict]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params).fetchall()]
    finally:
        con.close()


def _mask(row: dict) -> dict:
    out = dict(row)
    for k in LATENCY:
        if k in out and out[k] is not None:
            out[k] = "x"
    if out.get("timings_json") not in (None, "", "{}"):
        out["timings_json"] = ",".join(json.loads(out["timings_json"]))
    return out


def _no_id(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "id"}


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch) -> None:
    """The TypeScript run's clock and zone: time stands still at NOW, wall clock in Asia/Tashkent."""
    for name, module in list(sys.modules.items()):
        if name.startswith("app") and callable(getattr(module, "now_iso", None)):
            monkeypatch.setattr(module, "now_iso", lambda: NOW)
    monkeypatch.setattr(demo_data, "now_ms", lambda: demo_data.parse_ms(NOW))
    monkeypatch.setattr(demo_data, "to_local", lambda seconds: time.gmtime(seconds + TASHKENT))
    monkeypatch.setattr(demo_data, "from_local", lambda wall: calendar.timegm((*wall, 0, 0, 0)) - TASHKENT)
    monkeypatch.setattr(simulator, "TIME_SCALE", 0.0)


def test_seeded_random_matches_javascript() -> None:
    for seed, expected in GOLDEN["random"].items():
        rng = seeded_random(seed)
        values = [rng() for _ in range(8)]
        for _ in range(8, 999):
            rng()
        values.append(rng())
        assert values == expected, seed


def test_simulated_calls_match_typescript(data_dir: Path, frozen: None) -> None:
    db_path = data_dir / "ovoz.db"
    _seed(db_path)
    events: list[dict] = []
    unsubscribe = bus.subscribe("t1", events.append)

    async def run() -> list[dict]:
        out = []
        for case in GOLDEN["simulator"]:
            events.clear()
            call_id = simulator.simulate_call(
                "t1", seed=case["seed"], language=case.get("language"), difficulty=case.get("difficulty"), speed=1e9
            )
            load_at_start = simulator.simulator_load("t1")
            while simulator.simulator_load("t1") > 0:
                await asyncio.sleep(0.002)
            await background.drain()
            out.append(
                {
                    "loadAtStart": load_at_start,
                    "rows": {
                        "call": _mask(_no_id(_rows(db_path, "SELECT * FROM calls WHERE id = ?", call_id)[0])),
                        "turns": [
                            _mask(_no_id({**t, "call_id": "x"}))
                            for t in _rows(db_path, "SELECT * FROM turns WHERE call_id = ? ORDER BY ordinal", call_id)
                        ],
                        "escalations": [
                            _no_id({**e, "call_id": "x"})
                            for e in _rows(db_path, "SELECT * FROM escalations WHERE call_id = ?", call_id)
                        ],
                    },
                    "events": [
                        {
                            **e,
                            "callId": "x",
                            **({"escalationId": "x"} if "escalationId" in e else {}),
                            **({"latencyMs": "x"} if "latencyMs" in e else {}),
                        }
                        for e in events
                    ],  # fmt: skip
                }
            )
        return out

    try:
        got = asyncio.run(run())
    finally:
        unsubscribe()
    assert len(got) == len(GOLDEN["simulator"])
    outcomes = set()
    for case, mine in zip(GOLDEN["simulator"], got, strict=True):
        assert mine["loadAtStart"] == case["loadAtStart"], case["seed"]
        assert mine["rows"] == case["rows"], case["seed"]
        assert mine["events"] == case["events"], case["seed"]
        outcomes.add((case["rows"]["call"]["outcome"], case["rows"]["call"]["csat"]))
    # The fixture covers every ending: answered (each CSAT), abandoned, handed to an operator.
    assert {o for o, _ in outcomes} == {"resolved_by_ai", "abandoned", None}
    assert {c for _, c in outcomes} >= {2, 3, 4, 5}


def _demo_tables(db_path: Path) -> dict:
    measured = {
        r["d"]
        for r in _rows(
            db_path,
            "SELECT DISTINCT substr(ended_at, 1, 10) AS d FROM calls "
            "WHERE id IN (SELECT call_id FROM turns WHERE latency_ms IS NOT NULL)",
        )
    }
    return {
        "calls": [
            _mask(_no_id(c)) for c in _rows(db_path, "SELECT * FROM calls ORDER BY started_at, from_e164, caller_name")
        ],
        "escalations": [
            _no_id({**e, "call_id": "x"})
            for e in _rows(
                db_path,
                "SELECT e.*, c.started_at AS call_started, c.from_e164 AS call_from FROM escalations e "
                "JOIN calls c ON c.id = e.call_id ORDER BY c.started_at, c.from_e164, e.created_at",
            )
        ],
        "usage_daily": [
            _no_id({**u, "avg_latency_ms": "x"} if u["day"] in measured else u)
            for u in _rows(db_path, "SELECT * FROM usage_daily ORDER BY day")
        ],
        "invoices": [_no_id(i) for i in _rows(db_path, "SELECT * FROM invoices ORDER BY period")],
    }


def test_demo_history_matches_typescript(data_dir: Path, frozen: None) -> None:
    db_path = data_dir / "ovoz.db"
    _seed(db_path)
    want = GOLDEN["demo"]

    first = asyncio.run(demo_data.seed_demo_history("t1", days=9, per_day=14, live_calls=4))
    assert first == want["first"]
    after_first = _demo_tables(db_path)
    for table in ("calls", "escalations", "usage_daily", "invoices"):
        assert after_first[table] == want["afterFirst"][table], table

    second = asyncio.run(demo_data.seed_demo_history("t1", days=9, per_day=14, live_calls=4))
    assert second == want["second"]
    after_second = _demo_tables(db_path)
    for table in ("calls", "escalations", "usage_daily", "invoices"):
        assert after_second[table] == want["afterSecond"][table], table

    assert demo_data.clear_demo_history("t1") == want["cleared"]
    assert asyncio.run(demo_data.seed_demo_history("nobody")) == want["noAgent"]


def test_local_time_rules_match_javascript_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    """`setHours` / `setMonth` overflow and `getDay`, in a fixed UTC+5 zone (values checked in Node)."""
    monkeypatch.setattr(demo_data, "to_local", lambda seconds: time.gmtime(seconds + TASHKENT))
    monkeypatch.setattr(demo_data, "from_local", lambda wall: calendar.timegm((*wall, 0, 0, 0)) - TASHKENT)
    ms = demo_data.parse_ms("2026-03-30T20:15:00.123Z")  # 31 March, 01:15 in Tashkent
    assert demo_data.js_day(ms) == 2  # a Tuesday there (still Monday in UTC)
    assert demo_data.iso(demo_data.set_hours(ms, 23, 59, 58, 0)) == "2026-03-31T18:59:58.000Z"
    # 31 March minus one month is "31 February": JavaScript rolls it over to 3 March.
    assert demo_data.iso(demo_data.add_months(ms, -1)) == "2026-03-02T20:15:00.123Z"
    assert demo_data.iso(demo_data.add_months(ms, -3)) == "2025-12-30T20:15:00.123Z"
    assert demo_data.iso(demo_data.add_months(ms, 10)) == "2027-01-30T20:15:00.123Z"
