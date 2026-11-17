"""
The knowledge base's console actions and page data — ports of src/app/actions/knowledge.ts,
the data part of src/app/app/knowledge/page.tsx (with `knowledgeStats` from src/lib/analytics.ts)
and src/app/api/v1/documents/route.ts. Same messages, same return shapes, same audit rows and
bus events; the role checks are the routers' dependencies.
"""

from typing import Any

from app import db
from app.audit import audit
from app.auth import Session
from app.engine import bus
from app.jscompat import js_fixed_number, js_round, js_trim, utf16_len, utf16_slice
from app.rag import ingest
from app.rag.retrieve import retrieve_async
from app.starter_packs import starter_pack_for

MAX_BYTES = 25 * 1024 * 1024

parse_json = ingest.parse_json

SOURCE_TYPES = ("pdf", "docx", "txt", "md", "csv", "url", "faq")


def _js_str(value: Any) -> str:
    """A value in a template string: null and undefined print as words."""
    if value is None:
        return "null"
    return str(value)


def _error_message(exc: BaseException) -> str:
    """`err.message` of whatever the pipeline threw."""
    return str(exc)


def _doc(result: dict[str, Any]) -> dict[str, Any]:
    return {"id": result["docId"], "title": result["title"], "chunks": result["chunkCount"]}


# ── actions ─────────────────────────────────────────────────────────


async def upload_documents(session: Session, files: list[tuple[str, str | None, bytes]]) -> dict[str, Any]:
    """`uploadDocumentsAction`; `files` are (name, type, bytes) in form order."""
    tenant_id = session.tenant["id"]
    if not files:
        return {"ok": False, "message": "No files were received."}
    done: list[dict[str, Any]] = []
    failures: list[str] = []
    for name, mime, data in files:
        if len(data) > MAX_BYTES:
            failures.append(f"{name} is larger than 25 MB")
            continue
        try:
            result = await ingest.ingest_file(tenant_id, name, data, mime, session.user["id"])
        except Exception as exc:  # noqa: BLE001 - every failure is reported per file
            failures.append(f"{name}: {_error_message(exc)}")
            continue
        done.append(_doc(result))
        bus.publish(
            tenant_id,
            {"type": "document_indexed", "documentId": result["docId"], "title": result["title"],
             "chunks": result["chunkCount"]},
        )  # fmt: skip
    if done:
        audit(tenant_id, session.user, "kb.uploaded", None, {"count": len(done), "titles": [d["title"] for d in done]})
    if not done:
        return {"ok": False, "message": "; ".join(failures) or "Nothing could be indexed."}
    if failures:
        message = f"Indexed {len(done)} of {len(files)}. {'; '.join(failures)}"
    else:
        passages = 0
        for d in done:
            passages += d["chunks"]
        message = f"Indexed {len(done)} document{'' if len(done) == 1 else 's'} into {passages} passages."
    return {"ok": True, "documents": done, "message": message}


def normalize_url(url: str) -> str | None:
    """`new URL(url.startsWith('http') ? url : `https://${url}`).toString()`, or None when it does not parse."""
    from ada_url import URL

    try:
        return URL(url if url.startswith("http") else f"https://{url}").href
    except ValueError:
        return None


async def add_url(session: Session, url: str) -> dict[str, Any]:
    from ada_url import URL

    href = normalize_url(url)
    if href is None:
        return {"ok": False, "message": "That does not look like a valid address."}
    if URL(href).protocol not in ("http:", "https:"):
        return {"ok": False, "message": "Only http and https pages can be imported."}
    tenant_id = session.tenant["id"]
    try:
        result = await ingest.ingest_url(tenant_id, href, session.user["id"])
        audit(tenant_id, session.user, "kb.url_imported", result["docId"], {"url": href})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _error_message(exc)}
    return {
        "ok": True,
        "documents": [_doc(result)],
        "message": f"Imported “{result['title']}” into {result['chunkCount']} passages.",
    }


async def add_text(session: Session, title: str, text: str) -> dict[str, Any]:
    if utf16_len(js_trim(text)) < 40:
        return {"ok": False, "message": "Add a bit more text — at least a couple of sentences."}
    tenant_id = session.tenant["id"]
    try:
        result = await ingest.ingest_text(tenant_id, js_trim(title) or "Pasted note", text, user_id=session.user["id"])
        audit(tenant_id, session.user, "kb.text_added", result["docId"], {"title": title})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _error_message(exc)}
    return {"ok": True, "documents": [_doc(result)], "message": f"Added {result['chunkCount']} passages."}


async def add_faq(session: Session, title: str, pairs: list[dict[str, str]]) -> dict[str, Any]:
    clean = [p for p in pairs if js_trim(p["q"]) and js_trim(p["a"])]
    if not clean:
        return {"ok": False, "message": "Add at least one question and answer."}
    tenant_id = session.tenant["id"]
    try:
        result = await ingest.ingest_faq(tenant_id, js_trim(title) or "FAQ", clean, session.user["id"])
        audit(tenant_id, session.user, "kb.faq_added", result["docId"], {"count": len(clean)})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _error_message(exc)}
    n = len(clean)
    return {"ok": True, "documents": [_doc(result)], "message": f"Added {n} question{'' if n == 1 else 's'}."}


async def add_starter_pack(session: Session) -> dict[str, Any]:
    pack = starter_pack_for(session.tenant.get("industry"))
    tenant_id = session.tenant["id"]
    try:
        result = await ingest.ingest_text(tenant_id, pack["title"], pack["body"], user_id=session.user["id"])
        audit(tenant_id, session.user, "kb.starter_pack", result["docId"], {"industry": pack["industry"]})
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _error_message(exc)}
    return {
        "ok": True,
        "documents": [_doc(result)],
        "message": f"Loaded a {_js_str(pack['industry'])} starter pack — {result['chunkCount']} passages your agent "
        "can answer from right now.",
    }


def _document(tenant_id: str, document_id: Any) -> dict[str, Any] | None:
    with db.connect() as conn:
        return db.fetch_one(
            conn, "SELECT * FROM documents WHERE id = :id AND tenant_id = :t", id=document_id, t=tenant_id
        )


def delete_document(session: Session, document_id: Any) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    doc = _document(tenant_id, document_id)
    if doc is None:
        return {"ok": False, "message": "Document not found."}
    ingest.delete_document(tenant_id, document_id)
    audit(tenant_id, session.user, "kb.deleted", document_id, {"title": doc["title"]})
    return {"ok": True, "message": f"Removed “{doc['title']}”."}


async def reindex_document(session: Session, document_id: Any) -> dict[str, Any]:
    tenant_id = session.tenant["id"]
    doc = _document(tenant_id, document_id)
    if not doc or not doc["content"]:
        return {"ok": False, "message": "Nothing stored to reindex — upload the file again."}
    try:
        chunk_count, _tokens = await ingest.index_document(tenant_id, document_id, doc["content"])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": _error_message(exc)}
    return {"ok": True, "message": f"Rebuilt {chunk_count} passages."}


async def test_retrieval(session: Session, query: str) -> dict[str, Any]:
    """Powers the retrieval inspector in the knowledge base."""
    result = await retrieve_async(session.tenant["id"], query, top_k=6, min_score=0)
    return {
        "confidence": result.confidence,
        "tookMs": js_round(result.took_ms),
        "strategy": result.strategy,
        "totalChunks": result.total_chunks,
        "hits": [
            {
                "documentId": h["documentId"],
                "documentTitle": h["documentTitle"],
                "heading": h["heading"],
                "snippet": h["snippet"],
                "text": utf16_slice(h["text"], 0, 900),
                "score": js_fixed_number(h["score"], 3),
                "lexical": js_fixed_number(h["lexicalScore"], 3),
                "dense": js_fixed_number(h["denseScore"], 3),
            }
            for h in result.hits
        ],
    }


def list_documents(session: Session) -> list[dict[str, Any]]:
    return ingest.list_documents(session.tenant["id"])


# ── the page ────────────────────────────────────────────────────────


def knowledge_stats(tenant_id: str) -> dict[str, Any]:
    """`knowledgeStats` in src/lib/analytics.ts."""
    with db.connect() as conn:
        row = db.fetch_one(
            conn,
            """SELECT COUNT(*) AS c,
                      SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready,
                      COALESCE(SUM(chunk_count),0) AS chunks,
                      COALESCE(SUM(token_count),0) AS tokens,
                      COALESCE(SUM(byte_size),0) AS bytes
               FROM documents WHERE tenant_id = :t""",
            t=tenant_id,
        )
    row = row or {}

    def value(key: str) -> Any:
        v = row.get(key)
        return 0 if v is None else v

    return {
        "documents": value("c"),
        "ready": value("ready"),
        "chunks": value("chunks"),
        "tokens": value("tokens"),
        "bytes": value("bytes"),
    }


def knowledge_view(session: Session) -> dict[str, Any]:
    """What src/app/app/knowledge/page.tsx loaded: the document list, the stats and the starter pack's name."""
    tenant_id = session.tenant["id"]
    pack = starter_pack_for(session.tenant.get("industry"))
    return {
        "documents": ingest.list_documents(tenant_id),
        "stats": knowledge_stats(tenant_id),
        "pack": {"industry": pack["industry"], "title": pack["title"], "description": pack["description"]},
    }


# ── the public API ──────────────────────────────────────────────────


async def api_add_document(tenant_id: str, body: Any) -> tuple[int, dict[str, Any]]:
    """POST /v1/documents after the key check: (status, JSON body)."""
    from app.webhooks import dispatch_webhook

    def field(name: str) -> Any:
        return body.get(name) if isinstance(body, dict) else None

    title = js_trim(field("title")) if isinstance(field("title"), str) else ""
    text = field("text") if isinstance(field("text"), str) else ""
    if not title:
        return 400, {"error": {"type": "invalid_request", "message": "`title` is required."}}
    if not js_trim(text):
        return 400, {"error": {"type": "invalid_request", "message": "`text` is required."}}
    source = field("sourceType")
    source_type = source if isinstance(source, str) and source in SOURCE_TYPES else "txt"
    try:
        result = await ingest.ingest_text(tenant_id, title, text, source_type)
    except Exception as exc:  # noqa: BLE001 - unreadable/empty content is a 422, not a 500
        return 422, {"error": {"type": "ingest_failed", "message": _error_message(exc)}}
    dispatch_webhook(
        tenant_id,
        "document.indexed",
        {"id": result["docId"], "title": result["title"], "chunks": result["chunkCount"], "status": "ready"},
    )
    return 200, {"id": result["docId"], "chunks": result["chunkCount"], "status": "ready"}
