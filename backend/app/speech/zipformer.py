"""
Zipformer — the streaming Uzbek STT model, inside this process. Port of
src/lib/speech/zipformer.ts on the `sherpa-onnx` Python package, with the same
model files (`models/uzbek-zipformer/`, int8 ONNX, ~70 MB) and settings.

Two ways in: `transcribe_wav` (one finished utterance) and live sessions
(`feed_live`, `finish_live`, `reset_live`, `close_live`) that the Playground
feeds in quarter-second pieces while the caller speaks.

Decoding is CPU work: callers run these in a thread (`asyncio.to_thread`). One
lock serialises all use of the recognizer, as Node's single thread did.
Env: ZIPFORMER_MODEL_DIR, ZIPFORMER_THREADS (default 2).
"""

import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import regex as re

from app.config import REPO_ROOT
from app.env import env
from app.jscompat import JS_S, js_round, js_trim
from app.speech.wav import ZIPFORMER_RATE, decode_wav

log = logging.getLogger("callmind.zipformer")

_lock = threading.RLock()
_state: dict[str, Any] = {"recognizer": None, "failed": None}


def _model_dir() -> Path:
    override = env("ZIPFORMER_MODEL_DIR")
    return Path(override).resolve() if override else REPO_ROOT / "models" / "uzbek-zipformer"


def _find_model(folder: Path) -> dict[str, str] | None:
    """encoder/decoder/joiner, preferring the int8 builds (the CPU ones)."""
    if not folder.exists():
        return None
    files = sorted(p.name for p in folder.iterdir())

    def pick(part: str) -> str | None:
        return next((f for f in files if f.startswith(part) and f.endswith(".int8.onnx")), None) or next(
            (f for f in files if f.startswith(part) and f.endswith(".onnx")), None
        )

    encoder, decoder, joiner = pick("encoder"), pick("decoder"), pick("joiner")
    if not encoder or not decoder or not joiner or "tokens.txt" not in files:
        return None
    return {
        "encoder": str(folder / encoder),
        "decoder": str(folder / decoder),
        "joiner": str(folder / joiner),
        "tokens": str(folder / "tokens.txt"),
    }


def zipformer_available() -> bool:
    """Whether the model files are present (and the model has not failed to load); cheap."""
    if _state["failed"]:
        return False
    return _find_model(_model_dir()) is not None


def _recognizer() -> Any:
    with _lock:
        if _state["recognizer"] is not None:
            return _state["recognizer"]
        if _state["failed"]:
            raise RuntimeError(_state["failed"])
        files = _find_model(_model_dir())
        if not files:
            _state["failed"] = f"zipformer model not found in {_model_dir()}"
            raise RuntimeError(_state["failed"])
        try:
            import sherpa_onnx  # optional native package: a server without it only loses Zipformer

            started = time.perf_counter()
            _state["recognizer"] = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=files["tokens"],
                encoder=files["encoder"],
                decoder=files["decoder"],
                joiner=files["joiner"],
                num_threads=int(env("ZIPFORMER_THREADS", "2")),
                sample_rate=ZIPFORMER_RATE,
                feature_dim=80,
                decoding_method="greedy_search",
                provider="cpu",
                # Endpoints split a long monologue into sentences on a live session.
                enable_endpoint_detection=True,
                rule1_min_trailing_silence=2.4,
                rule2_min_trailing_silence=0.8,
                rule3_min_utterance_length=20,
            )
            log.info("[zipformer] model loaded in %d ms", (time.perf_counter() - started) * 1000)
            return _state["recognizer"]
        except Exception as err:
            _state["failed"] = f"zipformer failed to load: {err}"
            log.error("[zipformer] %s", _state["failed"])
            raise RuntimeError(_state["failed"]) from err


_SPACES = re.compile(f"[{JS_S}]+")
_SENTENCE_START = re.compile(f"(^|[.?!][{JS_S}]+)(\\p{{Ll}})")


def tidy(text: str) -> str:
    """The model writes lowercase; give each sentence its capital."""
    return _SENTENCE_START.sub(lambda m: m.group(1) + m.group(2).upper(), js_trim(_SPACES.sub(" ", text)))


def _drain(rec: Any, stream: Any) -> None:
    while rec.is_ready(stream):
        rec.decode_stream(stream)


def _tail() -> np.ndarray:
    """Half a second of silence lets the last word clear the model's look-ahead."""
    return np.zeros(ZIPFORMER_RATE // 2, dtype=np.float32)


def transcribe_wav(audio: bytes) -> str:
    """Transcribe one finished utterance (16-bit PCM WAV)."""
    with _lock:
        rec = _recognizer()
        samples, sample_rate = decode_wav(audio)
        stream = rec.create_stream()
        stream.accept_waveform(sample_rate, samples)
        stream.accept_waveform(sample_rate, np.zeros(js_round(sample_rate / 2), dtype=np.float32))
        stream.input_finished()
        _drain(rec, stream)
        return tidy(rec.get_result(stream))


# ── live sessions ───────────────────────────────────────────────────


@dataclass
class _LiveSession:
    owner: str
    stream: Any
    finals: str = ""  # sentences already closed by an endpoint (a pause)
    seen: float = field(default_factory=time.time)


SESSION_IDLE_S = 2 * 60  # a session nobody fed for this long belongs to a closed tab
MAX_SESSIONS = 200
_sessions: dict[str, _LiveSession] = {}


def _sweep() -> None:
    cutoff = time.time() - SESSION_IDLE_S
    for sid in [k for k, s in _sessions.items() if s.seen < cutoff]:
        del _sessions[sid]


def _session(owner: str, sid: str) -> _LiveSession:
    s = _sessions.get(sid)
    if s is not None and s.owner != owner:
        raise PermissionError("session_owner")
    if s is None:
        _sweep()
        if len(_sessions) >= MAX_SESSIONS:
            raise RuntimeError("too_many_sessions")
        s = _LiveSession(owner, _recognizer().create_stream())
        _sessions[sid] = s
    s.seen = time.time()
    return s


def _joined(a: str, b: str) -> str:
    return js_trim(f"{a} {b}")


def feed_live(owner: str, sid: str, samples: np.ndarray) -> str:
    """Add a piece of live audio; returns the whole utterance heard so far."""
    with _lock:
        rec = _recognizer()
        s = _session(owner, sid)
        if len(samples):
            s.stream.accept_waveform(ZIPFORMER_RATE, samples)
            _drain(rec, s.stream)
        current = tidy(rec.get_result(s.stream))
        if rec.is_endpoint(s.stream):
            s.finals = _joined(s.finals, current)
            rec.reset(s.stream)
            return s.finals
        return _joined(s.finals, current)


def finish_live(owner: str, sid: str, samples: np.ndarray | None = None) -> str:
    """The phrase ended: decode the last few hundred ms, return it all, start fresh."""
    with _lock:
        rec = _recognizer()
        s = _session(owner, sid)
        if samples is not None and len(samples):
            s.stream.accept_waveform(ZIPFORMER_RATE, samples)
        s.stream.accept_waveform(ZIPFORMER_RATE, _tail())
        _drain(rec, s.stream)
        text = _joined(s.finals, tidy(rec.get_result(s.stream)))
        _sessions[sid] = _LiveSession(owner, rec.create_stream())
        return text


def begin_live(owner: str, sid: str) -> str:
    """
    The caller started a new phrase: the segments the recogniser already ended (speech no turn took
    up) are not its; the segment in progress is kept, as it holds the phrase's first words.
    """
    with _lock:
        rec = _recognizer()
        s = _session(owner, sid)
        s.finals = ""
        return tidy(rec.get_result(s.stream))


def reset_live(owner: str, sid: str) -> None:
    """Forget what was heard (the agent started speaking)."""
    with _lock:
        s = _sessions.get(sid)
        if s is None or s.owner != owner:
            return
        _sessions[sid] = _LiveSession(owner, _recognizer().create_stream())


def close_live(owner: str, sid: str) -> None:
    """The tab closed or the call ended."""
    with _lock:
        s = _sessions.get(sid)
        if s is not None and s.owner == owner:
            del _sessions[sid]
