"""
One shared HTTP client for every outside service (LLMs, TTS, STT), so
connections stay open between turns — a fresh TLS handshake costs a caller
100–300 ms of silence. Like `fetch` in Node, it keeps connections alive.

Timeouts: `fetch(..., {signal: AbortSignal.timeout(ms)})` is a deadline for
the whole request including the body; httpx timeouts are per read. Callers
wrap their work in `asyncio.timeout(...)` for the deadline. Tests swap the
transport with `set_transport()`.
"""

import httpx

_client: httpx.AsyncClient | None = None
_transport: httpx.AsyncBaseTransport | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            transport=_transport,
            # A service that goes silent for a minute mid-request is cut off (the caller's fallback
            # takes over); live turns have their own, much shorter deadlines.
            timeout=httpx.Timeout(None, connect=10.0, read=60.0),
            # Idle connections are kept 5 minutes: callers pause between questions, and with 60 s the first
            # question after a pause reconnected to every service (measured 25 Nov: +0.4–1.5 s on that turn).
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=50, keepalive_expiry=300),
            follow_redirects=True,
        )
    return _client


def set_transport(transport: httpx.AsyncBaseTransport | None) -> None:
    """Route every request through `transport` (tests), or back to the network with None."""
    global _client, _transport
    _transport = transport
    _client = None


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def multipart(parts: list[tuple[str, object]]) -> list[tuple[str, tuple]]:
    """
    httpx `files=` for a FormData-like body, always multipart/form-data (as FormData is, even with
    no file). A part's value is a string field, or (filename, bytes, mime) for a file.
    """
    out: list[tuple[str, tuple]] = []
    for name, value in parts:
        if isinstance(value, str):
            out.append((name, (None, value.encode("utf-8"))))
        else:
            out.append((name, value))  # type: ignore[arg-type]
    return out


async def open_stream(method: str, url: str, deadline: float, **kwargs) -> httpx.Response:
    """
    Send a request and return the response with its body still to be read (close it with
    `aclose()`). `deadline` is a loop time (`loop.time() + seconds`): like AbortSignal.timeout,
    it bounds the whole exchange — read the body with `streams.read_until(res, deadline)`.
    Kept out of `asyncio.timeout` blocks that span a `yield`, which would cancel the consumer.
    """
    import asyncio

    request = client().build_request(method, url, **kwargs)
    async with asyncio.timeout_at(deadline):
        return await client().send(request, stream=True)
