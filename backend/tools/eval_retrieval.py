"""
Does grouped search find the right page more often than the plain search? Measure, don't guess.

    .venv/Scripts/python tools/eval_retrieval.py                 # flat vs routed
    .venv/Scripts/python tools/eval_retrieval.py --llm           # + "ask the LLM which group" (needs a hosted model)
    .venv/Scripts/python tools/eval_retrieval.py --out eval.md   # also write the table to a file

For every question in tools/brb_testset.json it runs each method against the
local database (data/ovoz.db, the BRB tenant) and checks whether a page that
answers it is the first hit (hit@1) or among the five passed to the model
(hit@5); MRR rewards ranking it higher. Latency is the search alone (plus the
LLM call for --llm), which is what the caller waits for on top of the answer.
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402
from app.llm.goal_call import llm_text  # noqa: E402
from app.rag import routing  # noqa: E402
from app.rag.retrieve import retrieve_async  # noqa: E402

HERE = Path(__file__).resolve().parent


def urls_by_document(tenant: str) -> dict[str, str]:
    with db.connect() as conn:
        rows = db.fetch_all(conn, "SELECT document_id, url FROM knowledge_pages WHERE tenant_id = :t", t=tenant)
    return {r["document_id"]: r["url"] for r in rows}


def first_match(hits: list[dict], urls: dict[str, str], expect: list[str]) -> int | None:
    """1-based rank of the first hit whose page URL contains an expected fragment."""
    for i, h in enumerate(hits, 1):
        url = urls.get(h["documentId"], "")
        if any(e in url for e in expect):
            return i
    return None


async def llm_routed(tenant: str, q: str, lang: str, llm: str | None) -> tuple[object, str]:
    """The alternative we chose not to ship: one LLM call picks the group, then search it."""
    with db.connect() as conn:
        gc = routing.load(conn, tenant)
        groups = db.fetch_all(
            conn, "SELECT id, title, description FROM knowledge_groups WHERE tenant_id = :t", t=tenant
        )
    menu = "\n".join(f"- {g['id']}: {g['title']} — {g['description']}" for g in groups)
    answer = await llm_text(
        "Pick the one group whose pages answer the caller's question. Reply with the group id only.\n" + menu,
        q,
        20,
        llm,
    )
    picked = (answer or "").strip().split()[0].strip(".,`'\"") if answer else ""
    qv, engine = await routing.query_vector(q, gc)
    part = routing.subset(gc, (picked,), lang)
    if len(part[1]) < routing.MIN_LANG_CHUNKS:
        part = routing.subset(gc, (picked,), None)
    if not len(part[1]):
        part = routing.subset(gc, (), None)
    return routing.search(gc, part, q, qv, engine), picked


async def evaluate(testset: dict, use_llm: bool, llm: str | None) -> dict:
    tenant = testset["tenant"]
    urls = urls_by_document(tenant)
    if not urls:
        sys.exit(f"No imported pages for {tenant}: run the scraper with CALLMIND_URL/CALLMIND_API_KEY first.")
    methods = ["flat", "routed"] + (["llm-routed"] if use_llm else [])
    rows = []
    for item in testset["questions"]:
        q, lang, expect = item["q"], item["lang"], item["expect"]
        row = {"q": q, "lang": lang}
        for m in methods:
            started = time.perf_counter()
            extra = ""
            if m == "flat":
                result = await retrieve_async(tenant, q, top_k=5)
            elif m == "routed":
                result = await routing.retrieve_routed(tenant, q, language=lang, threshold=0.45)
                extra = ",".join(result.extra["routing"]["groups"]) + f" ({result.extra['routing']['scope']})"
            else:
                result, extra = await llm_routed(tenant, q, lang, llm)
            ms = (time.perf_counter() - started) * 1000
            row[m] = {"rank": first_match(result.hits, urls, expect), "ms": ms, "note": extra}
        rows.append(row)
    return {"methods": methods, "rows": rows}


def summary(report: dict) -> list[str]:
    rows, methods = report["rows"], report["methods"]
    n = len(rows)
    out = [f"Questions: {n}", "", "| method | hit@1 | hit@5 | MRR | median ms | p95 ms |", "|---|---|---|---|---|---|"]
    for m in methods:
        ranks = [r[m]["rank"] for r in rows]
        ms = sorted(r[m]["ms"] for r in rows)
        hit1 = sum(1 for x in ranks if x == 1) / n
        hit5 = sum(1 for x in ranks if x) / n
        mrr = sum(1 / x for x in ranks if x) / n
        p95 = ms[min(len(ms) - 1, int(0.95 * len(ms)))]
        out.append(f"| {m} | {hit1:.0%} | {hit5:.0%} | {mrr:.2f} | {statistics.median(ms):.0f} | {p95:.0f} |")
    out += ["", "| question | " + " | ".join(methods) + " |", "|---|" + "---|" * len(methods)]
    for r in rows:
        cells = []
        for m in methods:
            rk = r[m]["rank"]
            cells.append(("✓" if rk == 1 else f"#{rk}" if rk else "✗") + (f" {r[m]['note']}" if r[m]["note"] else ""))
        out.append(f"| {r['q']} | " + " | ".join(cells) + " |")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--testset", default=str(HERE / "brb_testset.json"))
    ap.add_argument("--llm", action="store_true", help="also measure LLM group routing")
    ap.add_argument("--model", default=None, help="provider:model for --llm (default: the server default)")
    ap.add_argument("--out", help="write the markdown table here too")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    testset = json.loads(Path(args.testset).read_text(encoding="utf-8"))
    report = asyncio.run(evaluate(testset, args.llm, args.model))
    text = "\n".join(summary(report))
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
