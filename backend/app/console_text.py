"""
Small JavaScript string behaviours the console's agent and voice actions rely on, kept out of the
shared `jscompat` module: a `.slice()` whose result is stored, `String(x)` in a template literal,
and Node's `path.extname`.
"""

import math

from app.jscompat import js_number_str


def js_slice_stored(s: str, end: int) -> str:
    """
    `s.slice(0, end)` as the TypeScript stored it: cut in UTF-16 code units, and a surrogate pair cut in
    half becomes U+FFFD (what SQLite receives from Node; Python could not store the lone half at all).
    """
    units = s.encode("utf-16-le", errors="surrogatepass")[: end * 2]
    return units.decode("utf-16-le", errors="replace")


def js_str(value: object) -> str:
    """`String(value)` / `${value}` for a JSON value."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and math.isnan(value):
            return "NaN"
        return js_number_str(value)
    if isinstance(value, list):
        return ",".join("" if v is None else js_str(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def node_extname(path: str) -> str:
    """Node's `path.extname` (POSIX): '.wav' for 'a.wav', '' for '.bashrc', '.' for 'a.'."""
    start_dot = -1
    start_part = 0
    end = -1
    matched_slash = True
    pre_dot_state = 0
    for i in range(len(path) - 1, -1, -1):
        ch = path[i]
        if ch == "/":
            if not matched_slash:
                start_part = i + 1
                break
            continue
        if end == -1:
            matched_slash = False
            end = i + 1
        if ch == ".":
            if start_dot == -1:
                start_dot = i
            elif pre_dot_state != 1:
                pre_dot_state = 1
        elif start_dot != -1:
            pre_dot_state = -1
    if (
        start_dot == -1
        or end == -1
        or pre_dot_state == 0
        or (pre_dot_state == 1 and start_dot == end - 1 and start_dot == start_part + 1)
    ):
        return ""
    return path[start_dot:end]
