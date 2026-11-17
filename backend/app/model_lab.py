"""
The Model lab and the For-developers speech-to-text page — ports of `modelStats`
(src/lib/lab.ts), `setDefaultLlmAction` (src/app/actions/models.ts) and the data
src/app/app/models/lab/page.tsx and src/app/app/dev/stt/page.tsx load. The numbers come from the
deploy benchmark (`app/benchmark.py`), measured once per build.
"""

from typing import Any

from app.audit import audit
from app.auth import Session, can
from app.benchmark import latest_benchmarks
from app.custom_voices import list_speech_tests
from app.llm.choice import set_tenant_default_llm, tenant_default_llm
from app.llm.provider import engine_label, llm_provider_ready
from app.registry import ENGINES, LLM_MODELS, EngineInfo
from app.speech.stt import stt_engine_ids
from app.speech.tts import tts_engines


def _base(e: EngineInfo, ready: dict[str, bool]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": e.id, "name": e.name, "vendor": e.vendor}
    if e.via is not None:
        out["via"] = e.via  # `via: e.via` — undefined (left out) when the engine has none
    out.update({"ready": bool(ready.get(e.id)), "setup": e.setup, "own": e.runs == "server"})
    return out


def model_stats() -> dict[str, list[dict[str, Any]]]:
    result = {f"{b['kind']}:{b['engine']}": b for b in latest_benchmarks()}

    def ok(key: str) -> dict[str, Any]:
        """The result, when at least one sample answered; else {} (every number then reads as null)."""
        r = result.get(key)
        return r if r and r["passed"] > 0 else {}

    stt_ready = stt_engine_ids()
    tts_ready = tts_engines()

    stt = []
    for e in ENGINES:
        if e.kind == "stt":
            r = ok(f"stt:{e.id}")
            stt.append(
                {
                    **_base(e, stt_ready),
                    "pricePerMin": e.price_per_min,
                    "latencyMs": r.get("latencyMs"),
                    "wer": r.get("wer"),
                    "cer": r.get("cer"),
                }
            )
    tts = []
    for e in ENGINES:
        if e.kind == "tts":
            r = ok(f"tts:{e.id}")
            tts.append(
                {
                    **_base(e, tts_ready),
                    "pricePerMin": e.price_per_min,
                    "firstMs": r.get("firstMs"),
                    "latencyMs": r.get("latencyMs"),
                    "clarity": r.get("clarity"),
                }
            )
    llm = []
    for m in LLM_MODELS:
        r = ok(f"llm:{m.id}")
        llm.append(
            {
                "id": m.id,
                "name": m.name,
                "vendor": m.vendor,
                "ready": llm_provider_ready(m.provider),
                "setup": m.setup,
                "own": m.runs == "server",
                "provider": m.provider,
                "priceIn": m.price_in,
                "priceOut": m.price_out,
                "firstMs": r.get("firstMs"),
                "latencyMs": r.get("latencyMs"),
            }
        )
    return {"stt": stt, "tts": tts, "llm": llm}


def lab_page(session: Session) -> dict[str, Any]:
    """src/app/app/models/lab/page.tsx → <ModelLab> (minus `locale`)."""
    chosen = tenant_default_llm(session.tenant["id"])
    return {
        "stats": model_stats(),
        "canEdit": can(session.user["role"], "admin"),
        "llmDefault": chosen,
        "llmInUse": engine_label(chosen),
        "llmServerDefaultLabel": engine_label(None),
    }


def dev_stt_page(session: Session, model: str | None) -> dict[str, Any]:
    """src/app/app/dev/stt/page.tsx → <SttLab> (minus `locale`)."""
    ready = stt_engine_ids()
    models = [
        {
            "id": e.id,
            "name": e.name,
            "detail": f"{e.vendor} · {e.via}" if e.via else e.vendor,
            "ready": bool(ready.get(e.id)),
            "setup": e.setup,
        }
        for e in ENGINES
        if e.kind == "stt"
    ]
    # ?model=… from Models ▸ Model lab ▸ Test; otherwise the first model set up here.
    initial = next((m["id"] for m in models if m["id"] == model and m["ready"]), None)
    if initial is None:
        initial = next((m["id"] for m in models if m["ready"]), "")
    return {"history": list_speech_tests(session.tenant["id"], "stt"), "models": models, "initialModel": initial}


def set_default_llm(session: Session, choice: object) -> dict[str, Any]:
    """Pick the account's default language model (Models ▸ Model lab ▸ LLM). A falsy choice clears it."""
    tenant_id = session.tenant["id"]
    value = choice if choice else None  # `choice || null`
    if not set_tenant_default_llm(tenant_id, value):  # type: ignore[arg-type]
        return {"ok": False, "message": "Unknown model."}
    audit(tenant_id, session.user, "llm.default", None, {"model": value})
    return {"ok": True}
