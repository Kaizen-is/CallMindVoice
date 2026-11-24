"""
Default agents in every company (app/default_agents.py), the shared knowledge library they read
(app/rag/library.py), and the FILLERS switch. Python-only features: behaviour tests.
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
from app.auth import COOKIE, encode_session
from app.brb_setup import TENANT_ID as LIBRARY
from app.default_agents import ensure_default_agents
from app.engine.calls import start_call
from app.engine.conversation import run_turn
from app.rag import pages, routing
from app.rag.library import knowledge_tenant
from app.speech import fillers
from tests.conftest import SECRET
from tests.test_system import _seed_user
from tests.test_website_knowledge import GROUPS, LOAN

BACKEND = Path(__file__).resolve().parents[1]
COMPANY = "ten_test000000000001"  # the logged-in test company (_seed_user)
NOW = "2026-11-12T00:00:00.000Z"


def _library(sql, shared: bool = True) -> None:  # noqa: ANN001
    sql(
        "INSERT INTO tenants (id, name, slug, settings_json, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        LIBRARY,
        "BRB — website agents",
        "brb-website",
        json.dumps({"sharedLibrary": shared}),
        NOW,
        NOW,
    )


@pytest.fixture
def migrated(data_dir, sql) -> Path:  # noqa: ANN001
    _seed_user(sql)
    config = Config(str(BACKEND / "alembic.ini"))
    command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")
    routing._cache.clear()
    routing._sticky.clear()
    return data_dir


def _agents(sql, tenant: str) -> list[tuple]:  # noqa: ANN001
    return sql("SELECT name, status, knowledge_tenant_id FROM agents WHERE tenant_id = ? ORDER BY name", tenant)


def test_every_company_gets_the_default_agents_once(migrated, sql) -> None:  # noqa: ANN001
    _library(sql)
    created = ensure_default_agents(COMPANY)
    assert len(created) == 2
    assert _agents(sql, COMPANY) == [
        ("BRB ma'lumot xizmati", "draft", LIBRARY),  # drafts: the company's live agent and number stay its own
        ("Isomiddin — kredit arizasi", "draft", LIBRARY),
    ]
    assert ensure_default_agents(COMPANY) == []  # once: the settings note stops a second copy
    sql("DELETE FROM agents WHERE tenant_id = ?", COMPANY)
    assert ensure_default_agents(COMPANY) == []  # an agent the company deleted stays deleted
    assert ensure_default_agents(LIBRARY) == []  # the library holds the originals


def test_no_copies_before_the_library_exists(migrated, sql) -> None:  # noqa: ANN001
    assert ensure_default_agents(COMPANY) == []
    _library(sql, shared=False)
    assert ensure_default_agents(COMPANY) == []


def test_only_a_shared_library_can_be_read(migrated, sql) -> None:  # noqa: ANN001
    agent = {"tenant_id": COMPANY, "knowledge_tenant_id": LIBRARY}
    with db.connect() as conn:
        assert knowledge_tenant(conn, agent, COMPANY) == COMPANY  # no such company yet
    _library(sql, shared=False)
    with db.connect() as conn:
        assert knowledge_tenant(conn, agent, COMPANY) == COMPANY  # exists, but not marked as a library
    sql("UPDATE tenants SET settings_json = ? WHERE id = ?", json.dumps({"sharedLibrary": True}), LIBRARY)
    with db.connect() as conn:
        assert knowledge_tenant(conn, agent, COMPANY) == LIBRARY
        assert knowledge_tenant(conn, {"tenant_id": COMPANY}, COMPANY) == COMPANY


def test_a_copy_answers_from_the_library(migrated, sql) -> None:  # noqa: ANN001
    _library(sql)
    pages.set_groups(LIBRARY, GROUPS)
    asyncio.run(pages.upsert_pages(LIBRARY, [LOAN]))
    agent_id = ensure_default_agents(COMPANY)[0]
    with db.connect() as conn:
        agent = db.fetch_one(conn, "SELECT * FROM agents WHERE id = :id", id=agent_id)
    call_id = start_call(tenant_id=COMPANY, agent_id=agent_id, from_="playground", to="playground", channel="web")
    result = asyncio.run(run_turn(tenant_id=COMPANY, call_id=call_id, agent=agent, utterance="Avtokredit muddati?"))
    assert result["retrievalDebug"]["routing"]["groups"][0] == "personal_loans"
    assert result["citations"] and result["citations"][0]["documentTitle"] == "Avtokredit"
    # The company's own knowledge base is untouched: no pages were copied into it.
    assert sql("SELECT COUNT(*) FROM documents WHERE tenant_id = ?", COMPANY) == [(0,)]


@pytest.fixture
def api(migrated) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    with TestClient(create_app()) as client:
        client.cookies.set(COOKIE, encode_session("ses_test000000000001", SECRET))
        yield client


def test_defaults_endpoint(api, sql, client) -> None:  # noqa: ANN001
    _library(sql)
    assert len(api.post("/agents/defaults").json()["created"]) == 2
    assert api.post("/agents/defaults").json() == {"created": []}
    assert client.post("/agents/defaults").status_code == 401


@pytest.mark.parametrize(("value", "enabled"), [("", True), ("on", True), ("off", False), ("0", False), ("No", False)])
def test_fillers_switch(monkeypatch, value, enabled) -> None:  # noqa: ANN001
    monkeypatch.setenv("FILLERS", value)
    assert fillers.fillers_enabled() is enabled


def test_say_continues_a_reopened_chat(api, sql) -> None:  # noqa: ANN001
    from tests.test_website_knowledge import seed_agent

    agent_id = seed_agent(sql)
    first = api.post("/playground/say", json={"agentId": agent_id, "utterance": "Salom"}).json()
    sql("UPDATE calls SET ended_at = ? WHERE id = ?", NOW, first["callId"])  # closed while idle
    again = api.post("/playground/say", json={"agentId": agent_id, "callId": first["callId"], "utterance": "Ha"})
    assert again.json()["ok"] and again.json()["callId"] == first["callId"]
    other = api.post("/playground/say", json={"agentId": agent_id, "callId": "call_nope", "utterance": "Ha"})
    assert other.json()["ok"] is False
