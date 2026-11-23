"""
Website pages in the knowledge base: create-or-replace by URL, delete, list.

The BRB scraper (a separate service) sends one record per page:
`{url, site, lang, group, kind, title, breadcrumb, text, fingerprint}` (text is
Markdown). A page becomes an ordinary `documents` row with its `chunks`, so the
existing search (Next.js and Python) finds it like any uploaded file; the extra
facts (URL, group, language, fingerprint) live in `knowledge_pages`, which the
grouped search (`app.rag.routing`) and the next import read.

A page whose fingerprint has not changed is not re-chunked or re-embedded.
"""

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Connection

from app import db
from app.ids import new_id, now_iso
from app.rag.chunk import RawChunk, chunk_document
from app.rag.embed import LOCAL_ENGINE_ID, hosted_embed, hosted_engine_id, local_embed, pack_vector
from app.rag.text import stems

log = logging.getLogger(__name__)

EMBED_BATCH = 64  # as indexDocument in ingest.ts
MAX_CONTENT = 400_000  # documents.content keeps the first 400k characters, as ingest.ts
REQUIRED = ("url", "site", "lang", "group", "title", "text", "fingerprint")
LANGS = {"uz", "ru", "en"}


class PageError(ValueError):
    pass


@dataclass
class ImportResult:
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    embedding: str = LOCAL_ENGINE_ID
    # Pages refused one by one (bad field, no text): one bad page never blocks the others.
    rejected: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "created": self.created,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "rejected": self.rejected,
            "embedding": self.embedding,
        }


def table_ready(conn: Connection) -> bool:
    """Whether migration 0002 has run on this database (older databases simply have no website pages)."""
    row = db.fetch_one(conn, "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_pages'")
    return row is not None


def validate(record: dict[str, Any]) -> dict[str, Any]:
    missing = [k for k in REQUIRED if not isinstance(record.get(k), str) or not record[k].strip()]
    if missing:
        raise PageError(f"missing or empty: {', '.join(missing)}")
    if record["lang"] not in LANGS:
        raise PageError(f"lang must be one of {sorted(LANGS)}")
    crumbs = record.get("breadcrumb") or []
    if not isinstance(crumbs, list) or not all(isinstance(c, str) for c in crumbs):
        raise PageError("breadcrumb must be a list of strings")
    return {
        **record,
        "url": record["url"].strip(),
        "breadcrumb": [c.strip() for c in crumbs if c.strip()],
        "kind": (record.get("kind") or "page").strip() or "page",
    }


def chunk_page(record: dict[str, Any]) -> list[RawChunk]:
    """
    Chunk a page's Markdown with the document chunker, then give every chunk the page's place on the
    site as its heading ("Jismoniy shaxslarga › Kreditlar › Smart Drive › Foiz stavkasi"). A chunk cut
    out of a product page still says which product it is about, and those words count double in the
    keyword index (heading terms are boosted, as in ingest.ts).
    """
    title = record["title"].strip()
    trail = [c for c in record["breadcrumb"] if c]
    if not trail or trail[-1] != title:
        trail = [*trail, title]
    context = " › ".join(trail)
    out = []
    for c in chunk_document(record["text"], title):
        heading = c.heading.strip() if c.heading else ""
        full = context if not heading or heading in trail else f"{context} › {heading}"
        out.append(RawChunk(full, c.text, c.token_count))
    return out


def _terms(chunk: RawChunk) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in stems(chunk.text):
        counts[t] = counts.get(t, 0) + 1
    if chunk.heading:
        for t in stems(chunk.heading):
            counts[t] = counts.get(t, 0) + 2
    return counts


async def _embed(texts: list[str]) -> tuple[list[list[float]], str]:
    """Hosted embeddings when OPENAI_API_KEY is set (as the search expects), local otherwise or on failure."""
    engine = hosted_engine_id()
    if engine:
        try:
            vectors: list[list[float]] = []
            for i in range(0, len(texts), EMBED_BATCH):
                vectors.extend(await hosted_embed(texts[i : i + EMBED_BATCH]))
            return vectors, engine
        except Exception as err:  # noqa: BLE001 - a page must still be searchable by its words
            log.warning("hosted embedding failed, using the local engine: %s", err)
    return [local_embed(t) for t in texts], LOCAL_ENGINE_ID


async def upsert_pages(tenant_id: str, records: list[dict[str, Any]]) -> ImportResult:
    result = ImportResult()
    pages = []
    for record in records:
        try:
            pages.append(validate(record))
        except PageError as err:
            url = record.get("url") if isinstance(record.get("url"), str) else "?"
            result.rejected.append({"url": url, "error": str(err)})
    with db.connect() as conn:
        if not table_ready(conn):
            raise PageError("the database needs migration 0002 (run: alembic upgrade head)")
        known = {
            r["url"]: r
            for r in db.fetch_all(
                conn, "SELECT document_id, url, fingerprint FROM knowledge_pages WHERE tenant_id = :t", t=tenant_id
            )
        }

    changed: list[tuple[dict[str, Any], list[RawChunk]]] = []
    for page in pages:
        before = known.get(page["url"])
        if before and before["fingerprint"] == page["fingerprint"]:
            result.unchanged += 1
            continue
        chunks = chunk_page(page)
        if not chunks:
            result.rejected.append({"url": page["url"], "error": "no indexable text"})
            continue
        changed.append((page, chunks))

    if changed:
        texts = [c.text for _, chunks in changed for c in chunks]
        vectors, result.embedding = await _embed(texts)
        cursor = 0
        with db.transaction() as tx:
            for page, chunks in changed:
                page_vectors = vectors[cursor : cursor + len(chunks)]
                cursor += len(chunks)
                before = known.get(page["url"])
                _write_page(tx, tenant_id, page, chunks, page_vectors, before["document_id"] if before else None)
                if before:
                    result.updated += 1
                else:
                    result.created += 1
        _invalidate(tenant_id)
    return result


def _write_page(
    tx: Connection,
    tenant_id: str,
    page: dict[str, Any],
    chunks: list[RawChunk],
    vectors: list[list[float]],
    document_id: str | None,
) -> None:
    stamp = now_iso()
    text = page["text"]
    tokens = sum(c.token_count for c in chunks)
    doc_id = document_id or new_id("doc")
    fields = {
        "id": doc_id,
        "t": tenant_id,
        "title": page["title"].strip()[:300],
        "ref": page["url"],
        "size": len(text.encode("utf-8")),
        "lang": page["lang"],
        "chunks": len(chunks),
        "tokens": tokens,
        "chars": len(text),
        "content": text[:MAX_CONTENT],
        "now": stamp,
    }
    if document_id:
        db.execute(
            tx,
            """UPDATE documents SET title = :title, byte_size = :size, language = :lang, status = 'ready',
                 progress = 1, error = NULL, chunk_count = :chunks, token_count = :tokens, char_count = :chars,
                 content = :content, updated_at = :now
               WHERE id = :id AND tenant_id = :t""",
            **fields,
        )
        db.execute(tx, "DELETE FROM chunks WHERE document_id = :id", id=doc_id)
    else:
        db.execute(
            tx,
            """INSERT INTO documents (id, tenant_id, title, source_type, source_ref, byte_size, language, status,
                 progress, error, chunk_count, token_count, char_count, content, uploaded_by, created_at, updated_at)
               VALUES (:id, :t, :title, 'url', :ref, :size, :lang, 'ready', 1, NULL, :chunks, :tokens, :chars,
                 :content, NULL, :now, :now)""",
            **fields,
        )
    for i, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True)):
        db.execute(
            tx,
            """INSERT INTO chunks (id, tenant_id, document_id, ordinal, heading, text, token_count, embedding,
                 terms_json, created_at)
               VALUES (:id, :t, :doc, :ord, :heading, :text, :tokens, :emb, :terms, :now)""",
            id=new_id("chk"),
            t=tenant_id,
            doc=doc_id,
            ord=i,
            heading=chunk.heading,
            text=chunk.text,
            tokens=chunk.token_count,
            emb=pack_vector(vector),
            terms=json.dumps(_terms(chunk), ensure_ascii=False),
            now=stamp,
        )
    db.execute(
        tx,
        """INSERT INTO knowledge_pages (document_id, tenant_id, url, site, grp, lang, kind, fingerprint, updated_at)
           VALUES (:doc, :t, :url, :site, :grp, :lang, :kind, :fp, :now)
           ON CONFLICT(document_id) DO UPDATE SET url = excluded.url, site = excluded.site, grp = excluded.grp,
             lang = excluded.lang, kind = excluded.kind, fingerprint = excluded.fingerprint,
             updated_at = excluded.updated_at""",
        doc=doc_id,
        t=tenant_id,
        url=page["url"],
        site=page["site"],
        grp=page["group"],
        lang=page["lang"],
        kind=page["kind"],
        fp=page["fingerprint"],
        now=stamp,
    )


def delete_pages(tenant_id: str, urls: list[str]) -> int:
    if not urls:
        return 0
    removed = 0
    with db.transaction() as tx:
        if not table_ready(tx):
            return 0
        for url in urls:
            row = db.fetch_one(
                tx, "SELECT document_id FROM knowledge_pages WHERE tenant_id = :t AND url = :u", t=tenant_id, u=url
            )
            if not row:
                continue
            # chunks and the knowledge_pages row go with the document (ON DELETE CASCADE).
            db.execute(tx, "DELETE FROM chunks WHERE document_id = :d", d=row["document_id"])
            db.execute(tx, "DELETE FROM knowledge_pages WHERE document_id = :d", d=row["document_id"])
            removed += db.execute(
                tx, "DELETE FROM documents WHERE id = :d AND tenant_id = :t", d=row["document_id"], t=tenant_id
            )
    if removed:
        _invalidate(tenant_id)
    return removed


def list_pages(tenant_id: str) -> list[dict[str, Any]]:
    with db.connect() as conn:
        if not table_ready(conn):
            return []
        return db.fetch_all(
            conn,
            """SELECT url, site, grp AS "group", lang, kind, fingerprint, updated_at
               FROM knowledge_pages WHERE tenant_id = :t ORDER BY url""",
            t=tenant_id,
        )


def set_groups(tenant_id: str, groups: dict[str, Any]) -> int:
    """Replace the tenant's group list (id → {title, description, keywords})."""
    stamp = now_iso()
    with db.transaction() as tx:
        if not table_ready(tx):
            raise PageError("the database needs migration 0002 (run: alembic upgrade head)")
        db.execute(tx, "DELETE FROM knowledge_groups WHERE tenant_id = :t", t=tenant_id)
        for gid, g in groups.items():
            if not isinstance(g, dict) or not str(gid).strip():
                raise PageError(f"group {gid!r}: expected an object")
            keywords = [str(k) for k in g.get("keywords") or [] if str(k).strip()]
            db.execute(
                tx,
                """INSERT INTO knowledge_groups (tenant_id, id, title, description, keywords_json, updated_at)
                   VALUES (:t, :id, :title, :desc, :kw, :now)""",
                t=tenant_id,
                id=str(gid).strip(),
                title=str(g.get("title") or gid),
                desc=str(g.get("description") or ""),
                kw=json.dumps(keywords, ensure_ascii=False),
                now=stamp,
            )
    _invalidate(tenant_id)
    return len(groups)


def _invalidate(tenant_id: str) -> None:
    from app.rag import retrieve, routing

    retrieve.invalidate_corpus(tenant_id)
    routing.invalidate(tenant_id)
