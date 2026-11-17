"""
PDF text as unpdf produced it for the TypeScript ingest — `extractText(pdf, {mergePages: true})`,
i.e. pdf.js 6.4.299's `page.getTextContent()` joined page by page.

pdfminer.six parses the file (objects, streams, filters, encryption, content-stream tokens); the
rest is a line-by-line port of what pdf.js does with them, because the text layout decisions are
pdf.js's own and no Python library makes the same ones:

- the text-content builder (`getTextContent` in pdf.js's evaluator): when two glyphs get a space
  between them, when a run is cut, when a line ends — all from glyph positions, widths and the
  font size, with pdf.js's thresholds and its quirks (font changes only cut a run after `q`/`Q`,
  marked content cuts runs, soft hyphens are skipped without advancing, …);
- glyph widths and Unicode values the way pdf.js derives them from the font dictionary
  (ToUnicode CMaps, encodings with Differences, glyph names, standard-font metrics), with the
  encoding and glyph-name tables copied from that pdf.js build (`pdfjs_tables.json`,
  `backend/tools/pdfjs-tables.cjs`);
- unpdf's page join and whitespace normalisation.

Known gaps (pdf.js reads the font programs themselves; this does not): right-to-left reordering
(Arabic/Hebrew runs keep their stored order), CFF fonts whose own FontMatrix is not 1/1000
(pdf.js rescales their widths), fonts pdf.js fails to parse (it then drops their text), and
non-embedded CID TrueType fonts with standard names (pdf.js remaps them through its own glyph
tables). Documents built from such fonts can come out slightly differently.
"""

from __future__ import annotations

import contextlib
import json
import math
import unicodedata
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

import regex
from pdfminer.pdfdocument import PDFDocument, PDFEncryptionError, PDFPasswordIncorrect
from pdfminer.pdfinterp import PDFContentParser
from pdfminer.pdfpage import PDFPage
from pdfminer.pdfparser import PDFParser
from pdfminer.pdftypes import PDFObjRef, PDFStream
from pdfminer.psparser import PSEOF, PSBaseParser, PSKeyword, PSLiteral

from app.jscompat import JS_S

FONT_IDENTITY = [0.001, 0, 0, 0.001, 0, 0]
LETTER = [0, 0, 612, 792]
MAX_MAP_RANGE = 2**24 - 1

# FontFlags
SYMBOLIC = 4
NONSYMBOLIC = 32
SERIF = 2
FIXED_PITCH = 1

# pdf.js's glyph categories: /^(\s)|(\p{Mn})|(\p{Cf})$/u (JavaScript's `$` without the m flag is \Z)
_CATEGORY = regex.compile(f"^([{JS_S}])|(\\p{{Mn}})|(\\p{{Cf}})\\Z")
_NORMALIZE = regex.compile(
    "([\u00a0\u00b5\u037e\u0eb3\u2000-\u200a\u202f\u2126\ufb00-\ufb04\ufb06\ufb20-\ufb36\ufb38-\ufb3c"
    "\ufb3e\ufb40\ufb41\ufb43\ufb44\ufb46-\ufba1\ufba4-\ufba9\ufbae-\ufbb1\ufbd3-\ufbdc\ufbde-\ufbe7"
    "\ufbea-\ufbf8\ufbfc\ufbfd\ufc00-\ufc5d\ufc64-\ufcf1\ufcf5-\ufd3d\ufd88\ufdf4\ufdfa\ufdfb\ufe71"
    "\ufe77\ufe79\ufe7b\ufe7d]+)|(\ufb05+)"
)
# unpdf's normalizeMergedText: /[^\S\n]+/g, / ?\n ?/g, /\n{3,}/g
_SPACE_RUN = regex.compile(f"(?:(?!\\n)[{JS_S}])+")
_SPACE_NL = regex.compile(" ?\n ?")
_NL3 = regex.compile("\n{3,}")
_JS_WS = regex.compile(f"[{JS_S}]")
_SERIF_RE = regex.compile("serif", regex.IGNORECASE)


class PdfError(Exception):
    """The PDF could not be read; the message is what pdf.js would have said."""


@lru_cache
def tables() -> dict[str, Any]:
    return json.loads((Path(__file__).parent / "pdfjs_tables.json").read_text(encoding="utf-8"))


# ── JavaScript arithmetic ────────────────────────────────────────────


def _hypot(a: float, b: float) -> float:
    """V8's Math.hypot for two numbers (scaled, Kahan-compensated; Python's differs in the last bit)."""
    a, b = abs(a), abs(b)
    if a != a or b != b:
        return math.inf if math.inf in (a, b) else math.nan
    m = a if a > b else b
    if m == math.inf:
        return math.inf
    if m == 0:
        return 0
    total = 0.0
    comp = 0.0
    for x in (a, b):
        n = x / m
        summand = n * n - comp
        prelim = total + summand
        comp = (prelim - total) - summand
        total = prelim
    return math.sqrt(total) * m


def _div(a: float, b: float) -> float:
    try:
        return a / b
    except ZeroDivisionError:
        if a != a or a == 0:
            return math.nan
        return math.copysign(math.inf, a) * math.copysign(1.0, b)


def _sign(x: float) -> float:
    if x != x or x == 0:
        return x
    return 1 if x > 0 else -1


def _truthy(x: Any) -> bool:
    """JavaScript truthiness of a number (NaN and 0 are false)."""
    return x is not None and x is not False and x == x and x != 0


def _is_num(x: Any) -> bool:
    return isinstance(x, int | float) and not isinstance(x, bool)


def _is_int(x: Any) -> bool:
    """Number.isInteger."""
    return _is_num(x) and (isinstance(x, int) or (math.isfinite(x) and x == int(x)))


def _transform(m1: list[float], m2: list[float]) -> list[float]:
    return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ]


def _from_char_code(*codes: int) -> str:
    return "".join(chr(int(c) & 0xFFFF) if _is_num(c) and c == c else "\0" for c in codes)


def _parse_int16(s: str) -> float:
    """parseInt(s, 16)."""
    t = regex.sub(f"^[{JS_S}]+", "", s)
    sign = 1
    if t[:1] in "+-" and t:
        sign = -1 if t[0] == "-" else 1
        t = t[1:]
    if t[:2] in ("0x", "0X"):
        t = t[2:]
    digits = regex.match("[0-9a-fA-F]*", t).group(0)
    return sign * int(digits, 16) if digits else math.nan


def _js_number(s: str) -> float:
    from app.jscompat import js_number

    return js_number(s)


def _name(obj: Any) -> str | None:
    return obj.name if isinstance(obj, PSLiteral) else None


def _resolve(obj: Any) -> Any:
    seen = 0
    while isinstance(obj, PDFObjRef) and seen < 32:
        try:
            obj = obj.resolve()
        except Exception:  # noqa: BLE001 - a dangling reference reads as null, as in pdf.js
            return None
        seen += 1
    return obj


def _get(d: Any, key: str) -> Any:
    return _resolve(d.get(key)) if isinstance(d, dict) else None


def _bytes_str(value: Any) -> str:
    """A PDF string as pdf.js's stringToPDFString would give it (UTF-16BE with BOM, else PDFDocEncoding≈latin-1)."""
    if not isinstance(value, bytes):
        return ""
    if value[:2] == b"\xfe\xff":
        return value[2:].decode("utf-16-be", errors="replace")
    return value.decode("latin-1")


def _matrix(value: Any, default: list[float]) -> list[float]:
    """lookupMatrix: six numbers, else the default."""
    value = _resolve(value)
    if isinstance(value, list) and len(value) == 6 and all(_is_num(_resolve(v)) for v in value):
        return [_resolve(v) for v in value]
    return default


def _normal_rect(value: Any, default: list[float] | None) -> list[float] | None:
    """lookupNormalRect: four numbers, normalised so x1 <= x2 and y1 <= y2."""
    value = _resolve(value)
    if isinstance(value, list) and len(value) == 4 and all(_is_num(_resolve(v)) for v in value):
        x1, y1, x2, y2 = (_resolve(v) for v in value)
        return [min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]
    return default


def _intersect(a: list[float], b: list[float]) -> list[float] | None:
    xlow = max(min(a[0], a[2]), min(b[0], b[2]))
    xhigh = min(max(a[0], a[2]), max(b[0], b[2]))
    if xlow > xhigh:
        return None
    ylow = max(min(a[1], a[3]), min(b[1], b[3]))
    yhigh = min(max(a[1], a[3]), max(b[1], b[3]))
    if ylow > yhigh:
        return None
    return [xlow, ylow, xhigh, yhigh]


# ── CMaps (ToUnicode and composite-font encodings) ──────────────────


class CMapError(Exception):
    pass


class CMap:
    def __init__(self) -> None:
        self.codespace: list[list[int]] = [[], [], [], []]
        self.num_codespace = 0
        self.name = ""
        self.vertical = False
        self.map: dict[int, Any] = {}
        self._budget = 0
        self.identity = False

    def add_codespace(self, n: int, low: int, high: int) -> None:
        self.codespace[n - 1].append(low)  # n > 4 raises, as the JavaScript does
        self.codespace[n - 1].append(high)
        self.num_codespace += 1

    def _charge(self, n: int, what: str) -> None:
        if n <= 0:
            return
        if self._budget + n > MAX_MAP_RANGE:
            raise CMapError(f"{what} - ignoring data above MAX_MAP_RANGE.")
        self._budget += n

    def map_cid_range(self, low: int, high: int, dst: int) -> None:
        self._charge(high - low + 1, "mapCidRange")
        while low <= high:
            self.map[low] = dst
            low += 1
            dst += 1

    def map_bf_range(self, low: int, high: int, dst: str) -> None:
        self._charge(high - low + 1, "mapBfRange")
        last = len(dst) - 1
        while low <= high:
            self.map[low] = dst
            low += 1
            nxt = (ord(dst[last]) + 1) if last >= 0 else math.nan
            if nxt != nxt:
                dst = dst[:last] + "\0"
            elif nxt > 255:
                # n.substring(0, r - 1) + String.fromCharCode(n.charCodeAt(r - 1) + 1) + "\0"
                prev = chr((ord(dst[last - 1]) + 1) & 0xFFFF) if last >= 1 else "\0"
                dst = dst[: max(last - 1, 0)] + prev + "\0"
            else:
                dst = dst[:last] + chr(nxt)

    def map_bf_range_to_array(self, low: int, high: int, array: list[Any]) -> None:
        self._charge(min(high - low + 1, len(array)), "mapBfRangeToArray")
        i = 0
        while low <= high and i < len(array):
            self.map[low] = array[i]
            low += 1
            i += 1

    def lookup(self, code: int) -> Any:
        if self.identity:
            return code if _is_int(code) and code <= 0xFFFF else None
        return self.map.get(code)

    def contains(self, code: int) -> bool:
        if self.identity:
            return _is_int(code) and code <= 0xFFFF
        return code in self.map

    def items(self):
        if self.identity:
            return ((i, i) for i in range(0x10000))
        return self.map.items()

    @property
    def is_identity_cmap(self) -> bool:
        if self.name not in ("Identity-H", "Identity-V") or len(self.map) != 0x10000:
            return False
        return all(self.map.get(i) == i for i in range(0x10000))

    def read_char_code(self, data: bytes, offset: int) -> tuple[int, int]:
        c = 0
        for n in range(4):
            byte = data[offset + n] if offset + n < len(data) else 0
            c = ((c << 8) | byte) & 0xFFFFFFFF
            ranges = self.codespace[n]
            for k in range(0, len(ranges) - 1, 2):
                if ranges[k] <= c <= ranges[k + 1]:
                    return c, n + 1
        return 0, 1


def _identity_cmap(vertical: bool) -> CMap:
    cmap = CMap()
    cmap.identity = True
    cmap.vertical = vertical
    cmap.add_codespace(2, 0, 0xFFFF)
    return cmap


def _builtin_cmap(name: str) -> CMap:
    if name == "Identity-H":
        return _identity_cmap(False)
    if name == "Identity-V":
        return _identity_cmap(True)
    # unpdf runs pdf.js without its CMap files, so every other predefined CMap fails to load.
    raise CMapError("Ensure that the `cMapUrl` API parameter is provided.")


def _cmap_tokens(data: bytes):
    """Tokens as pdf.js's Lexer returns them: numbers, binary strings, names, commands."""
    parser = PSBaseParser(BytesIO(data))
    while True:
        try:
            _, token = parser.nexttoken()
        except PSEOF:
            return
        if isinstance(token, bytes):
            yield ("str", token.decode("latin-1"))
        elif isinstance(token, PSKeyword):
            yield ("cmd", token.name.decode("latin-1") if isinstance(token.name, bytes) else token.name)
        elif isinstance(token, PSLiteral):
            yield ("name", token.name)
        elif isinstance(token, bool):
            yield ("bool", token)
        elif _is_num(token):
            yield ("num", token)


def _convert_cid_string(cid: str) -> Any:
    """convertCidString: a 1- or 2-byte CID string as a number; anything longer stays a string (so no width)."""
    if len(cid) == 1:
        return ord(cid)
    if len(cid) == 2:
        return (ord(cid[0]) << 8) | ord(cid[1])
    return cid


def _str_to_int(s: str) -> int:
    a = 0
    for ch in s:
        a = ((a << 8) | ord(ch)) & 0xFFFFFFFF
    return a


def parse_cmap(data: bytes) -> CMap:
    """parseCMap (+ extendCMap for `usecmap`), as in pdf.js's cmap.js."""
    cmap = CMap()
    tokens = _cmap_tokens(data)
    EOF = ("eof", None)

    def nxt():
        return next(tokens, EOF)

    def expect_str(tok):
        if tok[0] != "str":
            raise CMapError("Malformed CMap: expected string.")
        return tok[1]

    def expect_int(tok):
        if not (tok[0] == "num" and _is_int(tok[1])):
            raise CMapError("Malformed CMap: expected int.")
        return int(tok[1])

    previous = None
    use_cmap = None
    while True:
        try:
            tok = nxt()
            if tok is EOF:
                break
            kind, value = tok
            if kind == "name":
                if value == "WMode":
                    t = nxt()
                    if t[0] == "num" and _is_int(t[1]):
                        cmap.vertical = bool(t[1])
                elif value == "CMapName":
                    t = nxt()
                    if t[0] == "name":
                        cmap.name = t[1]
                previous = tok
            elif kind == "cmd":
                if value == "endcmap":
                    break
                if value == "usecmap":
                    if previous and previous[0] == "name":
                        use_cmap = previous[1]
                elif value == "begincodespacerange":
                    while True:
                        t = nxt()
                        if t is EOF or t == ("cmd", "endcodespacerange"):
                            if t is EOF:
                                raise CMapError("Invalid codespace range.")
                            break
                        if t[0] != "str":
                            raise CMapError("Invalid codespace range.")
                        low = _str_to_int(t[1])
                        t = nxt()
                        if t[0] != "str":
                            raise CMapError("Invalid codespace range.")
                        cmap.add_codespace(len(t[1]), low, _str_to_int(t[1]))
                elif value == "beginbfchar":
                    while True:
                        t = nxt()
                        if t is EOF or t == ("cmd", "endbfchar"):
                            break
                        src = _str_to_int(expect_str(t))
                        cmap.map[src] = expect_str(nxt())
                elif value == "begincidchar":
                    while True:
                        t = nxt()
                        if t is EOF or t == ("cmd", "endcidchar"):
                            break
                        src = _str_to_int(expect_str(t))
                        cmap.map[src] = expect_int(nxt())
                elif value == "beginbfrange":
                    while True:
                        t = nxt()
                        if t is EOF:
                            raise CMapError("Invalid bf range.")
                        if t == ("cmd", "endbfrange"):
                            break
                        low = _str_to_int(expect_str(t))
                        high = _str_to_int(expect_str(nxt()))
                        t = nxt()
                        if (t[0] == "num" and _is_int(t[1])) or t[0] == "str":
                            cmap.map_bf_range(low, high, _from_char_code(t[1]) if t[0] == "num" else t[1])
                        elif t == ("cmd", "["):
                            array = []
                            t = nxt()
                            while t != ("cmd", "]") and t is not EOF:
                                array.append(t[1])
                                t = nxt()
                            cmap.map_bf_range_to_array(low, high, array)
                        else:
                            raise CMapError("Invalid bf range.")
                elif value == "begincidrange":
                    while True:
                        t = nxt()
                        if t is EOF or t == ("cmd", "endcidrange"):
                            break
                        low = _str_to_int(expect_str(t))
                        high = _str_to_int(expect_str(nxt()))
                        cmap.map_cid_range(low, high, expect_int(nxt()))
        except (CMapError, IndexError, TypeError, ValueError):
            continue
    if use_cmap:
        base = _builtin_cmap(use_cmap)
        if cmap.num_codespace == 0:
            cmap.codespace = [r[:] for r in base.codespace]
            cmap.num_codespace = base.num_codespace
        for code, value in base.items():
            if code not in cmap.map:
                cmap.map[code] = value
    if cmap.is_identity_cmap:
        return _builtin_cmap(cmap.name)
    return cmap


def _cmap_from(obj: Any) -> CMap:
    """CMapFactory.create."""
    obj = _resolve(obj)
    if isinstance(obj, PSLiteral):
        return _builtin_cmap(obj.name)
    if isinstance(obj, PDFStream):
        return parse_cmap(obj.get_data())
    raise CMapError("Encoding required.")


class ToUnicode:
    """ToUnicodeMap / IdentityToUnicodeMap."""

    def __init__(self, mapping: dict[int, str] | None = None, identity: tuple[int, int] | None = None):
        self.mapping = mapping if mapping is not None else {}
        self.identity = identity

    @property
    def size(self) -> int:
        if self.identity:
            return self.identity[1] + 1 - self.identity[0]
        return len(self.mapping)

    def has(self, code: int) -> bool:
        if self.identity:
            return self.identity[0] <= code <= self.identity[1]
        return code in self.mapping

    def get(self, code: int) -> str | None:
        if self.identity:
            return _from_char_code(code) if self.identity[0] <= code <= self.identity[1] else None
        return self.mapping.get(code)

    def char_code_of(self, value: Any) -> int:
        if self.identity:
            return value if _is_int(value) and self.identity[0] <= value <= self.identity[1] else -1
        for code, mapped in self.mapping.items():
            if mapped == value:
                return code
        return -1


def _utf16_value(value: Any) -> str:
    """readToUnicode's decoding of one CMap value."""
    if _is_num(value):
        return chr(int(value))
    t = value
    if len(t) % 2:
        t = "\0" + t
    out = []
    e = 0
    while e < len(t):
        n = (ord(t[e]) << 8) | ord(t[e + 1])
        if (n & 0xF800) != 0xD800:
            out.append(n)
            e += 2
            continue
        e += 2
        lo = ((ord(t[e]) << 8) | ord(t[e + 1])) if e + 1 < len(t) else 0
        out.append(((n & 1023) << 10) + (lo & 1023) + 65536)
        e += 2
    return "".join(chr(c) for c in out)  # a value above U+10FFFF raises, failing the map as in pdf.js


def _read_to_unicode(obj: Any) -> ToUnicode | None:
    obj = _resolve(obj)
    if obj is None:
        return None
    if isinstance(obj, PSLiteral):
        cmap = _builtin_cmap(obj.name)  # raises for anything but Identity: the font then fails
        return (
            ToUnicode(identity=(0, 65535))
            if cmap.identity
            else ToUnicode({k: _utf16_value(v) for k, v in cmap.map.items()})
        )
    if isinstance(obj, PDFStream):
        try:
            cmap = parse_cmap(obj.get_data())
            if cmap.identity:
                return ToUnicode(identity=(0, 65535))
            return ToUnicode({code: _utf16_value(value) for code, value in cmap.items()})
        except Exception:  # noqa: BLE001 - "readToUnicode - ignoring ToUnicode data"
            return None
    return None


# ── fonts ───────────────────────────────────────────────────────────


class Glyph:
    __slots__ = ("code", "unicode", "width", "vmetric", "whitespace", "diacritic", "invisible")

    def __init__(self, code: int, unicode: str, width: float, vmetric: list[float] | None):
        self.code = code
        self.unicode = unicode
        self.width = width
        self.vmetric = vmetric
        m = _CATEGORY.search(unicode)
        self.whitespace = bool(m and m.group(1))
        self.diacritic = bool(m and m.group(2))
        self.invisible = bool(m and m.group(3))


class Font:
    error = False

    def __init__(self) -> None:
        self.name: str | None = None
        self.type = ""
        self.vertical = False
        self.is_type3 = False
        self.font_matrix: list[float] = FONT_IDENTITY
        self.bbox: list[float] | None = None
        self.widths: dict[Any, float] = {}
        self.default_width: float = 0
        self.vmetrics: dict[int, list[float]] = {}
        self.default_vmetrics: list[float] | None = None
        self.to_unicode: ToUnicode = ToUnicode()
        self.cmap: CMap | None = None
        self.composite = False
        self.missing_file = False
        self.differences: dict[Any, str] = {}
        self.default_encoding: list[str] = []
        self._cache: dict[tuple[int, bool], Glyph] = {}
        self._space: float | None = None

    def chars_to_glyphs(self, data: bytes) -> list[Glyph]:
        glyphs = []
        if self.cmap:
            i = 0
            while i < len(data):
                code, length = self.cmap.read_char_code(data, i)
                i += length
                glyphs.append(self._glyph(code, length == 1 and data[i - 1 : i] == b" "))
        else:
            for byte in data:
                glyphs.append(self._glyph(byte, byte == 32))
        return glyphs

    def _glyph(self, code: int, is_space: bool) -> Glyph:
        cached = self._cache.get((code, is_space))
        if cached:
            return cached
        width_code: Any = code
        if self.cmap and self.cmap.contains(code):
            width_code = self.cmap.lookup(code)
            if isinstance(width_code, str):
                width_code = _convert_cid_string(width_code)
        width = self.widths.get(width_code)
        if not _is_num(width):
            width = self.default_width
        vmetric = self.vmetrics.get(width_code)
        if not vmetric and self.default_vmetrics:
            vmetric = [self.default_vmetrics[0], width * 0.5, self.default_vmetrics[2]]
        unicode = self.to_unicode.get(code) or _from_char_code(code)
        if self.missing_file and self.type == "Type1":
            glyph_name = self.differences.get(code) or (
                self.default_encoding[code] if 0 <= code < len(self.default_encoding) else None
            )
            if glyph_name == "":
                width = width or self._space_width()
                if not self.to_unicode.has(code):
                    unicode = " "
        glyph = Glyph(code, unicode, width, vmetric)
        self._cache[(code, is_space)] = glyph
        return glyph

    def _space_width(self) -> float:
        if self._space is None:
            found = None
            glyph_codes = tables()["glyphs"]
            for name in ("space", "minus", "one", "i", "I"):
                if name in self.widths:
                    found = self.widths[name]
                    break
                e = glyph_codes.get(name)
                r: Any = 0
                if self.composite and self.cmap and self.cmap.contains(e):
                    r = self.cmap.lookup(e)
                if not _truthy(r) and self.to_unicode:
                    r = self.to_unicode.char_code_of(e)
                if r is None or r <= 0:
                    r = e
                found = self.widths.get(r)
                if _truthy(found):
                    break
            self._space = found if _truthy(found) else self.default_width
        return self._space


class ErrorFont(Font):
    """What pdf.js uses for a font it could not load: it shows no glyphs at all."""

    error = True

    def __init__(self) -> None:
        super().__init__()
        self.font_matrix = None  # type: ignore[assignment]

    def chars_to_glyphs(self, data: bytes) -> list[Glyph]:
        return []


def normalize_font_name(name: str) -> str:
    return regex.sub(f"[{JS_S}]", "", regex.sub("[,_]", "-", name))


def _is_serif(name: str) -> bool:
    t = name.split("-", 1)[0]
    return t in tables()["serifFonts"] or bool(_SERIF_RE.search(t))


def _base_font_metrics(name: str) -> tuple[float, bool, dict[str, float]]:
    std = normalize_font_name(name)
    std = tables()["stdFontMap"].get(std) or std
    metrics = tables()["metrics"]
    entry = metrics.get(std)
    if entry is None:
        entry = metrics["Times-Roman" if _is_serif(name) else "Helvetica"]
    if _is_num(entry):
        return entry, True, {}
    return 0, False, entry


def _char_code_to_width(widths: dict[str, float], differences: dict[Any, str], encoding: list[str]) -> dict[int, float]:
    out = {}
    for code in range(256):
        w = (code in differences and widths.get(differences[code])) or (
            code < len(encoding) and widths.get(encoding[code])
        )
        if w:
            out[code] = w
    return out


def _unicode_for_glyph(name: str, glyphs: dict[str, int]) -> int:
    if name in glyphs:
        return glyphs[name]
    if not name:
        return -1
    if name[0] == "u":
        n = len(name)
        if n == 7 and name[1] == "n" and name[2] == "i":
            rest = name[3:]
        elif 5 <= n <= 7:
            rest = name[1:]
        else:
            return -1
        if rest == rest.upper():
            value = _parse_int16(rest)
            if value == value and value >= 0:
                return int(value)
    return -1


def _simple_font_to_unicode(props: dict[str, Any], force_glyphs: bool = False) -> dict[int, str]:
    """`_simpleFontToUnicode` in pdf.js's evaluator."""
    out: dict[int, str] = {}
    encoding: dict[Any, str] = dict(enumerate(props["defaultEncoding"]))
    for code, name in props["differences"].items():
        if name != ".notdef":
            encoding[code] = name
    base = props["baseEncodingName"]
    glyphs = tables()["glyphs"]
    int_keys = sorted(k for k in encoding if _is_int(k) and k >= 0)
    for code in int_keys:
        s = encoding[code]
        if s == "":
            continue
        if s in glyphs:
            out[int(code)] = _from_char_code(glyphs[s])
            continue
        value: Any = 0
        head = s[0]
        if head == "G":
            if len(s) == 3:
                value = _parse_int16(s[1:])
        elif head == "g":
            if len(s) == 5:
                value = _parse_int16(s[1:])
        elif head in ("C", "c"):
            if 3 <= len(s) <= 4:
                rest = s[1:]
                if force_glyphs:
                    value = _parse_int16(rest)
                else:
                    value = _js_number(rest)
                    if value != value and _is_int(_parse_int16(rest)):
                        return _simple_font_to_unicode(props, True)
        elif head == "u":
            c = _unicode_for_glyph(s, glyphs)
            if c != -1:
                value = c
        elif s in ("f_h", "f_t", "T_h"):
            out[int(code)] = s.replace("_", "")
            continue
        if _is_num(value) and value == value and 0 < value <= 0x10FFFF and _is_int(value):
            if base and value == code:
                enc = tables()["encodings"].get(base)
                if enc and code < len(enc) and enc[int(code)]:
                    out[int(code)] = _from_char_code(glyphs.get(enc[int(code)], math.nan))
                    continue
            out[int(code)] = chr(int(value))
    return out


def _font_file_kind(file: PDFStream | None, file_key: str | None) -> str | None:
    if file is None:
        return None
    if file_key == "FontFile":
        return "Type1"
    if file_key == "FontFile2":
        return "TrueType"
    sub = _name(_get(file.attrs, "Subtype"))
    if sub in ("Type1C", "CIDFontType0C"):
        return "CFF"
    if sub == "OpenType":
        return "TrueType"
    return "CFF"


def _type1_builtin_encoding(data: bytes) -> list[str] | None:
    """The encoding a Type 1 font program declares (pdf.js's Type1Font.builtInEncoding)."""
    head = data[: data.find(b"eexec")] if b"eexec" in data else data
    if regex.search(rb"/Encoding\s+StandardEncoding", head):
        return list(tables()["encodings"]["StandardEncoding"])
    entries = regex.findall(rb"dup\s+(\d+)\s*/([^\s/\[\]{}()<>]+)\s+put", head)
    if not entries:
        return None
    enc = [""] * 256
    for code, name in entries:
        c = int(code)
        if c < 256:
            enc[c] = name.decode("latin-1")
    return enc


def _cff_builtin_encoding(data: bytes) -> list[str] | None:
    try:
        from pdfminer.pdffont import CFFFont

        cff = CFFFont("", BytesIO(data))
        enc = [""] * 256
        for code, gid in cff.code2gid.items():
            name = cff.gid2name.get(gid)
            if 0 <= code < 256 and name:
                enc[code] = name.decode("latin-1") if isinstance(name, bytes) else str(name)
        return enc if any(enc) else None
    except Exception:  # noqa: BLE001 - no usable built-in encoding
        return None


def _only_windows_name_records(data: bytes) -> bool:
    """adjustTrueTypeToUnicode's test: the `name` table has records, all (3, 1, 0x409)."""
    try:
        num_tables = int.from_bytes(data[4:6], "big")
        for i in range(num_tables):
            rec = data[12 + 16 * i : 28 + 16 * i]
            if rec[:4] == b"name":
                offset = int.from_bytes(rec[8:12], "big")
                length = int.from_bytes(rec[12:16], "big")
                table = data[offset : offset + length]
                if int.from_bytes(table[0:2], "big") != 0 or length < 6:
                    return False
                count = int.from_bytes(table[2:4], "big")
                kept = []
                for r in range(count):
                    p = 6 + 12 * r
                    if p + 12 > length:
                        break
                    platform, encoding, language = (int.from_bytes(table[p + k : p + k + 2], "big") for k in (0, 2, 4))
                    if (platform, encoding, language) in ((1, 0, 0), (3, 1, 1033)):
                        kept.append((platform, encoding, language))
                return bool(kept) and all(k == (3, 1, 1033) for k in kept)
        return False
    except Exception:  # noqa: BLE001
        return False


def load_font(font_dict: Any) -> Font:
    """loadFont → preEvaluateFont → translateFont → new Font, for text purposes. Never raises."""
    try:
        return _translate(font_dict)
    except Exception:  # noqa: BLE001 - "loadFont - translateFont failed": the font shows nothing
        return ErrorFont()


FALLBACK_FONT = {"BaseFont": PSLiteral("Helvetica"), "Type": PSLiteral("FallbackType"),
                 "Subtype": PSLiteral("FallbackType"), "Encoding": PSLiteral("WinAnsiEncoding")}  # fmt: skip


def _translate(base: Any) -> Font:
    base = _resolve(base)
    if not isinstance(base, dict):
        base = FALLBACK_FONT
    subtype = _name(_get(base, "Subtype"))
    if subtype is None:
        raise ValueError("invalid font Subtype")
    d = base
    composite = False
    if subtype == "Type0":
        desc = _get(base, "DescendantFonts")
        if not desc:
            raise ValueError("Descendant fonts are not specified")
        d = _resolve(desc[0]) if isinstance(desc, list) else desc
        if not isinstance(d, dict):
            raise ValueError("Descendant font is not a dictionary.")
        subtype = _name(_get(d, "Subtype"))
        if subtype is None:
            raise ValueError("invalid font Subtype")
        composite = True
    first = _get(d, "FirstChar")
    first = int(first) if _is_int(first) else 0
    last = _get(d, "LastChar")
    last = int(last) if _is_int(last) else (65535 if composite else 255)
    descriptor = _get(d, "FontDescriptor")
    to_unicode_obj = d.get("ToUnicode") or base.get("ToUnicode")
    is_type3 = subtype == "Type3"

    props: dict[str, Any] = {
        "type": subtype, "composite": composite, "firstChar": first, "lastChar": last, "toUnicode": to_unicode_obj,
        "file": None, "fileKind": None, "isType3Font": is_type3, "fontMatrix": FONT_IDENTITY, "bbox": None,
        "cMap": None, "vertical": False, "cidSystemInfo": None,
    }  # fmt: skip

    if not isinstance(descriptor, dict):
        if is_type3 or composite:
            descriptor = {}
        else:
            base_font = _get(d, "BaseFont")
            if not isinstance(base_font, PSLiteral):
                raise ValueError("Base font is not specified")
            name = normalize_font_name(base_font.name)
            dw, mono, by_name = _base_font_metrics(name)
            head = name.split("-", 1)[0]
            props.update(name=name, flags=(SERIF if _is_serif(head) else 0) | (FIXED_PITCH if mono else 0)
                         | (SYMBOLIC if head in tables()["symbolsFonts"] else NONSYMBOLIC))  # fmt: skip
            _extract_data_structures(d, props)
            widths_arr = _get(d, "Widths")
            if isinstance(widths_arr, list):
                widths: dict[Any, float] = {}
                code = first
                for w in widths_arr:
                    w = _resolve(w)
                    if _is_num(w):
                        widths[code] = w
                    code += 1
            else:
                widths = _char_code_to_width(by_name, props["differences"], props["defaultEncoding"])
            props.update(widths=widths, defaultWidth=dw, vmetrics={}, defaultVMetrics=None)
            return _finish(props)

    font_name = _get(descriptor, "FontName")
    base_font = _get(d, "BaseFont")
    if isinstance(font_name, bytes):
        font_name = PSLiteral(font_name.decode("latin-1"))
    if isinstance(base_font, bytes):
        base_font = PSLiteral(base_font.decode("latin-1"))
    p, m = _name(font_name), _name(base_font)
    if is_type3:
        if not p:
            font_name = PSLiteral(subtype)
    elif p != m:
        if p and m and (m.startswith(p) or (not _known_font(p) and _known_font(m))):
            font_name = None
        font_name = font_name or base_font
    if not isinstance(font_name, PSLiteral):
        raise ValueError("invalid font name")
    props["name"] = font_name.name

    for key in ("FontFile", "FontFile2", "FontFile3"):
        f = _get(descriptor, key)
        if f is not None:
            if isinstance(f, PDFStream):
                try:
                    if f.get_data():
                        props["file"], props["fileKind"] = f, _font_file_kind(f, key)
                except Exception:  # noqa: BLE001 - "fetching font file": no file
                    pass
            break

    props["fontMatrix"] = _matrix(d.get("FontMatrix"), FONT_IDENTITY)
    props["bbox"] = _normal_rect(descriptor.get("FontBBox") or d.get("FontBBox"), [0, 0, 0, 0] if is_type3 else None)
    flags = _get(descriptor, "Flags")
    props["flags"] = int(flags) if _is_int(flags) else 0
    if composite:
        cmap = _cmap_from(base.get("Encoding"))
        props["cMap"], props["vertical"] = cmap, cmap.vertical
    _extract_data_structures(d, props)
    _extract_widths(d, descriptor, props)
    return _finish(props)


def _known_font(name: str) -> bool:
    t = normalize_font_name(name)
    tb = tables()
    return bool(
        tb["stdFontMap"].get(t) or tb["nonStdFontMap"].get(t) or t in tb["serifFonts"] or t in tb["symbolsFonts"]
    )


def _extract_data_structures(d: dict, props: dict[str, Any]) -> None:
    to_unicode = _read_to_unicode(props["toUnicode"])
    if props["composite"]:
        info = _get(d, "CIDSystemInfo")
        if isinstance(info, dict):
            props["cidSystemInfo"] = (_bytes_str(_get(info, "Registry")), _bytes_str(_get(info, "Ordering")))
    differences: dict[Any, str] = {}
    base_name = None
    if "Encoding" in d:
        enc = _get(d, "Encoding")
        if isinstance(enc, dict):
            base_name = _name(_get(enc, "BaseEncoding"))
            if "Encoding" in d and "Differences" in enc:
                code: Any = 0
                for item in _get(enc, "Differences") or []:
                    item = _resolve(item)
                    if _is_num(item):
                        code = item
                    elif isinstance(item, PSLiteral):
                        differences[code] = item.name
                        code += 1
                    else:
                        raise ValueError("Invalid entry in 'Differences' array")
        elif isinstance(enc, PSLiteral):
            base_name = enc.name
        if base_name not in ("MacRomanEncoding", "MacExpertEncoding", "WinAnsiEncoding"):
            base_name = None
    non_embedded = props["file"] is None
    symbol_font = props.get("name") in tables()["symbolsFonts"]
    if base_name and non_embedded and symbol_font:
        base_name = None
    encodings = tables()["encodings"]
    if base_name:
        default = encodings[base_name]
    else:
        flags = props["flags"]
        symbolic = bool(flags & SYMBOLIC)
        nonsymbolic = bool(flags & NONSYMBOLIC)
        if props["type"] == "TrueType" and symbolic and nonsymbolic and differences:
            props["flags"] = flags & ~SYMBOLIC
            symbolic = False
        default = encodings["StandardEncoding"]
        if props["type"] == "TrueType" and not nonsymbolic:
            default = encodings["WinAnsiEncoding"]
        if symbolic or symbol_font:
            default = encodings["MacRomanEncoding"]
            if non_embedded:
                name = props.get("name") or ""
                if regex.search("Symbol", name, regex.IGNORECASE):
                    default = encodings["SymbolSetEncoding"]
                elif regex.search("Dingbats", name, regex.IGNORECASE):
                    default = encodings["ZapfDingbatsEncoding"]
                elif regex.search("Wingdings", name, regex.IGNORECASE):
                    default = encodings["WinAnsiEncoding"]
    props.update(defaultEncoding=default, differences=differences, baseEncodingName=base_name,
                 hasEncoding=bool(base_name) or bool(differences), toUnicodeMap=to_unicode)  # fmt: skip
    # buildToUnicode
    props["hasIncludedToUnicodeMap"] = bool(to_unicode and to_unicode.size)
    props["fallbackToUnicode"] = None
    if props["hasIncludedToUnicodeMap"]:
        if not props["composite"] and props["hasEncoding"]:
            props["fallbackToUnicode"] = _simple_font_to_unicode(props)
    elif not props["composite"]:
        props["toUnicodeMap"] = ToUnicode(_simple_font_to_unicode(props))
    else:
        info = props["cidSystemInfo"]
        if info and info[0] == "Adobe" and info[1] in ("GB1", "CNS1", "Japan1", "Korea1"):
            raise CMapError("Ensure that the `cMapUrl` API parameter is provided.")
        props["toUnicodeMap"] = ToUnicode(identity=(props["firstChar"], props["lastChar"]))


def _extract_widths(d: dict, descriptor: dict, props: dict[str, Any]) -> None:
    widths: dict[Any, float] = {}
    default: float = 0
    vmetrics: dict[int, list[float]] = {}
    default_vmetrics = None
    if props["composite"]:
        dw = _get(d, "DW")
        default = math.ceil(dw) if _is_num(dw) else 1000
        w = _get(d, "W")
        if isinstance(w, list):
            e = 0
            while e < len(w):
                start = _resolve(w[e])
                e += 1
                if not _is_int(start):
                    break
                start = int(start)
                nxt = _resolve(w[e]) if e < len(w) else None
                if isinstance(nxt, list):
                    for item in nxt:
                        item = _resolve(item)
                        if _is_num(item):
                            widths[start] = item
                        start += 1
                elif _is_int(nxt):
                    e += 1
                    value = _resolve(w[e]) if e < len(w) else None
                    if _is_num(value):
                        for c in range(start, int(nxt) + 1):
                            widths[c] = value
                    e += 1
                    continue
                else:
                    break
                e += 1
        if props["vertical"]:
            dw2 = _get(d, "DW2")
            dw2 = (
                dw2
                if isinstance(dw2, list) and len(dw2) == 2 and all(_is_num(_resolve(v)) for v in dw2)
                else [880, -1000]
            )
            default_vmetrics = [_resolve(dw2[1]), default * 0.5, _resolve(dw2[0])]
            w2 = _get(d, "W2")
            if isinstance(w2, list):
                e = 0
                while e < len(w2):
                    start = _resolve(w2[e])
                    e += 1
                    if not _is_int(start):
                        break
                    start = int(start)
                    nxt = _resolve(w2[e]) if e < len(w2) else None
                    if isinstance(nxt, list):
                        k = 0
                        while k < len(nxt):
                            trio = [_resolve(v) for v in nxt[k : k + 3]]
                            k += 3
                            if len(trio) == 3 and all(_is_num(v) for v in trio):
                                vmetrics[start] = trio
                            start += 1
                    elif _is_int(nxt):
                        trio = [_resolve(v) for v in w2[e + 1 : e + 4]]
                        e += 4
                        if len(trio) == 3 and all(_is_num(v) for v in trio):
                            for c in range(start, int(nxt) + 1):
                                vmetrics[c] = trio
                        continue
                    else:
                        break
                    e += 1
    else:
        arr = _get(d, "Widths")
        if isinstance(arr, list):
            code = props["firstChar"]
            for item in arr:
                item = _resolve(item)
                if _is_num(item):
                    widths[code] = item
                code += 1
            missing = _get(descriptor, "MissingWidth")
            default = missing if _is_num(missing) else 0
        else:
            base_font = _get(d, "BaseFont")
            if isinstance(base_font, PSLiteral):
                dw, _mono, by_name = _base_font_metrics(base_font.name)
                widths = _char_code_to_width(by_name, props["differences"], props["defaultEncoding"])
                default = dw
    props.update(widths=widths, defaultWidth=default, vmetrics=vmetrics, defaultVMetrics=default_vmetrics)


def _finish(props: dict[str, Any]) -> Font:
    """new Font(...): what of it matters for text."""
    font = Font()
    font.name = props.get("name")
    font.type = props["type"]
    font.composite = props["composite"]
    font.is_type3 = props["isType3Font"]
    font.font_matrix = props["fontMatrix"]
    font.bbox = props["bbox"]
    font.widths = props["widths"]
    font.default_width = props["defaultWidth"]
    font.differences = props["differences"]
    font.default_encoding = props["defaultEncoding"]
    font.cmap = props["cMap"]
    to_unicode: ToUnicode = props["toUnicodeMap"]
    font.to_unicode = to_unicode
    if font.is_type3:
        return font
    font.vertical = bool(props["vertical"])
    if font.vertical:
        font.vmetrics = props["vmetrics"]
        font.default_vmetrics = props["defaultVMetrics"]
    file: PDFStream | None = props["file"]
    if file is None:
        font.missing_file = True
    else:
        data = file.get_data()
        kind = props["fileKind"]
        if kind == "TrueType" and not props["composite"]:
            # adjustTrueTypeToUnicode
            if (
                not props["hasIncludedToUnicodeMap"]
                and not props["hasEncoding"]
                and not to_unicode.identity
                and props["flags"] & SYMBOLIC
                and props["defaultEncoding"] is not tables()["encodings"]["WinAnsiEncoding"]
                and _only_windows_name_records(data)
            ):
                glyphs = tables()["glyphs"]
                for code, name in enumerate(tables()["encodings"]["WinAnsiEncoding"]):
                    if name and name in glyphs:
                        to_unicode.mapping[code] = _from_char_code(glyphs[name])
        elif kind in ("Type1", "CFF"):
            builtin = _type1_builtin_encoding(data) if kind == "Type1" else _cff_builtin_encoding(data)
            # adjustType1ToUnicode
            if (
                builtin
                and builtin != props["defaultEncoding"]
                and not props["hasIncludedToUnicodeMap"]
                and not to_unicode.identity
            ):
                glyphs = tables()["glyphs"]
                for code, name in enumerate(builtin):
                    if props["hasEncoding"] and (props["baseEncodingName"] or code in props["differences"]):
                        continue
                    u = _unicode_for_glyph(name, glyphs)
                    if u != -1:
                        to_unicode.mapping[code] = _from_char_code(u)
    # amendFallbackToUnicode
    fallback = props["fallbackToUnicode"]
    if fallback and not to_unicode.identity:
        for code, value in fallback.items():
            if code not in to_unicode.mapping:
                to_unicode.mapping[code] = value
    return font


# ── the text-content builder (pdf.js evaluator.getTextContent) ──────


class TextState:
    __slots__ = (
        "ctm", "font_name", "font_size", "font", "font_matrix", "text_matrix", "text_line_matrix",
        "char_spacing", "word_spacing", "leading", "text_hscale", "text_rise",
    )  # fmt: skip

    def __init__(self) -> None:
        self.ctm: list[float] = [1, 0, 0, 1, 0, 0]
        self.font_name: str | None = None
        self.font_size: Any = 0
        self.font: Font | None = None
        self.font_matrix: list[float] = FONT_IDENTITY
        self.text_matrix: list[float] = [1, 0, 0, 1, 0, 0]
        self.text_line_matrix: list[float] = [1, 0, 0, 1, 0, 0]
        self.char_spacing: Any = 0
        self.word_spacing: Any = 0
        self.leading: Any = 0
        self.text_hscale: Any = 1
        self.text_rise: Any = 0

    def clone(self) -> TextState:
        c = TextState.__new__(TextState)
        for slot in TextState.__slots__:
            setattr(c, slot, getattr(self, slot))
        c.text_matrix = self.text_matrix[:]
        c.text_line_matrix = self.text_line_matrix[:]
        c.font_matrix = self.font_matrix[:]
        return c

    def translate_text_matrix(self, x: float, y: float) -> None:
        m = self.text_matrix
        m[4] = m[0] * x + m[2] * y + m[4]
        m[5] = m[1] * x + m[3] * y + m[5]

    def translate_text_line_matrix(self, x: float, y: float) -> None:
        m = self.text_line_matrix
        m[4] = m[0] * x + m[2] * y + m[4]
        m[5] = m[1] * x + m[3] * y + m[5]

    def carriage_return(self) -> None:
        self.translate_text_line_matrix(0, -self.leading)
        self.text_matrix = self.text_line_matrix[:]


class StateManager:
    def __init__(self, state: TextState) -> None:
        self.state = state
        self.stack: list[TextState] = []

    def save(self) -> None:
        self.stack.append(self.state)
        self.state = self.state.clone()

    def restore(self) -> None:
        if self.stack:
            self.state = self.stack.pop()

    def transform(self, args: list[Any]) -> None:
        self.state.ctm = _transform(self.state.ctm, args)


class _Run:
    """`textContentItem`: the run of text being built."""

    __slots__ = (
        "initialized", "str", "total_width", "total_height", "width", "height", "vertical", "prev_transform",
        "prev_text_rise", "text_advance_scale", "space_in_flow_min", "space_in_flow_max", "tracking_space_min",
        "negative_space_max", "not_a_space", "transform", "font_name", "has_eol",
    )  # fmt: skip

    def __init__(self) -> None:
        self.initialized = False
        self.str: list[str] = []
        self.total_width: float = 0
        self.total_height: float = 0
        self.width: float = 0
        self.height: float = 0
        self.vertical = False
        self.prev_transform: list[float] | None = None
        self.prev_text_rise: float = 0
        self.text_advance_scale: float = 0
        self.space_in_flow_min: float = 0
        self.space_in_flow_max: float = 0
        self.tracking_space_min = math.inf
        self.negative_space_max = -math.inf
        self.not_a_space = -math.inf
        self.transform: list[float] | None = None
        self.font_name = None
        self.has_eol = False


class _Abort(Exception):
    """An error pdf.js would hit mid-page; it keeps what it had and moves on (ignoreErrors)."""


_PARTIAL_COMMANDS = {"BM", "BD", "true", "fa", "fal", "fals", "false", "nu", "nul", "null"}


def _split_command(word: str, known: dict[str, Any]) -> list[str]:
    """How pdf.js's Lexer cuts a run of regular characters into commands."""
    out = []
    i = 0
    while i < len(word):
        s = word[i]
        found = s in known or s in _PARTIAL_COMMANDS
        i += 1
        while i < len(word):
            possible = s + word[i]
            if found and possible not in known and possible not in _PARTIAL_COMMANDS:
                break
            s = possible
            found = s in known or s in _PARTIAL_COMMANDS
            i += 1
        out.append(s)
    return out


class _Document:
    def __init__(self) -> None:
        self.font_cache: dict[Any, Font] = {}

    def font(self, ref: Any) -> Font:
        key = ref.objid if isinstance(ref, PDFObjRef) else id(ref)
        font = self.font_cache.get(key)
        if font is None:
            font = load_font(ref)
            self.font_cache[key] = font
        return font


class _TextContent:
    """One `getTextContent` call (a page, or a form XObject inside it)."""

    def __init__(self, doc: _Document, view: list[float], out: list[tuple[str, bool]], prev_refs: frozenset) -> None:
        self.doc = doc
        self.view = view
        self.out = out
        self.prev_refs = prev_refs
        self.run = _Run()
        self.two_last = [" ", " "]
        self.last_pos = 0
        self.spaced: list[bytes] = []
        self.state: TextState  # `textState` (j): the state manager's current state
        self.last_font_state: TextState | None = None  # M

    # chars bookkeeping
    def save_last_char(self, ch: str) -> bool:
        nxt = (self.last_pos + 1) % 2
        ret = self.two_last[self.last_pos] != " " and self.two_last[nxt] == " "
        self.two_last[self.last_pos] = ch
        self.last_pos = nxt
        return ret

    def should_add_whitespace(self) -> bool:
        return self.two_last[self.last_pos] != " " and self.two_last[(self.last_pos + 1) % 2] == " "

    def reset_last_chars(self) -> None:
        self.two_last[0] = self.two_last[1] = " "
        self.last_pos = 0

    def push_whitespace(self) -> None:
        self.out.append((" ", False))

    def current_transform(self) -> list[float]:
        j = self.state
        font = j.font
        tsm = [j.font_size * j.text_hscale, 0, 0, j.font_size, 0, j.text_rise]
        # pdf.js also does this for Type3 fonts it measured glyph by glyph (`isCharBBox`), which needs the
        # glyph programs; not done here.
        if font.is_type3 and j.font_size <= 1 and j.font_matrix != FONT_IDENTITY and font.bbox:
            glyph_height = font.bbox[3] - font.bbox[1]
            if glyph_height > 0:
                tsm[3] *= glyph_height * j.font_matrix[3]
        return _transform(j.ctm, _transform(j.text_matrix, tsm))

    def ensure_run(self) -> _Run:
        y = self.run
        if y.initialized:
            return y
        j = self.state
        y.font_name = j.font_name
        n = y.transform = self.current_transform()
        if j.font.vertical:
            y.width = y.total_width = _hypot(n[0], n[1])
            y.height = y.total_height = 0
            y.vertical = True
        else:
            y.width = y.total_width = 0
            y.height = y.total_height = _hypot(n[2], n[3])
            y.vertical = False
        r = _hypot(j.text_line_matrix[0], j.text_line_matrix[1])
        i = _hypot(j.ctm[0], j.ctm[1])
        y.text_advance_scale = i * r
        a = j.font_size
        y.tracking_space_min = a * 0.102
        y.not_a_space = a * 0.03
        y.negative_space_max = a * -0.2
        y.space_in_flow_min = a * 0.102
        y.space_in_flow_max = a * 0.6
        y.has_eol = False
        y.initialized = True
        return y

    def update_advance_scale(self) -> None:
        y = self.run
        if not y.initialized:
            return
        j = self.state
        e = _hypot(j.text_line_matrix[0], j.text_line_matrix[1])
        t = _hypot(j.ctm[0], j.ctm[1]) * e
        if t != y.text_advance_scale:
            if y.vertical:
                y.total_height += y.height * y.text_advance_scale
                y.height = 0
            else:
                y.total_width += y.width * y.text_advance_scale
                y.width = 0
            y.text_advance_scale = t

    def flush(self) -> None:
        y = self.run
        if y.initialized and y.str is not None:
            if y.vertical:
                y.total_height += y.height * y.text_advance_scale
            else:
                y.total_width += y.width * y.text_advance_scale
            self.out.append((normalize_unicode("".join(y.str)), y.has_eol))
            y.initialized = False
            y.str = []

    def append_eol(self) -> None:
        self.reset_last_chars()
        if self.run.initialized:
            self.run.has_eol = True
            self.flush()
        else:
            self.out.append(("", True))

    def add_fake_spaces(self, width: float, prev_transform: list[float] | None, orientation: float) -> bool:
        y = self.run
        if orientation * y.space_in_flow_min <= width <= orientation * y.space_in_flow_max:
            if y.initialized:
                self.reset_last_chars()
                y.str.append(" ")
            return False
        self.flush()
        self.reset_last_chars()
        self.push_whitespace()
        return True

    def compare_with_last_position(self, glyph_width: float) -> bool:
        j = self.state
        y = self.run
        c = self.view
        t = self.current_transform()
        n, r = t[4], t[5]
        if j.font is not None and j.font.vertical:
            if n < c[0] or n > c[2] or r + glyph_width < c[1] or r > c[3]:
                return False
        elif n + glyph_width < c[0] or n > c[2] or r < c[1] or r > c[3]:
            return False
        if j.font is None or not y.prev_transform:
            return True
        i, a = y.prev_transform[4], y.prev_transform[5]
        if i == n and a == r:
            return True
        o = -1
        if _truthy(t[0]) and t[1] == 0 and t[2] == 0:
            o = 0 if t[0] > 0 else 180
        elif _truthy(t[1]) and t[0] == 0 and t[3] == 0:
            o = 90 if t[1] > 0 else 270
        if o == 0:
            pass
        elif o == 90:
            n, r = r, n
            i, a = a, i
        elif o == 180:
            n, r, i, a = -n, -r, -i, -a
        elif o == 270:
            n, r = -r, -n
            i, a = -a, -i
        else:
            n, r = _inverse_rotation(n, r, t)
            i, a = _inverse_rotation(i, a, y.prev_transform)
        if j.font.vertical:
            e = _div(a - r, y.text_advance_scale)
            dx = n - i
            sgn = _sign(y.height if _truthy(y.height) else y.total_height)
            if e < sgn * y.negative_space_max:
                if abs(dx) > 0.5 * y.width:
                    self.append_eol()
                    return True
                self.reset_last_chars()
                self.flush()
                return True
            if abs(dx) > y.width:
                self.append_eol()
                return True
            if e <= sgn * y.not_a_space:
                self.reset_last_chars()
            if e <= sgn * y.tracking_space_min:
                if self.should_add_whitespace():
                    self.reset_last_chars()
                    self.flush()
                    self.push_whitespace()
                else:
                    y.height += e
            elif not self.add_fake_spaces(e, y.prev_transform, sgn):
                if len(y.str) == 0:
                    self.reset_last_chars()
                    self.push_whitespace()
                else:
                    y.height += e
            if abs(dx) > y.width * 0.25:
                self.flush()
            return True
        s = _div(n - i, y.text_advance_scale)
        dy = r - a
        u = _sign(y.width if _truthy(y.width) else y.total_width)
        if s < u * y.negative_space_max:
            if abs(dy) > 0.5 * y.height:
                self.append_eol()
                return True
            self.reset_last_chars()
            self.flush()
            return True
        rise = j.text_rise - y.prev_text_rise
        f = dy if rise == 0 else dy - _div(t[3], j.font_size) * rise
        if abs(f) > y.height:
            self.append_eol()
            return True
        if s <= u * y.not_a_space:
            self.reset_last_chars()
        if s <= u * y.tracking_space_min:
            if self.should_add_whitespace():
                self.reset_last_chars()
                self.flush()
                self.push_whitespace()
            else:
                y.width += s
        elif not self.add_fake_spaces(s, y.prev_transform, u):
            if len(y.str) == 0:
                self.reset_last_chars()
                self.push_whitespace()
            else:
                y.width += s
        if abs(dy) > y.height * 0.25:
            self.flush()
        return True

    def build_text(self, chars: bytes, extra_spacing: float) -> None:
        j = self.state
        m = self.last_font_state
        if m is not j and (
            m.font_size != j.font_size
            or (
                m.font_name != j.font_name
                and (
                    _font_attr(m.font, "name") != _font_attr(j.font, "name")
                    or _font_attr(m.font, "vertical") != _font_attr(j.font, "vertical")
                )  # noqa: E501
            )
        ):
            self.flush()
            self.last_font_state = j.clone()
        font = j.font
        spacing = -j.char_spacing if font.vertical else j.char_spacing
        if not chars:
            e = spacing + extra_spacing
            if _truthy(e):
                if font.vertical:
                    j.translate_text_matrix(0, -e)
                else:
                    j.translate_text_matrix(e * j.text_hscale, 0)
            return
        glyphs = font.chars_to_glyphs(chars)
        scale = j.font_matrix[0] * j.font_size
        count = len(glyphs)
        for idx, g in enumerate(glyphs):
            if g.invisible:
                continue
            u = spacing + (extra_spacing if idx + 1 == count else 0)
            f = (g.vmetric[0] if font.vertical else g.width) * scale
            if g.code == 32:
                u += j.word_spacing
            if g.whitespace:
                if font.vertical:
                    u += -f
                    j.translate_text_matrix(0, -u)
                else:
                    u += f
                    j.translate_text_matrix(u * j.text_hscale, 0)
                self.save_last_char(" ")
                continue
            if not g.diacritic and not self.compare_with_last_position(f):
                if font.vertical:
                    j.translate_text_matrix(0, f)
                else:
                    j.translate_text_matrix(f * j.text_hscale, 0)
                continue
            run = self.ensure_run()
            if g.diacritic:
                f = 0
            if font.vertical:
                j.translate_text_matrix(0, f)
                f = abs(f)
                run.height += f
            else:
                f *= j.text_hscale
                j.translate_text_matrix(f, 0)
                run.width += f
            if _truthy(f):
                run.prev_transform = self.current_transform()
                run.prev_text_rise = j.text_rise
            if self.save_last_char(g.unicode):
                run.str.append(" ")
            run.str.append(g.unicode)
            if _truthy(u):
                if font.vertical:
                    j.translate_text_matrix(0, -u)
                else:
                    j.translate_text_matrix(u * j.text_hscale, 0)

    # the operator loop
    def process(self, data: bytes, resources: Any, manager: StateManager) -> None:
        # On an error pdf.js keeps what it had ("getTextContent - ignoring errors during … task").
        with contextlib.suppress(Exception):
            self._loop(data, resources, manager)
        self.flush()

    def _loop(self, data: bytes, resources: Any, manager: StateManager) -> None:
        ops = tables()["ops"]
        resources = resources if isinstance(resources, dict) else {}
        parser = PDFContentParser([PDFStream({}, data)])
        args: list[Any] | None = None
        non_processed: list[Any] = []
        invalid_path_ops = 0
        is_path_op = False
        xobjects = None
        empty_gstates: set[str] = set()
        while True:
            try:
                _, obj = parser.nextobject()
            except PSEOF:
                return
            if isinstance(obj, PSKeyword):
                word = obj.name.decode("latin-1") if isinstance(obj.name, bytes) else str(obj.name)
                pieces = [word] if word in ops or word == "null" else _split_command(word, ops)
            else:
                pieces = None
            if pieces is None:
                if args is None:
                    args = []
                args.append(obj)
                if len(args) > 33:
                    raise _Abort("Too many arguments")
                continue
            for cmd in pieces:
                if cmd == "null":
                    continue  # null objects are never arguments
                if cmd in ("true", "false"):
                    if args is None:
                        args = []
                    args.append(cmd == "true")
                    continue
                spec = ops.get(cmd)
                if spec is None:
                    continue  # "Unknown command" — its arguments stay for the next one
                num_args, variable = spec
                count = 0 if args is None else len(args)
                op_is_path = cmd in (
                    "m",
                    "l",
                    "c",
                    "v",
                    "y",
                    "h",
                    "re",
                    "S",
                    "s",
                    "f",
                    "F",
                    "f*",
                    "B",
                    "B*",
                    "b",
                    "b*",
                    "n",
                )  # noqa: E501
                if not is_path_op:
                    invalid_path_ops = 0
                is_path_op = op_is_path
                if not variable and count != num_args:
                    while count > num_args:
                        non_processed.append(args.pop(0))
                        count -= 1
                    while count < num_args and non_processed:
                        if args is None:
                            args = []
                        args.insert(0, non_processed.pop())
                        count += 1
                    if count < num_args:
                        if is_path_op:
                            invalid_path_ops += 1
                            if invalid_path_ops > 10:
                                raise _Abort("Invalid path op")
                        if args is not None:
                            args.clear()
                        continue
                op_args = args if args is not None else []
                args = None
                if cmd == "q":
                    manager.save()
                elif cmd == "Q":
                    manager.restore()
                elif cmd == "cm":
                    manager.transform(op_args)
                xobjects = self._op(cmd, op_args, resources, manager, xobjects, empty_gstates)

    def _op(self, cmd: str, b: list[Any], resources: dict, manager: StateManager, xobjects, empty_gstates):
        j = self.state = manager.state
        if self.last_font_state is None:
            self.last_font_state = j.clone()
        if cmd == "Tf":
            name = _name(b[0])
            size = b[1]
            if j.font is not None and name == j.font_name and size == j.font_size:
                return xobjects
            j.font_name = name
            j.font_size = size
            fonts = _get(resources, "Font")
            ref = fonts.get(name) if isinstance(fonts, dict) and name is not None else None
            font = self.doc.font(ref if ref is not None else FALLBACK_FONT)
            j.font = font
            j.font_matrix = font.font_matrix or FONT_IDENTITY
        elif cmd == "Ts":
            j.text_rise = b[0]
        elif cmd == "Tz":
            j.text_hscale = _div(b[0], 100)
        elif cmd == "TL":
            j.leading = b[0]
        elif cmd == "Td":
            j.translate_text_line_matrix(b[0], b[1])
            j.text_matrix = j.text_line_matrix[:]
        elif cmd == "TD":
            j.leading = -b[1]
            j.translate_text_line_matrix(b[0], b[1])
            j.text_matrix = j.text_line_matrix[:]
        elif cmd == "T*":
            j.carriage_return()
        elif cmd == "Tm":
            j.text_matrix[:] = b[:6]
            j.text_line_matrix[:] = b[:6]
            self.update_advance_scale()
        elif cmd == "Tc":
            j.char_spacing = b[0]
        elif cmd == "Tw":
            j.word_spacing = b[0]
        elif cmd == "BT":
            j.text_matrix = [1, 0, 0, 1, 0, 0]
            j.text_line_matrix = [1, 0, 0, 1, 0, 0]
        elif cmd == "TJ":
            if j.font is None:
                return xobjects
            factor = (1 if j.font.vertical else -1) * j.font_size / 1e3
            if isinstance(b[0], bytes):
                items: list[Any] = [b[0]]  # `for (const e of "…")` walks the string's characters
            elif isinstance(b[0], list):
                items = b[0]
            else:
                raise _Abort("TJ operand is not iterable")
            for e in items:
                if isinstance(e, bytes):
                    self.spaced.append(e)
                elif _is_num(e) and e != 0:
                    chars = b"".join(self.spaced)
                    self.spaced.clear()
                    self.build_text(chars, e * factor)
            if self.spaced:
                chars = b"".join(self.spaced)
                self.spaced.clear()
                self.build_text(chars, 0)
        elif cmd == "Tj":
            if j.font is None:
                return xobjects
            self.build_text(b[0] if isinstance(b[0], bytes) else b"", 0)
        elif cmd == "'":
            if j.font is None:
                return xobjects
            j.carriage_return()
            self.build_text(b[0] if isinstance(b[0], bytes) else b"", 0)
        elif cmd == '"':
            if j.font is None:
                return xobjects
            j.word_spacing = b[0]
            j.char_spacing = b[1]
            j.carriage_return()
            self.build_text(b[2] if isinstance(b[2], bytes) else b"", 0)
        elif cmd == "Do":
            self.flush()
            if xobjects is None:
                xobjects = _get(resources, "XObject") or {}
            self._paint_xobject(b[0], xobjects, resources, manager)
        elif cmd == "gs":
            name = _name(b[0])
            if name is not None and name in empty_gstates:
                return xobjects
            try:
                if name is None:
                    raise ValueError("GState must be referred to by name.")
                states = _get(resources, "ExtGState")
                if not isinstance(states, dict):
                    raise ValueError("ExtGState should be a dictionary.")
                gstate = _get(states, name)
                if not isinstance(gstate, dict):
                    raise ValueError("GState should be a dictionary.")
                font_entry = _get(gstate, "Font")
                if font_entry:
                    self.flush()
                    j.font_name = None
                    j.font_size = _resolve(font_entry[1])
                    font = self.doc.font(font_entry[0])
                    j.font = font
                    j.font_matrix = font.font_matrix or FONT_IDENTITY
                else:
                    empty_gstates.add(name)
            except Exception:  # noqa: BLE001 - "getTextContent - ignoring ExtGState"
                pass
        elif cmd in ("BMC", "BDC", "EMC"):
            self.flush()
        return xobjects

    def _paint_xobject(self, ref: Any, xobjects: Any, resources: dict, manager: StateManager) -> None:
        name = _name(ref)
        try:
            if name is None:
                raise ValueError("XObject must be referred to by name.")
            raw = xobjects.get(name) if isinstance(xobjects, dict) else None
            key = raw.objid if isinstance(raw, PDFObjRef) else None
            xobj = _resolve(raw)
            if not isinstance(xobj, PDFStream):
                raise ValueError("XObject should be a stream")
            sub = _get(xobj.attrs, "Subtype")
            if not isinstance(sub, PSLiteral):
                raise ValueError("XObject should have a Name subtype")
            if sub.name != "Form":
                return
            if key is not None and key in self.prev_refs:
                raise ValueError("getTextContent - ignoring circular reference")
            inner_manager = StateManager(manager.state.clone())
            matrix = _get(xobj.attrs, "Matrix")
            if isinstance(matrix, list) and len(matrix) == 6 and all(_is_num(_resolve(v)) for v in matrix):
                inner_manager.transform([_resolve(v) for v in matrix])
            inner_resources = _get(xobj.attrs, "Resources")
            refs = self.prev_refs | ({key} if key is not None else set())
            inner = _TextContent(self.doc, self.view, self.out, frozenset(refs))
            inner.process(
                xobj.get_data(), inner_resources if isinstance(inner_resources, dict) else resources, inner_manager
            )  # noqa: E501
        except Exception:  # noqa: BLE001 - "getTextContent - ignoring XObject"
            pass


def normalize_unicode(text: str) -> str:
    """pdf.js normalizeUnicode: NFKC for a fixed set of compatibility characters (ligatures, odd spaces)."""

    def repl(m: regex.Match) -> str:
        if m.group(1):
            return unicodedata.normalize("NFKC", m.group(1))
        # NormalizationMap.get(run) knows only a single U+FB05; a longer run comes back undefined.
        return "ſt" if m.group(2) == "ﬅ" else "undefined"

    return _NORMALIZE.sub(repl, text)


def _font_attr(font: Font | None, attr: str) -> Any:
    if font is None:
        raise _Abort("Cannot read properties of null")
    return getattr(font, attr, None)


def _inverse_rotation(x: float, y: float, m: list[float]) -> tuple[float, float]:
    scale = _hypot(m[0], m[1])
    return _div(m[0] * x + m[1] * y, scale), _div(m[2] * x + m[3] * y, scale)


# ── pages and documents ─────────────────────────────────────────────


def _page_view(page: PDFPage) -> list[float]:
    def box(key: str) -> list[float] | None:
        rect = _normal_rect(page.attrs.get(key), None)
        if rect and rect[2] - rect[0] > 0 and rect[3] - rect[1] > 0:
            return rect
        return None

    media = box("MediaBox") or LETTER
    crop = box("CropBox") or media
    if crop is not media and crop != media:
        inter = _intersect(crop, media)
        if inter and inter[2] - inter[0] > 0 and inter[3] - inter[1] > 0:
            return inter
    return media


def _page_content(page: PDFPage) -> bytes:
    parts = []
    for stream in page.contents or []:
        stream = _resolve(stream)
        if isinstance(stream, PDFStream):
            try:
                parts.append(stream.get_data())
            except Exception:  # noqa: BLE001 - "getContentStream - ignoring sub-stream"
                continue
    return b"".join(parts)


def page_items(doc: _Document, page: PDFPage) -> list[tuple[str, bool]]:
    out: list[tuple[str, bool]] = []
    content = _TextContent(doc, _page_view(page), out, frozenset())
    resources = page.resources if isinstance(page.resources, dict) else {}
    content.process(_page_content(page), resources, StateManager(TextState()))
    return out


def extract_pdf_text(data: bytes) -> str:
    """unpdf `extractText(pdf, {mergePages: true}).text`."""
    try:
        parser = PDFParser(BytesIO(data))
        document = PDFDocument(parser)
        pages = list(PDFPage.create_pages(document))
    except (PDFPasswordIncorrect, PDFEncryptionError) as exc:
        raise PdfError("No password given") from exc
    except Exception as exc:  # noqa: BLE001
        raise PdfError("Invalid PDF structure.") from exc
    doc = _Document()
    texts = []
    for page in pages:
        items = page_items(doc, page)
        texts.append("".join(text + ("\n" if eol else "") for text, eol in items))
    merged = "\n".join(texts)
    merged = _SPACE_RUN.sub(" ", merged)
    merged = _SPACE_NL.sub("\n", merged)
    return _NL3.sub("\n\n", merged)
