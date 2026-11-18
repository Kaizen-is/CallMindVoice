"""
The phone line served by Python (`app/routers/telephony.py`): what
src/app/api/telephony/bridge/{turn,filler,end}/route.ts answer — the shared-secret gate, the
number → agent lookup, the greeting / re-prompt / streamed reply legs with their x-ovoz-* headers,
barge-in truncation, fillers and closing the call. STT, TTS and the turn engine are scripted here
(they are parity-tested elsewhere); `tests/test_bridge_parity.py`-style byte comparisons against the
TypeScript ran end to end before the TypeScript routes were removed.
"""

import base64
import math
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.routers import telephony
from app.speech.fillers import filler_lines
from app.speech.stt import SttError
from app.speech.tts import TtsError
from tests.test_system import _seed_user

SECRET = "bridge-test-secret"
TENANT = "ten_test000000000001"
NUMBER = "+998787100001"
AGENT = "agt_test000000000001"
NOW = "2026-11-12T00:00:00.000Z"
PCM_TYPE = "audio/L16; rate=8000; channels=1"


def _seed_line(sql, *, agent_status: str = "live", greeting: str = "Assalomu alaykum, bank.") -> None:  # noqa: ANN001
    sql(
        "INSERT INTO agents (id, tenant_id, name, status, greeting, primary_lang, voice_id, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        AGENT,
        TENANT,
        "Isomiddin",
        agent_status,
        greeting,
        "uz",
        "isomiddin",
        NOW,
        NOW,
    )
    sql(
        "INSERT INTO phone_numbers (id, tenant_id, e164, agent_id, status, created_at) VALUES (?,?,?,?,?,?)",
        "num_test000000000001",
        TENANT,
        NUMBER,
        AGENT,
        "active",
        NOW,
    )


@pytest.fixture
def line(data_dir, sql, monkeypatch) -> Iterator[TestClient]:  # noqa: ANN001
    from app.main import create_app

    monkeypatch.setenv("BRIDGE_SHARED_SECRET", SECRET)
    _seed_user(sql)
    _seed_line(sql)
    with TestClient(create_app(), headers={"x-bridge-secret": SECRET}) as client:
        yield client


@pytest.fixture
def speech(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Scripted STT, TTS and turn engine; records what each was asked."""
    seen: dict = {"pcm": [], "stream": [], "stt": [], "turns": []}
    state = {"heard": {"text": "kredit qachon", "engine": "kotib", "language": "uz"}}
    state["result"] = {"reply": "Ertaga. Yana savol bormi?", "language": "uz", "escalate": None}

    async def synthesize_pcm(text, opts):  # noqa: ANN001
        seen["pcm"].append((text, opts))
        return f"PCM[{text}]".encode()

    async def synthesize_stream(text, opts):  # noqa: ANN001
        seen["stream"].append((text, opts))
        yield b"part1-"
        yield b"part2"

    async def transcribe(audio, *, language=None, clean=False, engine=None):  # noqa: ANN001
        seen["stt"].append((audio, language))
        return state["heard"]

    async def run_turn(**kw):  # noqa: ANN003
        seen["turns"].append(kw)
        return state["result"]

    monkeypatch.setattr(telephony, "synthesize_pcm", synthesize_pcm)
    monkeypatch.setattr(telephony, "synthesize_stream", synthesize_stream)
    monkeypatch.setattr(telephony, "transcribe", transcribe)
    monkeypatch.setattr(telephony, "run_turn", run_turn)
    seen["state"] = state
    return seen


def _text(res) -> str:  # noqa: ANN001
    return base64.b64decode(res.headers["x-ovoz-text"]).decode()


def _first_leg(line: TestClient) -> str:
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "from": "+998901112233", "first": "true"})
    assert res.status_code == 200, res.text
    return res.headers["x-ovoz-callid"]


# ── the gate ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("method", "path"),
    [("post", "/telephony/bridge/turn"), ("get", "/telephony/bridge/filler"), ("post", "/telephony/bridge/end")],
)
def test_gate(data_dir, monkeypatch, method, path) -> None:  # noqa: ANN001
    from app.main import create_app

    client = TestClient(create_app())
    monkeypatch.delenv("BRIDGE_SHARED_SECRET", raising=False)
    res = getattr(client, method)(path)
    assert (res.status_code, res.json()) == (503, {"error": "bridge_not_configured"})
    monkeypatch.setenv("BRIDGE_SHARED_SECRET", SECRET)
    for wrong in (None, "nope", SECRET + "x", SECRET[:-1]):
        headers = {"x-bridge-secret": wrong} if wrong is not None else {}
        res = getattr(client, method)(path, headers=headers)
        assert (res.status_code, res.json()) == (401, {"error": "unauthorized"})


# ── turn: refusals ──────────────────────────────────────────────────


def test_turn_needs_a_form(line) -> None:  # noqa: ANN001
    res = line.post("/telephony/bridge/turn", json={"to": NUMBER})
    assert (res.status_code, res.json()) == (400, {"error": "expected_multipart_form"})


def test_turn_unknown_number(line) -> None:  # noqa: ANN001
    res = line.post("/telephony/bridge/turn", data={"to": "+1555", "first": "true"})
    assert (res.status_code, res.json()) == (404, {"error": "number_not_configured", "to": "+1555"})


def test_turn_agent_not_live(line, sql) -> None:  # noqa: ANN001
    sql("UPDATE agents SET status = 'draft' WHERE id = ?", AGENT)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "first": "true"})
    assert (res.status_code, res.json()) == (409, {"error": "agent_unavailable"})


def test_turn_number_without_agent_uses_the_live_agent(line, sql, speech) -> None:  # noqa: ANN001
    sql("UPDATE phone_numbers SET agent_id = NULL")
    assert _first_leg(line)


# ── turn: first leg ─────────────────────────────────────────────────


def test_first_leg_opens_the_call_and_greets(line, sql, speech) -> None:  # noqa: ANN001
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "from": "+998901112233", "first": "true"})
    assert res.status_code == 200
    assert res.headers["content-type"] == PCM_TYPE
    assert res.headers["cache-control"] == "no-store"
    assert res.content == b"PCM[Assalomu alaykum, bank.]"
    assert _text(res) == "Assalomu alaykum, bank."
    assert (res.headers["x-ovoz-escalate"], res.headers["x-ovoz-engine"]) == ("", "none")
    call_id = res.headers["x-ovoz-callid"]
    (row,) = sql("SELECT tenant_id, agent_id, number_id, channel, from_e164, to_e164, language FROM calls")
    assert row == (TENANT, AGENT, "num_test000000000001", "voice", "+998901112233", NUMBER, "uz")
    assert call_id.startswith("call_")
    ((text, opts),) = speech["pcm"]
    assert (opts.tenant_id, opts.voice_id, opts.language, opts.tag, opts.cache) == (
        TENANT,
        "isomiddin",
        "uz",
        "greeting",
        True,
    )
    assert speech["stt"] == []


def test_first_leg_without_first_flag_when_no_call_id(line, speech) -> None:  # noqa: ANN001
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER})
    assert res.headers["x-ovoz-callid"].startswith("call_")


@pytest.mark.parametrize("greeting", ["", "   "])
def test_greeting_falls_back_per_language(line, sql, speech, greeting) -> None:  # noqa: ANN001
    sql("UPDATE agents SET greeting = ?", greeting)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "first": "true"})
    assert _text(res) == telephony.GREETING_FALLBACK["uz"]


def test_greeting_is_trimmed_and_utf8_survives_the_header(line, sql, speech) -> None:  # noqa: ANN001
    sql("UPDATE agents SET greeting = ?", "  Здравствуйте — o‘zbekcha!  ")
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "first": "true"})
    assert _text(res) == "Здравствуйте — o‘zbekcha!"


# ── turn: later legs ────────────────────────────────────────────────


def test_later_leg_needs_audio(line, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "callId": call_id})
    assert (res.status_code, res.json()) == (400, {"error": "missing_audio"})


def test_reply_is_streamed_with_its_headers(line, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    speech["state"]["result"] = {"reply": "Operatorga ulayman.", "language": "uz", "escalate": "caller_requested"}
    res = line.post(
        "/telephony/bridge/turn",
        data={"to": NUMBER, "callId": call_id},
        files={"audio": ("utterance.wav", b"RIFFfake", "audio/wav")},
    )
    assert res.status_code == 200
    assert res.content == b"part1-part2"
    assert res.headers["content-type"] == PCM_TYPE
    assert res.headers["x-ovoz-callid"] == call_id
    assert res.headers["x-ovoz-escalate"] == "caller_requested"
    assert res.headers["x-ovoz-engine"] == "kotib"
    assert _text(res) == "Operatorga ulayman."
    assert speech["stt"] == [(b"RIFFfake", "uz")]
    (turn,) = speech["turns"]
    assert (turn["tenant_id"], turn["call_id"], turn["utterance"]) == (TENANT, call_id, "kredit qachon")
    assert turn["agent"]["id"] == AGENT and turn["stt_ms"] >= 0
    ((text, opts),) = speech["stream"]
    assert (text, opts.tag, opts.cache, opts.language, opts.voice_id) == (
        "Operatorga ulayman.",
        "reply",
        False,
        "uz",
        "isomiddin",
    )


def test_no_escalation_is_an_empty_header(line, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "callId": call_id}, files={"audio": ("u.wav", b"x")})
    assert res.headers["x-ovoz-escalate"] == ""


def test_nothing_heard_reprompts(line, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    speech["state"]["heard"] = {"text": "", "engine": "gapi", "language": None}
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "callId": call_id}, files={"audio": ("u.wav", b"x")})
    assert _text(res) == telephony.REPROMPT["uz"]
    assert (res.headers["x-ovoz-engine"], res.headers["x-ovoz-callid"]) == ("gapi", call_id)
    assert res.content == f"PCM[{telephony.REPROMPT['uz']}]".encode()
    assert speech["pcm"][-1][1].tag == "reprompt" and speech["pcm"][-1][1].cache is True
    assert speech["turns"] == []


def test_stream_failure_keeps_what_was_spoken(line, speech, monkeypatch) -> None:  # noqa: ANN001
    call_id = _first_leg(line)

    async def broken(text, opts):  # noqa: ANN001
        yield b"spoken"
        raise TtsError("tts_stream_failed")

    monkeypatch.setattr(telephony, "synthesize_stream", broken)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "callId": call_id}, files={"audio": ("u.wav", b"x")})
    assert (res.status_code, res.content) == (200, b"spoken")


@pytest.mark.parametrize(
    ("error", "status", "body"),
    [
        (TtsError("tts_not_configured", 503), 503, "tts_not_configured"),
        (SttError("stt_not_configured", 503), 503, "stt_not_configured"),
        (RuntimeError("boom"), 502, "boom"),
    ],
)
def test_turn_errors(line, speech, monkeypatch, error, status, body) -> None:  # noqa: ANN001
    async def fail(*a, **kw):  # noqa: ANN002, ANN003
        raise error

    monkeypatch.setattr(telephony, "synthesize_pcm", fail)
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "first": "true"})
    assert (res.status_code, res.json()) == (status, {"error": body})


# ── barge-in ────────────────────────────────────────────────────────


def _agent_said(sql, call_id: str, text: str) -> None:  # noqa: ANN001
    sql(
        "INSERT INTO turns (id, tenant_id, call_id, ordinal, role, text, created_at) VALUES (?,?,?,?,?,?,?)",
        "trn_test000000000099",
        TENANT,
        call_id,
        99,
        "agent",
        text,
        NOW,
    )


@pytest.mark.parametrize(
    ("ratio", "expected"),
    [
        ("0.5", "bir ikki…"),
        ("0.2", "bir…"),
        ("0.01", "bir…"),  # at least one word
        ("0.999", "bir ikki uch to'rt…"),
        ("1", "bir ikki uch to'rt besh"),  # heard it all
        ("0", "bir ikki uch to'rt besh"),
        ("abc", "bir ikki uch to'rt besh"),  # NaN
        ("", "bir ikki uch to'rt besh"),
    ],
)
def test_barge_in_truncates_the_last_agent_turn(line, sql, speech, ratio, expected) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    _agent_said(sql, call_id, "bir  ikki\tuch to'rt besh")
    line.post(
        "/telephony/bridge/turn",
        data={"to": NUMBER, "callId": call_id, "spokenRatio": ratio},
        files={"audio": ("u.wav", b"x")},
    )
    (text,) = sql("SELECT text FROM turns WHERE id = 'trn_test000000000099'")[0]
    if expected == "bir ikki uch to'rt besh":
        assert text == "bir  ikki\tuch to'rt besh"  # untouched
    else:
        assert text == expected


def test_barge_in_happens_even_without_audio(line, sql, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    _agent_said(sql, call_id, "bir ikki uch to'rt")
    res = line.post("/telephony/bridge/turn", data={"to": NUMBER, "callId": call_id, "spokenRatio": "0.5"})
    assert res.status_code == 400
    assert sql("SELECT text FROM turns WHERE id = 'trn_test000000000099'")[0][0] == "bir ikki…"


# ── filler ──────────────────────────────────────────────────────────


def test_filler(line, speech) -> None:  # noqa: ANN001
    lines = filler_lines("uz")
    res = line.get("/telephony/bridge/filler", params={"to": NUMBER, "i": "1"})
    assert res.status_code == 200
    assert res.headers["content-type"] == PCM_TYPE
    assert res.headers["x-ovoz-count"] == str(len(lines))
    assert res.content == f"PCM[{lines[1]}]".encode()
    opts = speech["pcm"][-1][1]
    assert (opts.tag, opts.cache, opts.voice_id, opts.language) == ("filler", True, "isomiddin", "uz")


@pytest.mark.parametrize(("i", "position"), [(None, 0), ("", 0), ("abc", 0), ("Infinity", 0), ("4", 4), ("0x2", 2)])
def test_filler_index_rotates(line, speech, i, position) -> None:  # noqa: ANN001
    lines = filler_lines("uz")
    params = {"to": NUMBER} if i is None else {"to": NUMBER, "i": i}
    res = line.get("/telephony/bridge/filler", params=params)
    assert res.content == f"PCM[{lines[position % len(lines)]}]".encode()


@pytest.mark.parametrize("i", ["-1", "1.5"])
def test_filler_index_javascript_would_not_find(line, speech, i) -> None:  # noqa: ANN001
    res = line.get("/telephony/bridge/filler", params={"to": NUMBER, "i": i})
    assert (res.status_code, res.json()) == (502, {"error": "filler_failed"})


def test_filler_unknown_number_and_tts_error(line, speech, monkeypatch) -> None:  # noqa: ANN001
    res = line.get("/telephony/bridge/filler", params={"to": "+1"})
    assert (res.status_code, res.json()) == (404, {"error": "number_not_configured", "to": "+1"})

    async def fail(*a, **kw):  # noqa: ANN002, ANN003
        raise TtsError("tts_not_configured", 503)

    monkeypatch.setattr(telephony, "synthesize_pcm", fail)
    res = line.get("/telephony/bridge/filler", params={"to": NUMBER})
    assert (res.status_code, res.json()) == (503, {"error": "filler_failed"})


# ── end ─────────────────────────────────────────────────────────────


def test_end_checks(line, speech) -> None:  # noqa: ANN001
    res = line.post("/telephony/bridge/end", content=b"{oops", headers={"content-type": "application/json"})
    assert (res.status_code, res.json()) == (400, {"error": "invalid_json"})
    for body in ({}, {"callId": "  "}, {"callId": None}, "text", [1]):
        res = line.post("/telephony/bridge/end", json=body)
        assert (res.status_code, res.json()) == (400, {"error": "missing_callId"})
    # `(body.callId ?? '').trim()` on a number, and `null.callId`, throw in the TypeScript (Next.js: 500).
    for raw in (b'{"callId": 5}', b"null"):
        with pytest.raises(TypeError):
            line.post("/telephony/bridge/end", content=raw, headers={"content-type": "application/json"})
    res = line.post(
        "/telephony/bridge/end", content=b'{"callId": "x", "n": NaN}', headers={"content-type": "application/json"}
    )
    assert (res.status_code, res.json()) == (400, {"error": "invalid_json"})
    res = line.post("/telephony/bridge/end", json={"callId": "call_missing"})
    assert (res.status_code, res.json()) == (404, {"error": "call_not_found"})


def test_end_closes_the_call_once(line, sql, speech) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    sql("UPDATE calls SET started_at = ? WHERE id = ?", "2026-11-12T10:00:00.250Z", call_id)
    res = line.post("/telephony/bridge/end", json={"callId": f" {call_id} ", "durationSec": 42})
    assert res.status_code == 200
    body = res.json()
    assert (body["ok"], body["callId"], body["outcome"]) == (True, call_id, "resolved_by_ai")
    assert list(body)[:3] == ["ok", "callId", "outcome"]
    assert body["durationMs"] == 42000
    assert {"cost", "avg", "p95"} <= set(body)
    (row,) = sql("SELECT status, outcome, ended_at, duration_ms FROM calls WHERE id = ?", call_id)
    assert row == ("completed", "resolved_by_ai", "2026-11-12T10:00:42.250Z", 42000)

    again = line.post("/telephony/bridge/end", json={"callId": call_id})
    assert again.json() == {"ok": True, "alreadyClosed": True, "callId": call_id}


@pytest.mark.parametrize(
    ("duration", "ended"),
    [(1.2345, "2026-11-12T10:00:01.484Z"), (0, "2026-11-12T10:00:01.000Z")],
)
def test_end_fractional_duration_truncates_to_milliseconds(line, sql, speech, duration, ended) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    sql("UPDATE calls SET started_at = ? WHERE id = ?", "2026-11-12T10:00:00.250Z", call_id)
    line.post("/telephony/bridge/end", json={"callId": call_id, "durationSec": duration})
    ended_at, duration_ms = sql("SELECT ended_at, duration_ms FROM calls WHERE id = ?", call_id)[0]
    if duration == 0:
        # 0 s pins the end to the start; end_call still bills the 1 s minimum.
        assert ended_at == "2026-11-12T10:00:00.250Z" and duration_ms == 1000
    else:
        # 250 ms + 1234.5 ms = 1484.5 → 1484 (new Date truncates).
        assert ended_at == ended and math.isclose(duration_ms, 1234, abs_tol=1)


@pytest.mark.parametrize(
    ("outcome", "stored"), [("abandoned", "abandoned"), ("voicemail", "voicemail"), ("weird", "resolved_by_ai")]
)
def test_end_outcome_override(line, sql, speech, outcome, stored) -> None:  # noqa: ANN001
    call_id = _first_leg(line)
    res = line.post("/telephony/bridge/end", json={"callId": call_id, "outcome": outcome, "durationSec": -5})
    assert res.json()["outcome"] == stored
    assert sql("SELECT outcome FROM calls WHERE id = ?", call_id)[0][0] == stored
