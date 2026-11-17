"""
The knowledge base against the ORIGINAL TypeScript (fixtures/golden_knowledge.json, recorded by
tools/golden/make-golden-knowledge.cjs): every server action of src/app/actions/knowledge.ts, the
knowledge page's data and POST /api/v1/documents, replayed in the same order on the same seed.

IDs and timestamps come from the same counters on both sides, so the comparison is exact: each
call's result, the bus events, webhook dispatches and fetched pages, the revalidatePath calls the
thin TypeScript proxies make, and at the end every row written — documents (status, progress,
error, content, language, counts), chunks (text, heading, token count, the float32 vector bytes,
the term-count JSON) and audit rows — plus the uploaded files on disk.
"""

import base64
import json
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app import http
from app.auth import COOKIE, encode_session
from app.engine import bus
from app.ids import to_iso
from tests.conftest import FIXTURES, SECRET

GOLDEN = json.loads((FIXTURES / "golden_knowledge.json").read_text(encoding="utf-8"))

# The thin proxies in src/app/actions/knowledge.ts revalidate exactly where the originals did.
REVALIDATE_ON_OK = {
    "addUrlAction": ["/app/knowledge"],
    "addTextAction": ["/app/knowledge"],
    "addFaqAction": ["/app/knowledge"],
    "addStarterPackAction": ["/app/knowledge", "/app"],
    "deleteDocumentAction": ["/app/knowledge"],
    "reindexDocumentAction": ["/app/knowledge"],
}


def _proxy_revalidates(step: dict, result: object, status: int) -> list[str]:
    if status != 200:
        return []
    if step["action"] == "uploadDocumentsAction":
        return ["/app/knowledge", "/app"] if step["files"] else []
    paths = REVALIDATE_ON_OK.get(step["action"], [])
    return paths if isinstance(result, dict) and result.get("ok") else []


def _js_value(value: object) -> object:
    """The golden writes NaN/Infinity as '__NaN'; js_response writes them as null."""
    if isinstance(value, str) and value.startswith("__") and value[2:] in ("NaN", "Infinity", "-Infinity"):
        return None
    if isinstance(value, list):
        return [_js_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _js_value(v) for k, v in value.items()}
    return value


@pytest.fixture
def kb(data_dir, sql, monkeypatch):  # noqa: ANN001
    from app import audit, auth
    from app.main import create_app
    from app.rag import ingest

    for table, rows in GOLDEN["seed"].items():
        for row in rows:
            keys = list(row)
            sql(f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})", *row.values())

    counters: dict[str, int] = {}

    def new_id(prefix: str) -> str:
        counters[prefix] = counters.get(prefix, 0) + 1
        return f"{prefix}_{counters[prefix]:016d}"

    tick = [0]
    base = datetime.fromtimestamp(GOLDEN["base"] / 1000, UTC)

    def now_iso() -> str:
        stamp = to_iso(base + timedelta(seconds=tick[0]))
        tick[0] += 1
        return stamp

    for module in (ingest, audit):
        monkeypatch.setattr(module, "new_id", new_id)
    for module in (ingest, audit, auth):
        monkeypatch.setattr(module, "now_iso", now_iso)

    record: dict[str, list] = {"events": [], "webhooks": [], "fetched": []}
    unsubscribe = [
        bus.subscribe(t, lambda e, t=t: record["events"].append({"tenant": t, **e})) for t in ("ten_clinic", "ten_bank")
    ]
    monkeypatch.setattr(
        "app.webhooks.dispatch_webhook",
        lambda tenant_id, event, data: record["webhooks"].append({"tenantId": tenant_id, "event": event, "data": data}),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        record["fetched"].append({"url": url, "userAgent": request.headers.get("user-agent")})
        page = GOLDEN["pages"].get(url)
        if page is None:
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(
            page["status"], content=page["body"].encode(), headers={"content-type": "text/html; charset=windows-1251"}
        )

    http.set_transport(httpx.MockTransport(handler))
    client = TestClient(create_app())
    yield client, record, data_dir
    for off in unsubscribe:
        off()


def _call(client: TestClient, step: dict) -> httpx.Response:
    client.cookies.clear()
    if step.get("as"):
        client.cookies.set(COOKIE, encode_session(step["as"], SECRET))
    path = f"/actions/{step['action']}"
    if step["action"] == "uploadDocumentsAction":
        files = []
        for f in step["files"]:
            data = base64.b64decode(f["b64"]) if "b64" in f else f["fill"].encode() * f["size"]
            # undici sends an unknown type as application/octet-stream
            files.append(("files", (f["name"], data, f["type"] or "application/octet-stream")))
        return client.post(path, files=files or None, data={"note": "not a file"})
    return client.post(path, json=step.get("args", {}))


def test_actions_view_and_api_match_typescript(kb):  # noqa: ANN001
    client, record, data_dir = kb
    for step in GOLDEN["steps"]:
        for key in record:
            record[key].clear()
        res = _call(client, step)
        if "throws" in step:
            expected = {"ForbiddenError": 403, "UnauthorizedError": 401}[step["throws"]]
            assert res.status_code == expected, (step["name"], res.text)
            body = None
        else:
            assert res.status_code == 200, (step["name"], res.text)
            body = res.json()
            want = _js_value(step["value"])
            if step["action"] == "testRetrievalAction":
                body = {**body, "tookMs": None}
                want = {**want, "tookMs": None}
            assert body == want, step["name"]
        assert record["events"] == step["events"], step["name"]
        assert record["fetched"] == step["fetched"], step["name"]
        assert _proxy_revalidates(step, body, res.status_code) == step["revalidated"], step["name"]

    sessions = {"ten_clinic": "ses_admin", "ten_bank": "ses_owner"}
    for tenant, want in GOLDEN["views"].items():
        client.cookies.clear()
        client.cookies.set(COOKIE, encode_session(sessions[tenant], SECRET))
        res = client.get("/views/knowledge")
        assert res.status_code == 200
        assert res.json() == want, tenant

    client.cookies.clear()
    for case in GOLDEN["api"]:
        record["webhooks"].clear()
        res = client.post("/v1/documents", headers=case["headers"], content=case["request"].encode())
        assert res.status_code == case["status"], (case["name"], res.text)
        if case["status"] != 500:
            assert res.json() == case["response"], case["name"]
        assert record["webhooks"] == case["webhooks"], case["name"]

    con = sqlite3.connect(data_dir / "ovoz.db")
    con.row_factory = sqlite3.Row
    try:
        dump = GOLDEN["dump"]
        documents = [dict(r) for r in con.execute("SELECT * FROM documents ORDER BY rowid")]
        assert documents == dump["documents"]
        chunks = [
            {**dict(r), "embedding": base64.b64encode(r["embedding"]).decode() if r["embedding"] else None}
            for r in con.execute("SELECT * FROM chunks ORDER BY rowid")
        ]
        assert chunks == dump["chunks"]
        assert [dict(r) for r in con.execute("SELECT * FROM audit_log ORDER BY rowid")] == dump["audit_log"]
        assert [dict(r) for r in con.execute("SELECT id, last_used FROM api_keys ORDER BY id")] == dump["api_keys"]
    finally:
        con.close()
    uploads = data_dir / "uploads"
    files = sorted(f"{p.parent.name}/{p.name}" for p in uploads.glob("*/*"))
    assert files == sorted(dump["uploads"])


def test_ingest_helpers_match_typescript():
    from app.rag import ingest

    units = GOLDEN["units"]
    for name, want in units["extname"]:
        assert ingest.posix_extname(name) == want, name
    for html, want in units["html"]:
        assert ingest.html_to_text(html) == want, html
    for csv, delim, want in units["csv"]:
        assert ingest.csv_to_text(csv, delim) == want, csv
    for value, want in units["json"]:
        assert ingest.json_to_text(value) == want, value
    for text, want in units["jsonText"]:
        assert ingest.json_to_text(ingest.parse_json(text)) == want, text
    for raw, want in units["cleanupPdf"]:
        assert ingest.cleanup_pdf(raw) == want, raw
    for raw, want in units["sanitize"]:
        assert ingest.sanitize(raw) == want, raw
    for html, url, want in units["title"]:
        assert ingest.page_title(html, url) == want, html


def test_starter_packs_match_typescript():
    from app.starter_packs import starter_pack_for

    for industry, pack in GOLDEN["packs"].items():
        assert starter_pack_for(industry) == pack, industry
