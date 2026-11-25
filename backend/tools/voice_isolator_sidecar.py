"""
Voice-isolation sidecar: Inworld voice-isolator behind a small HTTP API, for VOICE_ISOLATION_URL.

    POST /isolate   multipart `file` (a 16-bit mono WAV, ideally 48 kHz) → the isolated WAV
    GET  /health    {"ok": true, "model": ..., "device": ...}

It runs apart from the backend because it needs PyTorch and downloads the model weights from
Hugging Face (inworld/voice-isolator, Apache-2.0) on first use. The model is loaded once at start
and shared by all requests.

    pip install fastapi uvicorn numpy torch <the inworld voice-isolator package, see its README>
    python backend/tools/voice_isolator_sidecar.py      # port VOICE_ISOLATOR_PORT, default 8095

Status: written against the API in the project README (Nov 2026) —
`voice_isolation.VoiceIsolator("inworld/voice-isolator").isolate(wav, sample_rate)` with a torch
tensor — and NOT yet run here (no torch or weights on the dev PC). Check the tensor shape it expects
the first time; the model card says it keeps the louder voice: dominant speaker, not a speaker
selector.
"""

import io
import os
import time
import wave

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, Response

MODEL_ID = os.environ.get("VOICE_ISOLATION_MODEL", "inworld/voice-isolator")
DEVICE = os.environ.get("VOICE_ISOLATION_DEVICE", "cpu")
RATE = 48000

app = FastAPI()
_isolator = None


def isolator():  # noqa: ANN201
    global _isolator
    if _isolator is None:
        from inworld import voice_isolation  # noqa: PLC0415 - heavy, optional

        _isolator = voice_isolation.VoiceIsolator(MODEL_ID)
        if hasattr(_isolator, "to"):
            _isolator.to(DEVICE)
    return _isolator


def read_wav(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data)) as w:
        if w.getsampwidth() != 2:
            raise ValueError("wav_not_16bit")
        rate, channels = w.getframerate(), w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    return pcm, rate


def write_wav(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "model": MODEL_ID, "device": DEVICE, "loaded": _isolator is not None})


@app.post("/isolate")
async def isolate(file: UploadFile = File(...)) -> Response:  # noqa: B008
    import torch  # noqa: PLC0415

    samples, rate = read_wav(await file.read())
    if rate != RATE:
        return JSONResponse({"error": f"expected {RATE} Hz, got {rate}"}, status_code=415)
    started = time.perf_counter()
    with torch.inference_mode():
        out = isolator().isolate(torch.from_numpy(samples).unsqueeze(0), RATE)
    result = out.squeeze().detach().cpu().numpy() if hasattr(out, "detach") else np.asarray(out).squeeze()
    ms = (time.perf_counter() - started) * 1000
    return Response(
        write_wav(result.astype(np.float32), RATE),
        media_type="audio/wav",
        headers={"x-processing-ms": f"{ms:.0f}", "x-rtf": f"{ms / 1000 / (len(samples) / RATE):.3f}"},
    )


if __name__ == "__main__":
    isolator()  # load once, before the first request
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("VOICE_ISOLATOR_PORT", "8095")))
