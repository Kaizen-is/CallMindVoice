"""
The deploy benchmark — port of src/lib/benchmark.ts. Measures every engine set up on this server
once per build, and the Model lab shows the numbers:

  • STT: the fixed Uzbek test set in `benchmarks/stt-uz/` (WAV + the words spoken) through each
    engine → latency, word and character error rate.
  • TTS: three Uzbek sentences in one voice per engine → time to first sound, total time, and
    clarity (Zipformer hears it back).
  • LLM: three short Uzbek questions to each model → first word and total time (the median, so
    one slow or busy answer does not decide it).

It starts by itself a little after the API boots (`startup_router`, mounted from app/main.py) and
runs once per build: the build id (`.next/BUILD_ID`) is written to `benchmark_runs` before anything
else, so a restart, or a second process of the same build, finds it and does nothing. A new deploy
is a new build, so it runs again. Engine calls are logged as usage source `bench`, never as real
traffic. Development servers (NODE_ENV not `production`) skip it unless BENCHMARK_ON_START=1;
BENCHMARK_ON_START=0 turns it off everywhere.
"""

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI

from app import db
from app.catalog import VOICES
from app.config import REPO_ROOT
from app.env import env, env_raw
from app.ids import now_iso
from app.jscompat import js_round, js_trim
from app.llm.prompts import GenerateInput
from app.llm.provider import generate_answer, is_fallback_answer, llm_provider_ready
from app.registry import ENGINES, LLM_MODELS
from app.speech import zipformer
from app.speech.scoring import score
from app.speech.speko import ELEVEN_VOICES
from app.speech.stt import stt_engine_ids, transcribe_one
from app.speech.tts import SynthOptions, pcm_to_wav, render_timed, tts_engines
from app.usage_log import usage_source

log = logging.getLogger("callmind.benchmark")

SET_DIR = REPO_ROOT / "benchmarks" / "stt-uz"
# Wait after boot, so the benchmark never competes with the server starting up.
START_DELAY_S = 90.0

TTS_SENTENCES = [
    "Assalomu alaykum! Buyurtmangiz 25-noyabr kuni soat 14:30 da yetkaziladi.",
    "Shifokor qabuliga yozilish uchun ismingiz va telefon raqamingizni ayting.",
    "Kechirasiz, bu savolga javob bera olmayman, sizni mutaxassisga ulayman.",
]
LLM_QUESTIONS = [
    "O‘zbekistonning poytaxti qaysi shahar?",
    "Bir haftada necha kun bor?",
    "Suv necha darajada qaynaydi?",
]


def clock_ms() -> float:
    """`performance.now()`: milliseconds on a monotonic clock (tests replace it)."""
    return time.perf_counter() * 1000


def latest_benchmarks() -> list[dict[str, Any]]:
    """The latest result for every engine and model, from the last benchmark that measured it."""
    with db.connect() as conn:
        rows = db.fetch_all(
            conn,
            """SELECT kind, engine, passed, samples, latency_ms, first_ms, wer, cer, clarity, created_at
                 FROM benchmark_results
                WHERE id IN (SELECT MAX(id) FROM benchmark_results GROUP BY kind, engine)""",
        )
    return [
        {
            "kind": r["kind"],
            "engine": r["engine"],
            "passed": r["passed"],
            "samples": r["samples"],
            "latencyMs": r["latency_ms"],
            "firstMs": r["first_ms"],
            "wer": r["wer"],
            "cer": r["cer"],
            "clarity": r["clarity"],
            "measuredAt": r["created_at"],
        }
        for r in rows
    ]


# ── scheduling ──────────────────────────────────────────────────────

_task: asyncio.Task | None = None


def build_id() -> str | None:
    try:
        return js_trim((REPO_ROOT / ".next" / "BUILD_ID").read_text(encoding="utf-8")) or None
    except OSError:
        return "dev" if env_raw("BENCHMARK_ON_START") == "1" else None


def schedule_benchmark() -> asyncio.Task | None:
    """Called once at API start: runs the benchmark later, in the background, if this build has none."""
    global _task
    flag = env_raw("BENCHMARK_ON_START")
    if flag == "0":
        return None
    if env("NODE_ENV") != "production" and flag != "1":
        return None
    build = build_id()
    if not build:
        return None

    async def later() -> None:
        await asyncio.sleep(START_DELAY_S)
        try:
            await run_benchmark(build)
        except Exception as err:  # noqa: BLE001 - a failed benchmark must never touch the API
            log.warning("[benchmark] failed: %s", err)

    _task = asyncio.get_running_loop().create_task(later())
    return _task


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    task = schedule_benchmark()
    try:
        yield
    finally:
        if task is not None and not task.done():
            task.cancel()


# Mounted once in app/main.py (`app.include_router(benchmark.startup_router)`); it has no routes, only the
# startup hook. Not in app/routers on purpose: tests start apps without it.
startup_router = APIRouter(lifespan=_lifespan)


# ── the run ─────────────────────────────────────────────────────────


async def run_benchmark(build: str) -> bool:
    """Measure everything for `build`, unless it was measured already. Returns False when skipped."""
    # The claim comes first: of two servers starting together, one wins.
    with db.transaction() as tx:
        claimed = db.execute(
            tx,
            "INSERT OR IGNORE INTO benchmark_runs (build, started_at, status) VALUES (:b, :at, 'running')",
            b=build,
            at=now_iso(),
        )
    if not claimed:
        return False
    log.info("[benchmark] measuring engines for build %s", build)

    failed = False
    steps: list[tuple[str, Callable[[str], Awaitable[None]]]] = [
        ("stt", benchmark_stt),
        ("tts", benchmark_tts),
        ("llm", benchmark_llm),
    ]
    with usage_source("bench"):
        for name, step in steps:
            try:
                await step(build)
            except Exception as err:  # noqa: BLE001 - one failed step leaves the others
                failed = True
                log.warning("[benchmark] %s step failed: %s", name, err)
    with db.transaction() as tx:
        db.execute(
            tx,
            "UPDATE benchmark_runs SET finished_at = :at, status = :status WHERE build = :b",
            at=now_iso(),
            status="partial" if failed else "done",
            b=build,
        )
    log.info("[benchmark] done for build %s", build)
    return True


def _save(build: str, r: dict[str, Any]) -> None:
    def rounded(n: float | None) -> int | None:
        return None if n is None else js_round(n)

    with db.transaction() as tx:
        db.execute(
            tx,
            """INSERT INTO benchmark_results (build, kind, engine, passed, samples, latency_ms, first_ms, wer, cer,
                 clarity, created_at)
               VALUES (:build, :kind, :engine, :passed, :samples, :latency, :first, :wer, :cer, :clarity, :at)""",
            build=build,
            kind=r["kind"],
            engine=r["engine"],
            passed=r["passed"],
            samples=r["samples"],
            latency=rounded(r["latencyMs"]),
            first=rounded(r["firstMs"]),
            wer=r["wer"],
            cer=r["cer"],
            clarity=r["clarity"],
            at=now_iso(),
        )


def mean(xs: list[float]) -> float | None:
    """`xs.reduce((a, b) => a + b, 0) / xs.length` — added in order (Python's sum() compensates)."""
    if not xs:
        return None
    total = 0.0
    for x in xs:
        total += x
    return total / len(xs)


def median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


# ── STT ─────────────────────────────────────────────────────────────


def load_set() -> list[dict[str, Any]]:
    data = json.loads((SET_DIR / "set.json").read_text(encoding="utf-8"))
    return [{**c, "audio": (SET_DIR / c["file"]).read_bytes()} for c in data["clips"]]


async def benchmark_stt(build: str) -> None:
    clips = load_set()
    ready = stt_engine_ids()
    for e in ENGINES:
        if e.kind != "stt" or not ready.get(e.id):
            continue
        times: list[float] = []
        wers: list[float] = []
        cers: list[float] = []
        # One clip at a time, one engine at a time: each timing is the engine alone.
        for clip in clips:
            started = clock_ms()
            try:
                heard = await transcribe_one(e.id, clip["audio"], clip["language"])
                times.append(clock_ms() - started)
                s = score(clip["text"], heard["text"])
                if s["wer"] is not None:
                    wers.append(s["wer"])
                if s["cer"] is not None:
                    cers.append(s["cer"])
            except Exception:  # noqa: BLE001, S112 - counted as not passed
                continue
        _save(
            build,
            {
                "kind": "stt",
                "engine": e.id,
                "passed": len(times),
                "samples": len(clips),
                "latencyMs": mean(times),
                "firstMs": None,
                "wer": mean(wers),
                "cer": mean(cers),
                "clarity": None,
            },
        )


# ── TTS ─────────────────────────────────────────────────────────────


async def benchmark_tts(build: str) -> None:
    ready = tts_engines()
    hear = zipformer.zipformer_available()
    for e in ENGINES:
        if e.kind != "tts" or not ready.get(e.id):
            continue
        engine = e.id
        voice_id = (
            (VOICES[0]["id"] if VOICES else None)
            if engine == "default"
            else (ELEVEN_VOICES[0]["id"] if ELEVEN_VOICES else None)
        )
        if not voice_id:
            continue
        first: list[float] = []
        total: list[float] = []
        clarity: list[float] = []
        for sentence in TTS_SENTENCES:
            try:
                out = await render_timed(
                    sentence, SynthOptions(tenant_id="bench", voice_id=voice_id, language="uz", engine=engine)
                )
                first.append(out["firstMs"])
                total.append(out["totalMs"])
                if hear:
                    heard = await asyncio.to_thread(zipformer.transcribe_wav, pcm_to_wav(out["pcm"]))
                    s = score(out["spoken"], heard)
                    if s["cer"] is not None:
                        clarity.append(max(0, 1 - s["cer"]))
            except Exception:  # noqa: BLE001, S112 - counted as not passed
                continue
        _save(
            build,
            {
                "kind": "tts",
                "engine": engine,
                "passed": len(total),
                "samples": len(TTS_SENTENCES),
                "latencyMs": mean(total),
                "firstMs": mean(first),
                "wer": None,
                "cer": None,
                "clarity": mean(clarity),
            },
        )


# ── LLM ─────────────────────────────────────────────────────────────


async def benchmark_llm(build: str) -> None:
    for m in LLM_MODELS:
        if not llm_provider_ready(m.provider):
            continue
        first: list[float] = []
        total: list[float] = []
        for question in LLM_QUESTIONS:
            started = clock_ms()
            first_ms: list[float] = []

            def on_delta(_delta: str, started: float = started, first_ms: list[float] = first_ms) -> None:
                if not first_ms:
                    first_ms.append(clock_ms() - started)

            try:
                out = await generate_answer(
                    GenerateInput(
                        question=question,
                        hits=[],
                        confidence=0,
                        language="uz",
                        agent_name="CallMind",
                        threshold=0.45,
                        history=[],
                        llm=m.id,
                    ),
                    on_delta,
                )
            except Exception:  # noqa: BLE001 - `.catch(() => null)`
                out = None
            # The model under test failed if the local engine or the fallback model answered for it.
            if not out or out["engine"] == "local" or is_fallback_answer(out) or not js_trim(out["answer"]):
                continue
            total_ms = clock_ms() - started
            total.append(total_ms)
            # Models that answer in one piece have no separate first word.
            first.append(first_ms[0] if first_ms else total_ms)
        _save(
            build,
            {
                "kind": "llm",
                "engine": m.id,
                "passed": len(total),
                "samples": len(LLM_QUESTIONS),
                "latencyMs": median(total),
                "firstMs": median(first),
                "wer": None,
                "cer": None,
                "clarity": None,
            },
        )
