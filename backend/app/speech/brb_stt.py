"""
BRB Whisper — port of src/lib/speech/brb-stt.ts. Our own speech-to-text model: Whisper served by
Triton at BRB_STT_URL (https://stt-service.brb.uz, port 443, through the BRB VPN), model
BRB_STT_MODEL (default `stt`).

Triton speaks the KServe v2 inference protocol over gRPC (HTTP/2 + TLS, no login). Two calls, made
with grpcio as raw bytes and a minimal protobuf codec for just their messages (byte for byte what
the TypeScript sends):

    ModelMetadata {name}                → the model's input and output tensors
    ModelInfer {name, inputs, raw data} → the transcript

Which tensors the model takes is not documented, so it is read from ModelMetadata (once per
process; read again after a failed call) and each input is filled by its type:

    FP32 [-1] or [1,-1]   the utterance as 16 kHz mono samples in [-1, 1)
    INT32 / INT64         its length in samples
    BYTES named language  the language code ("uz")
    BYTES named like a prompt (prefix, prompt, task, text)
                          Whisper's task prefix, <|startoftranscript|><|uz|><|transcribe|><|notimestamps|>
    BYTES / UINT8 otherwise
                          the utterance as a 16 kHz mono 16-bit WAV file

Anything else is refused as `brb_stt_input_<name>_<type>`. The first BYTES output is the text, with
Whisper's <|…|> markers removed. `http://` in BRB_STT_URL talks gRPC without TLS (local test
servers only).
"""

import asyncio
import struct
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import grpc
import numpy as np
import regex as re

from app.env import env
from app.jscompat import JS_S, js_trim

CONNECT_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 20.0
# The model's tensors are read again after this long, in case it was redeployed.
META_TTL_S = 600.0
SERVICE = "/inference.GRPCInferenceService"


class BrbSttError(Exception):
    pass


def _url() -> str:
    return js_trim(env("BRB_STT_URL"))


def brb_stt_configured() -> bool:
    return bool(_url())


def brb_stt_model() -> str:
    return js_trim(env("BRB_STT_MODEL")) or "stt"


def _target() -> tuple[str, bool]:
    """`host:port` and whether TLS is used (`https://` is the default when no scheme is given)."""
    raw = _url()
    parts = urlsplit(raw if re.match(r"(?i)^[a-z]+://", raw) else f"https://{raw}")
    secure = parts.scheme.lower() != "http"
    return f"{parts.hostname}:{parts.port or (443 if secure else 80)}", secure


# ── protobuf, just enough ───────────────────────────────────────────


def _varint(n: int) -> bytes:
    out = bytearray()
    while n > 127:
        out.append((n % 128) | 128)
        n //= 128
    out.append(n)
    return bytes(out)


def _bytes_field(num: int, value: bytes) -> bytes:
    return _varint((num << 3) | 2) + _varint(len(value)) + value


def _string_field(num: int, value: str) -> bytes:
    """proto3 leaves an empty string out."""
    return _bytes_field(num, value.encode("utf-8")) if value else b""


def _packed_field(num: int, values: list[int]) -> bytes:
    return _bytes_field(num, b"".join(_varint(v) for v in values)) if values else b""


class _Reader:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.at = 0

    @property
    def done(self) -> bool:
        return self.at >= len(self.buf)

    def varint(self) -> int:
        value = shift = 0
        while True:
            if self.at >= len(self.buf):
                raise BrbSttError("brb_stt_bad_message")
            byte = self.buf[self.at]
            self.at += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value
            shift += 7

    def tag(self) -> tuple[int, int]:
        key = self.varint()
        return key >> 3, key & 7

    def bytes(self) -> bytes:
        n = self.varint()
        if self.at + n > len(self.buf):
            raise BrbSttError("brb_stt_bad_message")
        out = self.buf[self.at : self.at + n]
        self.at += n
        return out

    def skip(self, wire: int) -> None:
        if wire == 0:
            self.varint()
        elif wire == 1:
            self.at += 8
        elif wire == 2:
            self.bytes()
        elif wire == 5:
            self.at += 4
        else:
            raise BrbSttError("brb_stt_bad_message")


def _int64(v: int) -> int:
    """A varint read as a signed 64-bit integer (BigInt.asIntN(64, v))."""
    v &= (1 << 64) - 1
    return v - (1 << 64) if v >= 1 << 63 else v


def _read_int64s(r: _Reader, wire: int, into: list[int]) -> None:
    """A repeated int64, packed or not."""
    if wire == 2:
        inner = _Reader(r.bytes())
        while not inner.done:
            into.append(_int64(inner.varint()))
    else:
        into.append(_int64(r.varint()))


@dataclass
class Tensor:
    name: str = ""
    datatype: str = ""
    shape: list[int] = field(default_factory=list)


@dataclass
class ModelMeta:
    inputs: list[Tensor] = field(default_factory=list)
    outputs: list[Tensor] = field(default_factory=list)


def encode_metadata_request(model: str) -> bytes:
    return _string_field(1, model)


def _read_tensor(buf: bytes) -> Tensor:
    r = _Reader(buf)
    t = Tensor()
    while not r.done:
        num, wire = r.tag()
        if num == 1 and wire == 2:
            t.name = r.bytes().decode("utf-8", errors="replace")
        elif num == 2 and wire == 2:
            t.datatype = r.bytes().decode("utf-8", errors="replace")
        elif num == 3 and wire in (0, 2):
            _read_int64s(r, wire, t.shape)
        else:
            r.skip(wire)
    return t


def decode_metadata(buf: bytes) -> ModelMeta:
    """ModelMetadataResponse: inputs (4) and outputs (5)."""
    r = _Reader(buf)
    meta = ModelMeta()
    while not r.done:
        num, wire = r.tag()
        if num == 4 and wire == 2:
            meta.inputs.append(_read_tensor(r.bytes()))
        elif num == 5 and wire == 2:
            meta.outputs.append(_read_tensor(r.bytes()))
        else:
            r.skip(wire)
    return meta


# ── what goes into each input ───────────────────────────────────────

_LANGUAGE_INPUT = re.compile(r"^lang(uage)?$", re.IGNORECASE)
_PROMPT_INPUT = re.compile(r"prefix|prompt|task|text", re.IGNORECASE)


def whisper_prefix(language: str | None = None) -> str:
    return f"<|startoftranscript|><|{'uz' if language is None else language}|><|transcribe|><|notimestamps|>"


def _wav_file(pcm: bytes) -> bytes:
    """16 kHz mono 16-bit PCM in a 44-byte WAV header."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16, b"data", len(pcm)
    )
    return header + pcm


def _bytes_element(value: bytes) -> bytes:
    """BYTES tensor contents: each element as a 4-byte little-endian length, then the bytes."""
    return struct.pack("<I", len(value)) + value


def _shape_for(t: Tensor, count: int) -> list[int]:
    """The last dimension is `count`, every other one 1 (a batch of one); a fixed misfit is refused."""
    if not t.shape:
        if count == 1:
            return []
        raise BrbSttError(f"brb_stt_input_{t.name}_{t.datatype}")
    out = []
    for i, d in enumerate(t.shape):
        want = count if i == len(t.shape) - 1 else 1
        if d not in (-1, want):
            raise BrbSttError(f"brb_stt_input_{t.name}_{t.datatype}")
        out.append(want)
    return out


def _fill(t: Tensor, pcm: bytes, language: str | None) -> tuple[list[int], bytes]:
    n = len(pcm) // 2
    if t.datatype == "FP32":
        samples = np.frombuffer(pcm, dtype="<i2", count=n).astype(np.float64) / 32768
        return _shape_for(t, n), samples.astype("<f4").tobytes()
    if t.datatype == "INT32":
        return _shape_for(t, 1), struct.pack("<i", n)
    if t.datatype == "INT64":
        return _shape_for(t, 1), struct.pack("<q", n)
    if t.datatype == "BYTES":
        if _LANGUAGE_INPUT.search(t.name):
            value = ("uz" if language is None else language).encode("utf-8")
        elif _PROMPT_INPUT.search(t.name):
            value = whisper_prefix(language).encode("utf-8")
        else:
            value = _wav_file(pcm)
        return _shape_for(t, 1), _bytes_element(value)
    if t.datatype == "UINT8":
        raw = _wav_file(pcm)
        return _shape_for(t, len(raw)), raw
    raise BrbSttError(f"brb_stt_input_{t.name}_{t.datatype}")


def encode_infer_request(model: str, meta: ModelMeta, pcm: bytes, language: str | None = None) -> bytes:
    """
    ModelInferRequest for the utterance (`pcm`: 16 kHz mono 16-bit): the model name (1), one tensor
    per model input (5) and their data, in the same order, as raw_input_contents (7).
    """
    out = _string_field(1, model)
    raws = []
    for t in meta.inputs:
        shape, raw = _fill(t, pcm, language)
        out += _bytes_field(5, _string_field(1, t.name) + _string_field(2, t.datatype) + _packed_field(3, shape))
        raws.append(raw)
    for raw in raws:
        out += _bytes_field(7, raw)
    return out


_MARKER = re.compile(r"<\|[^|>]*\|>")
_SPACES = re.compile(f"[{JS_S}]+")


def clean_transcript(text: str) -> str:
    """Whisper's text without its <|…|> markers."""
    return js_trim(_SPACES.sub(" ", _MARKER.sub(" ", text)))


def decode_transcript(buf: bytes) -> str:
    """ModelInferResponse → the first BYTES output's first element, cleaned."""
    r = _Reader(buf)
    outputs: list[tuple[str, list[bytes]]] = []
    raws: list[bytes] = []
    while not r.done:
        num, wire = r.tag()
        if num == 5 and wire == 2:
            o = _Reader(r.bytes())
            datatype, contents = "", []
            while not o.done:
                onum, owire = o.tag()
                if onum == 2 and owire == 2:
                    datatype = o.bytes().decode("utf-8", errors="replace")
                elif onum == 5 and owire == 2:
                    c = _Reader(o.bytes())  # InferTensorContents: bytes_contents (8)
                    while not c.done:
                        cnum, cwire = c.tag()
                        if cnum == 8 and cwire == 2:
                            contents.append(c.bytes())
                        else:
                            c.skip(cwire)
                else:
                    o.skip(owire)
            outputs.append((datatype, contents))
        elif num == 6 and wire == 2:
            raws.append(r.bytes())
        else:
            r.skip(wire)
    at = next((i for i, (datatype, _) in enumerate(outputs) if datatype == "BYTES"), -1)
    if at < 0:
        raise BrbSttError("brb_stt_no_text_output")
    if at < len(raws):
        raw = raws[at]
        if len(raw) < 4:
            return ""
        n = struct.unpack_from("<I", raw, 0)[0]
        return clean_transcript(raw[4 : 4 + n].decode("utf-8", errors="replace"))
    contents = outputs[at][1]
    return clean_transcript(contents[0].decode("utf-8", errors="replace") if contents else "")


# ── gRPC ────────────────────────────────────────────────────────────

_channel: grpc.aio.Channel | None = None
_channel_key: tuple | None = None


async def _channel_for() -> grpc.aio.Channel:
    global _channel, _channel_key
    target, secure = _target()
    # A channel belongs to the event loop it was made on.
    key = (target, secure, id(asyncio.get_running_loop()))
    if _channel is not None and _channel_key == key:
        return _channel
    if _channel is not None and _channel_key is not None and _channel_key[2] == key[2]:
        await _channel.close()  # same loop, another address: the old connection is no longer needed
    _channel = _channel_key = None
    channel = (
        grpc.aio.secure_channel(target, grpc.ssl_channel_credentials()) if secure else grpc.aio.insecure_channel(target)
    )
    try:
        await asyncio.wait_for(channel.channel_ready(), CONNECT_TIMEOUT_S)
    except TimeoutError:
        await channel.close()
        raise BrbSttError("brb_stt_connect_timeout") from None
    _channel, _channel_key = channel, key
    return channel


async def brb_stt_close() -> None:
    """Close the connection (tests, shutdown)."""
    global _channel, _channel_key
    if _channel is not None:
        await _channel.close()
    _channel = _channel_key = None


def _rpc_error(status: int, detail: str) -> BrbSttError:
    if status == 14:
        return BrbSttError(f"brb_stt_unreachable: {detail}")
    if status == 4:
        return BrbSttError("brb_stt_timeout")
    return BrbSttError(f"brb_stt_grpc_{status}" + (f": {detail}" if detail else ""))


async def _unary(method: str, message: bytes) -> bytes:
    channel = await _channel_for()
    call = channel.unary_unary(f"{SERVICE}/{method}")  # no serializers: bytes in, bytes out
    try:
        return await call(message, timeout=READ_TIMEOUT_S)
    except grpc.aio.AioRpcError as err:
        raise _rpc_error(err.code().value[0], err.details() or "") from None


# ── the call ────────────────────────────────────────────────────────

_meta: tuple[str, float, ModelMeta] | None = None


async def _metadata(model: str) -> ModelMeta:
    global _meta
    key = f"{_target()}|{model}"
    if _meta and _meta[0] == key and time.monotonic() - _meta[1] < META_TTL_S:
        return _meta[2]
    value = decode_metadata(await _unary("ModelMetadata", encode_metadata_request(model)))
    _meta = (key, time.monotonic(), value)
    return value


async def brb_transcribe(pcm: bytes, language: str | None = None) -> str:
    """Transcribe one utterance (`pcm`: 16 kHz mono 16-bit). '' when nothing was said; BrbSttError on failure."""
    global _meta
    if not brb_stt_configured():
        raise BrbSttError("brb_stt_not_configured")
    model = brb_stt_model()
    try:
        meta = await _metadata(model)
        return decode_transcript(await _unary("ModelInfer", encode_infer_request(model, meta, pcm, language)))
    except BrbSttError:
        _meta = None  # a redeployed model may take other inputs: read them again next time
        raise
    except Exception as err:
        _meta = None
        raise BrbSttError(str(err)) from err
