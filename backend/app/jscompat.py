"""
Small helpers that make Python behave like the JavaScript it replaces, where
the difference would change stored data or scores:

- JavaScript strings count UTF-16 code units (an emoji is 2); Python counts
  code points (an emoji is 1).
- `Math.round` rounds .5 up; Python's `round` rounds .5 to even.
- JavaScript's `\\s` is a fixed set of Unicode spaces; Python's differs slightly
  (it also matches \\x1c-\\x1f and \\x85, and not \\ufeff).
- `Float32Array` stores every value rounded to 32-bit float.
"""

import math
import struct

# JavaScript's \s, exactly (ECMAScript WhiteSpace + LineTerminator), as the body of a character class.
JS_S = "\t\n\v\f\r    -     　﻿"

# JavaScript's \b: a boundary between an ASCII word character [A-Za-z0-9_] and anything else.
# (So `\bсум\b` almost never matches in JavaScript — Cyrillic letters are not "word" characters.)
JS_B = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))"

# JavaScript's `^` under the `m` flag: start of input or after any line terminator (\n \r    ).
JS_LINE_START = r"(?<![^\n\r  ])"


def js_round(x: float) -> int:
    """`Math.round`: halves round toward +infinity."""
    return math.floor(x + 0.5)


def utf16_len(s: str) -> int:
    """`s.length` in JavaScript."""
    return len(s.encode("utf-16-le")) // 2


def utf16_slice(s: str, start: int, end: int | None = None) -> str:
    """`s.slice(start, end)` in JavaScript (non-negative indices), in UTF-16 code units."""
    units = s.encode("utf-16-le", errors="surrogatepass")
    # A cut through an emoji leaves half a surrogate pair, exactly as JavaScript does.
    return units[start * 2 : None if end is None else end * 2].decode("utf-16-le", errors="surrogatepass")


def utf16_units(s: str) -> list[int]:
    """`s.charCodeAt(i)` for every i."""
    raw = s.encode("utf-16-le", errors="surrogatepass")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


_F32 = struct.Struct("<f")


def f32(x: float) -> float:
    """The value JavaScript keeps after storing `x` in a Float32Array."""
    return _F32.unpack(_F32.pack(x))[0]


# ── Math.log, exactly as V8 computes it ─────────────────────────────
# V8's Math.log is fdlibm's __ieee754_log (src/base/ieee754.cc), which is not
# always correctly rounded; the C library's log (what math.log uses) is. They
# differ in the last bit for some inputs, which changes retrieval scores. This
# is a line-by-line port of that function.

_D = struct.Struct("<d")
_LN2_HI = 6.93147180369123816490e-01
_LN2_LO = 1.90821492927058770002e-10
_TWO54 = 1.80143985094819840000e16
_LG1 = 6.666666666666735130e-01
_LG2 = 3.999999999940941908e-01
_LG3 = 2.857142874366239149e-01
_LG4 = 2.222219843214978396e-01
_LG5 = 1.818357216161805012e-01
_LG6 = 1.531383769920937332e-01
_LG7 = 1.479819860511658591e-01


def _words(x: float) -> tuple[int, int]:
    bits = int.from_bytes(_D.pack(x), "little")
    hi = (bits >> 32) & 0xFFFFFFFF
    return (hi - (1 << 32) if hi & 0x80000000 else hi), bits & 0xFFFFFFFF


def _with_high(x: float, hi: int) -> float:
    lo = int.from_bytes(_D.pack(x), "little") & 0xFFFFFFFF
    return _D.unpack((((hi & 0xFFFFFFFF) << 32) | lo).to_bytes(8, "little"))[0]


def js_log(x: float) -> float:
    """`Math.log(x)` with V8's exact result."""
    hx, lx = _words(x)
    k = 0
    if hx < 0x00100000:  # x < 2**-1022
        if ((hx & 0x7FFFFFFF) | lx) == 0:
            return -math.inf
        if hx < 0:
            return math.nan
        k -= 54
        x *= _TWO54  # subnormal: scale up
        hx, _ = _words(x)
    if hx >= 0x7FF00000:
        return x + x
    k += (hx >> 20) - 1023
    hx &= 0x000FFFFF
    i = (hx + 0x95F64) & 0x100000
    x = _with_high(x, hx | (i ^ 0x3FF00000))  # normalise x or x/2
    k += i >> 20
    f = x - 1.0
    if (0x000FFFFF & (2 + hx)) < 3:  # -2**-20 <= f < 2**-20
        if f == 0.0:
            if k == 0:
                return 0.0
            dk = float(k)
            return dk * _LN2_HI + dk * _LN2_LO
        r = f * f * (0.5 - 0.33333333333333333 * f)
        if k == 0:
            return f - r
        dk = float(k)
        return dk * _LN2_HI - ((r - dk * _LN2_LO) - f)
    s = f / (2.0 + f)
    dk = float(k)
    z = s * s
    i = hx - 0x6147A
    w = z * z
    j = 0x6B851 - hx
    t1 = w * (_LG2 + w * (_LG4 + w * _LG6))
    t2 = z * (_LG1 + w * (_LG3 + w * (_LG5 + w * _LG7)))
    i |= j
    r = t2 + t1
    if i > 0:
        hfsq = 0.5 * f * f
        if k == 0:
            return f - (hfsq - s * (hfsq + r))
        return dk * _LN2_HI - ((hfsq - (s * (hfsq + r) + dk * _LN2_LO)) - f)
    if k == 0:
        return f - s * (f - r)
    return dk * _LN2_HI - ((s * (f - r) - dk * _LN2_LO) - f)
