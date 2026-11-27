"""
Parity with the ORIGINAL TypeScript for workspace administration and the dashboards
(`fixtures/golden_workspace.json`, from `tools/golden/make-golden-workspace.cjs`):

  • every page's data (`GET /views/<page>`) on the same seeded database at the same frozen time,
    for three companies and two server set-ups (no provider keys; Gemini + OpenAI + the phone bridge);
  • 62 server-action calls in sequence (`POST /actions/<name>`): what each returned or whether it
    threw, and the rows it added and removed in every table, with random values masked.

The reference has the approved intents() fix applied (one row for no intent and 'general').
"""

import json
import re
import sqlite3
from functools import partial
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app import audit, dashboards, workspace
from app.auth import COOKIE, encode_session
from app.ids import parse_iso
from app.jscompat import js_json
from app.routers import dashboard_views
from tests.conftest import SECRET, llm_list_as_recorded

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "golden_workspace.json").read_text(encoding="utf-8"))
NOW_ISO = FIXTURE["now"]
NOW = parse_iso(NOW_ISO)
TZ = ZoneInfo(FIXTURE["timezone"])
ORDER = (
    "tenants", "users", "sessions", "agents", "phone_numbers", "calls", "escalations", "usage_daily",
    "knowledge_gaps", "documents", "api_keys", "webhooks", "wallet_ledger", "audit_log", "speech_tests",
)  # fmt: skip
TABLES = (
    "phone_numbers", "users", "sessions", "api_keys", "webhooks", "speech_tests", "tenants", "wallet_ledger",
    "knowledge_gaps", "audit_log",
)  # fmt: skip
ENV_KEYS = ("GEMINI_API_KEY", "OPENAI_API_KEY", "OPENAI_EMBEDDING_MODEL", "BRIDGE_SHARED_SECRET")
VIEWS = {
    "overview": partial(dashboards.overview_view, now=NOW),
    "analytics": partial(dashboards.analytics_view, now=NOW, tz=TZ),
    "numbers": dashboards.numbers_view,
    "team": dashboards.team_view,
    "settings": dashboards.settings_view,
    "developers": dashboards.developers_view,
    "billing": dashboards.billing_view,
}


# ── helpers ─────────────────────────────────────────────────────────


def same(a: Any, b: Any, where: str = "$") -> None:
    """Equal as JavaScript values: numbers by value (1 == 1.0), but true is not 1 and null is not 0."""
    if isinstance(a, bool) or isinstance(b, bool):
        assert a is b, f"{where}: {a!r} != {b!r}"
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        assert a == b, f"{where}: {a!r} != {b!r}"
    elif isinstance(a, dict) and isinstance(b, dict):
        assert list(a) == list(b), f"{where}: keys {list(a)} != {list(b)}"
        for k in a:
            same(a[k], b[k], f"{where}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), f"{where}: {len(a)} items != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            same(x, y, f"{where}[{i}]")
    else:
        assert type(a) is type(b) and a == b, f"{where}: {a!r} != {b!r}"


_NEW_ID = re.compile(r"\b(num|usr|key|whk|spt|wl|aud)_[0-9a-z]{16}\b", re.ASCII)
_NEW_ROW_ID = re.compile(r"(num|usr|key|whk|spt|wl|aud)_[0-9a-z]{16}")


def mask(value: Any, row: dict[str, Any] | None = None) -> Any:
    """`mask` in make-golden-workspace.cjs, rule for rule."""
    if not isinstance(value, str):
        return value
    if re.fullmatch(r"ovoz_sk_[A-Za-z0-9_-]{32}", value):
        return "<api key>"
    if re.fullmatch(r"ovoz_sk_[A-Za-z0-9_-]{8}", value) and row and row.get("hash"):
        return "<api key prefix>"
    if re.fullmatch(r"[0-9a-f]{64}", value):
        return "<sha256>"
    if re.fullmatch(r"whsec_[A-Za-z0-9_-]{32}", value):
        return "<webhook secret>"
    if re.fullmatch(r"scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+", value):
        return "<password hash>"
    return _NEW_ID.sub(r"<\1>", value)


def mask_deep(value: Any, row: dict[str, Any] | None = None) -> Any:
    if isinstance(value, list):
        return [mask_deep(v) for v in value]
    if isinstance(value, dict):
        is_new = isinstance(value.get("id"), str) and _NEW_ROW_ID.fullmatch(value["id"])
        out = {}
        for k, v in value.items():
            if is_new and k == "avatar_hue":
                assert isinstance(v, int) and 0 <= v < 360
                out[k] = "<hue>"
            else:
                out[k] = mask_deep(v, value) if isinstance(v, (dict, list)) else mask(v, value)
        return out
    return mask(value, row)


def canonical(row: Any) -> str:
    """A row as a comparable string: through JSON (so 3.0 and 3 are one number), keys sorted."""
    return json.dumps(json.loads(js_json(row)), sort_keys=True, ensure_ascii=False)


def seed(db_path: Path) -> None:
    con = sqlite3.connect(db_path)
    for table in ORDER:
        for row in FIXTURE["seed"][table]:
            keys = list(row)
            con.execute(
                f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", [row[k] for k in keys]
            )
    con.commit()
    con.close()


def snapshot(db_path: Path) -> dict[str, list[str]]:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        return {t: sorted(canonical(mask_deep(dict(r))) for r in con.execute(f"SELECT * FROM {t}")) for t in TABLES}
    finally:
        con.close()


def multiset_minus(a: list[str], b: list[str]) -> list[str]:
    left: dict[str, int] = {}
    for x in b:
        left[x] = left.get(x, 0) + 1
    out = []
    for x in a:
        if left.get(x, 0) > 0:
            left[x] -= 1
        else:
            out.append(x)
    return sorted(out)


@pytest.fixture
def seeded(data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    seed(data_dir / "ovoz.db")
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(workspace, "now_iso", lambda: NOW_ISO)
    monkeypatch.setattr(audit, "now_iso", lambda: NOW_ISO)
    llm_list_as_recorded(monkeypatch)
    for name, view in VIEWS.items():
        monkeypatch.setattr(dashboard_views, f"{name}_view", view)
    return data_dir


@pytest.fixture
def api(seeded: Path) -> TestClient:
    from app.main import create_app

    return TestClient(create_app())


def login(client: TestClient, user_id: str | None) -> None:
    client.cookies.clear()
    if user_id:
        client.cookies.set(COOKIE, encode_session(f"ses_{user_id[4:]}", SECRET))


# ── views ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case",
    FIXTURE["views"],
    ids=[f"{v['view']}-{v['user']}-{'keys' if v['env'] else 'nokeys'}" for v in FIXTURE["views"]],
)
def test_view_matches_typescript(api: TestClient, monkeypatch: pytest.MonkeyPatch, case: dict) -> None:
    for key, value in case["env"].items():
        monkeypatch.setenv(key, value)
    login(api, case["user"])
    res = api.get(f"/views/{case['view']}")
    assert res.status_code == 200, res.text
    same(res.json(), case["data"])


def test_intents_fix_merges_no_intent_into_general() -> None:
    """The reference shows 'general' twice (no intent / 'general'); the port shows it once."""
    original = [r["intent"] for r in FIXTURE["intentsOriginal"]["ten_main"]]
    assert original.count("general") == 2
    ported = next(v for v in FIXTURE["views"] if v["view"] == "analytics" and v["user"] == "usr_admin")
    assert [r["intent"] for r in ported["data"]["topIntents"]].count("general") == 1


# ── actions ─────────────────────────────────────────────────────────

THROWS = {
    "UnauthorizedError": (401, "unauthorized"),
    "ForbiddenError": (403, "forbidden"),
    "TypeError": (400, "bad_request"),
}


def test_actions_match_typescript_step_by_step(api: TestClient, seeded: Path) -> None:
    db_path = seeded / "ovoz.db"
    before = snapshot(db_path)
    for i, step in enumerate(FIXTURE["steps"]):
        where = f"step {i} {step['user']} {step['action']} {json.dumps(step['args'])[:80]}"
        login(api, step["user"])
        res = api.post(f"/actions/{step['action']}", json=step["args"])
        expected = step["result"]
        if "throws" in expected:
            status, code = THROWS[expected["throws"]]
            assert (res.status_code, res.json()) == (status, {"error": code}), where
        else:
            assert res.status_code == 200, f"{where}: {res.text}"
            same(mask_deep(res.json()), expected["value"], where)
        after = snapshot(db_path)
        changes = {}
        for t in TABLES:
            added, removed = multiset_minus(after[t], before[t]), multiset_minus(before[t], after[t])
            if added or removed:
                changes[t] = {"added": added, "removed": removed}
        want = {t: {k: sorted(canonical(r) for r in rows) for k, rows in c.items()} for t, c in step["changes"].items()}
        assert changes == want, where
        before = after


def test_final_views_after_the_actions(api: TestClient, seeded: Path) -> None:
    for step in FIXTURE["steps"]:
        login(api, step["user"])
        api.post(f"/actions/{step['action']}", json=step["args"])
    login(api, "usr_owner")
    for case in FIXTURE["finalViews"]:
        res = api.get(f"/views/{case['view']}")
        assert res.status_code == 200, res.text
        same(mask_deep(res.json()), case["data"], case["view"])
