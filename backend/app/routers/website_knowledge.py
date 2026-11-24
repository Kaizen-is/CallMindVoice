"""
Website knowledge import — the API the BRB scraper sends pages to.

Machine-to-machine: authenticated with an API key of the receiving tenant
(`Authorization: Bearer ovoz_sk_…`, scope `write` to change, `read` to list),
not a browser session. Through the site it is /api/core/knowledge/*; on the
server the scraper can call 127.0.0.1:8100/knowledge/* directly.

    PUT  /knowledge/pages          {"pages": [record, …]}   create or replace by URL (unchanged fingerprint: skipped)
    POST /knowledge/pages/delete   {"urls": [url, …]}       remove pages
    GET  /knowledge/pages                                    url, group, lang, fingerprint of every page
    PUT  /knowledge/groups         {"groups": {id: {title, description, keywords}}}

A record is the scraper's page contract: url, site, lang, group, kind, title,
breadcrumb, text (Markdown), fingerprint.
"""

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.auth import check_api_key
from app.rag.pages import PageError, delete_pages, list_pages, set_groups, upsert_pages

router = APIRouter(prefix="/knowledge")

MAX_PAGES_PER_REQUEST = 200


def _invalid(message: str) -> JSONResponse:
    return JSONResponse({"error": {"type": "invalid_request", "message": message}}, status_code=400)


async def _body(request: Request) -> dict[str, Any] | None:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return None
    return body if isinstance(body, dict) else None


@router.put("/pages")
async def put_pages(request: Request) -> JSONResponse:
    auth = check_api_key(request.headers.get("authorization"), "write")
    body = await _body(request)
    pages = body.get("pages") if body else None
    if not isinstance(pages, list) or not all(isinstance(p, dict) for p in pages):
        return _invalid('Send {"pages": [ … ]}.')
    if len(pages) > MAX_PAGES_PER_REQUEST:
        return _invalid(f"At most {MAX_PAGES_PER_REQUEST} pages per request.")
    try:
        result = await upsert_pages(auth.tenant_id, pages)
    except PageError as err:
        return _invalid(str(err))
    return JSONResponse(result.as_dict())


@router.post("/pages/delete")
async def remove_pages(request: Request) -> JSONResponse:
    auth = check_api_key(request.headers.get("authorization"), "write")
    body = await _body(request)
    urls = body.get("urls") if body else None
    if not isinstance(urls, list) or not all(isinstance(u, str) for u in urls):
        return _invalid('Send {"urls": [ … ]}.')
    return JSONResponse({"removed": delete_pages(auth.tenant_id, urls)})


@router.get("/pages")
async def get_pages(request: Request) -> JSONResponse:
    auth = check_api_key(request.headers.get("authorization"), "read")
    pages = list_pages(auth.tenant_id)
    return JSONResponse({"count": len(pages), "pages": pages})


@router.put("/groups")
async def put_groups(request: Request) -> JSONResponse:
    auth = check_api_key(request.headers.get("authorization"), "write")
    body = await _body(request)
    groups = body.get("groups") if body else None
    if not isinstance(groups, dict):
        return _invalid('Send {"groups": {id: {title, description, keywords}}}.')
    try:
        count = set_groups(auth.tenant_id, groups)
    except PageError as err:
        return _invalid(str(err))
    return JSONResponse({"groups": count})
