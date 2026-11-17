"""
Ingestion — port of src/lib/rag/ingest.ts: bytes → text → chunks → vectors → index.

Each stage writes its progress onto the document row (status, progress), so the knowledge page
shows a truthful indexing state. Rows, vectors and term counts are written exactly as the
TypeScript wrote them (the retriever reads both apps' rows from the same tables).

Text extraction: PDFs through `app.rag.pdf_text` (pdf.js's text layout, ported), Word files
through mammoth (the Python port of the same library), the rest by hand as before.
"""

import asyncio
import json
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import regex

from app import db
from app.config import get_settings
from app.ids import new_id, now_iso
from app.jscompat import JS_S, js_json, js_number_str, js_trim, utf16_len, utf16_slice
from app.rag.chunk import RawChunk, chunk_document
from app.rag.embed import hosted_embed, hosted_engine_id, local_embed, pack_vector
from app.rag.retrieve import invalidate_corpus
from app.rag.text import detect_language, stems

USER_AGENT = "OvozAI-KnowledgeCrawler/1.0 (+https://ovoz.ai/bot)"
FETCH_TIMEOUT_S = 20.0
EMBED_BATCH = 64


class IngestError(Exception):
    """A failure the TypeScript reported with `throw new Error(message)` — the message reaches the user."""


# ── small JavaScript equivalents ────────────────────────────────────


def posix_extname(path: str) -> str:
    """Node's `path.extname` (POSIX, as on the server): '.pdf', '' for '.bashrc', '.' for 'a.'."""
    start_dot = -1
    start_part = 0
    end = -1
    matched_slash = True
    pre_dot_state = 0
    for i in range(len(path) - 1, -1, -1):
        ch = path[i]
        if ch == "/":
            if not matched_slash:
                start_part = i + 1
                break
            continue
        if end == -1:
            matched_slash = False
            end = i + 1
        if ch == ".":
            if start_dot == -1:
                start_dot = i
            elif pre_dot_state != 1:
                pre_dot_state = 1
        elif start_dot != -1:
            pre_dot_state = -1
    if (
        start_dot == -1
        or end == -1
        or pre_dot_state == 0
        or (pre_dot_state == 1 and start_dot == end - 1 and start_dot == start_part + 1)
    ):
        return ""
    return path[start_dot:end]


def utf8_text(data: bytes) -> str:
    """`buffer.toString('utf8')`: invalid bytes become U+FFFD, a BOM is kept."""
    return data.decode("utf-8", errors="replace")


def utf8_len(text: str) -> int:
    """`Buffer.byteLength(text)` (a lone surrogate counts as the 3 bytes of U+FFFD)."""
    return len(text.encode("utf-8", errors="surrogatepass"))


def _is_array_index(key: str) -> bool:
    return key.isascii() and key.isdigit() and (key == "0" or key[0] != "0") and int(key) < 2**32 - 1


def js_key_order(keys: list[str]) -> list[str]:
    """The order JavaScript keeps an object's own string keys in: array indices first (ascending), then insertion."""
    indices = sorted((k for k in keys if _is_array_index(k)), key=int)
    return indices + [k for k in keys if not _is_array_index(k)]


# `({})[key] ?? 0` finds Object.prototype's members; of those only `constructor` can be a stem
# (stems are lowercase), and `Object + 1` is this string.
_INHERITED = {"constructor": "function Object() { [native code] }"}


def _count(counts: dict[str, Any], term: str, by: int) -> None:
    """`counts[t] = (counts[t] ?? 0) + by` on a plain object."""
    current = counts[term] if term in counts else _INHERITED.get(term, 0)
    counts[term] = f"{current}{by}" if isinstance(current, str) else current + by


def terms_json(counts: dict[str, Any]) -> str:
    """JSON.stringify(counts)."""
    return js_json({k: counts[k] for k in js_key_order(list(counts))})


# ── extraction ──────────────────────────────────────────────────────

_CONTROL = regex.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufeff]")


def _js_string(value: Any) -> str:
    """String(value) for a JSON value."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return js_number_str(float(value)) if abs(value) >= 2**53 else str(value)
    if isinstance(value, float):
        return js_number_str(value)
    return str(value)


def json_to_text(value: Any, depth: int = 0) -> str:
    if depth > 6:
        return ""
    if value is None:
        return ""
    if not isinstance(value, dict | list):
        return _js_string(value)
    if isinstance(value, list):
        return "\n".join(json_to_text(v, depth + 1) for v in value)
    return "\n".join(f"{k}: {json_to_text(value[k], depth + 1)}" for k in js_key_order(list(value)))


def parse_json(text: str) -> Any:
    """JSON.parse: no NaN/Infinity literals (Python's json accepts them)."""

    def no_constant(name: str) -> Any:
        raise ValueError(name)

    return json.loads(text, parse_constant=no_constant)


def _split_csv_line(line: str, delim: str) -> list[str]:
    out: list[str] = []
    cur = ""
    quoted = False
    i = 0
    while i < len(line):
        c = line[i]
        if c == '"':
            if quoted and i + 1 < len(line) and line[i + 1] == '"':
                cur += '"'
                i += 1
            else:
                quoted = not quoted
        elif c == delim and not quoted:
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    return out


def csv_to_text(csv: str, delim: str) -> str:
    rows = [_split_csv_line(line, delim) for line in regex.split(r"\r?\n", csv) if line]
    if not rows:
        return ""
    header = rows[0]
    out = []
    for row in rows[1:]:
        pairs = [f"{js_trim(h)}: {js_trim(row[i])}" for i, h in enumerate(header) if i < len(row) and row[i]]
        if pairs:
            out.append(" · ".join(pairs))
    return "\n".join(out)


# JavaScript's `i` flag (without `u`) folds only where both sides agree: an ASCII letter never matches a
# non-ASCII one (Python's IGNORECASE would let "ſ" match "s").
_CI = regex.IGNORECASE | regex.ASCII

_HTML_STEPS = [
    (regex.compile(r"<script[\s\S]*?</script>", _CI), " "),
    (regex.compile(r"<style[\s\S]*?</style>", _CI), " "),
    (regex.compile(r"<nav[\s\S]*?</nav>", _CI), " "),
    (regex.compile(r"<footer[\s\S]*?</footer>", _CI), " "),
    (regex.compile(r"</(h[1-6]|p|div|li|tr|section|article)>", _CI), "\n"),
    (regex.compile(f"<br[{JS_S}]*/?>", _CI), "\n"),
    (regex.compile(r"<li[^>]*>", _CI), "• "),
    (regex.compile(r"<h([1-6])[^>]*>", _CI), "\n\n"),
    (regex.compile(r"<[^>]+>"), " "),
    (regex.compile("&nbsp;"), " "),
    (regex.compile("&amp;"), "&"),
    (regex.compile("&lt;"), "<"),
    (regex.compile("&gt;"), ">"),
    (regex.compile("&quot;"), '"'),
    (regex.compile("&#39;"), "'"),
    (regex.compile("[ \t]{2,}"), " "),
    (regex.compile("\n{3,}"), "\n\n"),
]


def html_to_text(html: str) -> str:
    for pattern, replacement in _HTML_STEPS:
        html = pattern.sub(lambda _m, r=replacement: r, html)
    return js_trim(html)


_PDF_STEPS = [
    (regex.compile(r"\r\n?"), lambda _m: "\n"),
    (regex.compile(r"-\n(?=\p{Ll})"), lambda _m: ""),
    (regex.compile(r"([^\n.!?:;])\n(?=\p{Ll})"), lambda m: f"{m.group(1)} "),
    (regex.compile(r"\n{3,}"), lambda _m: "\n\n"),
    (regex.compile(r"[ \t]{2,}"), lambda _m: " "),
]


def cleanup_pdf(raw: str) -> str:
    """PDF text extraction leaves hard line-wraps and hyphenation; repair them."""
    for pattern, replacement in _PDF_STEPS:
        raw = pattern.sub(replacement, raw)
    return js_trim(raw)


# mammoth.js's messages for the usual broken uploads (JSZip reads the archive there).
_NOT_A_ZIP = (
    "Can't find end of central directory : is this a zip file ? "
    "If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html"
)


def _docx_text(data: bytes) -> str:
    import zipfile

    import mammoth

    try:
        return mammoth.extract_raw_text(BytesIO(data)).value
    except zipfile.BadZipFile as exc:
        raise IngestError(_NOT_A_ZIP) from exc
    except KeyError as exc:
        raise IngestError("Could not find main document part. Are you sure this is a valid .docx file?") from exc


def _pdf_text(data: bytes) -> str:
    from app.rag.pdf_text import PdfError, extract_pdf_text

    try:
        return extract_pdf_text(data)
    except PdfError as exc:
        raise IngestError(str(exc)) from exc


def extract_text(data: bytes, filename: str, mime: str | None = None) -> tuple[str, str]:
    """(text, source type) — `extractText` in ingest.ts."""
    ext = posix_extname(filename).lower().replace(".", "", 1)
    if ext == "pdf" or mime == "application/pdf":
        return cleanup_pdf(_pdf_text(data)), "pdf"
    if ext == "docx" or (mime is not None and "wordprocessingml" in mime):
        return _docx_text(data), "docx"
    if ext in ("csv", "tsv"):
        return csv_to_text(utf8_text(data), "\t" if ext == "tsv" else ","), "csv"
    if ext in ("md", "markdown"):
        return utf8_text(data), "md"
    if ext in ("html", "htm"):
        return html_to_text(utf8_text(data)), "txt"
    if ext == "json":
        try:
            return json_to_text(parse_json(utf8_text(data))), "txt"
        except ValueError:
            pass  # fall through to plain text
    return utf8_text(data), "txt"


# ── documents ───────────────────────────────────────────────────────


def create_document(
    tenant_id: str,
    title: str,
    source_type: str,
    source_ref: str | None = None,
    byte_size: int = 0,
    uploaded_by: str | None = None,
) -> str:
    doc_id = new_id("doc")
    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO documents (id, tenant_id, title, source_type, source_ref, byte_size,
                 language, status, progress, uploaded_by, created_at, updated_at)
               VALUES (:id, :tenant_id, :title, :source_type, :source_ref, :byte_size,
                 'auto', 'queued', 0, :uploaded_by, :created_at, :updated_at)""",
            id=doc_id,
            tenant_id=tenant_id,
            title=utf16_slice(title, 0, 200),
            source_type=source_type,
            source_ref=source_ref,
            byte_size=byte_size,
            uploaded_by=uploaded_by,
            created_at=now_iso(),
            updated_at=now_iso(),
        )
    return doc_id


def _set_status(doc_id: str, status: str, progress: float, error: str | None = None) -> None:
    with db.transaction() as tx:
        db.execute(
            tx,
            """UPDATE documents SET status = :status, progress = :progress, error = :error, updated_at = :now
               WHERE id = :id""",
            status=status,
            progress=progress,
            error=error,
            now=now_iso(),
            id=doc_id,
        )


def sanitize(text: str) -> str:
    """Strip control characters that survive PDF and DOCX extraction."""
    return js_trim(_CONTROL.sub("", text))


def chunk_terms(chunk: RawChunk) -> str:
    """The chunk's stem counts as stored in `chunks.terms_json`."""
    counts: dict[str, Any] = {}
    for t in stems(chunk.text):
        _count(counts, t, 1)
    # Heading terms are boosted — they carry the topic of the chunk.
    if chunk.heading:
        for t in stems(chunk.heading):
            _count(counts, t, 2)
    return terms_json(counts)


async def _embed(texts: list[str]) -> list[list[float]]:
    """`embeddingEngine().embed(texts)`: OpenAI with OPENAI_API_KEY set, else the local encoder."""
    if hosted_engine_id() is None:
        return await asyncio.to_thread(lambda: [local_embed(t) for t in texts])
    try:
        return await hosted_embed(texts)
    except httpx.TransportError as exc:
        raise IngestError("fetch failed") from exc  # what Node's fetch says for a network failure


def _message(exc: BaseException) -> str:
    """`err instanceof Error ? err.message : 'Indexing failed'` — everything raised here is an Error."""
    return str(exc)


async def index_document(
    tenant_id: str, doc_id: str, text: str, chunks: list[RawChunk] | None = None
) -> tuple[int, int]:
    """(chunk count, token count). On failure the row is marked failed with the message, and the error re-raised."""
    with db.connect() as conn:
        doc = db.fetch_one(conn, "SELECT * FROM documents WHERE id = :id AND tenant_id = :t", id=doc_id, t=tenant_id)
    if doc is None:
        raise IngestError("Document not found")
    try:
        _set_status(doc_id, "parsing", 0.15)
        clean = sanitize(text)
        if utf16_len(clean) < 20:
            raise IngestError("No readable text could be extracted from this file.")

        _set_status(doc_id, "chunking", 0.35)
        raw = chunks if chunks is not None else await asyncio.to_thread(chunk_document, clean, doc["title"])
        if not raw:
            raise IngestError("Document produced no indexable content.")

        _set_status(doc_id, "embedding", 0.55)
        vectors: list[list[float]] = []
        for i in range(0, len(raw), EMBED_BATCH):
            batch = [c.text for c in raw[i : i + EMBED_BATCH]]
            vectors.extend(await _embed(batch))
            _set_status(doc_id, "embedding", 0.55 + 0.35 * ((i + len(batch)) / len(raw)))

        language = detect_language(utf16_slice(clean, 0, 4000))
        total_tokens = 0
        for c in raw:
            total_tokens += c.token_count
        term_counts = await asyncio.to_thread(lambda: [chunk_terms(c) for c in raw])
        stamp = now_iso()

        with db.transaction() as tx:
            db.execute(tx, "DELETE FROM chunks WHERE document_id = :id", id=doc_id)
            for i, c in enumerate(raw):
                if i >= len(vectors):
                    raise IngestError("Cannot read properties of undefined (reading 'buffer')")
                db.execute(
                    tx,
                    """INSERT INTO chunks (id, tenant_id, document_id, ordinal, heading, text, token_count,
                         embedding, terms_json, created_at)
                       VALUES (:id, :tenant_id, :document_id, :ordinal, :heading, :text, :token_count,
                         :embedding, :terms_json, :created_at)""",
                    id=new_id("chk"),
                    tenant_id=tenant_id,
                    document_id=doc_id,
                    ordinal=i,
                    heading=c.heading,
                    text=c.text,
                    token_count=c.token_count,
                    embedding=pack_vector(vectors[i]),
                    terms_json=term_counts[i],
                    created_at=stamp,
                )
            db.execute(
                tx,
                """UPDATE documents SET status = 'ready', progress = 1, error = NULL, chunk_count = :chunks,
                     token_count = :tokens, char_count = :chars, language = :language, content = :content,
                     updated_at = :now WHERE id = :id""",
                chunks=len(raw),
                tokens=total_tokens,
                chars=utf16_len(clean),
                language=language,
                content=utf16_slice(clean, 0, 400_000),
                now=stamp,
                id=doc_id,
            )
        invalidate_corpus(tenant_id)
        return len(raw), total_tokens
    except Exception as exc:
        _set_status(doc_id, "failed", 0, _message(exc))
        invalidate_corpus(tenant_id)
        raise


def _upload_dir() -> Path:
    return get_settings().callmind_data_dir / "uploads"


async def ingest_file(
    tenant_id: str, filename: str, data: bytes, mime: str | None = None, user_id: str | None = None
) -> dict[str, Any]:
    # Parsing a large PDF takes seconds of CPU: off the event loop, so calls on the line keep flowing.
    text, source_type = await asyncio.to_thread(extract_text, data, filename, mime)
    title = js_trim(regex.sub(r"[_-]+", " ", regex.sub(r"\.[^.]+\Z", "", filename))) or filename
    doc_id = create_document(tenant_id, title, source_type, filename, len(data), user_id)
    folder = _upload_dir() / tenant_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{doc_id}{posix_extname(filename)}").write_bytes(data)
    chunk_count, token_count = await index_document(tenant_id, doc_id, text)
    return {"docId": doc_id, "title": title, "chunkCount": chunk_count, "tokenCount": token_count}


def _utf16_units_str(s: str) -> str:
    """The string with every astral character written as its two surrogates — JavaScript's view of it."""
    return "".join(
        c if ord(c) < 0x10000 else chr(0xD800 + ((ord(c) - 0x10000) >> 10)) + chr(0xDC00 + ((ord(c) - 0x10000) & 0x3FF))
        for c in s
    )


def _from_units_str(s: str) -> str:
    return s.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="surrogatepass")


_TITLE = regex.compile(r"<title[^>]*>([^<]{1,150})</title>", _CI)


def page_title(html: str, url: str) -> str:
    """`(html.match(/<title[^>]*>([^<]{1,150})<\\/title>/i)?.[1] ?? new URL(url).hostname).trim()`."""
    match = _TITLE.search(_utf16_units_str(html))  # {1,150} counts UTF-16 units, as in JavaScript
    if match:
        return js_trim(_from_units_str(match.group(1)))
    from ada_url import URL

    return js_trim(URL(url).hostname)


async def fetch_page(url: str) -> str:
    """`fetch(url, {headers: {user-agent}, signal: AbortSignal.timeout(20_000)})` then `res.text()`."""
    from app import http

    try:
        async with asyncio.timeout(FETCH_TIMEOUT_S):
            res = await http.client().get(url, headers={"user-agent": USER_AGENT})
            if not 200 <= res.status_code <= 299:
                raise IngestError(f"Could not fetch page (HTTP {res.status_code})")
            body = res.content
    except TimeoutError as exc:
        raise IngestError("The operation was aborted due to timeout") from exc
    except httpx.HTTPError as exc:
        raise IngestError("fetch failed") from exc
    text = body.decode("utf-8", errors="replace")  # Response.text(): always UTF-8, BOM dropped
    return text[1:] if text.startswith("\ufeff") else text


async def ingest_url(tenant_id: str, url: str, user_id: str | None = None) -> dict[str, Any]:
    html = await fetch_page(url)
    title = page_title(html, url)
    text = html_to_text(html)
    doc_id = create_document(tenant_id, title, "url", url, utf16_len(html), user_id)
    chunk_count, token_count = await index_document(tenant_id, doc_id, text)
    return {"docId": doc_id, "title": title, "chunkCount": chunk_count, "tokenCount": token_count}


async def ingest_text(
    tenant_id: str, title: str, text: str, source_type: str = "txt", user_id: str | None = None
) -> dict[str, Any]:
    doc_id = create_document(tenant_id, title, source_type, "pasted", utf8_len(text), user_id)
    chunk_count, token_count = await index_document(tenant_id, doc_id, text)
    return {"docId": doc_id, "title": title, "chunkCount": chunk_count, "tokenCount": token_count}


async def ingest_faq(
    tenant_id: str, title: str, pairs: list[dict[str, str]], user_id: str | None = None
) -> dict[str, Any]:
    from app.rag.chunk import chunk_faq

    body = "\n\n".join(f"{p['q']}\n{p['a']}" for p in pairs)
    doc_id = create_document(tenant_id, title, "faq", f"{len(pairs)} pairs", utf8_len(body), user_id)
    chunk_count, token_count = await index_document(tenant_id, doc_id, body, chunk_faq(pairs))
    return {"docId": doc_id, "title": title, "chunkCount": chunk_count, "tokenCount": token_count}


def delete_document(tenant_id: str, doc_id: str) -> None:
    with db.transaction() as tx:
        db.execute(tx, "DELETE FROM documents WHERE id = :id AND tenant_id = :t", id=doc_id, t=tenant_id)
    invalidate_corpus(tenant_id)


DOCUMENT_COLUMNS = (
    "id, title, source_type, source_ref, byte_size, language, status, progress, error, "
    "chunk_count, token_count, char_count, created_at, updated_at"
)


def list_documents(tenant_id: str) -> list[dict[str, Any]]:
    """The knowledge page's document list (no content), newest first."""
    with db.connect() as conn:
        return db.fetch_all(
            conn,
            f"SELECT {DOCUMENT_COLUMNS} FROM documents WHERE tenant_id = :t ORDER BY created_at DESC",
            t=tenant_id,
        )
