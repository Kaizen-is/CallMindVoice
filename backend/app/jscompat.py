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
import re
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
    return len(s.encode("utf-16-le", errors="surrogatepass")) // 2


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


# ── strings, numbers and truthiness ─────────────────────────────────

# JS_S spelled out: as a class body it holds the range U+2000-U+200A, but `str.strip` would read
# that `-` as a literal hyphen (and skip U+2001-U+2009).
_JS_TRIM_CHARS = "\t\n\v\f\r   " + "".join(map(chr, range(0x2000, 0x200B))) + "    　﻿"


def js_trim(s: str) -> str:
    """`s.trim()`: strips JavaScript whitespace (Python's `strip()` uses a slightly different set)."""
    return s.strip(_JS_TRIM_CHARS)


def js_trim_start(s: str) -> str:
    return s.lstrip(_JS_TRIM_CHARS)


def js_trim_end(s: str) -> str:
    return s.rstrip(_JS_TRIM_CHARS)


def js_to_fixed(x: float, digits: int) -> str:
    """`x.toFixed(digits)`: the exact binary value rounded half away from zero (Python's `round` is half-even)."""
    from decimal import ROUND_HALF_UP, Decimal

    if math.isnan(x):
        return "NaN"
    if x == 0:
        x = 0.0  # (-0).toFixed() has no sign; (-0.0001).toFixed(3) keeps it: "-0.000"
    return format(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP), "f")


def js_fixed_number(x: float, digits: int) -> float:
    """`Number(x.toFixed(digits))`."""
    return float(js_to_fixed(x, digits))


def js_number_str(x: float) -> str:
    """`String(x)` / JSON.stringify of a number: JavaScript's Number::toString (shortest round-trip digits)."""
    from decimal import Decimal

    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    if x < 0:
        return "-" + js_number_str(-x)
    _, digit_tuple, exp = Decimal(repr(x)).as_tuple()
    digits = list(digit_tuple)
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    k = len(digits)
    n = exp + k  # x = 0.d1…dk × 10^n
    s = "".join(map(str, digits))
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return f"{s[:n]}.{s[n:]}"
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    mantissa = s if k == 1 else f"{s[0]}.{s[1:]}"
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


def js_max(*values: float) -> float:
    """`Math.max(...)`: NaN if any argument is NaN (Python's max() skips over NaN depending on position)."""
    if any(v != v for v in values):
        return math.nan
    return max(values) if values else -math.inf


def js_min(*values: float) -> float:
    """`Math.min(...)`: NaN if any argument is NaN."""
    if any(v != v for v in values):
        return math.nan
    return min(values) if values else math.inf


def js_truthy(value: object) -> bool:
    """JavaScript truthiness for a JSON value: `[]` and `{}` are true, `0`, `""` and null false."""
    if isinstance(value, (list, dict)):
        return True
    if isinstance(value, float) and math.isnan(value):
        return False
    return bool(value)


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _is_array_index(key: str) -> bool:
    return key.isascii() and key.isdigit() and str(int(key)) == key and int(key) <= 4294967294


def js_key_order(obj: dict) -> list[tuple[str, object]]:
    """
    An object's keys in JavaScript's order: integer-like keys ("0", "7") first, ascending, then the rest
    in insertion order. So `{"1": …, "0": …}` built in Python is written `{"0": …, "1": …}`, as
    JSON.stringify writes it (e.g. an agent's business hours, days "1"…"6" then "0").
    """
    items = [(str(k), x) for k, x in obj.items()]
    indexed = [kv for kv in items if _is_array_index(kv[0])]
    if not indexed:
        return items
    indexed.sort(key=lambda kv: int(kv[0]))
    return indexed + [kv for kv in items if not _is_array_index(kv[0])]


def js_json(value: object) -> str:
    """
    `JSON.stringify(value)`: compact, non-ASCII kept as is, numbers written as JavaScript writes
    them (1 not 1.0, 1e-7 not 1e-07) — so request bodies and stored JSON are byte-identical.
    """
    import json

    def enc(v: object) -> str:
        if v is None or v is True or v is False:
            return json.dumps(v)
        if isinstance(v, str):
            return string(v)
        if isinstance(v, (int, float)):
            if isinstance(v, float) and not math.isfinite(v):
                return "null"
            return js_number_str(v)
        if isinstance(v, dict):
            # Integer-like keys first (JavaScript's property order); keys escaped like any string.
            return "{" + ",".join(f"{string(k)}:{enc(x)}" for k, x in js_key_order(v)) + "}"
        if isinstance(v, (list, tuple)):
            return "[" + ",".join(enc(x) for x in v) + "]"
        raise TypeError(f"not JSON serialisable: {type(v).__name__}")

    def string(s: str) -> str:
        # A lone surrogate (half an emoji cut by .slice) is written as \udxxx, as JSON.stringify does.
        return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", json.dumps(s, ensure_ascii=False))

    return enc(value)


# ── values arriving as JSON (server action arguments) ───────────────

# `_LONE_SURROGATE` (above): in a Python str every surrogate code point is a lone one.


def js_well_formed(s: str) -> str:
    """`s.toWellFormed()`: lone surrogates become U+FFFD — what SQLite stores when JavaScript writes such text."""
    return _LONE_SURROGATE.sub("\ufffd", s)


class _Undefined:
    """A missing argument (`undefined`): JSON.stringify drops it, so it never reaches Python as null."""

    def __repr__(self) -> str:
        return "undefined"


UNDEFINED = _Undefined()


def js_string(value: object) -> str:
    """`String(value)` for a JSON value (or UNDEFINED)."""
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number_str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        # Array.prototype.join: null and undefined elements are empty.
        return ",".join("" if v is None or v is UNDEFINED else js_string(v) for v in value)
    return "[object Object]"


def js_to_number(value: object) -> float:
    """`Number(value)` for a JSON value (or UNDEFINED): null → 0, true → 1, [] → 0, ["5"] → 5, {} → NaN."""
    if value is UNDEFINED:
        return math.nan
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return js_number(value)
    if isinstance(value, (list, tuple)):
        return js_number(js_string(value))
    return math.nan


def js_sql_param(value: object) -> object:
    """
    A value as `src/lib/db.ts` binds it with node:sqlite: undefined/null → NULL, booleans → 1/0,
    numbers as REAL (so 5 in a TEXT column is stored as '5.0'), objects as JSON text, and text
    made well-formed (UTF-8 cannot carry a lone surrogate; V8 writes U+FFFD).
    """
    if value is None or value is UNDEFINED:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        return js_well_formed(value)
    return js_well_formed(js_json(value))


# ── new URL(input) ──────────────────────────────────────────────────
# The WHATWG URL parser (what `new URL()` runs in Node), reduced to the one question the console
# asks: does `new URL(input)` throw, and if not, what is its `.protocol`? Once there is a scheme,
# only the authority (host and port) can make a URL invalid; paths, queries and fragments are
# always accepted. Internationalised hosts go through UTS #46 with the `idna` package's tables.

_SPECIAL_SCHEMES = frozenset({"ftp", "file", "http", "https", "ws", "wss"})
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+\-.]*:")
_C0_OR_SPACE = "".join(chr(c) for c in range(0x21))
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | frozenset(chr(c) for c in range(0x20)) | {"%", "\x7f"}
_HEX = frozenset("0123456789abcdefABCDEF")
_DIGITS = frozenset("0123456789")
_OCTAL = frozenset("01234567")


def js_url_protocol(url: str) -> str | None:
    """`new URL(url).protocol` (e.g. 'https:'), or None where `new URL(url)` throws (there is no base URL)."""
    text = js_well_formed(url).strip(_C0_OR_SPACE).replace("\t", "").replace("\n", "").replace("\r", "")
    scheme_match = _SCHEME.match(text)
    if not scheme_match:
        return None  # no scheme, and no base URL to resolve against
    scheme = scheme_match.group()[:-1].lower()
    rest = text[scheme_match.end() :]
    if scheme == "file":
        ok = _file_host_ok(rest)
    elif scheme in _SPECIAL_SCHEMES:
        ok = _authority_ok(rest.lstrip("/\\"), special=True)
    elif rest.startswith("//"):
        ok = _authority_ok(rest[2:], special=False)
    else:
        ok = True  # an opaque path ("mailto:…") or a path ("foo:/x") never fails
    return f"{scheme}:" if ok else None


def _authority_ok(rest: str, *, special: bool) -> bool:
    ends = "/?#\\" if special else "/?#"
    end = next((i for i, c in enumerate(rest) if c in ends), len(rest))
    authority = rest[:end]
    at = authority.rfind("@")
    hostport = authority[at + 1 :] if at >= 0 else authority
    if at >= 0 and not hostport:
        return False  # credentials and no host
    inside_brackets = False
    for i, c in enumerate(hostport):
        if c == "[":
            inside_brackets = True
        elif c == "]":
            inside_brackets = False
        elif c == ":" and not inside_brackets:
            if i == 0:
                return False  # a port and no host
            port = hostport[i + 1 :]
            if any(ch not in _DIGITS for ch in port) or (port and int(port) > 65535):
                return False
            return _host_ok(hostport[:i], special=special)
    if special and not hostport:
        return False
    return _host_ok(hostport, special=special)


def _file_host_ok(rest: str) -> bool:
    if len(rest) < 2 or rest[0] not in "/\\" or rest[1] not in "/\\":
        return True  # no host part: a path
    rest = rest[2:]
    end = next((i for i, c in enumerate(rest) if c in "/\\?#"), len(rest))
    host = rest[:end]
    if not host or (len(host) == 2 and host[0].isascii() and host[0].isalpha() and host[1] in ":|"):
        return True  # no host, or a Windows drive letter ("file://C:/x")
    return _host_ok(host, special=True)


def _host_ok(host: str, *, special: bool) -> bool:
    if host.startswith("["):
        return host.endswith("]") and _ipv6_ok(host[1:-1])
    if not special:
        return not any(c in _FORBIDDEN_HOST for c in host)  # an opaque host
    domain = _percent_decode(host).decode("utf-8", errors="replace")
    ascii_domain = _domain_to_ascii(domain)
    if ascii_domain is None:
        return False
    if _ends_in_number(ascii_domain):
        return _ipv4_ok(ascii_domain)
    return True


def _percent_decode(text: str) -> bytes:
    raw = text.encode("utf-8")
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25 and i + 2 < len(raw) and chr(raw[i + 1]) in _HEX and chr(raw[i + 2]) in _HEX:
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(raw[i])
            i += 1
    return bytes(out)


def _domain_to_ascii(domain: str) -> str | None:
    """UTS #46 ToASCII as the URL standard runs it (no STD3 rules, no hyphen or DNS-length checks)."""
    if domain.isascii() and not any(label[:4].lower() == "xn--" for label in domain.split(".")):
        result = domain.lower()
    else:
        result = _uts46_to_ascii(domain)
        if not result:
            return None
    if any(c in _FORBIDDEN_DOMAIN for c in result):
        return None
    return result


def _uts46_to_ascii(domain: str) -> str | None:
    import unicodedata

    from idna import core as idna_core

    try:
        mapped = idna_core.uts46_remap(domain, std3_rules=False)
    except idna_core.IDNAError:
        return None
    labels: list[tuple[str, str]] = []  # (ASCII form, Unicode form)
    for label in mapped.split("."):
        if label[:4].lower() == "xn--":
            if not label.isascii():
                return None
            try:
                unicode_label = label[4:].encode("ascii").decode("punycode")
            except (UnicodeError, ValueError):
                return None
            if not unicode_label:
                return None
            labels.append((label, unicode_label))
        else:
            labels.append((label if label.isascii() else "xn--" + label.encode("punycode").decode("ascii"), label))
    for _, unicode_label in labels:
        if not unicode_label:
            continue
        try:
            if (
                not unicodedata.is_normalized("NFC", unicode_label)
                or unicodedata.category(unicode_label[0]).startswith("M")
                or idna_core.uts46_remap(unicode_label, std3_rules=False) != unicode_label
                or "." in unicode_label
            ):
                return None
            for pos, c in enumerate(unicode_label):
                if c in "\u200c\u200d" and not idna_core.valid_contextj(unicode_label, pos):
                    return None
            if not _bidi_ok([unicodedata.bidirectional(c) for c in unicode_label]):
                return None
        except (idna_core.IDNAError, ValueError):
            return None
    return ".".join(ascii_label for ascii_label, _ in labels)


_RTL = frozenset({"R", "AL", "AN"})
_RTL_ALLOWED = frozenset({"R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"})
_LTR_ALLOWED = frozenset({"L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM"})


def _bidi_ok(dirs: list[str]) -> bool:
    """
    The Bidi rule as Node's URL parser (Ada) applies it, found by probing Node 22: only labels that
    hold R/AL/AN characters are checked; a label starting with an L character is checked as LTR
    up to (not including) its last non-NSM character; any other is checked as RTL (RFC 5893
    rules 2-4, without rule 1).
    """
    if not any(d in _RTL for d in dirs):
        return True
    last = max((i for i, d in enumerate(dirs) if d != "NSM"), default=-1)
    if last < 0:
        return False
    if dirs[0] == "L":
        return all(d in _LTR_ALLOWED for d in dirs[:last])
    return (
        all(d in _RTL_ALLOWED for d in dirs)
        and dirs[last] in ("R", "AL", "EN", "AN")
        and not ("EN" in dirs and "AN" in dirs)
    )


def _ends_in_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last and all(c in _DIGITS for c in last):
        return True
    return _ipv4_number(last) is not None


def _ipv4_number(part: str) -> int | None:
    if not part:
        return None
    allowed = _DIGITS
    radix = 10
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        part, radix, allowed = part[2:], 16, _HEX
    elif len(part) >= 2 and part[0] == "0":
        part, radix, allowed = part[1:], 8, _OCTAL
    if not part:
        return 0
    if any(c not in allowed for c in part):
        return None
    return int(part, radix)


def _ipv4_ok(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return False
    numbers = [_ipv4_number(p) for p in parts]
    values = [n for n in numbers if n is not None]
    if len(values) != len(numbers):
        return False
    if any(n > 255 for n in values[:-1]):
        return False
    return values[-1] < 256 ** (5 - len(values))


def _ipv6_ok(text: str) -> bool:
    """The standard's IPv6 parser, step by step (only whether it fails)."""
    pieces = [0] * 8
    piece = 0
    compress: int | None = None
    i, n = 0, len(text)
    if i < n and text[i] == ":":
        if not text.startswith("::"):
            return False
        i += 2
        piece += 1
        compress = piece
    while i < n:
        if piece == 8:
            return False
        if text[i] == ":":
            if compress is not None:
                return False
            i += 1
            piece += 1
            compress = piece
            continue
        value = length = 0
        while length < 4 and i < n and text[i] in _HEX:
            value = value * 16 + int(text[i], 16)
            i += 1
            length += 1
        if i < n and text[i] == ".":
            if length == 0:
                return False
            i -= length
            if piece > 6:
                return False
            numbers_seen = 0
            while i < n:
                ipv4_piece: int | None = None
                if numbers_seen > 0:
                    if text[i] == "." and numbers_seen < 4:
                        i += 1
                    else:
                        return False
                if i >= n or text[i] not in _DIGITS:
                    return False
                while i < n and text[i] in _DIGITS:
                    number = int(text[i])
                    if ipv4_piece is None:
                        ipv4_piece = number
                    elif ipv4_piece == 0:
                        return False
                    else:
                        ipv4_piece = ipv4_piece * 10 + number
                    if ipv4_piece > 255:
                        return False
                    i += 1
                pieces[piece] = pieces[piece] * 0x100 + (ipv4_piece or 0)
                numbers_seen += 1
                if numbers_seen in (2, 4):
                    piece += 1
            if numbers_seen != 4:
                return False
            break
        if i < n and text[i] == ":":
            i += 1
            if i >= n:
                return False
        elif i < n:
            return False
        pieces[piece] = value
        piece += 1
    return compress is not None or piece == 8


def js_utf8(s: str) -> bytes:
    """`Buffer.from(s, 'utf8')`: a lone surrogate becomes U+FFFD instead of an encoding error."""
    return s.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def js_number(s: str) -> float:
    """
    `Number(s)` for a string: JavaScript whitespace trimmed, '' is 0, 0x/0o/0b integers,
    `Infinity`, and otherwise a plain decimal or NaN (no `inf`, `nan` or `1_000` as in `float`).
    """
    import re

    t = js_trim(s)
    if not t:
        return 0.0
    radix = re.fullmatch(r"0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)", t)
    if radix:
        try:
            return float(int(t[2:], {"x": 16, "o": 8, "b": 2}[t[1].lower()]))
        except OverflowError:
            return math.inf
    if re.fullmatch(r"[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)", t):
        return float(t.replace("Infinity", "inf"))
    return math.nan


def js_json_parse(raw: bytes) -> object:
    """
    `await request.json()`: the body read as UTF-8 (BOM dropped, bad bytes replaced), then
    `JSON.parse`, which refuses NaN and Infinity. Raises ValueError where JavaScript throws.
    """
    import json

    text = raw.decode("utf-8", errors="replace").removeprefix("﻿")

    def refuse(literal: str) -> object:
        raise ValueError(f"not JSON: {literal}")

    return json.loads(text, parse_constant=refuse)
