"""The shared vocabulary of the audio pipeline: frames, stage results and processor interfaces."""

from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np

Encoding = Literal["float32", "pcm16"]
StageStatus = Literal["ran", "bypassed", "disabled", "unavailable", "failed"]
TurnPhase = Literal["idle", "listening", "capturing", "finalizing", "thinking", "speaking", "rearming", "error"]


@dataclass
class AudioFrame:
    """A block of mono audio with everything a stateful processor needs to know about it."""

    samples: np.ndarray  # float32 in [-1, 1]
    sample_rate: int
    session_id: str = ""
    seq: int = 0  # frame number within the session
    timestamp_ms: float = 0.0  # start of the frame, from the start of the session
    channels: int = 1
    encoding: Encoding = "float32"

    @property
    def duration_ms(self) -> float:
        return len(self.samples) / self.sample_rate * 1000 if self.sample_rate else 0.0


@dataclass
class StageResult:
    """What one stage did. `status` is the truth: only "ran" means the audio was changed by it."""

    name: str  # highpass | gain | noise_suppression | voice_isolation | resample | vad | trim
    status: StageStatus
    ms: float = 0.0
    provider: str = ""
    model: str = ""
    sample_rate_in: int = 0
    sample_rate_out: int = 0
    level_in_db: float | None = None
    level_out_db: float | None = None
    error: str = ""
    notes: list[str] = field(default_factory=list)
    clip: str = ""  # temporary token of this stage's output audio, when it was kept

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "status": self.status,
            "ms": round(self.ms, 1),
            "provider": self.provider,
            "model": self.model,
            "sampleRateIn": self.sample_rate_in,
            "sampleRateOut": self.sample_rate_out,
            "levelInDb": None if self.level_in_db is None else round(self.level_in_db, 1),
            "levelOutDb": None if self.level_out_db is None else round(self.level_out_db, 1),
            "error": self.error,
            "notes": self.notes,
            "clip": self.clip,
        }


@dataclass
class SpeechSegment:
    start_ms: float
    end_ms: float


@dataclass
class VadResult:
    engine: str  # energy | silero
    segments: list[SpeechSegment]
    hop_ms: float
    scores: list[float]  # per hop; a probability for silero, an energy score (0..1) for energy
    score_kind: Literal["probability", "energy_score"]


@dataclass
class AudioProcessingResult:
    """The whole pipeline run on one clip."""

    samples: np.ndarray  # the final audio, the exact samples handed to STT
    sample_rate: int
    stages: list[StageResult]
    vad: VadResult | None
    input_sample_rate: int
    input_duration_ms: float
    total_ms: float
    rejected: bool = False  # the fallback policy refused the audio (see isolation.py)

    def stage(self, name: str) -> StageResult | None:
        return next((s for s in self.stages if s.name == name), None)


# ── processor interfaces ────────────────────────────────────────────


class AudioStreamProcessor(Protocol):
    """Stateful processing of consecutive frames of ONE session. Never shared between sessions."""

    def process(self, frame: AudioFrame) -> AudioFrame: ...

    def reset(self) -> None: ...


class NoiseSuppressionProcessor(Protocol):
    """Removes steady and impulsive NOISE. It does not remove other people's voices."""

    name: str

    def available(self) -> bool: ...

    async def process_clip(self, samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, StageResult]: ...


class VoiceIsolationProcessor(Protocol):
    """Keeps the primary speaker and suppresses competing voices (and noise)."""

    name: str
    model: str
    native_rates: tuple[int, ...]  # the rates the model actually runs at

    def available(self) -> bool: ...

    async def process_clip(self, samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, StageResult]: ...


class VADProcessor(Protocol):
    """Speech detection (NOT speaker identification) over a whole clip."""

    name: str

    def available(self) -> bool: ...

    def detect(self, samples: np.ndarray, sample_rate: int) -> VadResult: ...


class TurnStateController(Protocol):
    """
    The turn states every live path reports. Implemented by the browser hook
    (src/lib/voice/turn-gate.ts, use-voice-session.ts) and by the phone bridge
    (telephony-bridge/bridge.py `Connection.state`, a stdlib-only service).
    """

    @property
    def state(self) -> str: ...
