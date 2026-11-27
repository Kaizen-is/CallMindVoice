"""
L3: has the caller finished? An end-of-turn model that listens to how a phrase ends.

The Playground's silence wait (Q4) reads only the live words, so it must stay careful: "Men to'layman."
with a falling voice is over, the same words held up are not. Smart Turn v3.2 (pipecat-ai/smart-turn-v3,
`smart-turn-v3.2-cpu.onnx`, 8 MB, BSD-2-Clause) hears the tone: given the phrase so far (up to 8 s of
16 kHz audio, ending in a short pause) it says how sure it is that the speaker is done. It runs on the
CPU in tens of milliseconds, with onnxruntime alone (no torch, no transformers: the Whisper log-mel it
expects is computed here with numpy).

The live-words audio already reaches the server (app/routers/live.py); each live session keeps its last
8 s here (`note`), and the Playground's flush at the early pause asks for `end_probability`. Off when the
model file or onnxruntime is missing: SMART_TURN_MODEL (default data/models/smart-turn-v3.2-cpu.onnx).
"""

import logging
import threading
import time
from pathlib import Path

import numpy as np

from app.config import get_settings
from app.env import env

log = logging.getLogger("callmind.turn_model")

RATE = 16000
WINDOW_S = 8
KEEP_AT_BEGIN_S = 0.5  # a new phrase keeps the moment before speech was noticed
IDLE_DROP_S = 600  # buffers of live sessions nobody fed for 10 min are dropped

# ── Whisper's 80-band log-mel, as WhisperFeatureExtractor(chunk_length=8, do_normalize=True) ──


def _hz_to_mel(f: np.ndarray | float) -> np.ndarray:
    f = np.asarray(f, dtype=np.float64)
    log_step = 27.0 / np.log(6.4)
    return np.where(f >= 1000.0, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) * log_step, 3.0 * f / 200.0)


def _mel_to_hz(m: np.ndarray) -> np.ndarray:
    m = np.asarray(m, dtype=np.float64)
    log_step = np.log(6.4) / 27.0
    return np.where(m >= 15.0, 1000.0 * np.exp(log_step * (m - 15.0)), 200.0 * m / 3.0)


def _mel_filters(n_fft: int = 400, n_mels: int = 80) -> np.ndarray:
    fft_freqs = np.linspace(0, RATE // 2, 1 + n_fft // 2)
    filter_freqs = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(8000.0), n_mels + 2))
    diff = np.diff(filter_freqs)
    slopes = filter_freqs[None, :] - fft_freqs[:, None]
    bank = np.maximum(0.0, np.minimum(-slopes[:, :-2] / diff[:-1], slopes[:, 2:] / diff[1:]))
    return bank * (2.0 / (filter_freqs[2 : n_mels + 2] - filter_freqs[:n_mels]))[None, :]  # (201, 80), slaney


MEL = _mel_filters()
HANN = np.hanning(401)[:-1]  # periodic


def features(audio: np.ndarray) -> np.ndarray:
    """(1, 80, 800) float32 from float samples: the last 8 s, zero-padded at the start, normalised."""
    n = WINDOW_S * RATE
    x = audio[-n:] if len(audio) > n else np.pad(audio, (n - len(audio), 0))
    x = x.astype(np.float64)
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    padded = np.pad(x, (200, 200), mode="reflect")
    frames = 1 + (len(padded) - 400) // 160
    idx = np.arange(400)[None, :] + 160 * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(padded[idx] * HANN, n=400, axis=1)) ** 2
    log = np.log10(np.maximum(1e-10, spec @ MEL).T)[:, :-1]
    log = np.maximum(log, log.max() - 8.0)
    return ((log + 4.0) / 4.0).astype(np.float32)[None, :, :]


# ── the model ──

_lock = threading.Lock()
_session = None
_session_path = ""
_failed_path = ""


def model_path() -> Path:
    configured = env("SMART_TURN_MODEL")
    return Path(configured) if configured else get_settings().callmind_data_dir / "models" / "smart-turn-v3.2-cpu.onnx"


def _load():  # noqa: ANN202
    global _session, _session_path, _failed_path
    if _session_path == "test":
        return _session
    path = str(model_path())
    if _session is not None and _session_path == path:
        return _session
    if _failed_path == path or not Path(path).is_file():
        return None
    with _lock:
        if _session is not None and _session_path == path:
            return _session
        try:
            import onnxruntime as ort  # noqa: PLC0415 - optional dependency

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            _session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
            _session_path = path
            log.info("[turn] Smart Turn loaded: %s", path)
            return _session
        except Exception as err:  # noqa: BLE001
            _failed_path = path
            log.warning("[turn] end-of-turn model could not be loaded: %s", err)
            return None


def set_session(session) -> None:  # noqa: ANN001
    """Tests: a stand-in model (or None to forget it)."""
    global _session, _session_path, _failed_path
    _session, _session_path, _failed_path = session, "test" if session is not None else "", ""


def available() -> bool:
    return _load() is not None


_warmed = False


def _warm() -> None:
    """Load the model and run it once (the first run is several times slower than the rest)."""
    global _warmed
    if _warmed:
        return
    _warmed = True
    try:
        end_probability(np.zeros(RATE, dtype=np.float32))
    except Exception as err:  # noqa: BLE001
        log.warning("[turn] warm-up failed: %s", err)


def warm_up() -> None:
    """In the background, so the first phrase of a call is scored as fast as the rest."""
    if not _warmed and model_path().is_file():
        threading.Thread(target=_warm, name="turn-model-warm", daemon=True).start()


def end_probability(audio: np.ndarray) -> float | None:
    """How sure the model is (0–1) that the phrase in `audio` (float, 16 kHz) is finished; None without it."""
    session = _load()
    if session is None or len(audio) < RATE // 10:
        return None
    out = session.run(None, {"input_features": features(audio)})[0]
    return float(np.asarray(out).reshape(-1)[0])


# ── the live sessions' recent audio ──


class _Recent:
    __slots__ = ("buf", "fed_at")

    def __init__(self) -> None:
        self.buf = np.zeros(0, dtype=np.float32)
        self.fed_at = time.monotonic()

    def add(self, samples: np.ndarray) -> None:
        self.buf = np.concatenate([self.buf, samples])[-WINDOW_S * RATE :]
        self.fed_at = time.monotonic()


_recent: dict[tuple[str, str], _Recent] = {}
_recent_lock = threading.Lock()


def note(owner: str, sid: str, op: str, pcm: bytes | np.ndarray | None) -> None:
    """Keep a live session's audio as it streams in: feed/flush/finish add, begin starts a phrase, reset/close clear."""
    key = (owner, sid)
    with _recent_lock:
        if op == "close":
            _recent.pop(key, None)
            return
        now = time.monotonic()
        for stale in [k for k, r in _recent.items() if now - r.fed_at > IDLE_DROP_S]:
            del _recent[stale]
        if key not in _recent:
            warm_up()  # a live session opened: have the model ready before its first pause
        recent = _recent.setdefault(key, _Recent())
        if op == "reset":
            recent.buf = np.zeros(0, dtype=np.float32)
        elif op == "begin":
            recent.buf = recent.buf[-int(KEEP_AT_BEGIN_S * RATE) :]
        if pcm is not None and len(pcm) and op in ("feed", "flush", "finish"):
            if isinstance(pcm, bytes | bytearray):
                pcm = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0
            recent.add(pcm.astype(np.float32, copy=False))


def recent_audio(owner: str, sid: str) -> np.ndarray | None:
    with _recent_lock:
        recent = _recent.get((owner, sid))
        return None if recent is None else recent.buf.copy()


def end_probability_for(owner: str, sid: str) -> tuple[float | None, float]:
    """(probability, ms the model took) for a live session's phrase so far."""
    audio = recent_audio(owner, sid)
    if audio is None:
        return None, 0.0
    started = time.perf_counter()
    prob = end_probability(audio)
    return prob, (time.perf_counter() - started) * 1000
