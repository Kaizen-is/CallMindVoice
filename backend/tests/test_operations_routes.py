"""
Calls and operations served by Python (`app/routers/operations.py`, `app/routers/v1_calls.py`, the
401 of `/stream`): the console actions of src/app/actions/ops.ts (simulator, demo data,
escalations, operator inbox) with their role checks, audit rows and return values, the page data
of the inbox, call history, call detail and live wallboard, and the public /v1/calls and
/v1/answer. Compared against the TypeScript side by side on a copy of the real database too; the
simulator and demo history are replayed against golden fixtures in test_ops_parity.py.
"""

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app import background
from app.auth import COOKIE, api_key_hash, encode_session
from app.engine import bus, simulator
from app.ids import to_iso
from tests.conftest import SECRET
from tests.test_system import _seed_user

TENANT = "ten_test000000000001"
OWNER = "usr_test000000000001"  # role admin (see _seed_user)
NOW = "2026-11-12T00:00:00.000Z"


def _iso(minutes_ago: float) -> str:
    return to_iso(datetime.now(UTC) - timedelta(minutes=minutes_ago))


def _user(sql, role: str) -> str:  # noqa: ANN001
    uid, sid = f"usr_{role}", f"ses_{role}"
    sql(
        "INSERT INTO users (id, tenant_id, email, name, password_hash, role, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        uid, TENANT, f"{role}@example.uz", role.title(), "x", role, "active", NOW, NOW,
    )  # fmt: skip
    sql(
        "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at) VALUES (?,?,?,?,?)",
        sid, uid, TENANT, NOW, _iso(-60 * 24),
    )  # fmt: skip
    return encode_session(sid, SECRET)


def _agent(sql, agent_id: str = "agt_test000000000001") -> str:  # noqa: ANN001
    sql(
        "INSERT INTO agents (id, tenant_id, name, status, greeting, primary_lang, languages_json, max_turns, "
        "confidence_threshold, escalation_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        agent_id, TENANT, "Laylo", "live", "Salom", "uz", '["uz","ru"]', 20, 0.3, '{"onLowConfidence":false}', NOW, NOW,
    )  # fmt: skip
    return agent_id


def _call(sql, call_id: str, **cols) -> str:  # noqa: ANN001
    row = {
        "id": call_id, "tenant_id": TENANT, "channel": "voice", "from_e164": "+998901112233",
        "to_e164": "+998712000000", "status": "completed", "language": "uz", "started_at": NOW, **cols,
    }  # fmt: skip
    sql(f"INSERT INTO calls ({','.join(row)}) VALUES ({','.join('?' * len(row))})", *row.values())
    return call_id


def _turn(sql, call_id: str, ordinal: int, role: str, text: str, **cols) -> None:  # noqa: ANN001
    row = {
        "id": f"trn_{call_id[-6:]}{ordinal:02d}", "tenant_id": TENANT, "call_id": call_id, "ordinal": ordinal,
        "role": role, "text": text, "created_at": NOW, **cols,
    }  # fmt: skip
    sql(f"INSERT INTO turns ({','.join(row)}) VALUES ({','.join('?' * len(row))})", *row.values())


def _escalation(sql, esc_id: str, call_id: str, **cols) -> str:  # noqa: ANN001
    row = {
        "id": esc_id, "tenant_id": TENANT, "call_id": call_id, "reason": "low_confidence", "priority": "normal",
        "status": "waiting", "created_at": NOW, **cols,
    }  # fmt: skip
    sql(f"INSERT INTO escalations ({','.join(row)}) VALUES ({','.join('?' * len(row))})", *row.values())
    return esc_id


@pytest.fixture
def api(data_dir, sql) -> Iterator[TestClient]:  # noqa: ANN001
    """Logged in as the owner (role admin), on one event loop for the background calls."""
    from app.main import create_app

    sid = _seed_user(sql)
    with TestClient(create_app(), raise_server_exceptions=False) as client:
        client.cookies.set(COOKIE, encode_session(sid, SECRET))
        yield client


@pytest.fixture
def fast_simulator(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(simulator, "TIME_SCALE", 0.0)
    simulator._running.clear()
    yield
    simulator._running.clear()


def _as(client: TestClient, token: str | None) -> TestClient:
    client.cookies.clear()
    if token:
        client.cookies.set(COOKIE, token)
    return client


# ── role checks ─────────────────────────────────────────────────────

OPERATOR_ACTIONS = [
    "simulateCallAction", "simulateBurstAction", "stopSimulationAction", "acceptEscalationAction",
    "resolveEscalationAction", "operatorReplyAction", "refreshSummaryAction",
]  # fmt: skip
ADMIN_ACTIONS = ["seedDemoHistoryAction", "clearHistoryAction"]
SESSION_ONLY = ["simulatorStatusAction", "inboxAction"]


def test_actions_need_login_and_role(api: TestClient, sql) -> None:  # noqa: ANN001
    analyst, operator = _user(sql, "analyst"), _user(sql, "operator")
    for name in OPERATOR_ACTIONS + ADMIN_ACTIONS + SESSION_ONLY:
        res = _as(api, None).post(f"/actions/{name}", json={})
        assert (res.status_code, res.json()) == (401, {"error": "unauthorized"}), name
    for name in OPERATOR_ACTIONS + ADMIN_ACTIONS:
        res = _as(api, analyst).post(f"/actions/{name}", json={})
        assert (res.status_code, res.json()) == (403, {"error": "forbidden"}), name
    for name in ADMIN_ACTIONS:
        assert _as(api, operator).post(f"/actions/{name}", json={}).status_code == 403, name
    for name in SESSION_ONLY:
        assert _as(api, analyst).post(f"/actions/{name}").status_code == 200, name
    for path in ("/views/inbox", "/views/calls", "/views/calls/x", "/views/live"):
        assert _as(api, None).get(path).status_code == 401, path
    assert sql("SELECT COUNT(*) FROM audit_log") == [(0,)]


# ── escalations and the operator inbox ──────────────────────────────


def test_inbox_lists_open_voice_escalations_most_urgent_first(api: TestClient, sql) -> None:  # noqa: ANN001
    for cid in ("call_a", "call_b", "call_c", "call_web", "call_done"):
        _call(sql, cid, channel="web" if cid == "call_web" else "voice", caller_name=cid.upper())
    _turn(sql, "call_a", 0, "caller", "Salom", citations_json='[{"x":1}]', timings_json='{"sttMs":12}')
    _turn(sql, "call_a", 1, "system", "__unanswered__")
    _turn(sql, "call_a", 2, "agent", "Va alaykum", confidence=0.5)
    _escalation(sql, "esc_normal_old", "call_a", created_at="2026-11-11T00:00:00.000Z")
    _escalation(sql, "esc_urgent", "call_b", priority="urgent", created_at="2026-11-11T05:00:00.000Z")
    _escalation(sql, "esc_assigned", "call_c", status="assigned", operator_id=OWNER, priority="high")
    _escalation(sql, "esc_web", "call_web")
    _escalation(sql, "esc_resolved", "call_done", status="resolved")

    items = api.get("/views/inbox").json()
    assert [i["id"] for i in items] == ["esc_urgent", "esc_assigned", "esc_normal_old"]
    assert items[1]["operator_name"] == "Aziz"
    first = items[2]
    assert list(first)[-9:] == [
        "from_e164", "caller_name", "language", "started_at", "intent", "sentiment", "turns", "operator_name",
        "transcript",
    ]  # fmt: skip
    assert first["transcript"] == [
        {"ordinal": 0, "role": "caller", "text": "Salom", "confidence": None, "citations_json": '[{"x":1}]',
         "timings_json": '{"sttMs":12}', "created_at": NOW},
        {"ordinal": 2, "role": "agent", "text": "Va alaykum", "confidence": 0.5, "citations_json": "[]",
         "timings_json": "{}", "created_at": NOW},
    ]  # fmt: skip
    assert api.post("/actions/inboxAction").json() == items


def test_accept_reply_refresh_and_resolve(api: TestClient, sql) -> None:  # noqa: ANN001
    operator = _user(sql, "operator")
    _call(sql, "call_a", status="escalating", escalated=1, language="ru", started_at=_iso(3))
    _turn(sql, "call_a", 0, "caller", "Здравствуйте")
    _turn(sql, "call_a", 1, "agent", "Добрый день")
    _escalation(sql, "esc_a", "call_a", created_at=_iso(2))
    events: list[dict] = []
    unsubscribe = bus.subscribe(TENANT, events.append)
    try:
        _as(api, operator)
        res = api.post("/actions/acceptEscalationAction", json={"escalationId": "esc_a"}).json()
        assert res == {"ok": True, "callId": "call_a", "message": "You are on the call."}
        again = api.post("/actions/acceptEscalationAction", json={"escalationId": "esc_a"}).json()
        assert again == {"ok": False, "message": "Someone else already took this call."}

        reply = api.post("/actions/operatorReplyAction", json={"callId": "call_a", "text": "Слушаю вас"})
        assert reply.json() == {"ok": True}
        assert sql(
            "SELECT ordinal, role, text, language, citations_json, timings_json FROM turns WHERE role='operator'"
        ) == [(2, "operator", "Слушаю вас", "ru", "[]", "{}")]
        missing = api.post("/actions/operatorReplyAction", json={"callId": "call_x", "text": "?"}).json()
        assert missing == {"ok": False, "message": "Call not found."}

        summary = api.post("/actions/refreshSummaryAction", json={"escalationId": "esc_a"}).json()
        assert summary["ok"] is True and summary["summary"]
        assert sql("SELECT summary FROM escalations") == [(summary["summary"],)]
        assert sql("SELECT summary FROM calls") == [(summary["summary"],)]
        assert api.post("/actions/refreshSummaryAction", json={"escalationId": "esc_x"}).json() == {
            "ok": False,
            "message": "Escalation not found.",
        }

        res = api.post(
            "/actions/resolveEscalationAction",
            json={"escalationId": "esc_a", "resolution": "answered", "notes": "ok", "csat": 5},
        ).json()
        assert res == {"ok": True, "message": "Call closed."}
        assert sql("SELECT status, resolution, notes, handled_ms >= 0 FROM escalations") == [
            ("resolved", "answered", "ok", 1)
        ]
        assert sql("SELECT status, outcome, csat FROM calls") == [("completed", "resolved_by_operator", 5)]
        # Notes left out: the TypeScript default ''; null stays null.
        _call(sql, "call_b")
        _escalation(sql, "esc_b", "call_b")
        api.post("/actions/resolveEscalationAction", json={"escalationId": "esc_b", "resolution": "callback"})
        assert sql("SELECT notes FROM escalations WHERE id='esc_b'") == [("",)]
        unknown = api.post("/actions/resolveEscalationAction", json={"escalationId": "esc_x", "resolution": "x"})
        assert unknown.json() == {"ok": False, "message": "Escalation not found."}
    finally:
        unsubscribe()
    assert [e["type"] for e in events] == ["escalation_assigned", "escalation_resolved", "call_ended"] + [
        "escalation_resolved",
        "call_ended",
    ]
    assert sql("SELECT actor_id, action, target, meta_json FROM audit_log ORDER BY created_at, rowid") == [
        ("usr_operator", "escalation.accepted", "esc_a", '{"callId":"call_a"}'),
        ("usr_operator", "escalation.resolved", "esc_a", '{"resolution":"answered"}'),
        ("usr_operator", "escalation.resolved", "esc_b", '{"resolution":"callback"}'),
    ]


# ── call history and detail ─────────────────────────────────────────


def test_call_history_filters_and_pages_like_the_page(api: TestClient, sql) -> None:  # noqa: ANN001
    for i in range(55):
        _call(
            sql,
            f"call_{i:02d}",
            started_at=f"2026-11-10T00:{i:02d}:00.000Z",
            outcome="resolved_by_ai" if i % 3 else "abandoned",
            language="ru" if i % 5 == 0 else "uz",
            caller_name="Aziz Karimov" if i == 7 else None,
            escalated=1 if i in (3, 4) else 0,
        )
    _call(sql, "call_web", channel="web", started_at="2026-11-10T01:00:00.000Z")

    def page(query: str) -> dict:
        return api.get(f"/views/calls{query}").json()

    first = page("")
    assert first["paging"] == {"page": 1, "pages": 2, "total": 55, "pageSize": 50}
    assert first["calls"][0]["id"] == "call_54" and len(first["calls"]) == 50
    assert page("?page=2")["calls"][-1]["id"] == "call_00"
    # Number.parseInt(page, 10) || 1, clamped: junk, zero and negatives are page 1, too far is the last page.
    for query, want in [("?page=abc", 1), ("?page=0", 1), ("?page=-3", 1), ("?page=%202x", 2), ("?page=9e9", 2),
                        ("?page=99999999999999999999999", 2), ("?page=2&page=1", 2)]:  # fmt: skip
        assert page(query)["paging"]["page"] == want, query
    assert page("?outcome=escalated")["paging"]["total"] == 2
    assert page("?outcome=abandoned")["paging"]["total"] == 19
    assert page("?outcome=all&lang=all")["paging"]["total"] == 55
    assert page("?lang=ru")["paging"]["total"] == 11
    assert [c["id"] for c in page("?q=karimov")["calls"]] == ["call_07"]
    # A repeated key is an array in Next.js: bound as its JSON, so nothing matches.
    assert page("?outcome=abandoned&outcome=resolved_by_ai")["paging"]["total"] == 0
    assert page("?q=Aziz&q=Karimov")["paging"]["total"] == 0  # LIKE '%Aziz,Karimov%'


def test_call_detail(api: TestClient, sql) -> None:  # noqa: ANN001
    _call(sql, "call_a", summary="S")
    _turn(sql, "call_a", 0, "caller", "Salom")
    _turn(sql, "call_a", 1, "system", "__unanswered__")
    _turn(sql, "call_a", 2, "agent", "Javob", citations_json='[{"documentTitle":"D","score":0.5}]',
          timings_json='{"sttMs":1,"llmMs":2.5}', latency_ms=420)  # fmt: skip
    _turn(sql, "call_a", 3, "agent", "Buzuq", citations_json="{bad", timings_json="NaN")
    _escalation(sql, "esc_old", "call_a", created_at="2026-11-11T00:00:00.000Z")
    _escalation(sql, "esc_new", "call_a", created_at="2026-11-11T01:00:00.000Z", status="resolved")
    _call(sql, "call_other", tenant_id=TENANT)
    sql("INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('ten_2', 'B', 'b', ?, ?)", NOW, NOW)
    _call(sql, "call_foreign", tenant_id="ten_2")

    data = api.get("/views/calls/call_a").json()
    assert data["call"]["summary"] == "S"
    assert [t["ordinal"] for t in data["turns"]] == [0, 2, 3]
    assert data["turns"][1]["citations"] == [{"documentTitle": "D", "score": 0.5}]
    assert data["turns"][1]["timings"] == {"sttMs": 1, "llmMs": 2.5}
    assert (data["turns"][2]["citations"], data["turns"][2]["timings"]) == ([], {})  # bad JSON → fallback
    assert data["escalation"]["id"] == "esc_new"
    assert api.get("/views/calls/call_other").json()["escalation"] is None
    assert api.get("/views/calls/call_foreign").text == "null"
    assert api.get("/views/calls/nope%2Fx").text == "null"


# ── live wallboard ──────────────────────────────────────────────────


def test_live_board(api: TestClient, sql, fast_simulator) -> None:  # noqa: ANN001
    _call(sql, "call_stale", status="ringing", started_at=_iso(20))
    _call(sql, "call_live", status="active", started_at=_iso(1))
    _call(sql, "call_play", status="active", channel="web", started_at=_iso(1))
    _call(sql, "call_done", started_at=_iso(60), outcome="resolved_by_ai")
    for i, text in enumerate(["Salom", "__unanswered__", "Assalomu alaykum", "Narxi?"]):
        _turn(sql, "call_live", i, "caller" if i % 2 == 0 else "system", text, confidence=None)
    _escalation(sql, "esc_w", "call_live")

    board = api.get("/views/live").json()
    assert [row["call"]["id"] for row in board["calls"]] == ["call_live"]
    assert [t["text"] for t in board["calls"][0]["recent"]] == ["Assalomu alaykum", "Narxi?"]
    assert list(board["calls"][0]["recent"][0]) == ["role", "text", "confidence", "created_at"]
    # The stale ringing call was closed as abandoned; today: 4 calls, 1 answered by AI.
    assert sql("SELECT status, outcome FROM calls WHERE id='call_stale'") == [("completed", "abandoned")]
    assert (board["todayCalls"], board["todayDeflection"], board["waiting"]) == (4, 0.25, 1)
    assert board["simulated"] == 0
    assert board["telephony"] == {"configured": False, "mode": "simulator"}
    assert list(board) == ["calls", "todayCalls", "todayDeflection", "waiting", "simulated", "telephony"]


# ── simulator and demo data ─────────────────────────────────────────


def test_simulator_actions(api: TestClient, sql, fast_simulator, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    res = api.post("/actions/simulateCallAction", json={})
    assert res.json() == {"ok": False, "message": "Create an agent before running a simulated call."}
    _agent(sql)

    res = api.post("/actions/simulateCallAction", json={"opts": {"language": "ru", "difficulty": 0}}).json()
    assert res["ok"] is True and res["message"] == "Call started." and res["callId"].startswith("call_")
    api.portal.call(background.drain)
    row = sql("SELECT channel, language, status FROM calls WHERE id = ?", res["callId"])[0]
    assert row[:2] == ("voice", "ru") and row[2] in ("completed", "escalating")
    assert sql("SELECT COUNT(*) > 0 FROM turns WHERE call_id = ?", res["callId"]) == [(1,)]

    status = api.post("/actions/simulatorStatusAction").json()
    assert status == {"running": 0, "telephony": {"configured": False, "mode": "simulator"}}

    # Count: Math.min(24, Math.max(1, count)); a missing count is NaN, so nothing starts.
    monkeypatch.setattr(simulator, "simulate_call", lambda tenant_id, **kw: f"call_{kw['seed'].split(':')[1]}")
    for count, started in [(0, 1), (3, 3), (2.5, 3), (99, 24), ("2", 2), (None, 1)]:
        out = api.post("/actions/simulateBurstAction", json={"count": count}).json()
        ids = [f"call_{i}" for i in range(started)]
        assert out == {"ok": True, "message": f"{started} calls queued.", "callIds": ids}, count
    assert api.post("/actions/simulateBurstAction", json={}).json()["message"] == "0 calls queued."
    assert sql("SELECT meta_json FROM audit_log WHERE action='simulator.burst' ORDER BY created_at, rowid")[-1] == (
        '{"count":0}',
    )


def test_stop_simulation_counts_waits_and_abandons_open_calls(api: TestClient, sql, monkeypatch) -> None:  # noqa: ANN001
    _agent(sql)
    monkeypatch.setattr(simulator, "TIME_SCALE", 100.0)  # long rings: both calls are still waiting
    simulator._running.clear()
    a = api.post("/actions/simulateCallAction", json={}).json()["callId"]
    b = api.post("/actions/simulateCallAction", json={"opts": {"language": "uz"}}).json()["callId"]
    _call(sql, "call_phone", status="active", started_at=_iso(1))
    assert api.post("/actions/simulatorStatusAction").json()["running"] == 2
    assert api.post("/actions/stopSimulationAction").json() == {"ok": True, "message": "Stopped 2 simulated calls."}
    assert api.post("/actions/simulatorStatusAction").json()["running"] == 0
    api.portal.call(background.drain)
    assert sql("SELECT id, status, outcome FROM calls ORDER BY id") == sorted(
        [(a, "abandoned", "abandoned"), (b, "abandoned", "abandoned"), ("call_phone", "abandoned", "abandoned")]
    )
    assert sql("SELECT COUNT(*) FROM turns") == [(0,)]  # stopped while ringing: they never speak
    assert api.post("/actions/stopSimulationAction").json()["message"] == "Stopped 0 simulated calls."


def test_demo_data_actions(api: TestClient, sql, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: ANN001
    res = api.post("/actions/seedDemoHistoryAction").json()
    assert res == {"ok": False, "created": 0, "message": "Create an agent first."}
    _agent(sql)
    from app.engine import demo_data

    async def few(tenant_id: str):  # noqa: ANN202 - the real generator, smaller
        return await real(tenant_id, days=2, per_day=5, live_calls=1)

    real = demo_data.seed_demo_history
    monkeypatch.setattr("app.routers.operations.seed_demo_history", few)
    res = api.post("/actions/seedDemoHistoryAction").json()
    assert res["ok"] is True and res["realCalls"] == 1
    assert res["message"] == f"Generated {res['created'] - 1} historical records and 1 fully-replayed calls."
    total = sql("SELECT COUNT(*) FROM calls")[0][0]
    assert total == res["created"]
    assert api.post("/actions/clearHistoryAction").json() == {"ok": True, "message": f"Removed {total} call records."}
    assert sql("SELECT COUNT(*) FROM calls") == [(0,)]
    assert sql("SELECT action, meta_json FROM audit_log ORDER BY created_at, rowid") == [
        ("demo.seeded", '{"created":0}'),
        ("demo.seeded", json.dumps({"created": res["created"]}, separators=(",", ":"))),
        ("demo.cleared", json.dumps({"removed": total}, separators=(",", ":"))),
    ]


# ── the public API ──────────────────────────────────────────────────

KEY = "ovoz_sk_parity00000000000000000000000000"


@pytest.fixture
def public(data_dir, sql) -> TestClient:  # noqa: ANN001
    from app.main import create_app

    _seed_user(sql)
    for raw, scopes in ((KEY, "read"), ("ovoz_sk_writeonly", "write")):
        sql(
            "INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)",
            f"key_{scopes}", TENANT, "k", raw[:12], api_key_hash(raw), scopes, NOW,
        )  # fmt: skip
    return TestClient(create_app(), raise_server_exceptions=False)


AUTH = {"authorization": f"Bearer {KEY}"}


def test_v1_calls(public: TestClient, sql) -> None:  # noqa: ANN001
    for i in range(60):
        _call(sql, f"call_{i:02d}", started_at=f"2026-11-10T00:{i:02d}:00.000Z", outcome="abandoned" if i < 5 else None,
              duration_ms=1000 + i, avg_latency_ms=400 if i == 59 else None, csat=4 if i == 59 else None)  # fmt: skip
    body = public.get("/v1/calls", headers=AUTH).json()
    assert len(body["data"]) == 50 and body["hasMore"] is True
    assert body["data"][0] == {
        "id": "call_59", "from": "+998901112233", "outcome": None, "language": "uz", "turns": 0,
        "durationMs": 1059, "avgLatencyMs": 400, "csat": 4,
    }  # fmt: skip
    for query, n, more in [("limit=2", 2, True), ("limit=abc", 50, True), ("limit=1e3", 60, False),
                           ("limit=%207%20", 7, True), ("limit=0x10", 16, True), ("limit=-5", 50, True),
                           ("limit=Infinity", 50, True), ("limit=0.5", 0, True), ("limit=3&limit=1", 3, True),
                           ("outcome=abandoned", 5, False), ("outcome=&limit=4", 4, True),
                           ("from=2026-11-10T00:58:00.000Z", 2, False)]:  # fmt: skip
        body = public.get(f"/v1/calls?{query}", headers=AUTH).json()
        assert (len(body["data"]), body["hasMore"]) == (n, more), query
    assert sql("SELECT last_used IS NOT NULL FROM api_keys WHERE id='key_read'") == [(1,)]

    def error(headers: dict) -> tuple[int, dict]:
        res = public.get("/v1/calls", headers=headers)
        return res.status_code, res.json()["error"]

    provide = "Provide an API key as `Authorization: Bearer ovoz_sk_...`."
    assert error({}) == (401, {"type": "unauthorized", "message": provide})
    assert error({"authorization": f"Bearer {KEY} extra"})[1]["message"] == provide
    assert public.get("/v1/calls?limit=1", headers={"authorization": f"  bearer\t{KEY} "}).status_code == 200
    assert error({"authorization": "Bearer sk_123"})[1]["message"] == "Malformed API key. Keys start with `ovoz_sk_`."
    assert error({"authorization": "Bearer ovoz_sk_nope"})[1]["message"] == "Invalid or revoked API key."
    assert error({"authorization": "Bearer ovoz_sk_writeonly"}) == (
        403,
        {"type": "forbidden", "message": "This API key is missing the `read` scope."},
    )


def test_check_api_key_uses_javascript_whitespace(data_dir, sql) -> None:  # noqa: ANN001
    from app.auth import ApiKeyError, check_api_key

    # \x85 and \x1f are whitespace to Python's split() but not to JavaScript's \s.
    for header in (f"Bearer\x85{KEY}", f"Bearer\x1f{KEY}"):
        with pytest.raises(ApiKeyError) as err:
            check_api_key(header, "read")
        assert err.value.message.startswith("Provide an API key")


def test_v1_answer(public: TestClient, sql) -> None:  # noqa: ANN001
    _agent(sql)

    def post(body: str) -> tuple[int, object]:
        res = public.post("/v1/answer", headers={**AUTH, "content-type": "application/json"}, content=body.encode())
        try:
            return res.status_code, res.json()
        except ValueError:
            return res.status_code, res.text

    status, body = post(json.dumps({"question": "  Operator bilan gaplashmoqchiman  "}))
    assert status == 200
    assert list(body) == ["answer", "confidence", "answered", "escalate", "citations", "timings"]
    assert body["escalate"] == "explicit_request" and body["citations"] == []
    assert list(body["timings"]) == ["retrievalMs", "llmMs", "totalMs"]
    status, body = post(json.dumps({"question": "Kosmosga chipta?", "language": "de"}))
    assert (status, body["answered"], body["escalate"], body["confidence"]) == (200, False, "low_confidence", 0)

    required = (400, {"error": {"type": "invalid_request", "message": "`question` is required."}})
    invalid = (400, {"error": {"type": "invalid_request", "message": "Request body must be valid JSON."}})
    cases = [
        ('{"language":"uz"}', required), ('{"question":"   "}', required), ('{"question":4}', required),
        ("[1]", required), ('"q"', required), ("{x", invalid), ("", invalid), ('{"question":NaN}', invalid),
        ("﻿" + '{"question":" "}', required),
    ]  # fmt: skip
    for raw, want in cases:
        assert post(raw) == want, raw
    assert post("null")[0] == 500  # `null.question` throws in the TypeScript handler
    res = public.post("/v1/answer", headers={"authorization": "Bearer ovoz_sk_writeonly"}, json={"question": "x"})
    assert res.status_code == 403


# ── the live feed ───────────────────────────────────────────────────


def test_stream_refuses_without_session_like_typescript(client: TestClient) -> None:
    res = client.get("/stream")
    assert (res.status_code, res.text, res.headers["content-type"]) == (401, "Unauthorized", "text/plain;charset=UTF-8")
