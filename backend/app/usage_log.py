"""
The usage log — port of src/lib/usage-log.ts. One `model_usage` row each time
an STT, TTS or LLM engine does work: which engine, how long, how much audio or
text, what it cost, whether it failed.

Rows are written from inside the engine layer, so every path that uses an
engine is covered. Writing never raises and never slows a call down.

`source` tells real traffic (`live`) apart from the model lab (`lab`); wrap
lab work in `with usage_source("lab", tenant_id): ...`. The setting follows
the work into tasks it starts (contextvars), like AsyncLocalStorage.
"""

import asyncio
import logging
import math
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app import db
from app.ids import now_iso, to_iso
from app.jscompat import js_round, utf16_slice
from app.registry import audio_cost

log = logging.getLogger("callmind.usage")

_UNSET = object()


@dataclass
class UsageEntry:
    kind: str
    engine: str
    ms: float
    ok: bool
    model: str | None = None
    first_ms: float | None = None
    audio_ms: float | None = None
    chars: float | None = None
    tokens_in: float | None = None
    tokens_out: float | None = None
    # Left unset, the cost is worked out from the audio length; None means "unknown".
    cost_usd: float | None | object = _UNSET
    error: str | None = None
    tenant_id: str | None = None


_context: ContextVar[tuple[str, str | None] | None] = ContextVar("usage_source", default=None)


@contextmanager
def usage_source(source: str, tenant_id: str | None = None) -> Iterator[None]:
    token = _context.set((source, tenant_id))
    try:
        yield
    finally:
        _context.reset(token)


_writes = 0
KEEP_DAYS = 90
# One writer thread, so rows keep their order and SQLite sees one writer from here (tests set this False).
BACKGROUND = True
_writer = ThreadPoolExecutor(max_workers=1, thread_name_prefix="usage-log")


def _round(n: float | None) -> int | None:
    return None if n is None or not math.isfinite(n) else js_round(n)


def record_usage(entry: UsageEntry) -> None:
    """
    One row for one piece of engine work. Inside a running server the write happens on a background
    thread (L7): it is SQLite I/O, and on the event loop it froze every call on the server for the
    commit (measured 170 ms). The row's facts (who, when, what) are taken now, in the caller's context.
    """
    try:
        row = _row(entry)
    except Exception as err:  # noqa: BLE001 - bookkeeping must never fail a call
        log.warning("[usage] not recorded: %s", err)
        return
    if BACKGROUND:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass  # no event loop (a script, a worker thread): write here
        else:
            _writer.submit(_write, row)
            return
    _write(row)


def _row(entry: UsageEntry) -> dict:
    ctx = _context.get()
    cost = audio_cost(entry.kind, entry.engine, entry.audio_ms) if entry.cost_usd is _UNSET else entry.cost_usd
    return {
        "tenant_id": entry.tenant_id if entry.tenant_id is not None else (ctx[1] if ctx else None),
        "source": ctx[0] if ctx else "live",
        "kind": entry.kind,
        "engine": entry.engine,
        "model": entry.model,
        "ms": _round(entry.ms) or 0,
        "first_ms": _round(entry.first_ms),
        "audio_ms": _round(entry.audio_ms),
        "chars": _round(entry.chars),
        "tokens_in": _round(entry.tokens_in),
        "tokens_out": _round(entry.tokens_out),
        "cost_usd": cost,
        "ok": 1 if entry.ok else 0,
        "error": utf16_slice(entry.error, 0, 200) if entry.error else None,
        "created_at": now_iso(),
    }


def _write(row: dict) -> None:
    global _writes
    try:
        with db.transaction() as tx:
            db.execute(
                tx,
                """INSERT INTO model_usage (tenant_id, source, kind, engine, model, ms, first_ms, audio_ms, chars,
                     tokens_in, tokens_out, cost_usd, ok, error, created_at)
                   VALUES (:tenant_id, :source, :kind, :engine, :model, :ms, :first_ms, :audio_ms, :chars,
                     :tokens_in, :tokens_out, :cost_usd, :ok, :error, :created_at)""",
                **row,
            )
            _writes += 1
            if _writes % 500 == 0:  # now and then, drop rows past the retention window
                cutoff = to_iso(datetime.now(UTC) - timedelta(days=KEEP_DAYS))
                db.execute(tx, "DELETE FROM model_usage WHERE created_at < :cutoff", cutoff=cutoff)
    except Exception as err:  # noqa: BLE001 - bookkeeping must never fail a call
        log.warning("[usage] not recorded: %s", err)


def flush_usage() -> None:
    """Wait for the rows still being written (tests, shutdown)."""
    _writer.submit(lambda: None).result()
