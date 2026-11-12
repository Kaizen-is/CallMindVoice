"""
Scripted stand-ins for the outside world, mirroring the recorders in the golden generators
(scratchpad/golden/make-golden-*.cjs): an httpx transport that answers from a script and writes
down every request, and a fake Anthropic SDK client.
"""

import base64
import hashlib
import json
from types import SimpleNamespace
from typing import Any

import httpx


class _Body(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], break_after: bool):
        self.chunks, self.break_after = chunks, break_after

    async def __aiter__(self):
        for c in self.chunks:
            yield c
        if self.break_after:
            raise httpx.ReadError("connection reset")


def _chunk_bytes(c: Any) -> bytes:
    return c.encode() if isinstance(c, str) else base64.b64decode(c["b64"])


def parse_multipart(request: httpx.Request) -> list:
    """[name, value] for fields, [name, {filename, type, sha1, size}] for files — as the TS recorder."""
    ctype = request.headers["content-type"]
    boundary = ctype.split("boundary=")[1].encode()
    body = request.content
    parts = []
    for raw in body.split(b"--" + boundary)[1:-1]:
        head, _, data = raw[2:].partition(b"\r\n\r\n")
        data = data[:-2]  # the CRLF before the next boundary
        headers = {}
        for line in head.decode().split("\r\n"):
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        disp = headers["content-disposition"]
        attrs = dict(
            (a.split("=", 1)[0].strip(), a.split("=", 1)[1].strip().strip('"')) for a in disp.split(";")[1:] if "=" in a
        )
        if "filename" in attrs:
            parts.append(
                [
                    attrs["name"],
                    {
                        "filename": attrs["filename"],
                        "type": headers.get("content-type", ""),
                        "sha1": hashlib.sha1(data).hexdigest(),
                        "size": len(data),
                    },
                ]
            )
        else:
            parts.append([attrs["name"], data.decode()])
    return parts


class ScriptedTransport(httpx.AsyncBaseTransport):
    """Answers each request with the next scripted response ({status, body | chunks, breakAfter, error})."""

    def __init__(self, script: list[dict]):
        self.script = list(script)
        self.requests: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await request.aread()
        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/form-data"):
            body: Any = {"form": parse_multipart(request)}
        elif request.content:
            body = {"text": request.content.decode()}
        else:
            body = None
        self.requests.append(
            {"url": str(request.url), "method": request.method, "headers": dict(request.headers), "body": body}
        )
        if not self.script:
            raise httpx.ConnectError("no scripted response")
        nxt = self.script.pop(0)
        if nxt.get("error"):
            raise httpx.ConnectError(nxt["error"])
        chunks = nxt.get("chunks", [nxt["body"]] if "body" in nxt else [])
        return httpx.Response(
            nxt.get("status", 200),
            headers=nxt.get("headers", {}),
            stream=_Body([_chunk_bytes(c) for c in chunks], bool(nxt.get("breakAfter"))),
            extensions={"reason_phrase": (nxt.get("statusText") or "").encode()},
        )


def same_request(ts: dict, py: dict) -> None:
    """The Python request matches the recorded TypeScript one (URL, method, explicit headers, body)."""
    assert py["url"] == ts["url"]
    assert py["method"] == ts["method"]
    for key, value in ts["headers"].items():
        if key == "content-type" and value == "application/json":
            assert py["headers"].get(key, "").startswith("application/json"), key
        else:
            assert py["headers"].get(key) == value, key
    assert py["body"] == ts["body"]


def _ns(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{k: _ns(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_ns(v) for v in value]
    return value


class _Stream:
    def __init__(self, scripted: dict):
        self.scripted = scripted

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self._events()

    async def _events(self):
        for ev in self.scripted.get("events", []):
            yield _ns(ev)
        if self.scripted.get("throw"):
            raise RuntimeError(self.scripted["throw"])

    async def get_final_message(self):
        return _ns(self.scripted["final"])


class FakeAnthropic:
    """Stands in for anthropic.AsyncAnthropic; one shared script and call log per test."""

    script: list[dict] = []
    calls: list[dict] = []

    def __init__(self, api_key: str | None = None, **_kw: Any):
        self.messages = SimpleNamespace(create=self._create, stream=self._stream)

    @staticmethod
    def _record(kind: str, params: dict) -> dict:
        FakeAnthropic.calls.append({"kind": kind, "params": json.loads(json.dumps(params))})
        if not FakeAnthropic.script:
            raise RuntimeError("no scripted claude response")
        return FakeAnthropic.script.pop(0)

    async def _create(self, **params: Any):
        nxt = self._record("create", params)
        if nxt.get("throw"):
            raise RuntimeError(nxt["throw"])
        return _ns(nxt["message"])

    def _stream(self, **params: Any):
        return _Stream(self._record("stream", params))
