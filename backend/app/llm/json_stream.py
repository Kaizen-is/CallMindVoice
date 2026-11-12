"""
Streaming structured answers — port of src/lib/llm/json-stream.ts.

Every model returns the same JSON object ({answer, answered, usedExcerpts}),
and the voice wants the `answer` text while it is still being written. The
extractor follows the growing JSON and hands on the answer as it appears;
escapes split across pieces wait for their next piece.
"""

from collections.abc import Callable

import regex as re

_ANSWER_KEY = re.compile(r'"answer"\s*:\s*"')


def answer_extractor(on_answer: Callable[[str], None]) -> Callable[[str], None]:
    """Returns a function to call with the whole JSON text so far, after each new piece."""
    state = {"at": -1, "closed": False}

    def feed(raw: str) -> None:
        if state["closed"]:
            return
        if state["at"] < 0:
            m = _ANSWER_KEY.search(raw)
            if not m:
                return
            state["at"] = m.end()
        out: list[str] = []
        i = state["at"]
        while i < len(raw):
            c = raw[i]
            if c == '"':
                state["closed"] = True
                break
            if c != "\\":
                out.append(c)
                i += 1
                continue
            if i + 1 >= len(raw):
                break
            e = raw[i + 1]
            if e == "u":
                if i + 6 > len(raw):
                    break
                # `parseInt(hex, 16) || 32`: parses the leading hex digits; none → a space.
                digits = re.match(r"[0-9a-fA-F]*", raw[i + 2 : i + 6]).group(0)
                out.append(chr(int(digits, 16) if digits and int(digits, 16) else 32))
                i += 6
            else:
                out.append("\n" if e == "n" else " " if e == "t" else "" if e == "r" else e)
                i += 2
        state["at"] = i
        if out:
            # 😀-style escapes arrive as two halves; join them like a JavaScript string would.
            text = "".join(out).encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
            on_answer(text)

    return feed
