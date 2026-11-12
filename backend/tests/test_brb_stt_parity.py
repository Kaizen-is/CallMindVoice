"""
BRB Whisper (app/speech/brb_stt.py and its engine in stt.py) against the ORIGINAL TypeScript,
recorded in fixtures/golden_brb_stt.json by tools/golden/make-golden-brb-stt.cjs:

- the protobuf both write (metadata and inference requests, byte for byte) and how both read
  metadata and inference responses;
- whole transcriptions against a fake Triton: the TypeScript ran against an HTTP/2 server in Node,
  Python runs against a grpcio server answering the same bytes — the requests each received must
  be identical, and so must the results, errors and usage rows.
"""

import asyncio
import base64
import json
from pathlib import Path

import grpc
import pytest

from app.speech import brb_stt, stt

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "golden_brb_stt.json").read_text(encoding="utf-8"))
AUDIO = {k: base64.b64decode(v) for k, v in GOLDEN["audio"].items()}
PCM = base64.b64decode(GOLDEN["pcm"])
CODES = {code.value[0]: code for code in grpc.StatusCode}


def _meta(raw: dict) -> brb_stt.ModelMeta:
    tensor = lambda t: brb_stt.Tensor(t["name"], t["datatype"], list(t["shape"]))  # noqa: E731
    return brb_stt.ModelMeta([tensor(t) for t in raw["inputs"]], [tensor(t) for t in raw["outputs"]])


# ── the codec ───────────────────────────────────────────────────────


@pytest.mark.parametrize("case", GOLDEN["codec"]["metadataRequests"], ids=lambda c: c["model"] or "empty")
def test_metadata_request_bytes(case: dict) -> None:
    assert base64.b64encode(brb_stt.encode_metadata_request(case["model"])).decode() == case["bytes"]


@pytest.mark.parametrize("case", GOLDEN["codec"]["metadata"], ids=lambda c: c["decoded"]["inputs"][0]["name"])
def test_metadata_is_read_alike(case: dict) -> None:
    meta = brb_stt.decode_metadata(base64.b64decode(case["bytes"]))
    as_dict = lambda ts: [{"name": t.name, "datatype": t.datatype, "shape": t.shape} for t in ts]  # noqa: E731
    assert {"inputs": as_dict(meta.inputs), "outputs": as_dict(meta.outputs)} == case["decoded"]


@pytest.mark.parametrize("case", GOLDEN["codec"]["infer"], ids=lambda c: f"{c['layout']}-{c['language']}")
def test_infer_request_bytes(case: dict) -> None:
    got = error = None
    try:
        got = base64.b64encode(brb_stt.encode_infer_request("stt", _meta(case["meta"]), PCM, case["language"])).decode()
    except brb_stt.BrbSttError as err:
        error = str(err)
    assert got == case["bytes"]
    assert error == case["error"]


@pytest.mark.parametrize("case", GOLDEN["codec"]["transcripts"], ids=lambda c: c["bytes"][:12])
def test_transcript_is_read_alike(case: dict) -> None:
    text = error = None
    try:
        text = brb_stt.decode_transcript(base64.b64decode(case["bytes"]))
    except brb_stt.BrbSttError as err:
        error = str(err)
    assert text == case["text"]
    assert error == case["error"]


@pytest.mark.parametrize("case", GOLDEN["codec"]["clean"], ids=lambda c: c["in"])
def test_markers_and_spaces_go(case: dict) -> None:
    assert brb_stt.clean_transcript(case["in"]) == case["out"]


# ── whole calls against a fake Triton ───────────────────────────────


class _FakeTriton(grpc.GenericRpcHandler):
    """Answers each call with the next scripted step, recording what it was sent."""

    def __init__(self, script: list[dict]):
        self.script = list(script)
        self.received: list[dict] = []

    def service(self, handler_call_details):  # noqa: ANN001, ANN201
        path = handler_call_details.method

        async def unary(request: bytes, context: grpc.aio.ServicerContext) -> bytes:
            self.received.append({"path": path, "body": base64.b64encode(request).decode()})
            step = self.script.pop(0) if self.script else {"status": 12, "message": "unscripted"}
            if step["status"]:
                await context.abort(CODES[step["status"]], step["message"])
            return base64.b64decode(step["body"])

        return grpc.unary_unary_rpc_method_handler(unary)


def _usage_view(e) -> dict:  # noqa: ANN001
    return {"kind": e.kind, "engine": e.engine, "model": e.model, "audioMs": e.audio_ms, "ok": e.ok, "error": e.error}


def _ts_usage(u: dict) -> dict:
    return {k: u.get(k) for k in ("kind", "engine", "model", "audioMs", "ok", "error")}


@pytest.mark.parametrize("scenario", GOLDEN["calls"], ids=lambda s: s["name"])
def test_call_matches_typescript(scenario: dict, data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZIPFORMER_MODEL_DIR", str(data_dir / "no-model"))
    monkeypatch.setattr(brb_stt, "_meta", None)
    usage: list = []
    monkeypatch.setattr(stt, "record_usage", usage.append)
    fake = _FakeTriton(scenario["server"])
    opts = scenario["opts"]
    outcome: dict = {}

    async def main() -> None:
        server = grpc.aio.server()
        server.add_generic_rpc_handlers((fake,))
        port = server.add_insecure_port("127.0.0.1:0")
        await server.start()
        for key, value in scenario["env"].items():
            monkeypatch.setenv(key, f"http://127.0.0.1:{port}" if value == "FAKE" else value)
        try:
            outcome["result"] = await stt.transcribe(
                AUDIO[scenario["audio"]],
                language=opts.get("language"),
                clean=bool(opts.get("denoise")),
                engine=opts.get("engine"),
            )
        except stt.SttError as err:
            outcome["error"] = {"message": str(err), "status": err.status}
        finally:
            await brb_stt.brb_stt_close()
            await server.stop(None)

    asyncio.run(main())

    assert outcome.get("result") == scenario["result"]
    assert outcome.get("error") == scenario["error"]
    assert fake.received == [{"path": r["path"], "body": r["body"]} for r in scenario["received"]]
    assert all(r["contentType"] == "application/grpc" and r["te"] == "trailers" for r in scenario["received"])
    assert [_usage_view(e) for e in usage] == [_ts_usage(u) for u in scenario["usage"]]
    assert len(fake.script) == scenario["leftover"]
