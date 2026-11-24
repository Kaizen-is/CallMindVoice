"""
The knowledge base — the console's server actions, the page data and the public API endpoint,
ported from src/app/actions/knowledge.ts, src/app/app/knowledge/page.tsx and
src/app/api/v1/documents/route.ts (logic in app/knowledge.py and app/rag/ingest.py).

  POST /actions/uploadDocumentsAction     multipart `files` (admin)
  POST /actions/addUrlAction              {url} (admin)
  POST /actions/addTextAction             {title, text} (admin)
  POST /actions/addFaqAction              {title, pairs: [{q, a}]} (admin)
  POST /actions/addStarterPackAction      {} (admin)
  POST /actions/deleteDocumentAction      {documentId} (admin)
  POST /actions/reindexDocumentAction     {documentId} (admin)
  POST /actions/testRetrievalAction       {query} (any signed-in role)
  POST /actions/listDocumentsAction       {} (any signed-in role)
  GET  /views/knowledge                   the knowledge page's data
  POST /v1/documents                      public API, `Authorization: Bearer ovoz_sk_…` with the write scope
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from starlette.datastructures import UploadFile

from app import knowledge
from app.auth import LoggedIn, Session, check_api_key, require_role
from app.views_common import action_args, js_response

router = APIRouter()

Admin = Annotated[Session, Depends(require_role("admin"))]


def _string(args: dict[str, Any], name: str) -> str:
    """An argument the TypeScript used as a string (calling a string method on anything else threw)."""
    value = args.get(name)
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail="bad_request")
    return value


@router.post("/actions/uploadDocumentsAction")
async def upload_documents_action(request: Request, session: Admin) -> Response:
    files: list[tuple[str, str | None, bytes]] = []
    try:
        form = await request.form(max_files=10_000, max_fields=10_000)
    except Exception:  # noqa: BLE001 - not a form: no files were received
        form = None
    if form is not None:
        for item in form.getlist("files"):
            if isinstance(item, UploadFile):
                files.append((item.filename or "", item.content_type, await item.read()))
    return js_response(await knowledge.upload_documents(session, files))


@router.post("/actions/addUrlAction")
async def add_url_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(await knowledge.add_url(session, _string(args, "url")))


@router.post("/actions/addTextAction")
async def add_text_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(await knowledge.add_text(session, _string(args, "title"), _string(args, "text")))


@router.post("/actions/addFaqAction")
async def add_faq_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    title = _string(args, "title")
    pairs = args.get("pairs")
    if not isinstance(pairs, list) or not all(
        isinstance(p, dict) and isinstance(p.get("q"), str) and isinstance(p.get("a"), str) for p in pairs
    ):
        raise HTTPException(status_code=400, detail="bad_request")
    return js_response(await knowledge.add_faq(session, title, [{"q": p["q"], "a": p["a"]} for p in pairs]))


@router.post("/actions/addStarterPackAction")
async def add_starter_pack_action(session: Admin) -> Response:
    return js_response(await knowledge.add_starter_pack(session))


@router.post("/actions/deleteDocumentAction")
async def delete_document_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(knowledge.delete_document(session, args.get("documentId")))


@router.post("/actions/reindexDocumentAction")
async def reindex_document_action(request: Request, session: Admin) -> Response:
    args = await action_args(request)
    return js_response(await knowledge.reindex_document(session, args.get("documentId")))


@router.post("/actions/testRetrievalAction")
async def test_retrieval_action(request: Request, session: LoggedIn) -> Response:
    args = await action_args(request)
    return js_response(await knowledge.test_retrieval(session, _string(args, "query")))


@router.post("/actions/listDocumentsAction")
async def list_documents_action(session: LoggedIn) -> Response:
    return js_response(knowledge.list_documents(session))


@router.get("/views/knowledge")
async def knowledge_view(session: LoggedIn) -> Response:
    return js_response(knowledge.knowledge_view(session))


@router.post("/v1/documents")
async def v1_documents(request: Request) -> Response:
    auth = check_api_key(request.headers.get("authorization"), "write")
    raw = await request.body()
    try:
        text = raw.decode("utf-8", errors="replace")  # Request.json(): UTF-8, a leading BOM dropped
        body = knowledge.parse_json(text[1:] if text.startswith("\ufeff") else text)
    except ValueError:
        return js_response(
            {"error": {"type": "invalid_request", "message": "Request body must be valid JSON."}}, status=400
        )
    if body is None:
        return Response(status_code=500)  # `null.title` threw in the route
    status, payload = await knowledge.api_add_document(auth.tenant_id, body)
    return js_response(payload, status=status)
