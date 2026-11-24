"""
Re-embed a tenant's chunks with the current embedding engine: `python -m app.rag.reembed --tenant <id>`.

Chunks keep the vectors of the engine they were embedded with. If OPENAI_API_KEY
was missing or unreachable at import time (on the office network: Python does not
trust the inspecting proxy's certificate unless SSL_CERT_FILE points at a bundle
that includes it), they got local 384-dimension vectors, and the hosted query
vectors cannot be compared with them: meaning-based search silently stops. An
unchanged page is never re-imported, so this tool re-embeds in place. It stops on
the first failure instead of falling back, so it never writes local vectors.

Restart the API afterwards: the search caches the corpus by chunk count and date,
which re-embedding does not change.
"""

import argparse
import asyncio
import sys

from app import db
from app.rag.embed import hosted_embed, hosted_engine_id, pack_vector

BATCH = 64


async def reembed(tenant_id: str) -> int:
    engine = hosted_engine_id()
    if not engine:
        sys.exit("OPENAI_API_KEY is not set: there is no hosted engine to re-embed with.")
    with db.connect() as conn:
        rows = db.fetch_all(conn, "SELECT id, text FROM chunks WHERE tenant_id = :t ORDER BY id", t=tenant_id)
    done = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i : i + BATCH]
        vectors = await hosted_embed([r["text"] for r in batch])  # raises on failure: nothing half-written
        with db.transaction() as tx:
            for row, vec in zip(batch, vectors, strict=True):
                db.execute(tx, "UPDATE chunks SET embedding = :e WHERE id = :id", e=pack_vector(vec), id=row["id"])
        done += len(batch)
        print(f"{done}/{len(rows)} chunks re-embedded with {engine}", flush=True)
    return done


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tenant", required=True)
    args = ap.parse_args()
    asyncio.run(reembed(args.tenant))


if __name__ == "__main__":
    main()
