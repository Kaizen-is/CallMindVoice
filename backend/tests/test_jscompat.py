"""The JavaScript-compatibility helpers behave exactly like JavaScript."""

import json
import math
import struct
from pathlib import Path

from app.jscompat import f32, js_log, js_round, utf16_len, utf16_slice, utf16_units

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
