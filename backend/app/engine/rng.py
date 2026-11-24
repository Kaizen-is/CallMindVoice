"""
`seededRandom` from src/lib/utils.ts, bit for bit: the same seed gives the same sequence in both
apps, so the simulator and the demo history pick the same callers, questions and numbers.

JavaScript does this arithmetic on doubles with 32-bit casts (`^`, `|`, `>>>`, `Math.imul`); the
helpers below make those casts explicit. The running state is kept as a float because in
JavaScript it is a plain number that is never wrapped (`h += 0x6d2b79f5`).
"""

from collections.abc import Callable

from app.jscompat import utf16_units


def _i32(x: float) -> int:
    """ToInt32: truncate toward zero, then wrap to a signed 32-bit integer."""
    n = int(x) & 0xFFFFFFFF
    return n - 0x100000000 if n & 0x80000000 else n


def _u32(x: float) -> int:
    """ToUint32 (`x >>> 0`)."""
    return int(x) & 0xFFFFFFFF


def _imul(a: float, b: float) -> int:
    """`Math.imul`."""
    return _i32(_i32(a) * _i32(b))


def seeded_random(seed: str) -> Callable[[], float]:
    """A deterministic stream of numbers in [0, 1) — mulberry32 over an FNV-1a hash of the seed."""
    h: float = 2166136261
    for unit in utf16_units(seed):
        h = _i32(h) ^ unit
        h = _imul(h, 16777619)
    state = [float(h)]

    def rng() -> float:
        state[0] = state[0] + 0x6D2B79F5
        t: int = _i32(state[0])
        t = _imul(t ^ (_u32(t) >> 15), t | 1)
        t = t ^ _i32(t + _imul(t ^ (_u32(t) >> 7), t | 61))
        return _u32(t ^ (_u32(t) >> 14)) / 4294967296

    return rng
