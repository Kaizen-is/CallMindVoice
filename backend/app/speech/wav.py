"""WAV and PCM helpers used by the STT engines (from src/lib/speech/stt.ts and zipformer.ts)."""

import math
import struct

import numpy as np

ZIPFORMER_RATE = 16000


def _tag(buf: bytes, at: int) -> bytes:
    return buf[at : at + 4] if at + 4 <= len(buf) else b""


def wav_duration_ms(audio: bytes) -> float | None:
    """Length of a 16-bit PCM WAV in ms, or None for anything else."""
    if _tag(audio, 0) != b"RIFF" or _tag(audio, 8) != b"WAVE":
        return None
    offset = 12
    bytes_per_second = 0
    while offset + 8 <= len(audio):
        chunk = _tag(audio, offset)
        size = struct.unpack_from("<I", audio, offset + 4)[0]
        if chunk == b"fmt " and size >= 16 and offset + 20 <= len(audio):
            bytes_per_second = struct.unpack_from("<I", audio, offset + 16)[0]
        if chunk == b"data":
            n = min(size, len(audio) - offset - 8)
            return (n / bytes_per_second) * 1000 if bytes_per_second else None
        offset += 8 + size + (size % 2)
    return None


def is_silent(audio: bytes) -> bool:
    """
    True for a 16-bit WAV whose samples are all within ±64: a muted or dead input. A model asked to
    transcribe it may invent words (Gemini answers digital silence with "Здравствуйте").
    Anything that is not a 16-bit WAV is passed through untouched (False).
    """
    if _tag(audio, 0) != b"RIFF" or _tag(audio, 8) != b"WAVE":
        return False
    offset = 12
    bits = 0
    while offset + 8 <= len(audio):
        chunk = _tag(audio, offset)
        size = struct.unpack_from("<I", audio, offset + 4)[0]
        body = offset + 8
        if chunk == b"fmt " and size >= 16 and body + 16 <= len(audio):
            bits = struct.unpack_from("<H", audio, body + 14)[0]
        if chunk == b"data":
            if bits != 16:
                return False
            end = min(len(audio), body + size) - 1  # the TypeScript loop reads pairs below `end`
            count = max(0, (end - body + 1) // 2)
            samples = np.frombuffer(audio, dtype="<i2", count=count, offset=body) if count else np.zeros(0, "<i2")
            return not bool(np.any(np.abs(samples.astype(np.int32)) > 64))
        offset = body + size + (size % 2)
    return False


def decode_wav(buf: bytes) -> tuple[np.ndarray, int]:
    """16-bit PCM WAV → (mono float32 samples, sample rate). Raises ValueError on anything else."""
    if len(buf) < 12 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise ValueError("not_wav")
    offset = 12
    channels, sample_rate, bits = 1, ZIPFORMER_RATE, 16
    while offset + 8 <= len(buf):
        chunk = buf[offset : offset + 4]
        size = struct.unpack_from("<I", buf, offset + 4)[0]
        body = offset + 8
        if chunk == b"fmt ":
            channels = struct.unpack_from("<H", buf, body + 2)[0]
            sample_rate = struct.unpack_from("<I", buf, body + 4)[0]
            bits = struct.unpack_from("<H", buf, body + 14)[0]
        elif chunk == b"data":
            if bits != 16:
                raise ValueError("wav_not_16bit")
            end = min(len(buf), body + size)
            frames = (end - body) // (2 * channels)
            raw = np.frombuffer(buf, dtype="<i2", count=frames * channels, offset=body).astype(np.float64)
            summed = raw.reshape(frames, channels).sum(axis=1) if channels > 1 else raw
            return (summed / channels / 32768).astype(np.float32), sample_rate
        offset = body + size + (size % 2)
    raise ValueError("wav_no_data")


def wav_to_pcm16k(audio: bytes) -> bytes:
    """A WAV as 16 kHz mono 16-bit PCM (nearest-sample decimation, as stt.ts) — what Speko takes."""
    samples, sample_rate = decode_wav(audio)
    ratio = sample_rate / 16000
    n = math.floor(len(samples) / ratio)
    picked = samples[np.floor(np.arange(n) * ratio).astype(np.int64)].astype(np.float64)
    s = np.clip(picked, -1, 1)
    scaled = np.where(s < 0, s * 0x8000, s * 0x7FFF)
    return np.floor(scaled + 0.5).astype("<i2").tobytes()


def pcm16_to_float(buf: bytes) -> np.ndarray:
    """16-bit little-endian PCM → float32 in [-1, 1)."""
    n = len(buf) // 2
    return (np.frombuffer(buf, dtype="<i2", count=n).astype(np.float64) / 32768).astype(np.float32)
