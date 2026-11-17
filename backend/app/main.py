"""
CallMind API — the FastAPI app.

Runs privately on 127.0.0.1:8100. The browser reaches it only through the
Next.js app, which forwards `/api/core/*` here (see `next.config.ts`), so the
paths below have no `/api/core` prefix.
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.auth import ApiKeyError
from app.config import get_settings
from app.routers import bridge, live, playground, system


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="CallMind API",
        version="0.1.0",
        docs_url="/docs" if settings.api_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.api_docs else None,
    )

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        # `{"error": "<code>"}` — the shape the Next.js routes already return.
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(ApiKeyError)
    async def api_key_error(_request: Request, exc: ApiKeyError) -> JSONResponse:
        return exc.response()

    app.include_router(system.router)
    app.include_router(playground.router)
    app.include_router(live.router)
    app.include_router(bridge.router)
    return app


app = create_app()
