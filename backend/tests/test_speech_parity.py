"""
The Python speech layer against the ORIGINAL TypeScript, recorded in fixtures/golden_speech.json
by scratchpad/golden/make-golden-speech.cjs: TTS disk-cache keys (shared with the TypeScript app,
so they must match to the byte), TTS requests and audio pieces, STT requests and engine choice,
usage rows, and how the Playground cuts a reply being written into pieces to voice.
"""

import asyncio
import base64
import hashlib
import json
from pathlib import Path

import pytest

from app import http
from app.jscompat import js_number_str, js_trim_start
from app.playground_voice import next_segment
from app.speech import stt, tts
from app.voices import ResolvedVoice
from tests.fakes import ScriptedTransport, same_request

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_speech.json").read_text(encoding="utf-8"))
AUDIO = {k: base64.b64decode(v) for k, v in GOLDEN["audio"].items()}


def _env(monkeypatch: pytest.MonkeyPatch, env: dict) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)


def _usage_view(e) -> dict:
    return {
        "kind": e.kind,
        "engine": e.engine,
        "model": e.model,
        "audioMs": e.audio_ms,
        "chars": e.chars,
        "ok": e.ok,
        "error": e.error,
        "tenantId": e.tenant_id,
        "firstMs": None if e.first_ms is None else "set",
    }


def _ts_usage(u: dict) -> dict:
    keys = ("kind", "engine", "model", "audioMs", "chars", "ok", "error", "tenantId", "firstMs")
    return {k: u.get(k) for k in keys}


# ── the disk cache ──────────────────────────────────────────────────


@pytest.mark.parametrize("case", GOLDEN["mtimes"], ids=lambda c: c["mtimeMs"])
def test_mtime_stamp_matches_node(case: dict) -> None:
    sec, nsec = divmod(int(case["ns"]), 1_000_000_000)
    assert js_number_str(sec * 1e3 + nsec / 1e6) == case["mtimeMs"]


def _voice(raw: dict) -> ResolvedVoice:
    return ResolvedVoice(
        raw["kind"],
        speaker=raw.get("speaker", ""),
        design=raw.get("design", ""),
        ref_audio_path=raw.get("refAudioPath", ""),
        ref_text=raw.get("refText", ""),
        file_name=raw.get("fileName", ""),
    )


def test_cache_keys_match_typescript(monkeypatch: pytest.MonkeyPatch) -> None:
    sec, nsec = divmod(int(GOLDEN["cloneMtimeNs"]), 1_000_000_000)

    def fake_mtime(path: str) -> float:
        if path.endswith("m0.wav"):
            return sec * 1e3 + nsec / 1e6
        raise FileNotFoundError(path)

    monkeypatch.setattr(tts, "mtime_ms", fake_mtime)
    for case in GOLDEN["cacheKeys"]:
        monkeypatch.delenv("SPEKO_TTS_VOICE", raising=False)
        _env(monkeypatch, case["env"])
        key = tts.cache_key(case["text"], _voice(case["voice"]), case["engine"], case["voiceId"], case["rate"])
        assert key == case["key"], case


# ── TTS renders ─────────────────────────────────────────────────────


def _synth_options(raw: dict) -> tts.SynthOptions:
    return tts.SynthOptions(
        tenant_id=raw["tenantId"],
        voice_id=raw.get("voiceId"),
        language=raw.get("language"),
        cache=raw.get("cache", False),
        engine=raw.get("engine", "default"),
        sample_rate=raw.get("sampleRate"),
        quick_start=raw.get("quickStart", False),
    )


@pytest.mark.parametrize("scenario", GOLDEN["tts"], ids=lambda s: s["name"])
def test_tts_render_matches_typescript(scenario: dict, data_dir: Path, sql, monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, scenario["env"])
    sql("INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('t1','T','t','x','x')")
    for row in scenario.get("db", {}).get("custom", []):
        sql(
            "INSERT INTO custom_voices (id, tenant_id, name, mode, voice_design, ref_audio_path, ref_text, created_at)"
            " VALUES (?,?,?,?,?,?,?,'x')",
            row["id"], row["tenant_id"], "v", row["mode"], row["voice_design"], row["ref_audio_path"], row["ref_text"],
        )  # fmt: skip
    for rel, content in scenario.get("files", {}).items():
        target = data_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    transport = ScriptedTransport(scenario["fetch"])
    http.set_transport(transport)
    usage: list = []
    monkeypatch.setattr(tts, "record_usage", usage.append)
    opts = _synth_options(scenario["opts"])

    async def run() -> list[bytes]:
        if scenario["call"] == "stream":
            return [p async for p in tts.synthesize_stream(scenario["text"], opts)]
        return [await tts.synthesize_pcm(scenario["text"], opts)]

    pieces: list[bytes] = []
    error = None
    try:
        pieces = asyncio.run(run())
    except tts.TtsError as err:
        error = {"message": str(err), "status": err.status}
    except Exception as err:  # noqa: BLE001 - "no scripted response" surfaces as a transport error
        error = {"message": "no scripted response"} if "no scripted" in str(err) else {"message": str(err)}

    assert error == scenario["error"]
    assert [{"size": len(p), "sha1": hashlib.sha1(p).hexdigest()} for p in pieces] == scenario["pieces"]
    assert len(transport.requests) == len(scenario["requests"])
    for ts_req, py_req in zip(scenario["requests"], transport.requests, strict=True):
        same_request(ts_req, py_req)
    cached = sorted(p.name for p in (data_dir / "tts-cache").glob("*")) if (data_dir / "tts-cache").exists() else []
    if scenario["opts"].get("voiceId") == "cv_1":
        assert len(cached) == len(scenario["cached"])  # clone keys hold the sample's absolute path
    else:
        assert cached == scenario["cached"]
    assert [_usage_view(e) for e in usage] == [_ts_usage(u) for u in scenario["usage"]]
    assert len(transport.script) == scenario["leftover"]


# ── STT ─────────────────────────────────────────────────────────────


def _digest_gemini(requests: list[dict]) -> None:
    for r in requests:
        if r["body"] and "inlineData" in r["body"].get("text", ""):
            body = json.loads(r["body"]["text"])
            part = body["contents"][0]["parts"][0]["inlineData"]
            part["data"] = "sha1:" + hashlib.sha1(part["data"].encode()).hexdigest()
            r["body"] = {"geminiJson": body}


@pytest.mark.parametrize("scenario", GOLDEN["stt"], ids=lambda s: s["name"])
def test_stt_matches_typescript(scenario: dict, data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _env(monkeypatch, scenario["env"])
    monkeypatch.setenv("ZIPFORMER_MODEL_DIR", str(data_dir / "no-model"))
    transport = ScriptedTransport(scenario["fetch"])
    http.set_transport(transport)
    usage: list = []
    monkeypatch.setattr(stt, "record_usage", usage.append)
    opts = scenario["opts"]

    result = error = None
    try:
        result = asyncio.run(
            stt.transcribe(
                AUDIO[scenario["audio"]],
                language=opts.get("language"),
                clean=bool(opts.get("denoise")),
                engine=opts.get("engine"),
            )
        )
    except stt.SttError as err:
        error = {"message": str(err), "status": err.status}

    assert result == scenario["result"]
    assert error == scenario["error"]
    _digest_gemini(transport.requests)
    assert len(transport.requests) == len(scenario["requests"])
    for ts_req, py_req in zip(scenario["requests"], transport.requests, strict=True):
        if "geminiJson" in (ts_req["body"] or {}):
            assert py_req["url"] == ts_req["url"]
            assert py_req["body"] == ts_req["body"]
        else:
            same_request(ts_req, py_req)
    assert [_usage_view(e) for e in usage] == [_ts_usage(u) for u in scenario["usage"]]
    assert len(transport.script) == scenario["leftover"]


# ── voicing a reply while it is written ─────────────────────────────


def _merge_pairs(s: str) -> str:
    return s.encode("utf-16-le", "surrogatepass").decode("utf-16-le")


@pytest.mark.parametrize("case", GOLDEN["segments"], ids=lambda c: f"{c['reply'][:12]}-{c['fast']}-{c['step']}")
def test_next_segment_matches_typescript(case: dict) -> None:
    from app.jscompat import utf16_len, utf16_slice

    reply, fast, step = case["reply"], case["fast"], case["step"]
    text, taken, segments, got = "", 0, 0, []

    def drain(finished: bool) -> None:
        nonlocal taken, segments
        while True:
            seg, taken = next_segment(text, taken, finished, fast, segments)
            if not seg:
                return
            got.append(_merge_pairs(seg))
            segments += 1

    for i in range(0, utf16_len(reply), step):
        piece = utf16_slice(reply, i, i + step)  # the TypeScript loop steps in UTF-16 units
        text = text + piece if taken else js_trim_start(text + piece)
        drain(False)
    drain(True)
    assert got == case["segments"]
