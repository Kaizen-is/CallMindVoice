"""
The preprocessing pipeline over one clip, and its use in front of live STT.

    decode → high-pass → gain → noise suppression → voice isolation → resample 16 kHz → VAD → trim

Every stage appends a StageResult with its real status and timing. The STT lab runs it with the
options the page sends; live turns run `prepare_for_stt` with the env flags (default: nothing
changes). Isolation runs at the input's own rate, before resampling, so a 48 kHz model gets the
full band when the input has it.

Live flags (all off by default):
  VOICE_ISOLATION_BROWSER=1   isolate browser turns (Playground, demos) before STT
  VOICE_ISOLATION_PHONE=1     isolate phone turns (the bridge's utterances) before STT
  VOICE_ISOLATION_FALLBACK    original (default): isolation failed → STT gets the original audio;
                              reject: the turn counts as "nothing heard" — for flows where audio of
                              uncertain origin must not become trusted input
  SERVER_VAD                  off (default) | energy | silero: also trim live turns to speech
"""

import logging
import time
from dataclasses import dataclass

import numpy as np

from app.audio import isolation as iso
from app.audio.dsp import highpass, keep_segments, level_db, normalize_gain, resample, to_wav
from app.audio.types import AudioProcessingResult, StageResult, VadResult
from app.audio.vad import VADS, VadSettings
from app.env import env
from app.speech.denoise import denoise_detailed
from app.speech.wav import decode_wav

log = logging.getLogger("callmind.audio")

STT_RATE = 16000
MAX_LAB_SECONDS = 120


def flag(name: str) -> bool:
    return env(name).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class ProcessingOptions:
    highpass: bool = True
    gain: bool = True
    noise_suppression: bool = False
    voice_isolation: bool = False
    isolation_provider: str = "inworld"
    vad: str = "energy"  # energy | silero | off
    trim: bool = False  # cut the final audio down to the detected speech
    min_speech_ms: float = 250.0
    end_silence_ms: float = 700.0
    pad_ms: float = 250.0

    @classmethod
    def from_json(cls, data: object) -> "ProcessingOptions":
        d = data if isinstance(data, dict) else {}
        o = cls()

        def num(key: str, lo: float, hi: float, default: float) -> float:
            v = d.get(key)
            return min(hi, max(lo, float(v))) if isinstance(v, int | float) and not isinstance(v, bool) else default

        for key in ("highpass", "gain", "trim"):
            if isinstance(d.get(key), bool):
                setattr(o, key, d[key])
        if isinstance(d.get("noiseSuppression"), bool):
            o.noise_suppression = d["noiseSuppression"]
        if isinstance(d.get("voiceIsolation"), bool):
            o.voice_isolation = d["voiceIsolation"]
        if d.get("isolationProvider") in iso.PROVIDERS:
            o.isolation_provider = d["isolationProvider"]
        if d.get("vad") in ("energy", "silero", "off"):
            o.vad = d["vad"]
        o.min_speech_ms = num("minSpeechMs", 50, 2000, o.min_speech_ms)
        o.end_silence_ms = num("endSilenceMs", 100, 3000, o.end_silence_ms)
        o.pad_ms = num("padMs", 0, 1000, o.pad_ms)
        return o


class IsolationRejected(Exception):
    """VOICE_ISOLATION_FALLBACK=reject and isolation could not run: the audio is not trusted."""


async def run_pipeline(
    samples: np.ndarray, sample_rate: int, opts: ProcessingOptions, *, keep=None, fallback: str = "original"
) -> AudioProcessingResult:
    """
    Run the stages on mono float samples. `keep(stage, samples, rate)` is called with each stage's
    output (the lab stores them for inspection). Never raises for a failing optional stage, except
    IsolationRejected under the "reject" fallback.
    """
    started = time.perf_counter()
    stages: list[StageResult] = []
    input_rate = sample_rate
    input_ms = len(samples) / sample_rate * 1000 if sample_rate else 0.0
    x = samples.astype(np.float32)
    if keep:
        keep("raw", x, sample_rate)

    def timed(name: str, enabled: bool, fn) -> None:  # noqa: ANN001
        nonlocal x
        if not enabled:
            stages.append(StageResult(name, "disabled", sample_rate_in=sample_rate, sample_rate_out=sample_rate))
            return
        t = time.perf_counter()
        before = level_db(x)
        x, notes = fn(x)
        stages.append(
            StageResult(
                name,
                "ran",
                (time.perf_counter() - t) * 1000,
                sample_rate_in=sample_rate,
                sample_rate_out=sample_rate,
                level_in_db=before,
                level_out_db=level_db(x),
                notes=notes,
            )
        )

    timed("highpass", opts.highpass, lambda a: (highpass(a, sample_rate), ["75 Hz"]))

    def _gain(a: np.ndarray) -> tuple[np.ndarray, list[str]]:
        out, g = normalize_gain(a)
        return out, [f"x{g:.2f}"]

    timed("gain", opts.gain, _gain)
    if keep and (opts.highpass or opts.gain):
        keep("conditioned", x, sample_rate)

    # Noise suppression (CleanVoice): noise only, not other voices.
    if not opts.noise_suppression:
        stages.append(StageResult("noise_suppression", "disabled", provider="cleanvoice"))
    else:
        t = time.perf_counter()
        outcome = await denoise_detailed(to_wav(x, sample_rate), threshold_db=1000)
        stage = StageResult(
            "noise_suppression",
            "unavailable",
            provider="cleanvoice",
            sample_rate_in=sample_rate,
            sample_rate_out=sample_rate,
            level_in_db=level_db(x),
        )
        if outcome.status in ("cleaned", "skipped"):
            cleaned, rate = decode_wav(outcome.audio)
            x = resample(cleaned, rate, sample_rate)
            stage.status = "ran" if outcome.status == "cleaned" else "bypassed"
            if outcome.snr_db:
                stage.notes.append(f"SNR {outcome.snr_db} dB (service estimate)")
        elif outcome.status == "failed":
            stage.status, stage.error = "failed", outcome.error
        stage.level_out_db = level_db(x)
        stage.ms = (time.perf_counter() - t) * 1000
        stages.append(stage)
        if keep and stage.status == "ran":
            keep("denoised", x, sample_rate)

    # Voice isolation: suppress competing voices.
    provider = iso.provider(opts.isolation_provider)
    if not opts.voice_isolation:
        stages.append(StageResult("voice_isolation", "disabled", provider=opts.isolation_provider))
    elif provider is None or not provider.available():
        stage = StageResult(
            "voice_isolation", "unavailable", provider=opts.isolation_provider, error="provider_not_configured"
        )
        stages.append(stage)
        if fallback == "reject":
            raise IsolationRejected(stage.error)
    else:
        x, stage = await provider.process_clip(x, sample_rate)
        stages.append(stage)
        if stage.status != "ran" and fallback == "reject":
            raise IsolationRejected(stage.error)
        if keep and stage.status == "ran":
            keep("isolated", x, sample_rate)

    # The rate every STT engine here takes.
    if sample_rate != STT_RATE:
        t = time.perf_counter()
        x = resample(x, sample_rate, STT_RATE)
        stages.append(
            StageResult(
                "resample",
                "ran",
                1000 * (time.perf_counter() - t),
                sample_rate_in=sample_rate,
                sample_rate_out=STT_RATE,
            )
        )
        sample_rate = STT_RATE

    vad: VadResult | None = None
    detector = VADS.get(opts.vad)
    if detector is None:
        stages.append(StageResult("vad", "disabled"))
    elif not detector.available():
        stages.append(StageResult("vad", "unavailable", provider=opts.vad, error="model_not_configured"))
    else:
        t = time.perf_counter()
        settings = VadSettings(min_speech_ms=opts.min_speech_ms, min_silence_ms=opts.end_silence_ms, pad_ms=opts.pad_ms)
        vad = detector.detect(x, sample_rate, settings)
        stages.append(
            StageResult(
                "vad",
                "ran",
                (time.perf_counter() - t) * 1000,
                provider=vad.engine,
                sample_rate_in=sample_rate,
                sample_rate_out=sample_rate,
                notes=[f"{len(vad.segments)} speech segment(s)"],
            )
        )

    if opts.trim and vad is not None:
        t = time.perf_counter()
        before_ms = len(x) / sample_rate * 1000
        x = keep_segments(x, sample_rate, vad.segments)
        stages.append(
            StageResult(
                "trim",
                "ran",
                (time.perf_counter() - t) * 1000,
                sample_rate_in=sample_rate,
                sample_rate_out=sample_rate,
                notes=[f"{before_ms - len(x) / sample_rate * 1000:.0f} ms removed"],
            )
        )
    else:
        stages.append(StageResult("trim", "disabled"))

    if keep:
        keep("final", x, sample_rate)
    return AudioProcessingResult(
        samples=x,
        sample_rate=sample_rate,
        stages=stages,
        vad=vad,
        input_sample_rate=input_rate,
        input_duration_ms=input_ms,
        total_ms=(time.perf_counter() - started) * 1000,
    )


# ── live turns ──────────────────────────────────────────────────────


def live_options(route: str) -> ProcessingOptions | None:
    """What live turns of `route` ("browser" | "phone") get, or None when nothing is switched on."""
    isolate = flag("VOICE_ISOLATION_PHONE" if route == "phone" else "VOICE_ISOLATION_BROWSER")
    server_vad = env("SERVER_VAD", "off").lower()
    if not isolate and server_vad not in ("energy", "silero"):
        return None
    return ProcessingOptions(
        highpass=False,  # the browser already did; the phone line is band-limited
        gain=False,
        noise_suppression=False,  # transcribe(clean=True) still runs CleanVoice as before
        voice_isolation=isolate,
        isolation_provider=env("VOICE_ISOLATION_PROVIDER", "inworld"),
        vad=server_vad if server_vad in ("energy", "silero") else "off",
        trim=server_vad in ("energy", "silero"),
        end_silence_ms=500.0,
    )


async def prepare_for_stt(wav: bytes, route: str) -> bytes:
    """
    A live turn's utterance before STT. With every flag off (the default) this returns `wav` itself.
    Raises IsolationRejected only under VOICE_ISOLATION_FALLBACK=reject.
    """
    opts = live_options(route)
    if opts is None:
        return wav
    try:
        samples, rate = decode_wav(wav)
    except ValueError:
        return wav
    fallback = "reject" if env("VOICE_ISOLATION_FALLBACK", "original").lower() == "reject" else "original"
    result = await run_pipeline(samples, rate, opts, fallback=fallback)
    iso_stage = result.stage("voice_isolation")
    log.info(
        "[audio] %s turn: isolation=%s (%s ms) vad=%s total=%.0f ms",
        route,
        iso_stage.status if iso_stage else "-",
        round(iso_stage.ms) if iso_stage else 0,
        result.vad.engine if result.vad else "off",
        result.total_ms,
    )
    if result.vad is not None and not result.vad.segments:
        return to_wav(np.zeros(0, dtype=np.float32), result.sample_rate)  # no speech: STT hears silence
    return to_wav(result.samples, result.sample_rate)


async def prepare_live(wav: bytes, route: str) -> bytes:
    """
    `prepare_for_stt` for a live turn that must never fail because of preprocessing: an unexpected
    error passes the original audio on; a rejection (fallback "reject") becomes silence, which STT
    reports as nothing heard, so the agent asks again instead of acting on untrusted audio.
    """
    try:
        return await prepare_for_stt(wav, route)
    except IsolationRejected:
        log.warning("[audio] %s turn rejected: voice isolation unavailable (fallback=reject)", route)
        return to_wav(np.zeros(0, dtype=np.float32), STT_RATE)
    except Exception as err:  # noqa: BLE001
        log.warning("[audio] %s turn preprocessing failed, original audio used: %s", route, err)
        return wav
