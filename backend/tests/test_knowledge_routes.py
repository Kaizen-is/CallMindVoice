"""
The knowledge base's routes (app/routers/knowledge.py) beyond what the golden replay covers:
role checks, bad arguments, hosted (OpenAI) embeddings and their failures, slow or redirected
pages, the public API's stored rows — and the pdf.js details of app/rag/pdf_text.py that a
synthetic test can pin down (the real-file comparison is in the commit message / report).
"""

import asyncio
import json
import struct

import httpx
import pytest
from fastapi.testclient import TestClient

from app import http
from app.auth import COOKIE, api_key_hash, encode_session
from tests.conftest import SECRET

TENANT = "ten_kb0000000000001"
NOW = "2026-11-12T00:00:00.000Z"
FAR = "2099-01-01T00:00:00.000Z"
TEXT = (
    "Ish vaqti va manzil\nKlinika dushanbadan jumagacha 08:00 dan 20:00 gacha ishlaydi.\n"
    "Qabul narxlari\nTerapevt qabuli — 120 000 so'm.\nKardiolog qabuli — 180 000 so'm."
)


def _seed(sql) -> None:  # noqa: ANN001
    sql(
        "INSERT INTO tenants (id, name, slug, industry, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        TENANT,
        "Klinika",
        "klinika",
        "clinic",
        NOW,
        NOW,
    )
    for uid, role in (("usr_admin", "admin"), ("usr_analyst", "analyst"), ("usr_operator", "operator")):
        sql(
            "INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            uid,
            TENANT,
            f"{uid}@x.uz",
            uid,
            "x",
            role,
            NOW,
            NOW,
        )
        sql(
            "INSERT INTO sessions (id, user_id, tenant_id, created_at, expires_at) VALUES (?,?,?,?,?)",
            f"ses_{role}",
            uid,
            TENANT,
            NOW,
            FAR,
        )
    sql(
        "INSERT INTO api_keys (id, tenant_id, name, prefix, hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)",
        "key_kb",
        TENANT,
        "kb",
        "ovoz_sk_kb",
        api_key_hash("ovoz_sk_kb_secret"),
        "write",
        NOW,
    )


@pytest.fixture
def kb(data_dir, sql) -> TestClient:  # noqa: ANN001
    from app.main import create_app

    _seed(sql)
    return TestClient(create_app())


def _as(client: TestClient, role: str | None) -> TestClient:
    client.cookies.clear()
    if role:
        client.cookies.set(COOKIE, encode_session(f"ses_{role}", SECRET))
    return client


ADMIN_ACTIONS = {
    "addUrlAction": {"url": "https://a.uz"},
    "addTextAction": {"title": "t", "text": TEXT},
    "addFaqAction": {"title": "t", "pairs": [{"q": "q", "a": "a"}]},
    "addStarterPackAction": {},
    "deleteDocumentAction": {"documentId": "doc_x"},
    "reindexDocumentAction": {"documentId": "doc_x"},
}


def test_role_checks(kb: TestClient, sql) -> None:  # noqa: ANN001
    for role in ("analyst", "operator"):
        for action, args in ADMIN_ACTIONS.items():
            res = _as(kb, role).post(f"/actions/{action}", json=args)
            assert res.status_code == 403, (role, action)
            assert res.json() == {"error": "forbidden"}
        res = _as(kb, role).post(
            "/actions/uploadDocumentsAction", files=[("files", ("a.txt", TEXT.encode(), "text/plain"))]
        )
        assert res.status_code == 403
    for action in [*ADMIN_ACTIONS, "uploadDocumentsAction", "testRetrievalAction", "listDocumentsAction"]:
        assert _as(kb, None).post(f"/actions/{action}", json={}).status_code == 401
    assert _as(kb, None).get("/views/knowledge").status_code == 401
    assert sql("SELECT COUNT(*) FROM documents") == [(0,)]
    assert sql("SELECT COUNT(*) FROM audit_log") == [(0,)]
    # Any signed-in role may look.
    assert _as(kb, "analyst").post("/actions/listDocumentsAction").json() == []
    res = _as(kb, "analyst").post("/actions/testRetrievalAction", json={"query": "narx"})
    assert res.json()["strategy"] == "empty-index"


def test_bad_arguments_are_refused(kb: TestClient) -> None:
    client = _as(kb, "admin")
    assert client.post("/actions/addUrlAction", json={}).status_code == 400
    assert client.post("/actions/addTextAction", json={"title": "x", "text": 5}).status_code == 400
    assert client.post("/actions/addFaqAction", json={"title": "x", "pairs": [{"q": 1}]}).status_code == 400
    assert client.post("/actions/testRetrievalAction", json={"query": None}).status_code == 400
    # No file parts (only a text field) is the action's own message, as before.
    res = client.post("/actions/uploadDocumentsAction", data={"files": "not a file"})
    assert res.json() == {"ok": False, "message": "No files were received."}


def test_view_and_list(kb: TestClient) -> None:
    client = _as(kb, "admin")
    client.post("/actions/addTextAction", json={"title": "Narxlar", "text": TEXT})
    view = _as(kb, "analyst").get("/views/knowledge").json()
    assert [d["title"] for d in view["documents"]] == ["Narxlar"]
    assert "content" not in view["documents"][0]
    assert view["stats"]["documents"] == 1 and view["stats"]["ready"] == 1
    assert view["stats"]["bytes"] == len(TEXT.encode())
    assert view["pack"] == {
        "industry": "clinic",
        "title": "Clinic starter knowledge (UZ/RU/EN)",
        "description": "Hours, price list, lab turnaround, insurance, paediatrics and booking rules.",
    }
    assert client.post("/actions/listDocumentsAction").json() == view["documents"]


def _openai(monkeypatch, handler) -> None:  # noqa: ANN001
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    http.set_transport(httpx.MockTransport(handler))


def test_hosted_embeddings_are_stored_normalised(kb: TestClient, sql, monkeypatch) -> None:  # noqa: ANN001
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"data": [{"embedding": [3, 4, 0]} for _ in body["input"]]})

    _openai(monkeypatch, handler)
    res = _as(kb, "admin").post("/actions/addTextAction", json={"title": "N", "text": TEXT})
    assert res.json()["ok"] is True
    assert seen[0]["model"] == "text-embedding-3-small"
    (blob,) = sql("SELECT embedding FROM chunks LIMIT 1")[0]
    assert struct.unpack("<3f", blob) == pytest.approx((0.6, 0.8, 0.0))
    hits = _as(kb, "admin").post("/actions/testRetrievalAction", json={"query": "terapevt"}).json()
    assert hits["strategy"] == "hybrid:bm25+text-embedding-3-small"


def test_hosted_embedding_failures_fail_the_document(kb: TestClient, sql, monkeypatch) -> None:  # noqa: ANN001
    _openai(monkeypatch, lambda request: httpx.Response(401, json={"error": "bad key"}))
    res = _as(kb, "admin").post("/actions/addTextAction", json={"title": "N", "text": TEXT})
    assert res.json() == {"ok": False, "message": "Embedding request failed: 401"}
    assert sql("SELECT status, progress, error FROM documents") == [("failed", 0.0, "Embedding request failed: 401")]

    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    _openai(monkeypatch, offline)
    res = _as(kb, "admin").post("/actions/addTextAction", json={"title": "N2", "text": TEXT})
    assert res.json() == {"ok": False, "message": "fetch failed"}


def test_pages_follow_redirects_and_time_out(kb: TestClient, sql, monkeypatch) -> None:  # noqa: ANN001
    from app.rag import ingest

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "old.uz":
            return httpx.Response(301, headers={"location": "https://new.uz/narx"})
        if request.url.host == "slow.uz":
            await asyncio.sleep(1)
        return httpx.Response(200, content=f"<title>Yangi</title><p>{TEXT}</p>".encode())

    http.set_transport(httpx.MockTransport(handler))
    client = _as(kb, "admin")
    res = client.post("/actions/addUrlAction", json={"url": "old.uz/narx"}).json()
    assert res["ok"] is True and res["documents"][0]["title"] == "Yangi"
    # The source is the address as typed (normalised), not where it redirected to.
    assert sql("SELECT source_ref, source_type FROM documents") == [("https://old.uz/narx", "url")]
    monkeypatch.setattr(ingest, "FETCH_TIMEOUT_S", 0.05)
    res = client.post("/actions/addUrlAction", json={"url": "https://slow.uz/"}).json()
    assert res == {"ok": False, "message": "The operation was aborted due to timeout"}


def test_public_api_stores_like_the_dashboard(kb: TestClient, sql, monkeypatch) -> None:  # noqa: ANN001
    sent = []
    monkeypatch.setattr("app.webhooks.dispatch_webhook", lambda *a: sent.append(a))
    headers = {"authorization": "Bearer ovoz_sk_kb_secret"}
    res = kb.post("/v1/documents", headers=headers, json={"title": " API ", "text": TEXT, "sourceType": "csv"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ready" and body["chunks"] >= 1
    row = sql("SELECT title, source_type, source_ref, uploaded_by, status FROM documents WHERE id = ?", body["id"])
    assert row == [("API", "csv", "pasted", None, "ready")]
    assert sent == [
        (TENANT, "document.indexed", {"id": body["id"], "title": "API", "chunks": body["chunks"], "status": "ready"})
    ]
    assert sql("SELECT last_used IS NOT NULL FROM api_keys") == [(1,)]
    assert kb.get("/v1/documents", headers=headers).status_code == 405


# ── pdf.js details ──────────────────────────────────────────────────


def test_v8_hypot():
    from app.rag.pdf_text import _hypot

    # Math.hypot as V8 computes it (values printed by Node); math.hypot differs in the last bit on two of them.
    for a, b, want in [
        (0.1, 0.2, 0.223606797749979),
        (1e-300, 1e-300, 1.4142135623730952e-300),
        (0.7071067811865476, 0.7071067811865476, 1.0000000000000002),
        (12.3456, 0.0001, 12.345600000405),
        (3, 4, 5),
    ]:
        assert _hypot(a, b) == want


def test_command_splitting_like_the_pdfjs_lexer():
    from app.rag.pdf_text import _split_command, tables

    ops = tables()["ops"]
    assert _split_command("BTq", ops) == ["BT", "q"]
    assert _split_command("ETQ", ops) == ["ET", "Q"]
    assert _split_command("BDC", ops) == ["BDC"]
    assert _split_command("foo", ops) == ["f", "oo"]


def test_unicode_normalisation_quirks():
    from app.rag.pdf_text import normalize_unicode

    assert normalize_unicode("ﬁle ﬂow") == "file flow"
    assert normalize_unicode("a\u00a0b") == "a b"
    assert normalize_unicode("ﬅ") == "ſt"
    assert normalize_unicode("ﬅﬅ") == "undefined"  # NormalizationMap.get() of the whole run


def test_cmap_parsing():
    from app.rag.pdf_text import _read_to_unicode, _utf16_value, parse_cmap

    cmap = parse_cmap(
        b"/CMapName /Test def 1 begincodespacerange <00> <FF> endcodespacerange\n"
        b"1 beginbfrange <FE> <FF> <00FF> endbfrange\n"
        b"1 beginbfchar <41> <D83DDE00> endbfchar\n"
        b"1 beginbfrange <10> <12> [<0061> <0062>] endbfrange\n"
        b"1 begincidrange <20> <21> 100 endcidrange\n"
    )
    # Past 0xFF the byte before is bumped and the last byte restarts at 0.
    assert cmap.map[0xFE] == "\x00\xff" and cmap.map[0xFF] == "\x01\x00"
    assert _utf16_value(cmap.map[0x41]) == "😀"
    assert 0x12 not in cmap.map and cmap.map[0x11] == "\x00b"
    assert cmap.map[0x21] == 101
    assert cmap.read_char_code(b"\x41", 0) == (0x41, 1)
    assert parse_cmap(b"/CMapName /X def /Identity-H usecmap").contains(0x1234)
    assert _read_to_unicode(None) is None


def test_constructor_term_counts_match_javascript():
    from app.rag.chunk import RawChunk
    from app.rag.ingest import chunk_terms

    # `({})["constructor"] ?? 0` is Object itself, so JavaScript stores a string; integer keys come first.
    got = json.loads(chunk_terms(RawChunk("constructor", "the constructor 2026 builds", 3)))
    assert list(got) == ["2026", "constructor", "build"]
    assert got["constructor"] == "function Object() { [native code] }12"
