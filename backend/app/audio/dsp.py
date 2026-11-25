"""Plain signal helpers for whole clips: conversion, high-pass, gain, levels, resampling, trimming."""

import math
import struct

import numpy as np

from app.audio.types import SpeechSegment
from app.speech.resample import resample_pcm16


def to_pcm16(samples: np.ndarray) -> bytes:
    s = np.clip(samples.astype(np.float64), -1, 1)
    return np.where(s < 0, s * 0x8000, s * 0x7FFF).round().astype("<i2").tobytes()


def from_pcm16(pcm: bytes) -> np.ndarray:
    n = len(pcm) // 2
    return (np.frombuffer(pcm, dtype="<i2", count=n).astype(np.float64) / 32768).astype(np.float32)


def to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = to_pcm16(samples)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    )
    return header + pcm


def level_db(samples: np.ndarray) -> float:
    """RMS level in dBFS (-120 for silence)."""
    if not len(samples):
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(samples.astype(np.float64)))))
    return 20 * math.log10(rms) if rms > 1e-6 else -120.0


def highpass(samples: np.ndarray, sample_rate: int, cutoff_hz: float = 75.0) -> np.ndarray:
    """
    Remove rumble, hum and desk thumps below `cutoff_hz` (the same 75 Hz the browser applies),
    with a soft 50 Hz-wide ramp so nothing rings. Zero phase: nothing shifts in time.
    """
    n = len(samples)
    if n < 64:
        return samples.copy()
    spectrum = np.fft.rfft(samples.astype(np.float64))
    freqs = np.fft.rfftfreq(n, 1 / sample_rate)
    ramp = np.clip((freqs - (cutoff_hz - 25)) / 50, 0, 1)
    gain = 0.5 - 0.5 * np.cos(np.pi * ramp)  # raised cosine 0 → 1
    return np.fft.irfft(spectrum * gain, n).astype(np.float32)


def normalize_gain(samples: np.ndarray, max_gain: float = 8.0, peak_target: float = 0.97) -> tuple[np.ndarray, float]:
    """Peak-normalize a quiet recording (at most `max_gain`×, as the browser does). Returns the gain used."""
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    gain = min(max_gain, peak_target / peak) if peak > 0 else 1.0
    return (samples * gain).astype(np.float32), gain


def resample(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Band-limited resampling (the backend's polyphase filter). Down only loses band; up adds none."""
    if src_rate == dst_rate:
        return samples
    return from_pcm16(resample_pcm16(to_pcm16(samples), src_rate, dst_rate))


def keep_segments(
    samples: np.ndarray, sample_rate: int, segments: list[SpeechSegment], gap_ms: float = 120.0
) -> np.ndarray:
    """Only the speech segments, joined with a short silence between them (nothing when there are none)."""
    if not segments:
        return np.zeros(0, dtype=np.float32)
    gap = np.zeros(int(sample_rate * gap_ms / 1000), dtype=np.float32)
    parts: list[np.ndarray] = []
    for i, seg in enumerate(segments):
        a = max(0, int(seg.start_ms * sample_rate / 1000))
        b = min(len(samples), int(math.ceil(seg.end_ms * sample_rate / 1000)))
        if b > a:
            if i:
                parts.append(gap)
            parts.append(samples[a:b])
    return np.concatenate(parts).astype(np.float32) if parts else np.zeros(0, dtype=np.float32)
