"""Reading streamed HTTP bodies the way the TypeScript readers do."""

import codecs
import json
from collections.abc import AsyncIterator

import httpx

from app.jscompat import js_trim


async def iter_lines(res: httpx.Response) -> AsyncIterator[str]:
    """Each complete line of the body, trimmed (split on '\\n'; a last line without one is dropped, as in TS)."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buffered = ""
    async for chunk in res.aiter_bytes():
        buffered += decoder.decode(chunk)
        while (nl := buffered.find("\n")) >= 0:
            line = js_trim(buffered[:nl])
            buffered = buffered[nl + 1 :]
            yield line


def json_loads(text: str) -> object:
    """`JSON.parse(text.trim())`; raises ValueError on bad JSON."""
    return json.loads(js_trim(text))


async def error_body(res: httpx.Response, limit: int) -> str:
    """`(await res.text().catch(() => '')).slice(0, limit)` for a response that failed."""
    try:
        return (await res.aread()).decode("utf-8", "replace")[:limit]
    except Exception:  # noqa: BLE001
        return ""


async def read_until(res: httpx.Response, deadline: float) -> AsyncIterator[bytes]:
    """The body's chunks as they arrive; TimeoutError once the loop time passes `deadline`."""
    import asyncio

    chunks = res.aiter_bytes()
    while True:
        try:
            async with asyncio.timeout_at(deadline):
                chunk = await anext(chunks)
        except StopAsyncIteration:
            return
        yield chunk
