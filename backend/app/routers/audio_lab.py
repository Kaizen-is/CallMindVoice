"""
The Audio Processing Lab behind For developers ▸ STT ("Nutqni matnga").

  GET  /audio/capabilities   which stages and providers this server can really run
  POST /audio/process        multipart {file: a 16-bit WAV at its own rate, options: JSON}
                             → JSON: per-stage results, VAD segments and scores, metrics, and
                               short-lived clip tokens (raw / conditioned / denoised / isolated /
                               final) for playback and download
  GET  /audio/clip/{token}   one of those clips as a WAV (its owner only, for CLIP_TTL_S)

The page decodes MP3/M4A/OGG in the browser and uploads WAV at the file's own sample rate, so the
server sees the full band. Clips live in memory only (app/audio/store.py). Off with AUDIO_LAB=0.
"""

import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from app.audio import isolation as iso
from app.audio import store
from app.audio.dsp import to_wav
from app.audio.pipeline import MAX_LAB_SECONDS, ProcessingOptions, flag, run_pipeline
from app.audio.vad import VADS
from app.auth import LoggedIn
from app.env import env
from app.speech.denoise import denoise_configured
from app.speech.wav import decode_wav

log = logging.getLogger("callmind.audio.lab")

router = APIRouter()

MAX_UPLOAD_BYTES = 40 * 1024 * 1024


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def _lab_enabled() -> bool:
    return env("AUDIO_LAB", "1").strip().lower() not in ("0", "false", "no", "off")


def _owner(session) -> str:  # noqa: ANN001
    return f"{session.tenant['id']}:{session.user['id']}"


@router.get("/audio/capabilities")
async def capabilities(session: LoggedIn) -> JSONResponse:
    return JSONResponse(
        {
            "enabled": _lab_enabled(),
            "noiseSuppression": {"provider": "cleanvoice", "available": denoise_configured()},
            "voiceIsolation": [
                {
                    "id": name,
                    "model": p.model,
                    "nativeRates": list(p.native_rates),
                    "available": p.available(),
                    "kind": "dominant_speaker",
                }
                for name, p in iso.PROVIDERS.items()
            ],
            "vad": [{"id": name, "available": v.available()} for name, v in VADS.items()],
            "live": {
                "browserIsolation": flag("VOICE_ISOLATION_BROWSER"),
                "phoneIsolation": flag("VOICE_ISOLATION_PHONE"),
                "serverVad": env("SERVER_VAD", "off"),
                "fallback": env("VOICE_ISOLATION_FALLBACK", "original"),
            },
            "sttRate": 16000,
            "maxSeconds": MAX_LAB_SECONDS,
        }
    )


@router.post("/audio/process")
async def process(request: Request, session: LoggedIn) -> Response:
    if not _lab_enabled():
        return _error("lab_disabled", 404)
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001
        return _error("bad_request", 400)
    file = form.get("file")
    if not isinstance(file, UploadFile):
        return _error("no_audio", 400)
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        return _error("too_large", 413)
    try:
        samples, rate = decode_wav(data)
    except ValueError as err:
        return _error(str(err), 415)
    if not rate or len(samples) / rate > MAX_LAB_SECONDS:
        return _error("too_long", 413)
    raw_opts = form.get("options")
    try:
        opts = ProcessingOptions.from_json(json.loads(raw_opts) if isinstance(raw_opts, str) and raw_opts else {})
    except ValueError:
        return _error("bad_options", 400)

    owner = _owner(session)
    clips: dict[str, dict] = {}

    def keep(stage: str, audio, sample_rate: int) -> None:  # noqa: ANN001
        clips[stage] = {"token": store.put(owner, to_wav(audio, sample_rate)), "sampleRate": sample_rate}

    result = await run_pipeline(samples, rate, opts, keep=keep)
    for stage in result.stages:
        stage_clip = {"noise_suppression": "denoised", "voice_isolation": "isolated"}.get(stage.name)
        if stage_clip and stage_clip in clips:
            stage.clip = clips[stage_clip]["token"]

    vad = result.vad
    by_name = {s.name: s for s in result.stages}
    iso_stage = by_name.get("voice_isolation")
    log.info(
        "[lab] %.1f s at %d Hz: isolation=%s vad=%s total %.0f ms",
        result.input_duration_ms / 1000,
        rate,
        iso_stage.status if iso_stage else "-",
        vad.engine if vad else "off",
        result.total_ms,
    )
    return JSONResponse(
        {
            "stages": [s.as_json() for s in result.stages],
            "clips": clips,
            "vad": None
            if vad is None
            else {
                "engine": vad.engine,
                "scoreKind": vad.score_kind,
                "hopMs": vad.hop_ms,
                "scores": [round(x, 3) for x in vad.scores],
                "segments": [{"startMs": round(s.start_ms), "endMs": round(s.end_ms)} for s in vad.segments],
            },
            "metrics": {
                "inputDurationMs": round(result.input_duration_ms),
                "inputSampleRate": result.input_sample_rate,
                "outputSampleRate": result.sample_rate,
                "outputDurationMs": round(len(result.samples) / result.sample_rate * 1000),
                "isolationMs": round(iso_stage.ms, 1) if iso_stage and iso_stage.status == "ran" else None,
                "totalMs": round(result.total_ms, 1),
            },
            "options": {
                "highpass": opts.highpass,
                "gain": opts.gain,
                "noiseSuppression": opts.noise_suppression,
                "voiceIsolation": opts.voice_isolation,
                "isolationProvider": opts.isolation_provider,
                "vad": opts.vad,
                "trim": opts.trim,
                "minSpeechMs": opts.min_speech_ms,
                "endSilenceMs": opts.end_silence_ms,
            },
        },
        headers={"Cache-Control": "no-store"},
    )


@router.get("/audio/clip/{token}")
async def clip(token: str, session: LoggedIn) -> Response:
    wav = store.get(_owner(session), token)
    if wav is None:
        return _error("not_found", 404)
    return Response(wav, media_type="audio/wav", headers={"Cache-Control": "private, no-store"})
