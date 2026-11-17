"""
JavaScript-compatibility helpers for values that arrive as JSON (server action arguments) and
for `new URL()`; the expected values were printed by Node 22.
"""

import json
import math
import sqlite3
from pathlib import Path

import pytest

from app.jscompat import UNDEFINED, js_json, js_sql_param, js_string, js_to_number, js_url_protocol, js_well_formed

URL_CASES = json.loads((Path(__file__).parent / "fixtures" / "golden_url.json").read_text(encoding="utf-8"))["cases"]

# [value, String(value), Number(value)] from Node (NaN as "NaN").
STRING_NUMBER = [
    (None, "null", 0), (True, "true", 1), (False, "false", 0), (0, "0", 0), (2.5, "2.5", 2.5), (1e21, "1e+21", 1e21),
    (1e-7, "1e-7", 1e-7), ("", "", 0), ("  12  ", "  12  ", 12), ("1e3", "1e3", 1000), ("0x1F", "0x1F", 31),
    ("0b101", "0b101", 5), ("0o17", "0o17", 15), ("1_000", "1_000", "NaN"), ("Infinity", "Infinity", math.inf),
    ("-Infinity", "-Infinity", -math.inf), ("inf", "inf", "NaN"), ("nan", "nan", "NaN"), ("12px", "12px", "NaN"),
    ([], "", 0), ([5], "5", 5), (["7"], "7", 7), ([1, 2], "1,2", "NaN"), ([None], "", 0), ([[3]], "3", 3),
    ({}, "[object Object]", "NaN"), ({"a": 1}, "[object Object]", "NaN"), (UNDEFINED, "undefined", "NaN"),
]  # fmt: skip


@pytest.mark.parametrize(("value", "as_string", "as_number"), STRING_NUMBER)
def test_string_and_number_of_json_values(value, as_string, as_number) -> None:  # noqa: ANN001
    assert js_string(value) == as_string
    number = js_to_number(value)
    if as_number == "NaN":
        assert math.isnan(number)
    else:
        assert number == as_number


def test_json_stringify_escapes_lone_surrogates() -> None:
    # JSON.stringify(['a\ud83d', '\udc00b', 'ok😀']) in Node
    assert js_json(["a\ud83d", "\udc00b", "ok\U0001f600"]) == '["a\\ud83d","\\udc00b","ok😀"]'
    assert js_json({"\ud83d": 1}) == '{"\\ud83d":1}'


def test_text_stored_by_sqlite_is_well_formed() -> None:
    assert js_well_formed("a\ud83d") == "a�"
    assert js_well_formed("ok\U0001f600") == "ok\U0001f600"


def test_sql_params_bind_like_node_sqlite() -> None:
    """node:sqlite binds every number as REAL: 5 in a TEXT column is stored as '5.0' (checked in Node)."""
    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE t (a TEXT, b INTEGER)")
    con.execute("INSERT INTO t VALUES (?, ?)", (js_sql_param(5), js_sql_param(1000)))
    con.execute("INSERT INTO t VALUES (?, ?)", (js_sql_param("\ud83d"), js_sql_param(1e20)))
    con.execute("INSERT INTO t VALUES (?, ?)", (js_sql_param({"x": [1]}), js_sql_param(True)))
    con.execute("INSERT INTO t VALUES (?, ?)", (js_sql_param(UNDEFINED), js_sql_param(None)))
    rows = con.execute("SELECT a, typeof(a), b, typeof(b) FROM t").fetchall()
    assert rows == [
        ("5.0", "text", 1000, "integer"),
        ("�", "text", 1e20, "real"),
        ('{"x":[1]}', "text", 1, "integer"),
        (None, "null", None, "null"),
    ]


def test_url_protocol_matches_node_new_url() -> None:
    wrong = [(c, want, js_url_protocol(c)) for c, want in URL_CASES if js_url_protocol(c) != want]
    assert not wrong, wrong[:10]
    assert len(URL_CASES) > 2000


@pytest.mark.parametrize(
    ("url", "protocol"),
    [
        ("https://hooks.example.com/in", "https:"),
        ("HTTPS://Hooks.Example.COM", "https:"),
        ("https:hooks.example.com", "https:"),  # special schemes need no slashes
        ("http://hooks.example.com", "http:"),
        ("hooks.example.com/in", None),  # no scheme, no base URL
        ("https://exa mple.com", None),
        ("https://example.com:65536", None),
        ("https://[::1", None),
        ("https://bücher.de", "https:"),
        ("https://xn--a.com", None),  # invalid punycode
    ],
)
def test_url_protocol_examples(url: str, protocol: str | None) -> None:
    assert js_url_protocol(url) == protocol
