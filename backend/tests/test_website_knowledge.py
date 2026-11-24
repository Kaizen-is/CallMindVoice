"""
Website knowledge (app.rag.pages, app.rag.routing), goal-led calls (app.llm.goal_call) and their
endpoints (routers/website_knowledge.py, routers/playground_chat.py). Python-only features: there is no
TypeScript to be identical to, so these are behaviour tests. The parity suites guard the other side:
tenants without imported pages and agents without a goal must behave exactly as before.
"""

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app import db
from app.auth import COOKIE, api_key_hash, encode_session
from app.engine.calls import start_call
from app.engine.conversation import run_turn
from app.llm import goal_call
from app.llm.prompts import GenerateInput, system_prompt
from app.rag import pages, routing
from tests.conftest import SECRET
from tests.test_system import _seed_user

BACKEND = Path(__file__).resolve().parents[1]
TENANT = "ten_test000000000001"
NOW = "2026-11-12T00:00:00.000Z"
WRITE_KEY = "ovoz_sk_test_write_000000000000"
READ_KEY = "ovoz_sk_test_read_0000000000000"


def page(url: str, group: str, title: str, text: str, lang: str = "uz", crumbs: list[str] | None = None) -> dict:
    return {
        "url": url,
        "site": "brb",
        "lang": lang,
        "group": group,
        "kind": "page",
        "title": title,
        "breadcrumb": crumbs or [],
        "text": text,
        "fingerprint": f"sha256:{hash((title, text))}",
    }


LOAN = page(
    "https://brb.uz/jismoniy-shaxslarga/kreditlar/avtokredit",
    "personal_loans",
    "Avtokredit",
    "# Avtokredit\nFoiz stavkasi: 0% dan 12% gacha\nKredit muddati: 60 oygacha\n"
    "Boshlang'ich badal: kamida 25%\nKredit avtomobil xaridi uchun beriladi.",
    crumbs=["Jismoniy shaxslarga", "Kreditlar", "Avtokredit"],
)
CARD = page(
    "https://brb.uz/jismoniy-shaxslarga/kartalar/humo",
    "personal_cards",
    "Humo karta",
    "# Humo karta\nKartani ochish bepul.\nKarta muddati: 5 yil\nKartani filialda yoki mobil ilovada ochish mumkin.",
    crumbs=["Jismoniy shaxslarga", "Kartalar", "Humo karta"],
)
LOAN_RU = page(
    "https://brb.uz/ru/fizicheskim-litsam/kredity/avtokredit",
    "personal_loans",
    "Автокредит",
    "# Автокредит\nПроцентная ставка: от 0% до 12%\nСрок кредита: до 60 месяцев\nПервоначальный взнос: от 25%",
    lang="ru",
    crumbs=["Физическим лицам", "Кредиты", "Автокредит"],
)
GROUPS = {
    "personal_loans": {"title": "Loans", "description": "loans", "keywords": ["kredit", "avtokredit", "кредит"]},
    "personal_cards": {"title": "Cards", "description": "cards", "keywords": ["karta", "humo", "карта"]},
}

GOAL = {
    "purpose": "Follow up on the online loan application the person left on brb.uz",
    "person": {"fullName": "Aziz Karimov", "birthYear": "1988"},
    "facts": ["The application was left on brb.uz"],
    "collect": [
        {"key": "loan_type", "label": "Loan type", "ask": "Which loan do you need?"},
        {"key": "amount", "label": "Loan amount"},
    ],
    "closing": "A loan officer will call within one working day.",
    "personas": [{"situation": "You want a car loan of 150 million so'm.", "questions": ["What is the rate?"]}],
}


@pytest.fixture
def migrated(data_dir, sql) -> Path:  # noqa: ANN001
    _seed_user(sql)
    config = Config(str(BACKEND / "alembic.ini"))
    command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")
    for raw, scopes in ((WRITE_KEY, "read,write"), (READ_KEY, "read")):
        sql(
            "INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)",
            f"key_{scopes.replace(',', '_')}",
            TENANT,
            "scraper",
            raw[:12],
            api_key_hash(raw),
            scopes,
            NOW,
        )
    routing._cache.clear()
    routing._sticky.clear()
    return data_dir


@pytest.fixture
def api(migrated) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session("ses_test000000000001", SECRET))
        yield client


def bearer(key: str) -> dict[str, str]:
    return {"authorization": f"Bearer {key}"}


def seed_agent(sql, goal: dict | None = None, agent_id: str = "agt_test000000000001") -> str:  # noqa: ANN001
    sql(
        "INSERT INTO agents (id, tenant_id, name, status, greeting, primary_lang, voice_id, goal_json, created_at,"
        " updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        agent_id,
        TENANT,
        "Isomiddin",
        "live",
        "Assalomu alaykum, BRB bankidan qo'ng'iroq qilyapman.",
        "uz",
        "isomiddin",
        json.dumps(goal or {}),
        NOW,
        NOW,
    )
    return agent_id


# ── import API ───────────────────────────────────────────────────────


def test_import_creates_skips_updates_and_deletes(api, sql) -> None:  # noqa: ANN001
    res = api.put("/knowledge/pages", json={"pages": [LOAN, CARD]}, headers=bearer(WRITE_KEY))
    assert res.status_code == 200 and res.json()["created"] == 2

    again = api.put("/knowledge/pages", json={"pages": [LOAN, CARD]}, headers=bearer(WRITE_KEY)).json()
    assert again == {"created": 0, "updated": 0, "unchanged": 2, "rejected": [], "embedding": again["embedding"]}

    changed = {**LOAN, "text": LOAN["text"] + "\nSug'urta majburiy.", "fingerprint": "sha256:new"}
    assert api.put("/knowledge/pages", json={"pages": [changed]}, headers=bearer(WRITE_KEY)).json()["updated"] == 1
    doc = sql("SELECT d.id, d.source_type, d.language FROM documents d WHERE d.source_ref = ?", LOAN["url"])
    assert len(doc) == 1 and doc[0][1:] == ("url", "uz")
    assert any("Sug'urta" in t for (t,) in sql("SELECT text FROM chunks WHERE document_id = ?", doc[0][0]))

    listed = api.get("/knowledge/pages", headers=bearer(READ_KEY)).json()
    assert listed["count"] == 2 and {p["group"] for p in listed["pages"]} == {"personal_loans", "personal_cards"}

    gone = api.post("/knowledge/pages/delete", json={"urls": [CARD["url"]]}, headers=bearer(WRITE_KEY)).json()
    assert gone == {"removed": 1}
    assert sql("SELECT COUNT(*) FROM documents WHERE source_ref = ?", CARD["url"]) == [(0,)]
    assert sql("SELECT COUNT(*) FROM knowledge_pages") == [(1,)]


def test_import_needs_a_write_key_and_rejects_bad_pages_one_by_one(api) -> None:  # noqa: ANN001
    assert api.put("/knowledge/pages", json={"pages": [LOAN]}).status_code == 401
    assert api.put("/knowledge/pages", json={"pages": [LOAN]}, headers=bearer(READ_KEY)).status_code == 403
    batch = [{**CARD, "lang": "de"}, {**CARD, "url": "https://brb.uz/empty", "text": "  "}, LOAN]
    res = api.put("/knowledge/pages", json={"pages": batch}, headers=bearer(WRITE_KEY))
    out = res.json()
    # The good page goes in; each bad one is listed with its reason instead of failing the whole batch.
    assert res.status_code == 200 and out["created"] == 1
    assert [r["url"] for r in out["rejected"]] == [CARD["url"], "https://brb.uz/empty"]
    assert "lang" in out["rejected"][0]["error"] and "text" in out["rejected"][1]["error"]
    assert api.put("/knowledge/pages", json={"pages": "x"}, headers=bearer(WRITE_KEY)).status_code == 400


def test_chunks_carry_the_page_place_on_the_site(migrated) -> None:  # noqa: ANN001
    chunks = pages.chunk_page(pages.validate(LOAN))
    assert chunks and all(c.heading.startswith("Jismoniy shaxslarga › Kreditlar › Avtokredit") for c in chunks)


# ── grouped search ───────────────────────────────────────────────────


def _import_all(api) -> None:  # noqa: ANN001
    api.put("/knowledge/groups", json={"groups": GROUPS}, headers=bearer(WRITE_KEY))
    api.put("/knowledge/pages", json={"pages": [LOAN, CARD, LOAN_RU]}, headers=bearer(WRITE_KEY))


def test_routing_picks_the_group_and_the_language(api) -> None:  # noqa: ANN001
    _import_all(api)
    result = asyncio.run(
        routing.retrieve_routed(TENANT, "Avtokredit foiz stavkasi qancha?", language="uz", threshold=0.3, call_id="c1")
    )
    info = result.extra["routing"]
    assert info["groups"][0] == "personal_loans" and info["language"] == "uz"
    assert result.hits and result.hits[0]["documentTitle"] == "Avtokredit"
    assert result.strategy.startswith("routed:")
    assert routing.sticky_group("c1") == "personal_loans"

    cards = asyncio.run(routing.retrieve_routed(TENANT, "Humo karta ochish", language="uz", threshold=0.3))
    assert cards.extra["routing"]["groups"][0] == "personal_cards"
    assert cards.hits[0]["documentTitle"] == "Humo karta"


def test_routing_falls_back_when_the_group_guess_is_wrong(api, monkeypatch) -> None:  # noqa: ANN001
    _import_all(api)
    monkeypatch.setattr(routing, "pick_groups", lambda scores: ("personal_cards",))
    result = asyncio.run(
        routing.retrieve_routed(TENANT, "Avtokredit foiz stavkasi qancha?", language="uz", threshold=0.6)
    )
    assert result.extra["routing"]["scope"] in ("all-groups", "everything")
    assert result.hits[0]["documentTitle"] == "Avtokredit"


def test_run_turn_routes_only_tenants_with_pages(api, sql) -> None:  # noqa: ANN001
    agent_id = seed_agent(sql)
    with db.connect() as conn:
        agent = db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id", id=agent_id)

    def turn() -> dict:
        call_id = start_call(tenant_id=TENANT, agent_id=agent_id, from_="playground", to="playground", channel="web")
        return asyncio.run(run_turn(tenant_id=TENANT, call_id=call_id, agent=agent, utterance="Avtokredit muddati?"))

    assert "routing" not in turn()["retrievalDebug"]  # no pages yet: the plain search, as before
    _import_all(api)
    assert turn()["retrievalDebug"]["routing"]["groups"][0] == "personal_loans"


# ── goal-led calls ───────────────────────────────────────────────────


def _prompt(goal: dict | None, said: list[str]) -> str:
    return system_prompt(
        GenerateInput(
            question=said[-1],
            hits=[],
            confidence=0,
            language="uz",
            agent_name="Isomiddin",
            threshold=0.5,
            history=[{"role": "caller", "text": s} for s in said[:-1]],
            goal=goal,
        )
    )


def test_goal_block_follows_the_identity_check() -> None:
    goal = goal_call.agent_goal({"goal_json": json.dumps(GOAL)})
    assert goal and goal["person"]["fullName"] == "Aziz Karimov"
    waiting = _prompt(goal, ["Allo"])
    assert "OUTBOUND CALL WITH A GOAL" in waiting and "NOT CONFIRMED YET" in waiting
    assert "WHAT YOU NEED FROM THEM" not in waiting and "1988" not in waiting
    confirmed = _prompt(goal, ["Allo", "Ha, men Aziz", "1988-yil"])
    assert "CONFIRMED" in confirmed and "1. Loan type" in confirmed and "loan officer will call" in confirmed
    assert "NEVER ask for card numbers" in confirmed


def test_no_goal_means_no_change() -> None:
    assert goal_call.agent_goal({"goal_json": "{}"}) is None
    assert goal_call.agent_goal({}) is None
    assert _prompt(None, ["Salom"]) == system_prompt(
        GenerateInput(question="Salom", hits=[], confidence=0, language="uz", agent_name="Isomiddin", threshold=0.5)
    )


def test_scenario_card() -> None:
    card = goal_call.scenario(goal_call.agent_goal({"goal_json": json.dumps(GOAL)}), seed=1)
    assert card["you"] == "Aziz Karimov" and card["birthYear"] == "1988"
    assert card["agentNeeds"] == ["Loan type", "Loan amount"] and "car loan" in card["situation"]


def test_playground_say_scenario_and_collect(api, sql, monkeypatch) -> None:  # noqa: ANN001
    agent_id = seed_agent(sql, GOAL)
    said = api.post("/playground/say", json={"agentId": agent_id, "utterance": "Allo"}).json()
    assert said["ok"] and said["callId"] and said["reply"]
    assert sql("SELECT direction FROM calls WHERE id = ?", said["callId"]) == [("outbound",)]
    again = api.post("/playground/say", json={"agentId": agent_id, "callId": said["callId"], "utterance": "Ha"}).json()
    assert again["ok"] and again["callId"] == said["callId"]

    card = api.get(f"/playground/scenario?agentId={agent_id}&seed=3").json()["scenario"]
    assert card["agentNeeds"] == ["Loan type", "Loan amount"]

    async def fake_llm(system: str, user: str, max_tokens: int, llm: str | None) -> str:
        assert "PERSON: Allo" in user and "loan_type" in system
        return '{"fields": {"loan_type": "avtokredit", "amount": null}, "identityConfirmed": true, "outcome": "x"}'

    monkeypatch.setattr(goal_call, "llm_text", fake_llm)
    got = api.post("/playground/collect", json={"callId": said["callId"]}).json()
    assert got["result"]["fields"] == {"loan_type": "avtokredit", "amount": None}
    assert got["result"]["complete"] is False and got["labels"]["amount"] == "Loan amount"
    assert json.loads(sql("SELECT data_json FROM call_results WHERE call_id = ?", said["callId"])[0][0])["fields"]


def test_say_refuses_strangers_and_empty_lines(api, client, sql) -> None:  # noqa: ANN001
    agent_id = seed_agent(sql)
    assert api.post("/playground/say", json={"agentId": agent_id, "utterance": "  "}).json()["ok"] is False
    assert client.post("/playground/say", json={"agentId": agent_id, "utterance": "Salom"}).status_code == 401


def test_a_follow_up_is_searched_in_context(api, sql) -> None:  # noqa: ANN001
    """'Uning muddati qancha?' matches both pages by its words; the conversation says it is the car loan."""
    _import_all(api)
    agent_id = seed_agent(sql)
    with db.connect() as conn:
        agent = db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id", id=agent_id)
    call_id = start_call(tenant_id=TENANT, agent_id=agent_id, from_="playground", to="playground", channel="web")
    asyncio.run(run_turn(tenant_id=TENANT, call_id=call_id, agent=agent, utterance="Avtokredit haqida aytib bering"))
    follow = asyncio.run(run_turn(tenant_id=TENANT, call_id=call_id, agent=agent, utterance="Uning muddati qancha?"))
    assert follow["retrievalDebug"]["hits"][0]["title"] == "Avtokredit"
