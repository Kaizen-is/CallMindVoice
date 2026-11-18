"""The JavaScript-compatibility helpers behave exactly like JavaScript."""

import json
import math
import struct
from pathlib import Path

import pytest

from app.jscompat import (
    f32,
    js_json_parse,
    js_log,
    js_number,
    js_round,
    js_trim,
    js_utf8,
    utf16_len,
    utf16_slice,
    utf16_units,
)

LOG_CASES = json.loads((Path(__file__).parent / "fixtures" / "golden_mathlog.json").read_text())


def _from_hex(h: str) -> float:
    return struct.unpack("<d", bytes.fromhex(h))[0]


def _to_hex(x: float) -> str:
    return struct.pack("<d", x).hex()


def test_js_log_matches_node_math_log_bit_for_bit():
    mismatches = [(x, want) for x, want in LOG_CASES if _to_hex(js_log(_from_hex(x))) != want]
    assert not mismatches, f"{len(mismatches)} of {len(LOG_CASES)} differ, e.g. {mismatches[:3]}"


def test_js_log_edges():
    assert js_log(0.0) == -math.inf
    assert math.isnan(js_log(-1.0))
    assert js_log(math.inf) == math.inf
    assert js_log(1.0) == 0.0


def test_js_round_rounds_halves_up():
    assert [js_round(x) for x in (0.5, 1.5, 2.5, -0.5, -1.5, 2.4999)] == [1, 2, 3, 0, -1, 2]


def test_utf16_helpers():
    assert utf16_len("kredit 💳") == 9  # the emoji is two UTF-16 units
    assert utf16_slice("ab💳cd", 0, 3) == "ab\ud83d"  # a cut through the emoji leaves half of it
    assert utf16_units("я") == [0x044F]


def test_f32_rounds_like_float32array():
    assert f32(0.1) == 0.10000000149011612


# `Number(s)` in Node, for each input (NaN, -0 and infinities spelled out).
NUMBER_CASES = [
    ("", 0), ("  ", 0), (" 42 ", 42), ("-0", "-0"), ("+1.5", 1.5), (".5", 0.5), ("5.", 5), ("1e3", 1000),
    ("1E-2", 0.01), ("0x1F", 31), ("0X1f", 31), ("0o17", 15), ("0b101", 5), ("-0x10", "NaN"),
    ("Infinity", "inf"), ("-Infinity", "-inf"), ("+Infinity", "inf"), ("inf", "NaN"), ("nan", "NaN"),
    ("NaN", "NaN"), ("1_000", "NaN"), ("1,5", "NaN"), ("12px", "NaN"), ("  7 ﻿", 7), ("  8", 8),
    ("0x", "NaN"), ("1e", "NaN"), ("--1", "NaN"), ("0x" + "F" * 244, 6.386688990511104e293), ("1e400", "inf"),
    ("١", "NaN"),
]  # fmt: skip


@pytest.mark.parametrize(("text", "want"), NUMBER_CASES)
def test_js_number_matches_node(text, want):
    got = js_number(text)
    if want == "NaN":
        assert math.isnan(got)
    elif want == "-0":
        assert got == 0 and math.copysign(1, got) < 0
    elif want in ("inf", "-inf"):
        assert got == float(want)
    else:
        assert got == want


def test_js_trim_keeps_hyphens_and_strips_every_js_space():
    # String.prototype.trim in Node.
    assert js_trim("-5 so‘m-") == "-5 so‘m-"
    assert js_trim(" x ") == "x"
    assert js_trim("​x​") == "​x​"
    assert js_trim("\x1cx\x1c") == "\x1cx\x1c"
    assert js_trim("﻿x　") == "x"


def test_js_json_parse_refuses_what_json_parse_refuses():
    assert js_json_parse(b'\xef\xbb\xbf{"a":1}') == {"a": 1}
    assert js_json_parse(b'{"a":"\xff"}') == {"a": "�"}
    for bad in (b"", b"NaN", b'{"a":Infinity}', b"[-Infinity]", b"{'a':1}"):
        with pytest.raises(ValueError):
            js_json_parse(bad)


def test_js_utf8_replaces_lone_surrogates():
    assert js_utf8("a\ud83d") == b"a\xef\xbf\xbd"
    assert js_utf8("😀") == "😀".encode()
