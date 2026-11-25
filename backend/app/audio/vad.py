"""
Voice activity detection over a clip: the energy VAD (always there) and Silero VAD (neural, optional).

Both produce per-hop scores and then the same hysteresis segmenter: speech starts at `threshold`,
ends only after `min_silence_ms` below `neg_threshold`, must last `min_speech_ms`, and each segment
is padded by `pad_ms` on both sides (pre-roll), so quiet word onsets and last syllables survive.

VAD detects speech, not WHO speaks: it is never a speaker check.

Silero VAD runs on onnxruntime alone (no torch). Its tensors, from snakers4/silero-vad
`utils_vad.OnnxWrapper`: input "input" float32 (1, context + window), "state" float32 (2, 1, 128),
"sr" int64 scalar; outputs (probability, new state). Window 512 samples at 16 kHz (32 ms) and 256 at
8 kHz, with the last 64 / 32 samples of the previous window prepended as context. Set
SILERO_VAD_MODEL to the path of `silero_vad.onnx` and install `onnxruntime` to enable it.
"""

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.audio.dsp import resample
from app.audio.types import SpeechSegment, VadResult
from app.env import env

log = logging.getLogger("callmind.audio.vad")


@dataclass(frozen=True)
class VadSettings:
    threshold: float = 0.5
    neg_threshold: float = 0.35
    min_speech_ms: float = 250.0
    min_silence_ms: float = 700.0
    pad_ms: float = 250.0


def segments_from_scores(scores: list[float], hop_ms: float, total_ms: float, s: VadSettings) -> list[SpeechSegment]:
    """Hysteresis segmentation of per-hop speech scores (see the module note)."""
    segments: list[SpeechSegment] = []
    start: float | None = None
    last_speech = 0.0
    for i, score in enumerate(scores):
        t = i * hop_ms
        if start is None:
            if score >= s.threshold:
                start = t
                last_speech = t + hop_ms
        elif score >= s.neg_threshold:
            last_speech = t + hop_ms
        elif t + hop_ms - last_speech >= s.min_silence_ms:
            if last_speech - start >= s.min_speech_ms:
                segments.append(SpeechSegment(start, last_speech))
            start = None
    if start is not None and last_speech - start >= s.min_speech_ms:
        segments.append(SpeechSegment(start, last_speech))
    # Pad (pre-roll / post-roll), then merge what now overlaps.
    padded: list[SpeechSegment] = []
    for seg in segments:
        a, b = max(0.0, seg.start_ms - s.pad_ms), min(total_ms, seg.end_ms + s.pad_ms)
        if padded and a <= padded[-1].end_ms:
            padded[-1].end_ms = max(padded[-1].end_ms, b)
        else:
            padded.append(SpeechSegment(a, b))
    return padded


class EnergyVad:
    """Adaptive energy detector: frames well above the clip's own noise floor. Fast, no model."""

    name = "energy"
    hop_ms = 20.0

    def available(self) -> bool:
        return True

    def scores(self, samples: np.ndarray, sample_rate: int) -> list[float]:
        hop = max(1, int(sample_rate * self.hop_ms / 1000))
        n = len(samples) // hop
        if n == 0:
            return []
        frames = samples[: n * hop].astype(np.float64).reshape(n, hop)
        rms = np.sqrt(np.mean(frames**2, axis=1)) + 1e-9
        db = 20 * np.log10(rms)
        floor_db = float(np.percentile(db, 10))
        # 0 at the noise floor, 0.5 at +9.5 dB (≈3× the floor's amplitude), 1 at +19 dB;
        # nothing quieter than -60 dBFS counts as speech (a quiet caller is around -45 to -50).
        score = np.clip((db - floor_db) / 19.0, 0, 1)
        score[db < -60] = 0
        return [float(x) for x in score]

    def detect(self, samples: np.ndarray, sample_rate: int, settings: VadSettings | None = None) -> VadResult:
        s = settings or VadSettings()
        scores = self.scores(samples, sample_rate)
        total = len(samples) / sample_rate * 1000 if sample_rate else 0
        return VadResult(
            "energy", segments_from_scores(scores, self.hop_ms, total, s), self.hop_ms, scores, "energy_score"
        )


# ── Silero (neural) ─────────────────────────────────────────────────

_session_lock = threading.Lock()
_session = None  # one onnxruntime session per process, shared by every stream
_session_path = ""


def _load_session():  # noqa: ANN202
    """The process-wide Silero session (loaded once), or None when it cannot be."""
    global _session, _session_path
    if _session is not None and _session_path == "test":
        return _session  # installed by set_silero_session
    path = env("SILERO_VAD_MODEL")
    if not path:
        return None
    with _session_lock:
        if _session is not None and _session_path == path:
            return _session
        if not Path(path).is_file():
            log.warning("[vad] SILERO_VAD_MODEL does not exist: %s", path)
            return None
        try:
            import onnxruntime as ort  # noqa: PLC0415 - optional dependency

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 1
            opts.inter_op_num_threads = 1
            _session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
            _session_path = path
            return _session
        except Exception as err:  # noqa: BLE001
            log.warning("[vad] Silero model could not be loaded: %s", err)
            return None


def set_silero_session(session, path: str = "test") -> None:  # noqa: ANN001
    """Tests: install a stand-in session (or None to forget the loaded one)."""
    global _session, _session_path
    _session, _session_path = session, path


class SileroStream:
    """Per-session state over the shared model: feed consecutive windows, get probabilities."""

    def __init__(self, session, sample_rate: int):  # noqa: ANN001
        if sample_rate not in (8000, 16000):
            raise ValueError("silero_rate")
        self.session = session
        self.sample_rate = sample_rate
        self.window = 512 if sample_rate == 16000 else 256
        self.context_size = 64 if sample_rate == 16000 else 32
        self.reset()

    def reset(self) -> None:
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, self.context_size), dtype=np.float32)

    def prob(self, window: np.ndarray) -> float:
        if len(window) != self.window:
            raise ValueError("silero_window")
        x = np.concatenate([self.context, window.astype(np.float32).reshape(1, -1)], axis=1)
        out, state = self.session.run(
            None, {"input": x, "state": self.state, "sr": np.array(self.sample_rate, dtype=np.int64)}
        )
        self.state = np.asarray(state, dtype=np.float32)
        self.context = x[:, -self.context_size :]
        return float(np.asarray(out).reshape(-1)[0])


class SileroVad:
    name = "silero"

    def available(self) -> bool:
        return _load_session() is not None

    def detect(self, samples: np.ndarray, sample_rate: int, settings: VadSettings | None = None) -> VadResult:
        session = _load_session()
        if session is None:
            raise RuntimeError("silero_unavailable")
        s = settings or VadSettings()
        rate = 8000 if sample_rate == 8000 else 16000
        audio = samples if sample_rate == rate else resample(samples, sample_rate, rate)
        stream = SileroStream(session, rate)
        hop_ms = stream.window / rate * 1000
        n = len(audio) // stream.window
        scores = [stream.prob(audio[i * stream.window : (i + 1) * stream.window]) for i in range(n)]
        total = len(samples) / sample_rate * 1000 if sample_rate else 0
        return VadResult("silero", segments_from_scores(scores, hop_ms, total, s), hop_ms, scores, "probability")


VADS = {"energy": EnergyVad(), "silero": SileroVad()}
