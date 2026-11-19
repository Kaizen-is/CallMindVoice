"""
Streaming resampling of 16-bit mono PCM with an anti-aliasing low-pass filter.

Gemini TTS (through Speko) only renders 24 kHz, while phone calls and some pages want 8 or
16 kHz. Plain interpolation would fold everything above the new Nyquist frequency back into
the speech (a hiss and a "muffled" edge); this polyphase filter (windowed sinc, Blackman)
removes it first. It keeps state between pieces, so a stream can be converted piece by piece
and gives the same samples as converting it in one go.
"""

from math import gcd

import numpy as np

_TAPS_PER_PHASE = 24  # filter length per output phase: ~1 ms of 24 kHz history, steep enough for speech


def _lowpass(up: int, down: int) -> np.ndarray:
    """Windowed-sinc low-pass at the lower Nyquist frequency, for a signal upsampled by `up`."""
    n = _TAPS_PER_PHASE * up
    n += 1 - n % 2  # odd length: a symmetric filter with a whole-sample delay
    cutoff = 0.5 / max(up, down) * 0.92  # of the upsampled rate, a little under Nyquist
    t = np.arange(n) - (n - 1) / 2
    h = 2 * cutoff * np.sinc(2 * cutoff * t) * np.blackman(n)
    return (h / h.sum() * up).astype(np.float64)  # gain `up` makes up for the inserted zeros


class StreamResampler:
    """16-bit mono PCM from `src_rate` to `dst_rate`, piece by piece (`feed`), then `flush` once."""

    def __init__(self, src_rate: int, dst_rate: int) -> None:
        g = gcd(src_rate, dst_rate)
        self.up, self.down = dst_rate // g, src_rate // g
        h = _lowpass(self.up, self.down)
        self.taps = -(-len(h) // self.up)  # input samples each output sample looks at
        padded = np.zeros(self.taps * self.up)
        padded[: len(h)] = h
        # phases[p][j] multiplies input sample (i0 - j) for an output at upsampled position i0*up + p.
        self.phases = padded.reshape(self.taps, self.up).T.copy()
        # Delay of the filter in output samples: skipped at the start so the output lines up with the input.
        self._skip = ((len(h) - 1) // 2) // self.down
        self._buf = np.zeros(self.taps - 1)  # input history (starts as silence)
        self._first = -(self.taps - 1)  # absolute index of _buf[0] in the input
        self._k = 0  # next output sample (absolute, in output samples)
        self._odd = b""  # a half sample left over from the last piece

    def _run(self, samples: np.ndarray) -> np.ndarray:
        self._buf = np.concatenate((self._buf, samples))
        last = self._first + len(self._buf) - 1  # newest input index we hold
        # Output k needs input up to i0 = (k*down)//up.
        k_end = (last * self.up) // self.down + 1
        if k_end <= self._k:
            return np.zeros(0)
        ks = np.arange(self._k, k_end)
        pos = ks * self.down
        i0, phase = pos // self.up, pos % self.up
        idx = i0[:, None] - np.arange(self.taps)[None, :] - self._first
        out = np.einsum("kj,kj->k", self.phases[phase], self._buf[idx])
        self._k = k_end
        # Keep only the history the next output can still need.
        keep_from = (self._k * self.down) // self.up - (self.taps - 1) - self._first
        if keep_from > 0:
            self._buf = self._buf[keep_from:]
            self._first += keep_from
        return out

    def _pcm(self, out: np.ndarray) -> bytes:
        if self._skip:
            dropped = min(self._skip, len(out))
            out = out[dropped:]
            self._skip -= dropped
        return np.clip(np.rint(out), -32768, 32767).astype("<i2").tobytes()

    def feed(self, pcm: bytes) -> bytes:
        data = self._odd + pcm
        whole = len(data) - len(data) % 2
        self._odd = data[whole:]
        if not whole:
            return b""
        return self._pcm(self._run(np.frombuffer(data[:whole], dtype="<i2").astype(np.float64)))

    def flush(self) -> bytes:
        """The tail still inside the filter (feeds silence through it)."""
        return self._pcm(self._run(np.zeros(self.taps)))


def resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """One whole buffer of 16-bit mono PCM, converted in one go."""
    if src_rate == dst_rate:
        return pcm
    r = StreamResampler(src_rate, dst_rate)
    return r.feed(pcm) + r.flush()
